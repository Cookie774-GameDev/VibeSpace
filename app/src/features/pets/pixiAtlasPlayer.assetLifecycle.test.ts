import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const assetBases = new Map<string, { source: object; destroy: ReturnType<typeof vi.fn> }>();
const loadSpy = vi.fn(async (input: unknown) => {
  const url = String(input);
  const base = { source: {}, destroy: vi.fn() };
  assetBases.set(url, base);
  return base;
});
const unloadSpy = vi.fn(async () => undefined);
const appDestroySpy = vi.fn();

vi.mock('pixi.js', () => {
  class FakeApplication {
    canvas = document.createElement('canvas');
    stage = { addChild: vi.fn() };
    ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), started: true };
    renderer = { background: { alpha: 0 }, resize: vi.fn() };
    async init() {}
    destroy(removeView?: boolean, options?: unknown) {
      appDestroySpy(removeView, options);
    }
  }
  class FakeSprite {
    texture: unknown = null;
    anchor = { set: vi.fn() };
    scale = { set: vi.fn() };
    destroy = vi.fn();
  }
  class FakeTexture {
    source: object;
    width = 128;
    height = 128;
    destroy = vi.fn();
    constructor(options?: { source?: object }) {
      this.source = options?.source ?? {};
    }
  }
  return {
    Application: FakeApplication,
    Assets: { load: loadSpy, unload: unloadSpy },
    Rectangle: class {
      constructor(
        public x: number,
        public y: number,
        public w: number,
        public h: number,
      ) {}
    },
    Sprite: FakeSprite,
    Texture: FakeTexture,
    SCALE_MODES: { NEAREST: 'nearest', LINEAR: 'linear' },
  };
});

describe('PixiAtlasPlayer asset ownership', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          frames: { frame0: { frame: { x: 0, y: 0, w: 16, h: 16 } } },
          meta: { image: 'sheet.png', size: { w: 16, h: 16 } },
        }),
      })),
    );
  });

  afterEach(() => {
    loadSpy.mockClear();
    unloadSpy.mockClear();
    appDestroySpy.mockClear();
    assetBases.clear();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('leaves Assets-managed TextureSources to Assets.unload during replacement and disposal', async () => {
    const { PixiAtlasPlayer } = await import('./pixiAtlasPlayer');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new PixiAtlasPlayer();
    await player.init(host);

    await player.load('/atlas-a.json', '/atlas-a.png');
    await player.load('/atlas-b.json', '/atlas-b.png');
    player.dispose();

    expect(loadSpy).toHaveBeenNthCalledWith(1, '/atlas-a.png');
    expect(loadSpy).toHaveBeenNthCalledWith(2, '/atlas-b.png');
    expect(assetBases.get('/atlas-a.png')?.destroy).not.toHaveBeenCalled();
    expect(assetBases.get('/atlas-b.png')?.destroy).not.toHaveBeenCalled();
    expect(unloadSpy).toHaveBeenCalledWith('/atlas-a.png');
    expect(appDestroySpy).toHaveBeenCalledWith(true, expect.objectContaining({ texture: false }));
  });
});
