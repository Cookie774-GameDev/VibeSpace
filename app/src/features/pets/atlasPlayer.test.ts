/**
 * PixiAtlasPlayer unit tests.
 * WebGL may be limited in jsdom — we test pure logic + lifecycle counters
 * and mock Application when needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLivePixiApplicationCount,
  PixiAtlasPlayer,
  type AnimPlaybackMeta,
} from './pixiAtlasPlayer';

const pixiMockState = vi.hoisted(() => ({
  initOptions: [] as Array<Record<string, unknown>>,
}));

// Mock pixi.js Application for jsdom (no real WebGL).
vi.mock('pixi.js', async () => {
  class FakeTicker {
    fns: Array<(t: { deltaMS: number }) => void> = [];
    started = false;
    add(fn: (t: { deltaMS: number }) => void) {
      this.fns.push(fn);
    }
    remove(fn: (t: { deltaMS: number }) => void) {
      this.fns = this.fns.filter((f) => f !== fn);
    }
    start() {
      this.started = true;
    }
  }
  class FakeRenderer {
    background = { alpha: 1, color: 0x000000 };
    resize() {}
  }
  class FakeApplication {
    canvas = document.createElement('canvas');
    stage = { addChild: vi.fn() };
    ticker = new FakeTicker();
    renderer = new FakeRenderer();
    async init(options?: Record<string, unknown>) {
      pixiMockState.initOptions.push(options ?? {});
    }
    destroy() {}
  }
  class FakeSprite {
    texture: unknown = null;
    anchor = { set: vi.fn() };
    scale = { set: vi.fn() };
    x = 0;
    y = 0;
    roundPixels = false;
    destroy() {}
  }
  class FakeTexture {
    width = 128;
    height = 128;
    source = { scaleMode: 'nearest' };
    destroy() {}
  }
  return {
    Application: FakeApplication,
    Assets: {
      load: async () => new FakeTexture(),
      unload: async () => undefined,
    },
    Rectangle: class {
      constructor(
        public x: number,
        public y: number,
        public w: number,
        public h: number,
      ) {}
    },
    Sprite: FakeSprite,
    Texture: class extends FakeTexture {
      constructor(_opts?: unknown) {
        super();
      }
      static from() {
        return new FakeTexture();
      }
    },
    SCALE_MODES: { NEAREST: 'nearest', LINEAR: 'linear' },
  };
});

describe('PixiAtlasPlayer', () => {
  afterEach(() => {
    pixiMockState.initOptions.length = 0;
  });

  it('selects @2x atlas when DPR >= 1.5', () => {
    const def = { atlas: 'atlases/a@1x.json', atlas2x: 'atlases/a@2x.json' };
    expect(PixiAtlasPlayer.selectAtlasScale(def, 1).scale).toBe('1x');
    expect(PixiAtlasPlayer.selectAtlasScale(def, 1.5).scale).toBe('2x');
    expect(PixiAtlasPlayer.selectAtlasScale(def, 2).atlasPath).toContain('@2x');
  });

  it('inits a single Application and disposes without leaving live apps', async () => {
    const before = getLivePixiApplicationCount();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const p = new PixiAtlasPlayer();
    await p.init(host, { displaySize: 128, resolution: 1 });
    expect(getLivePixiApplicationCount()).toBe(before + 1);
    expect(p.application).not.toBeNull();

    // Second init same host must not create another Application
    await p.init(host, { displaySize: 128 });
    expect(getLivePixiApplicationCount()).toBe(before + 1);

    p.dispose();
    expect(p.isDestroyed).toBe(true);
    expect(p.application).toBeNull();
    expect(getLivePixiApplicationCount()).toBe(before);
    host.remove();
  });

  it('initializes Pixi with a transparent alpha-capable renderer and canvas', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const p = new PixiAtlasPlayer();
    await p.init(host, { displaySize: 128, resolution: 2, backgroundAlpha: 0 });

    expect(pixiMockState.initOptions).toHaveLength(1);
    expect(pixiMockState.initOptions[0]).toMatchObject({
      width: 128,
      height: 128,
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: 2,
      clearBeforeRender: true,
    });
    expect(pixiMockState.initOptions[0]).not.toHaveProperty('useBackBuffer', true);
    expect((p.application?.renderer as unknown as { background: { alpha: number } }).background.alpha).toBe(0);
    expect(host.style.background).toBe('transparent');
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.background).toBe('transparent');
    expect(canvas.style.backgroundColor).toBe('transparent');
    expect(canvas.dataset.petPixiCanvas).toBe('true');
    // Healthy init is soft-recoverable without a hard re-init.
    expect(p.isContextUnhealthy()).toBe(false);
    expect(p.ensureAliveRendering()).toBe(true);

    p.dispose();
    host.remove();
  });

  it('prevents re-init after dispose', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    p.dispose();
    await expect(p.init(host)).rejects.toThrow(/dispose/i);
  });

  it('load keeps prior textures until the new atlas is ready (no blink/clear-first)', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);

    // Seed two fake frame textures as if an idle atlas was loaded.
    const idleTex = { destroy: vi.fn() } as unknown as import('pixi.js').Texture;
    // Access private map via cast for unit test of swap semantics
    const internal = p as unknown as {
      frameTextures: Map<string, { destroy: (c?: boolean) => void }>;
      lastImageUrl: string | null;
      atlas: unknown;
      baseTexture: unknown;
    };
    internal.frameTextures.set('frame_000', idleTex);
    internal.lastImageUrl = 'idle.png';
    internal.atlas = { frames: {} };
    internal.baseTexture = { destroy: vi.fn() };

    // Mock fetch + Assets for walk atlas
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        frames: {
          frame_000: { frame: { x: 0, y: 0, w: 128, h: 128 } },
        },
        meta: { image: 'walk.png', size: { w: 128, h: 128 } },
      }),
    } as Response);

    // While load is in-flight we cannot easily interleave without rewriting load
    // to expose mid-state; assert post-condition: after load, prior destroy ran
    // and new lastImageUrl is set (swap completed).
    await p.load('walk.json', 'walk.png');
    expect(internal.lastImageUrl).toBe('walk.png');
    // Prior frame texture was destroyed only after swap (destroy was called).
    expect(idleTex.destroy).toHaveBeenCalled();

    fetchMock.mockRestore();
    p.dispose();
  });

  it('advances frames by fps and completes one-shots', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);

    // Inject atlas frames map without network
    const atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 128, h: 128 } },
        b: { frame: { x: 128, y: 0, w: 128, h: 128 } },
        c: { frame: { x: 256, y: 0, w: 128, h: 128 } },
      },
      meta: { image: 'x', size: { w: 384, h: 128 } },
    };
    (p as unknown as { atlas: unknown }).atlas = atlas;
    // Stub frame textures
    const fakeTex = { width: 128, height: 128, source: { scaleMode: 'nearest' }, destroy: () => {} };
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    map.set('a', fakeTex);
    map.set('b', fakeTex);
    map.set('c', fakeTex);
    (p as unknown as { sprite: { texture: unknown; scale: { set: () => void }; x: number; y: number } }).sprite = {
      texture: null,
      scale: { set: () => {} },
      x: 64,
      y: 128,
    };

    let completed = 0;
    const meta: AnimPlaybackMeta = {
      frames: ['a', 'b', 'c'],
      fps: 10,
      loop: false,
      oneShot: true,
    };
    p.setAnimation(meta, () => {
      completed += 1;
    });
    expect(p.currentFrameName).toBe('a');
    p.update(100);
    expect(p.currentFrameName).toBe('b');
    p.update(100);
    expect(p.currentFrameName).toBe('c');
    const done = p.update(100);
    expect(done).toBe(true);
    expect(completed).toBe(1);
    expect(p.update(500)).toBe(true);
    expect(completed).toBe(1);
    p.dispose();
  });

  it('does not reset duplicate playback requests for the same loaded animation', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);

    (p as unknown as { atlas: unknown; lastAtlasJsonUrl: string; lastImageUrl: string }).atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        b: { frame: { x: 1, y: 0, w: 1, h: 1 } },
        c: { frame: { x: 2, y: 0, w: 1, h: 1 } },
      },
      meta: { image: 'idle.png', size: { w: 3, h: 1 } },
    };
    (p as unknown as { lastAtlasJsonUrl: string; lastImageUrl: string }).lastAtlasJsonUrl = 'idle.json';
    (p as unknown as { lastImageUrl: string }).lastImageUrl = 'idle.png';
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    for (const n of ['a', 'b', 'c']) {
      map.set(n, { width: 1, height: 1, source: { scaleMode: 'nearest' }, destroy: () => {} });
    }

    const meta: AnimPlaybackMeta = { frames: ['a', 'b', 'c'], fps: 10, loop: true };
    p.setAnimation(meta);
    p.update(200);
    expect(p.currentFrameIndex).toBe(2);

    p.setAnimation(meta);

    expect(p.currentFrameIndex).toBe(2);
    expect(p.getDiagnostics().ignoredDuplicateAnimationRequests).toBe(1);
    expect(p.getDiagnostics().animationResetCount).toBe(1);
    p.dispose();
  });

  it('reports actual ticker started state, not only callback attachment', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);

    const diag = p.getDiagnostics();

    expect(diag.tickerRunning).toBe(true);
    expect(diag.tickerStarted).toBe(true);
    expect(diag.tickerListenerCount).toBe(1);
    p.dispose();
  });

  it('does not report the same animation as playable after its player was disposed', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    (p as unknown as { atlas: unknown; lastAtlasJsonUrl: string; lastImageUrl: string }).atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        b: { frame: { x: 1, y: 0, w: 1, h: 1 } },
      },
      meta: { image: 'idle.png', size: { w: 2, h: 1 } },
    };
    (p as unknown as { lastAtlasJsonUrl: string; lastImageUrl: string }).lastAtlasJsonUrl =
      'idle.json';
    (p as unknown as { lastImageUrl: string }).lastImageUrl = 'idle.png';
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    map.set('a', { width: 1, height: 1, source: {}, destroy: () => {} });
    map.set('b', { width: 1, height: 1, source: {}, destroy: () => {} });
    p.setAnimation({
      frames: ['a', 'b'],
      fps: 10,
      loop: true,
      playbackKey: 'axo:idlePrimary',
    });

    expect(p.isPlaybackReady('axo:idlePrimary', 'idle.json')).toBe(true);
    p.dispose();
    expect(p.isPlaybackReady('axo:idlePrimary', 'idle.json')).toBe(false);
  });

  it('pauses, resumes, and restarts the current visible animation without replacing it', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    (p as unknown as { atlas: unknown }).atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        b: { frame: { x: 1, y: 0, w: 1, h: 1 } },
      },
      meta: { image: 'walk.png', size: { w: 2, h: 1 } },
    };
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    map.set('a', { width: 1, height: 1, source: {}, destroy: () => {} });
    map.set('b', { width: 1, height: 1, source: {}, destroy: () => {} });
    p.setAnimation({ frames: ['a', 'b'], fps: 10, loop: true });

    p.pause();
    p.update(200);
    expect(p.currentFrameIndex).toBe(0);
    expect(p.isAnimationPaused).toBe(true);

    p.resume();
    p.update(100);
    expect(p.currentFrameIndex).toBe(1);

    p.restartAnimation();
    expect(p.currentFrameIndex).toBe(0);
    expect(p.isAnimationPaused).toBe(false);
    p.dispose();
  });

  it('tracks real texture assignment identity instead of falling back to frame name', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    (p as unknown as { atlas: unknown; lastAtlasJsonUrl: string; lastImageUrl: string }).atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        b: { frame: { x: 1, y: 0, w: 1, h: 1 } },
      },
      meta: { image: 'x', size: { w: 2, h: 1 } },
    };
    (p as unknown as { lastAtlasJsonUrl: string; lastImageUrl: string }).lastAtlasJsonUrl = 'x.json';
    (p as unknown as { lastImageUrl: string }).lastImageUrl = 'x.png';
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    const sameTexture = { width: 1, height: 1, source: { scaleMode: 'nearest' }, destroy: () => {} };
    map.set('a', sameTexture);
    map.set('b', sameTexture);

    p.setAnimation({ frames: ['a', 'b'], fps: 10, loop: true });
    const before = p.getDiagnostics();
    p.update(100);
    const after = p.getDiagnostics();

    expect(after.currentFrameName).toBe('b');
    expect(after.currentTextureUid).toBe(before.currentTextureUid);
    expect(after.lastTextureChanged).toBe(false);
    expect(after.textureAssignmentCount).toBe(2);
    p.dispose();
  });

  it('loops when loop=true', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    (p as unknown as { atlas: unknown }).atlas = {
      frames: {
        a: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        b: { frame: { x: 1, y: 0, w: 1, h: 1 } },
      },
      meta: { image: 'x', size: { w: 2, h: 1 } },
    };
    const fakeTex = { width: 1, height: 1, source: { scaleMode: 'nearest' }, destroy: () => {} };
    const map = (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures;
    map.set('a', fakeTex);
    map.set('b', fakeTex);
    (p as unknown as { sprite: { texture: unknown; scale: { set: () => void }; x: number; y: number } }).sprite = {
      texture: null,
      scale: { set: () => {} },
      x: 0,
      y: 0,
    };
    p.setAnimation({ frames: ['a', 'b'], fps: 10, loop: true });
    p.update(100);
    expect(p.currentFrameName).toBe('b');
    p.update(100);
    expect(p.currentFrameName).toBe('a');
    p.dispose();
  });

  it('records nearest-neighbor scale mode after load', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host);
    // Mock fetch for atlas json
    const atlas = {
      frames: { frame_000: { frame: { x: 0, y: 0, w: 128, h: 128 } } },
      meta: { image: 'sheet.png', size: { w: 128, h: 128 } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => atlas,
      })),
    );
    await p.load('atlas.json', 'sheet.png');
    expect(p.textureScaleMode).toBe('nearest');
    p.dispose();
    vi.unstubAllGlobals();
  });

  it('keeps bottom-center anchor positions integer after frame apply', async () => {
    const host = document.createElement('div');
    const p = new PixiAtlasPlayer();
    await p.init(host, { displaySize: 128 });
    const sprite = {
      texture: null as unknown,
      scale: { set: vi.fn() },
      x: 0,
      y: 0,
    };
    (p as unknown as { sprite: typeof sprite }).sprite = sprite;
    (p as unknown as { atlas: unknown }).atlas = {
      frames: { a: { frame: { x: 0, y: 0, w: 128, h: 128 } } },
      meta: { image: 'x', size: { w: 128, h: 128 } },
    };
    (p as unknown as { frameTextures: Map<string, unknown> }).frameTextures.set('a', {
      width: 128,
      height: 128,
      source: { scaleMode: 'nearest' },
      destroy: () => {},
    });
    p.setAnimation({ frames: ['a'], fps: 12, loop: true });
    expect(Number.isInteger(sprite.x)).toBe(true);
    expect(Number.isInteger(sprite.y)).toBe(true);
    expect(sprite.x).toBe(64);
    expect(sprite.y).toBe(128);
    p.dispose();
  });
});
