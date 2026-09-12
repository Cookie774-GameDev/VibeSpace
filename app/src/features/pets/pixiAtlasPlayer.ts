/**
 * Real PixiJS Application-based atlas animation player.
 * Loads Pixi-compatible JSON atlases + PNG sheets. Never decodes MP4.
 * Nearest-neighbor sampling, hard-alpha transparent canvas, bottom-center anchors.
 */

import {
  Application,
  Assets,
  Rectangle,
  Sprite,
  Texture,
  SCALE_MODES,
  type TextureSource,
} from 'pixi.js';
import {
  petPerfRecordTextureReload,
  petPerfSetCanvasCount,
  petPerfSetTickerFps,
} from './petDevPerf';

export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  trimmed?: boolean;
  rotated?: boolean;
}

export interface AtlasJson {
  frames: Record<string, AtlasFrame>;
  animations?: Record<string, string[]>;
  meta: { image: string; size: { w: number; h: number }; scale?: string };
}

export interface AnimPlaybackMeta {
  frames: string[];
  fps: number;
  loop: boolean;
  oneShot?: boolean;
  playbackKey?: string;
}

export interface PixiAtlasPlayerOptions {
  /** Logical display size (CSS pixels). */
  displaySize?: number;
  /** Device pixel ratio for @1x vs @2x selection (caller may pass). */
  resolution?: number;
  /** Prefer @2x atlas assets when resolution >= 1.5. */
  prefer2x?: boolean;
  /** Background alpha for the renderer (0 = fully transparent). */
  backgroundAlpha?: number;
}

/** Track live applications so tests can assert single-instance discipline. */
const liveApplications = new WeakSet<Application>();
let liveApplicationCount = 0;
const managedAssetRefCounts = new Map<string, number>();
const textureObjectIds = new WeakMap<object, string>();
let textureObjectSeq = 0;

function retainManagedAsset(url: string): void {
  managedAssetRefCounts.set(url, (managedAssetRefCounts.get(url) ?? 0) + 1);
}

async function releaseManagedAsset(url: string): Promise<void> {
  const current = managedAssetRefCounts.get(url) ?? 0;
  if (current > 1) {
    managedAssetRefCounts.set(url, current - 1);
    return;
  }
  managedAssetRefCounts.delete(url);
  try {
    await Assets.unload(url);
  } catch {
    /* Ignore an already-evicted cache entry. */
  }
}

async function unloadUnreferencedManagedAsset(url: string): Promise<void> {
  if (managedAssetRefCounts.has(url)) return;
  try {
    await Assets.unload(url);
  } catch {
    /* Ignore an already-evicted cache entry. */
  }
}

function textureObjectId(value: unknown): string | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return null;
  }
  const obj = value as object;
  const existing = textureObjectIds.get(obj);
  if (existing) return existing;
  const next = `tex:${++textureObjectSeq}`;
  textureObjectIds.set(obj, next);
  return next;
}

export function getLivePixiApplicationCount(): number {
  return liveApplicationCount;
}

/**
 * PixiJS atlas player: one Application, one Sprite, texture frames from atlas JSON.
 * Destroy fully on dispose (app, textures, ticker listeners).
 */
export class PixiAtlasPlayer {
  private app: Application | null = null;
  private sprite: Sprite | null = null;
  private atlas: AtlasJson | null = null;
  private baseTexture: Texture | null = null;
  private frameTextures = new Map<string, Texture>();
  private frameNames: string[] = [];
  private fps = 12;
  private loop = true;
  private index = 0;
  private accum = 0;
  private done = false;
  private manuallyPaused = false;
  private onComplete: (() => void) | null = null;
  private displaySize = 128;
  private destroyed = false;
  private contextLost = false;
  private tickerFn: ((ticker: { deltaMS: number }) => void) | null = null;
  private mountEl: HTMLElement | null = null;
  private contextLostHandler: ((event: Event) => void) | null = null;
  private contextRestoredHandler: ((event: Event) => void) | null = null;
  private onContextLostCallback: (() => void) | null = null;
  private lastFilter: 'nearest' | 'linear' | null = null;
  private loadGeneration = 0;
  private activePlaybackKey: string | null = null;
  private activeFrameSignature = '';
  private activeLoop = true;
  private activeOneShot = false;
  private setAnimationCallCount = 0;
  private ignoredDuplicateAnimationRequests = 0;
  private animationResetCount = 0;
  private textureAssignmentCount = 0;
  private lastAssignedTexture: unknown = null;
  private lastTextureChanged = false;
  private currentTextureObjectId: string | null = null;
  private currentTextureSourceId: string | null = null;
  private currentTextureFrameRect: string | null = null;
  /** Last successfully loaded atlas JSON URL (diagnostic source of truth). */
  private lastAtlasJsonUrl: string | null = null;
  /** Last successfully loaded atlas image URL (for cache eviction on skin switch). */
  private lastImageUrl: string | null = null;

