import { vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readTextFileSample: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  listDirectory: fsMocks.listDirectory,
  readTextFileSample: fsMocks.readTextFileSample,
  writeTextFile: fsMocks.writeTextFile,
}));

import { generateProjectContextTree, MAX_CONTEXT_FILE_BYTES } from './tree';

describe('generateProjectContextTree file safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fsMocks.writeTextFile.mockResolvedValue({ ok: true, path: 'C:\\proj\\context_map.json' });
  });

  it('maps media metadata without reading binary bytes and samples large text files', async () => {
    fsMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\proj',
      entries: [
        {
          name: 'clip.mp4',
          path: 'C:\\proj\\assets\\clip.mp4',
          isDir: false,
          size: 90 * 1024 * 1024,
          modifiedMs: 1_700_000_000_000,
        },
        {
          name: 'large.ts',
          path: 'C:\\proj\\src\\large.ts',
          isDir: false,
          size: 8 * 1024 * 1024,
          modifiedMs: 1_700_000_000_001,
        },
      ],
    });
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path: 'C:\\proj\\src\\large.ts',
      content: 'export const value = 1;\n',
    });

    const tree = await generateProjectContextTree({
      projectId: null,
      rootDir: 'C:\\proj',
      provider: 'local',
    });

    expect(tree.fileCount).toBe(2);
    expect(JSON.stringify(tree.nodes)).toContain('clip.mp4');
    expect(JSON.stringify(tree.nodes)).toContain('large.ts');
    expect(fsMocks.readTextFileSample).toHaveBeenCalledTimes(1);
    expect(fsMocks.readTextFileSample).toHaveBeenCalledWith('C:\\proj\\src\\large.ts', 64 * 1024);
  });

  it('accepts image and video metadata up to 100 MB and rejects larger files', async () => {
    fsMocks.listDirectory.mockResolvedValue({
      ok: true,
      path: 'C:\\proj',
      entries: [
        {
          name: 'hero.heic',
          path: 'C:\\proj\\media\\hero.heic',
          isDir: false,
          size: MAX_CONTEXT_FILE_BYTES,
          modifiedMs: 1_700_000_000_000,
        },
        {
          name: 'walkthrough.mkv',
          path: 'C:\\proj\\media\\walkthrough.mkv',
          isDir: false,
          size: MAX_CONTEXT_FILE_BYTES,
          modifiedMs: 1_700_000_000_001,
        },
        {
          name: 'too-big.mp4',
          path: 'C:\\proj\\media\\too-big.mp4',
          isDir: false,
          size: MAX_CONTEXT_FILE_BYTES + 1,
          modifiedMs: 1_700_000_000_002,
        },
      ],
    });

    const tree = await generateProjectContextTree({
      projectId: null,
      rootDir: 'C:\\proj',
      provider: 'local',
    });
    const serialized = JSON.stringify(tree.nodes);

    expect(tree.fileCount).toBe(2);
    expect(tree.totalBytes).toBe(MAX_CONTEXT_FILE_BYTES * 2);
    expect(serialized).toContain('hero.heic');
    expect(serialized).toContain('walkthrough.mkv');
    expect(serialized).not.toContain('too-big.mp4');
    expect(serialized).toContain('image media');
    expect(serialized).toContain('video media');
    expect(fsMocks.readTextFileSample).not.toHaveBeenCalled();
  });
});
