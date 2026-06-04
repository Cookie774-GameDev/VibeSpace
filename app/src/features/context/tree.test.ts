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

import { generateProjectContextTree } from './tree';

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
});
