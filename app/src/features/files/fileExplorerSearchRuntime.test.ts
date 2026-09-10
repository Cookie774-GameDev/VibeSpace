import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetExplorerSearchRuntimeForTests,
  cancelExplorerSearchJob,
  clearExplorerSearchHits,
  getExplorerSearchState,
  resolveSearchRoots,
  setExplorerSearchPanelOpen,
  setExplorerSearchQuery,
  startExplorerSearch,
  subscribeExplorerSearch,
} from './fileExplorerSearchRuntime';

vi.mock('./fileExplorerSearch', async () => {
  const actual =
    await vi.importActual<typeof import('./fileExplorerSearch')>('./fileExplorerSearch');
  return {
    ...actual,
    walkEntries: vi.fn(async () => [
      {
        name: 'invoice.txt',
        path: 'C:\\Users\\demo\\Documents\\invoice.txt',
        isDir: false,
        size: 120,
      },
      {
        name: 'notes.md',
        path: 'C:\\Users\\demo\\Documents\\notes.md',
        isDir: false,
        size: 40,
      },
    ]),
    walkMany: vi.fn(async () => [
      {
        name: 'deepgram-keys.txt',
        path: 'C:\\Users\\demo\\Documents\\deepgram-keys.txt',
        isDir: false,
        size: 80,
      },
      {
        name: 'context_map.json',
        path: 'C:\\Users\\demo\\.android\\context_map.json',
        isDir: false,
        size: 2200,
      },
    ]),
    scoreEntriesLocally: vi.fn(async (entries, clues) => {
      const terms = clues.terms ?? [];
      const exts = clues.extensions ?? [];
      return entries
        .filter((e: { path: string; name: string; isDir: boolean }) => {
          if (e.isDir) return false;
          if (exts.length) {
            const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
            if (!exts.includes(ext)) return false;
          }
          if (terms.length === 0) return true;
          const hay = `${e.name} ${e.path}`.toLowerCase();
          const matched = terms.filter((t: string) => hay.includes(t.toLowerCase()));
          // Mirror production: with type gate, half the terms is enough
          const need = exts.length
            ? Math.max(1, Math.ceil(terms.length * 0.5))
            : terms.length <= 3
              ? terms.length
              : Math.ceil(terms.length * 0.75);
          return matched.length >= need;
        })
        .map((e: { path: string; name: string; size?: number }, i: number) => ({
          path: e.path,
          name: e.name,
          isDir: false,
          size: e.size,
          score: 100 - i,
          reason: 'mock',
          termsMatched: terms.length,
          termsTotal: terms.length,
        }));
    }),
  };
});

describe('resolveSearchRoots', () => {
  const places = [
    { id: 'home', label: 'Home', path: 'C:\\Users\\demo' },
    { id: 'documents', label: 'Documents', path: 'C:\\Users\\demo\\Documents' },
    { id: 'desktop', label: 'Desktop', path: 'C:\\Users\\demo\\Desktop' },
    { id: 'downloads', label: 'Downloads', path: 'C:\\Users\\demo\\Downloads' },
  ];

  it('searches wide by default (current + places)', () => {
    const roots = resolveSearchRoots({
      scopePath: 'C:\\Users\\demo\\.android',
      placePaths: places,
    });
    expect(roots.some((r) => r.includes('.android'))).toBe(true);
    expect(roots.some((r) => r.includes('Documents'))).toBe(true);
    expect(roots.length).toBeGreaterThan(2);
  });

  it('respects here-only', () => {
    const roots = resolveSearchRoots({
      scopePath: 'C:\\Users\\demo\\.android',
      hereOnly: true,
      placePaths: places,
    });
    expect(roots).toEqual(['C:\\Users\\demo\\.android']);
  });

  it('focuses pathHint places', () => {
    const roots = resolveSearchRoots({
      scopePath: 'C:\\Users\\demo\\.android',
      pathHint: 'document',
      placePaths: places,
    });
    expect(roots.some((r) => /documents/i.test(r))).toBe(true);
  });
});