  get application(): Application | null {
    return this.app;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get currentFrameName(): string | null {
    return this.frameNames[this.index] ?? null;
  }

  get currentFrameIndex(): number {
    return this.index;
  }

  get frameCount(): number {
    return this.frameNames.length;
  }

  get animationElapsedMs(): number {
    return this.accum + this.index * (this.fps > 0 ? 1000 / this.fps : 0);
  }

  get isAnimationPaused(): boolean {
    return this.manuallyPaused || this.done || this.destroyed || this.frameNames.length === 0;
  }

  get isTickerAttached(): boolean {
    return Boolean(this.app && this.tickerFn && !this.destroyed);
  }

  get textureCacheKey(): string | null {
    return this.lastImageUrl;
  }

  get loadedAtlasJsonUrl(): string | null {
    return this.lastAtlasJsonUrl;
  }

  /**
   * True only when the requested animation is already live on this exact
   * player. A matching React animation key alone is insufficient after a
   * StrictMode cleanup or player replacement.
   */
  isPlaybackReady(playbackKey: string, atlasJsonUrl: string): boolean {
    const tickerStarted = this.isTickerStarted();
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined;
    return Boolean(
      !this.destroyed &&
      this.app &&
      this.sprite &&
      this.atlas &&
      this.frameTextures.size > 1 &&
      this.frameNames.length > 1 &&
      this.activePlaybackKey === playbackKey &&
      this.lastAtlasJsonUrl === atlasJsonUrl &&
      this.isTickerAttached &&
      tickerStarted &&
      this.sprite.texture &&
      canvas?.parentElement === this.mountEl,
    );
  }

  get currentTextureUid(): string | number | null {
    const tex = this.sprite?.texture as
      | (Texture & { uid?: string | number; source?: { uid?: string | number } })
      | null
      | undefined;
    if (!tex) return null;
    return tex.uid ?? textureObjectId(tex);
  }

  /**
   * Distinct cache identity: characterId + animation state + scale + asset version.
   * @see buildPetTextureCacheKey
   */
  static buildTextureCacheKey(input: {
    characterId: string;
    animationState: string;
    scale: '1x' | '2x' | string;
    assetVersion?: string | number;
    imageUrl?: string;
  }): string {
    // Local re-export of pure helper (avoids circular import in tests).
    const ver = input.assetVersion ?? '1';
    const url = input.imageUrl ?? '';
    return `${input.characterId}|${input.animationState}|${input.scale}|${ver}|${url}`;
  }

  /**
   * Safe development diagnostics for the registry→atlas→ticker chain.
   * No console spam — callers log only when needed.
   */
  getDiagnostics(): {
    currentFrameIndex: number;
    frameCount: number;
    currentFrameName: string | null;
    elapsedAnimationMs: number;
    fps: number;
    loop: boolean;
    done: boolean;
    tickerRunning: boolean;
    tickerStarted: boolean;
    tickerListenerCount: number | null;
    animationPaused: boolean;
    textureCacheKey: string | null;
    loadedAtlasJsonUrl: string | null;
    currentTextureUid: string | number | null;
    currentTextureSourceUid: string | null;
    currentTextureFrameRect: string | null;
    lastTextureChanged: boolean;
    textureAssignmentCount: number;
    setAnimationCallCount: number;
    ignoredDuplicateAnimationRequests: number;
    animationResetCount: number;
    applicationObjectId: string | null;
    canvasObjectId: string | null;
    liveApplicationCount: number;
    backgroundAlpha: number;
    scaleMode: 'nearest' | 'linear' | null;
  } {
    return {
      currentFrameIndex: this.index,
      frameCount: this.frameNames.length,
      currentFrameName: this.currentFrameName,
      elapsedAnimationMs: this.animationElapsedMs,
      fps: this.fps,
      loop: this.loop,
      done: this.done,
      tickerRunning: this.isTickerAttached,
      tickerStarted: this.isTickerStarted(),
      tickerListenerCount: this.getTickerListenerCount(),
      animationPaused: this.isAnimationPaused,
      textureCacheKey: this.textureCacheKey,
      loadedAtlasJsonUrl: this.loadedAtlasJsonUrl,
      currentTextureUid: this.currentTextureUid,
      currentTextureSourceUid: this.currentTextureSourceId,
      currentTextureFrameRect: this.currentTextureFrameRect,
      lastTextureChanged: this.lastTextureChanged,
      textureAssignmentCount: this.textureAssignmentCount,
      setAnimationCallCount: this.setAnimationCallCount,
      ignoredDuplicateAnimationRequests: this.ignoredDuplicateAnimationRequests,
      animationResetCount: this.animationResetCount,
      applicationObjectId: textureObjectId(this.app),
      canvasObjectId: textureObjectId(this.app?.canvas),
      liveApplicationCount: liveApplicationCount,
      backgroundAlpha: this.backgroundAlpha,
      scaleMode: this.lastFilter,
    };
  }

  get textureScaleMode(): 'nearest' | 'linear' | null {
    return this.lastFilter;
  }

  /** Renderer clear alpha (0 = fully transparent). Used by unit tests. */
  get backgroundAlpha(): number {
    if (!this.app) return 0;
    try {
      const bg = this.app.renderer.background as unknown as { alpha?: number };
      return typeof bg.alpha === 'number' ? bg.alpha : 0;
    } catch {
      return 0;
    }
  }

  private forceTransparentBackground(app: Application): void {
    try {
      const bg = app.renderer.background as unknown as {
        alpha?: number;
        color?: unknown;
      };
      if (bg) {
        bg.alpha = 0;
      }
    } catch {
      /* ignore */
    }
  }

  private isTickerStarted(): boolean {
    const ticker = this.app?.ticker as { started?: boolean; start?: () => void } | undefined;
    return Boolean(ticker?.started);
  }

  private getTickerListenerCount(): number | null {
    const ticker = this.app?.ticker as
      | { fns?: unknown[]; count?: number; _head?: { next?: unknown } }
      | undefined;
    if (!ticker) return null;
    if (Array.isArray(ticker.fns)) return ticker.fns.length;
    if (typeof ticker.count === 'number') return ticker.count;
    return null;
  }

  /**
   * Initialize (or re-bind) a single Pixi Application into `host`.
   * Safe to call again with the same host — does not create a second app.
   */
  async init(host: HTMLElement, opts: PixiAtlasPlayerOptions = {}): Promise<void> {
    if (this.destroyed) {
      throw new Error('PixiAtlasPlayer: cannot init after dispose');
    }
    this.displaySize = opts.displaySize ?? 128;
    this.mountEl = host;

    if (this.app) {
      // Already have an application — ensure canvas is in the host once.
      if (this.app.canvas.parentElement !== host) {
        host.replaceChildren(this.app.canvas as HTMLCanvasElement);
      }
      this.resizeToDisplay();
      return;
    }

    const app = new Application();
    const res = Math.min(
      2,
      Math.max(
        1,
        opts.resolution ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
      ),
    );
    await app.init({
      width: this.displaySize,
      height: this.displaySize,
      // Critical: fully transparent clear — never opaque black plate
      backgroundAlpha: opts.backgroundAlpha ?? 0,
      antialias: false,
      autoDensity: true,
      resolution: res,
      preference: 'webgl',
      roundPixels: true,
      clearBeforeRender: true,
      // WebGL must allocate an alpha buffer (otherwise clear is opaque black)
      multiView: false,
    });

    // Re-assert transparent background after init (some Pixi paths reset it).
    this.forceTransparentBackground(app);

    // Nearest-neighbor default for all textures on this renderer.
    const canvas = app.canvas as HTMLCanvasElement;
    canvas.style.width = `${this.displaySize}px`;
    canvas.style.height = `${this.displaySize}px`;
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'block';
    canvas.style.background = 'transparent';
    canvas.style.backgroundColor = 'transparent';
    canvas.style.backgroundImage = 'none';
    canvas.style.border = 'none';
    canvas.style.outline = 'none';
    canvas.style.boxShadow = 'none';
    canvas.style.mixBlendMode = 'normal';
    canvas.dataset.petPixiCanvas = 'true';
    host.classList.add('pet-canvas-container');
    host.style.background = 'transparent';
    host.style.backgroundColor = 'transparent';
    host.style.backgroundImage = 'none';
    host.style.border = 'none';
    host.style.boxShadow = 'none';
    host.replaceChildren(canvas);

    // WebGL context loss blanks the sprite while the window/drag surface remains.
    // Prevent default so the browser can restore, then request a full re-init.
    this.contextLostHandler = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      try {
        this.onContextLostCallback?.();
      } catch {
        /* host recovery is best-effort */
      }
    };
    this.contextRestoredHandler = () => {
      this.contextLost = false;
      try {
        this.onContextLostCallback?.();
      } catch {
        /* host recovery is best-effort */
      }
    };
    canvas.addEventListener('webglcontextlost', this.contextLostHandler, false);
    canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler, false);