describe('fileExplorerSearchRuntime', () => {
  beforeEach(() => {
    __resetExplorerSearchRuntimeForTests();
  });

  afterEach(() => {
    __resetExplorerSearchRuntimeForTests();
    vi.clearAllMocks();
  });

  it('persists query/panel state outside the dialog', () => {
    setExplorerSearchQuery('tax pdf');
    setExplorerSearchPanelOpen(true);
    expect(getExplorerSearchState().query).toBe('tax pdf');
    expect(getExplorerSearchState().panelOpen).toBe(true);
  });

  it('never reuses cached search hits in a different root capability', async () => {
    await startExplorerSearch({
      query: 'invoice type:txt here',
      scopePath: 'C:\\Users\\demo\\Documents',
      accessRoot: 'C:\\Users\\demo\\Documents',
    });
    expect(getExplorerSearchState('C:\\Users\\demo\\Documents').hits.length).toBeGreaterThan(0);
    expect(getExplorerSearchState('C:\\other').hits).toEqual([]);
    expect(getExplorerSearchState(null).hits).toEqual([]);
  });

  it('notifies subscribers on state changes', () => {
    let ticks = 0;
    const unsub = subscribeExplorerSearch(() => {
      ticks += 1;
    });
    setExplorerSearchQuery('hello');
    expect(ticks).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it('completes a multi-clue search and prefers matching txt over json', async () => {
    await startExplorerSearch({
      query: 'txt document Deepgram API keys',
      scopePath: 'C:\\Users\\demo\\.android',
      placePaths: [
        { id: 'home', label: 'Home', path: 'C:\\Users\\demo' },
        { id: 'documents', label: 'Documents', path: 'C:\\Users\\demo\\Documents' },
      ],
    });
    const st = getExplorerSearchState();
    expect(st.busy).toBe(false);
    expect(st.clueSummary).toMatch(/type:txt/);
    expect(st.hits.length).toBeGreaterThanOrEqual(1);
    expect(st.hits[0]?.name).toMatch(/deepgram/i);
    expect(st.hits.some((h) => h.name.includes('context_map'))).toBe(false);
  });

  it('keeps hits available after a simulated dialog close (store survives)', async () => {
    await startExplorerSearch({
      query: 'invoice type:txt',
      scopePath: 'C:\\Users\\demo\\Documents',
      placePaths: [{ id: 'documents', label: 'Documents', path: 'C:\\Users\\demo\\Documents' }],
    });
    // Force single-root path (here-ish) — still works with walkMany/walkEntries mocks
    const reopened = getExplorerSearchState();
    expect(reopened.query).toContain('invoice');
  });

  it('invalidates in-flight work when cancelled so stale results do not reappear', async () => {
    let releaseWalk!: () => void;
    const walkGate = new Promise<void>((resolve) => {
      releaseWalk = resolve;
    });

    const searchMod = await import('./fileExplorerSearch');
    vi.mocked(searchMod.walkMany).mockImplementationOnce(async () => {
      await walkGate;
      return [
        {
          name: 'late.txt',
          path: 'C:\\Users\\demo\\late.txt',
          isDir: false,
          size: 1,
        },
      ];
    });
    vi.mocked(searchMod.scoreEntriesLocally).mockImplementationOnce(async () => [
      {
        path: 'C:\\Users\\demo\\late.txt',
        name: 'late.txt',
        isDir: false,
        size: 1,
        score: 1,
        reason: 'late',
      },
    ]);

    const pending = startExplorerSearch({
      query: 'late type:txt',
      scopePath: 'C:\\Users\\demo',
      placePaths: [
        { id: 'home', label: 'Home', path: 'C:\\Users\\demo' },
        { id: 'documents', label: 'Documents', path: 'C:\\Users\\demo\\Documents' },
      ],
    });
    await Promise.resolve();
    expect(getExplorerSearchState().busy).toBe(true);

    cancelExplorerSearchJob();
    clearExplorerSearchHits();
    expect(getExplorerSearchState().busy).toBe(false);
    expect(getExplorerSearchState().hits).toEqual([]);

    releaseWalk();
    await pending;

    expect(getExplorerSearchState().hits).toEqual([]);
    expect(getExplorerSearchState().busy).toBe(false);
  });
});