    const sprite = new Sprite();
    sprite.roundPixels = true;
    sprite.anchor.set(0.5, 1); // bottom-center
    sprite.x = Math.round(this.displaySize / 2);
    sprite.y = Math.round(this.displaySize);
    // Full brightness — never greyed-out tint
    sprite.alpha = 1;
    sprite.tint = 0xffffff;
    app.stage.addChild(sprite);

    this.tickerFn = (ticker) => {
      this.update(ticker.deltaMS);
      // Dev perf: approximate FPS from deltaMS when available.
      if (ticker.deltaMS > 0) {
        petPerfSetTickerFps(Math.round(1000 / ticker.deltaMS));
      }
    };
    app.ticker.add(this.tickerFn);
    try {
      app.ticker.start();
    } catch {
      /* Pixi ticker starts by default in some environments. */
    }

    this.app = app;
    this.sprite = sprite;
    liveApplications.add(app);
    liveApplicationCount += 1;
    petPerfSetCanvasCount(liveApplicationCount);
  }

  private resizeToDisplay(): void {
    if (!this.app) return;
    this.app.renderer.resize(this.displaySize, this.displaySize);
    if (this.sprite) {
      this.sprite.x = Math.round(this.displaySize / 2);
      this.sprite.y = Math.round(this.displaySize);
    }
  }

  /**
   * Load atlas JSON + image. Replaces prior atlas textures.
   */
  /** Image URL of the atlas currently held by this player (if any). */
  get loadedImageUrl(): string | null {
    return this.lastImageUrl;
  }

  /**
   * Drop cached textures for a prior skin so switching Axo↔Glitch cannot leave
   * a stale Glitch frame on screen under the Axo character id.
   * Always unloads `lastImageUrl` plus any extra URLs passed by the caller.
   */
  async unloadCharacterCache(imageUrls: string[] = []): Promise<void> {
    const ownedImageUrl = this.lastImageUrl;
    const urls = new Set<string>();
    for (const u of imageUrls) {
      if (u) urls.add(u);
    }
    this.clearFrameTextures();
    this.lastAtlasJsonUrl = null;
    this.lastImageUrl = null;
    this.activePlaybackKey = null;
    this.activeFrameSignature = '';
    if (ownedImageUrl) {
      urls.delete(ownedImageUrl);
      await releaseManagedAsset(ownedImageUrl);
    }
    for (const url of urls) {
      await unloadUnreferencedManagedAsset(url);
    }
  }

  async load(atlasUrl: string, imageUrl: string): Promise<void> {
    if (this.destroyed) throw new Error('PixiAtlasPlayer disposed');
    if (!this.app) throw new Error('PixiAtlasPlayer.init() required before load');

    // Already showing this exact sheet — skip (avoids blink between walk frames).
    if (
      this.lastAtlasJsonUrl === atlasUrl &&
      this.lastImageUrl === imageUrl &&
      this.frameTextures.size > 0 &&
      this.atlas
    ) {
      return;
    }

    const gen = ++this.loadGeneration;
    const prevImageUrl = this.lastImageUrl;
    const prevFrames = new Map(this.frameTextures);

    // CRITICAL: do NOT clear current textures until the new atlas is ready.
    // Clearing first made the pet vanish on every walk/idle atlas switch.

    const res = await fetch(atlasUrl);
    if (!res.ok) throw new Error(`atlas fetch failed: ${atlasUrl}`);
    const atlas = (await res.json()) as AtlasJson;
    if (gen !== this.loadGeneration || this.destroyed) return;

    // Load full sheet; prefer non-premultiplied alpha so cream stays bright on dark UI.
    const base = (await Assets.load(imageUrl)) as Texture;
    if (gen !== this.loadGeneration || this.destroyed) {
      return;
    }

    const nextFrames = new Map<string, Texture>();
    this.applyNearestFilter(base);
    for (const [name, entry] of Object.entries(atlas.frames)) {
      const { x, y, w, h } = entry.frame;
      const frame = new Texture({
        source: base.source,
        frame: new Rectangle(x, y, w, h),
      });
      this.applyNearestFilter(frame);
      nextFrames.set(name, frame);
    }

    // Atomic swap — old sprite keeps drawing until this point.
    if (prevImageUrl !== imageUrl) retainManagedAsset(imageUrl);
    this.baseTexture = base;
    this.lastAtlasJsonUrl = atlasUrl;
    this.lastImageUrl = imageUrl;
    this.atlas = atlas;
    this.frameTextures = nextFrames;
    this.activePlaybackKey = null;
    this.activeFrameSignature = '';
    petPerfRecordTextureReload();

    // Dispose previous sheet after swap (not before).
    for (const t of prevFrames.values()) {
      try {
        t.destroy(false);
      } catch {
        /* ignore */
      }
    }
    if (prevImageUrl && prevImageUrl !== imageUrl) {
      await releaseManagedAsset(prevImageUrl);
    }
  }

  private applyNearestFilter(tex: Texture): void {
    const source = tex.source as TextureSource & {
      scaleMode?: string;
      alphaMode?: string;
    };
    if (source) {
      if ('scaleMode' in source) source.scaleMode = SCALE_MODES.NEAREST;
      // Keep unpremultiplied so semi-transparent edges don't darken
      try {
        (source as { alphaMode?: string }).alphaMode = 'no-premultiply-alpha';
      } catch {
        /* ignore */
      }
    }
    this.lastFilter = 'nearest';
  }

  private clearFrameTextures(): void {
    for (const t of this.frameTextures.values()) {
      try {
        t.destroy(false);
      } catch {
        /* ignore */
      }
    }
    this.frameTextures.clear();
    this.baseTexture = null;
  }

  setAnimation(meta: AnimPlaybackMeta, onComplete?: () => void): void {
    this.setAnimationCallCount += 1;
    const frameSignature = meta.frames.join('\u001f');
    const playbackKey =
      meta.playbackKey ??
      `${this.lastAtlasJsonUrl ?? 'no-atlas'}|${this.lastImageUrl ?? 'no-image'}|${frameSignature}|${meta.loop ? 'loop' : 'once'}|${meta.oneShot ? 'one' : 'multi'}`;
    const nextLoop = meta.loop && !meta.oneShot;
    const nextOneShot = Boolean(meta.oneShot);
    if (
      this.activePlaybackKey === playbackKey &&
      this.activeFrameSignature === frameSignature &&
      this.activeLoop === nextLoop &&
      this.activeOneShot === nextOneShot &&
      this.frameNames.length > 0 &&
      this.atlas
    ) {
      this.ignoredDuplicateAnimationRequests += 1;
      this.fps = meta.fps > 0 ? meta.fps : this.fps;
      this.onComplete = onComplete ?? this.onComplete;
      return;
    }
    this.animationResetCount += 1;
    this.activePlaybackKey = playbackKey;
    this.activeFrameSignature = frameSignature;
    this.activeLoop = nextLoop;
    this.activeOneShot = nextOneShot;
    this.frameNames = meta.frames.slice();
    this.fps = meta.fps > 0 ? meta.fps : 12;
    this.loop = nextLoop;
    this.index = 0;
    this.accum = 0;
    this.done = false;
    this.manuallyPaused = false;
    this.onComplete = onComplete ?? null;
    this.applyCurrentFrame();
  }

  setPlaybackFps(fps: number): void {
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.fps = fps;
  }

  pause(): void {
    if (!this.destroyed) this.manuallyPaused = true;
  }

  resume(): void {
    if (!this.destroyed && this.frameNames.length > 0) this.manuallyPaused = false;
  }

  restartAnimation(): void {
    if (this.destroyed || this.frameNames.length === 0) return;
    this.index = 0;
    this.accum = 0;
    this.done = false;
    this.manuallyPaused = false;
    this.applyCurrentFrame();
  }

  /**
   * Register a host-side recovery callback for WebGL context loss/restore.
   * The host should dispose this player and re-init + reload the current anim.
   */
  setContextLostHandler(handler: (() => void) | null): void {
    this.onContextLostCallback = handler;
  }

  /** True when the WebGL context is known-lost or the canvas is detached. */
  isContextUnhealthy(): boolean {
    if (this.destroyed || this.contextLost) return true;
    if (!this.app || !this.sprite) return true;
    const canvas = this.app.canvas as HTMLCanvasElement | undefined;
    if (!canvas || !canvas.isConnected) return true;
    try {
      const gl = (
        this.app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }
      ).gl;
      if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        this.contextLost = true;
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }

  /**
   * Soft recovery when the canvas is still valid: restart ticker, re-assert
   * transparent clear, and re-apply the current frame so the sprite reappears.
   * Returns false when a hard re-init is required.
   */
  ensureAliveRendering(): boolean {
    if (this.destroyed) return false;
    if (this.isContextUnhealthy()) return false;
    if (!this.app || !this.sprite) return false;
    try {
      this.forceTransparentBackground(this.app);
      if (!this.isTickerStarted()) {
        try {
          this.app.ticker.start();
        } catch {
          /* ignore */
        }
      }
      if (this.frameNames.length > 0) {
        this.applyCurrentFrame();
      }
      // Nudge a single render so a paused/static frame is painted again.
      try {
        (this.app.renderer as unknown as { render?: (stage: unknown) => void }).render?.(
          this.app.stage,
        );
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Advance animation clock. Also invoked by Pixi ticker.
   * Returns true if a one-shot completed.
   */
  update(dtMs: number): boolean {
    if (this.manuallyPaused || this.done || this.frameNames.length === 0 || this.destroyed) {
      return this.done;
    }
    const frameMs = 1000 / this.fps;
    this.accum += dtMs;
    let advanced = false;
    while (this.accum >= frameMs) {
      this.accum -= frameMs;
      advanced = true;
      if (this.index + 1 >= this.frameNames.length) {
        if (this.loop) {
          this.index = 0;
        } else {
          this.done = true;
          this.onComplete?.();
          this.applyCurrentFrame();
          return true;
        }
      } else {
        this.index += 1;
      }
    }
    if (advanced) this.applyCurrentFrame();
    return this.done;
  }

  private applyCurrentFrame(): void {
    if (!this.sprite || this.frameNames.length === 0) return;
    const name = this.frameNames[Math.min(this.index, this.frameNames.length - 1)];
    const tex = this.frameTextures.get(name);
    if (!tex) return;
    const prev = this.sprite.texture;
    this.sprite.texture = tex;
    this.textureAssignmentCount += 1;
    this.lastTextureChanged = prev !== tex;
    this.lastAssignedTexture = tex;
    this.currentTextureObjectId = textureObjectId(tex);
    this.currentTextureSourceId = textureObjectId((tex as Texture).source);

    // Fit frame into display with integer scale; preserve bottom-center anchor.
    const tw = tex.width || 1;
    const th = tex.height || 1;
    const scale = Math.max(1, Math.floor(this.displaySize / Math.max(tw, th)));
    // If frame already matches display (128), scale=1; otherwise upscale by integers only.
    const fit = Math.min(this.displaySize / tw, this.displaySize / th);
    const s = Number.isFinite(fit) && fit > 0 ? fit : 1;
    // Prefer crisp integer scale when close; else exact fit without subpixel drift via round.
    const use = Math.abs(s - Math.round(s)) < 0.01 ? Math.round(s) : s;
    this.sprite.scale.set(use);
    this.sprite.x = Math.round(this.displaySize / 2);
    this.sprite.y = Math.round(this.displaySize);

    // Trimmed-frame offset: spriteSourceSize x/y shifts the draw origin within sourceSize.
    const entry = this.atlas?.frames[name];
    this.currentTextureFrameRect = entry
      ? `${entry.frame.x},${entry.frame.y},${entry.frame.w},${entry.frame.h}`
      : null;
    if (entry?.trimmed && entry.spriteSourceSize && entry.sourceSize) {
      const ox = entry.spriteSourceSize.x;
      const oy = entry.spriteSourceSize.y;
      // With bottom-center anchor on the texture itself, apply trim offset in texture space.
      this.sprite.x = Math.round(
        this.displaySize / 2 + (ox + entry.frame.w / 2 - entry.sourceSize.w / 2) * use,
      );
      this.sprite.y = Math.round(
        this.displaySize + (oy + entry.frame.h - entry.sourceSize.h) * use,
      );
    }
  }

  /** Select atlas path by DPR: prefer2x when resolution >= 1.5. */
  static selectAtlasScale(
    def: { atlas: string; atlas2x?: string },
    devicePixelRatio: number,
  ): { atlasPath: string; scale: '1x' | '2x' } {
    if (def.atlas2x && devicePixelRatio >= 1.5) {
      return { atlasPath: def.atlas2x, scale: '2x' };
    }
    return { atlasPath: def.atlas, scale: '1x' };
  }

  dispose(): void {
    if (this.destroyed) return;
    const ownedImageUrl = this.lastImageUrl;
    this.destroyed = true;
    this.onComplete = null;
    this.onContextLostCallback = null;
    this.frameNames = [];
    this.atlas = null;
    this.lastAtlasJsonUrl = null;
    this.lastImageUrl = null;

    if (this.app) {
      const canvas = this.app.canvas as HTMLCanvasElement | undefined;
      if (canvas && this.contextLostHandler) {
        canvas.removeEventListener('webglcontextlost', this.contextLostHandler, false);
      }
      if (canvas && this.contextRestoredHandler) {
        canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler, false);
      }
    }
    this.contextLostHandler = null;
    this.contextRestoredHandler = null;
    this.contextLost = false;

    if (this.app && this.tickerFn) {
      try {
        this.app.ticker.remove(this.tickerFn);
      } catch {
        /* ignore */
      }
    }
    this.tickerFn = null;
    this.clearFrameTextures();
    if (ownedImageUrl) void releaseManagedAsset(ownedImageUrl);

    if (this.sprite) {
      try {
        this.sprite.destroy();
      } catch {
        /* ignore */
      }
      this.sprite = null;
    }

    if (this.app) {
      liveApplications.delete(this.app);
      liveApplicationCount = Math.max(0, liveApplicationCount - 1);
      petPerfSetCanvasCount(liveApplicationCount);
      try {
        this.app.destroy(true, { children: true, texture: false, textureSource: false });
      } catch {
        /* ignore */
      }
      this.app = null;
    }

    if (this.mountEl) {
      this.mountEl.replaceChildren();
      this.mountEl = null;
    }
  }
}

/** Back-compat alias used by older imports / tests that still say AtlasPlayer. */
export { PixiAtlasPlayer as AtlasPlayer };
