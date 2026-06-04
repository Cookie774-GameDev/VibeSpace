import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readTextFileSample: vi.fn(),
  listDirectory: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  readTextFileSample: fsMocks.readTextFileSample,
  listDirectory: fsMocks.listDirectory,
  writeTextFile: fsMocks.writeTextFile,
}));

vi.mock('@/lib/db', () => ({
  projectRepo: { getById: vi.fn() },
}));

import { getExplicitFilesBlock } from './context';

describe('AI explicit file context safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('samples attached text files instead of reading them in full', async () => {
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path: 'C:\\repo\\large.log',
      content: 'a'.repeat(20_000),
    });

    const block = await getExplicitFilesBlock(['C:\\repo\\large.log']);

    expect(fsMocks.readTextFileSample).toHaveBeenCalledWith('C:\\repo\\large.log', 64 * 1024);
    expect(block).toContain('C:\\repo\\large.log (truncated)');
    expect(block.length).toBeLessThan(18_000);
  });

  it('adds media attachments as metadata without reading binary bytes', async () => {
    const block = await getExplicitFilesBlock([
      'C:\\repo\\assets\\hero.png',
      'C:\\repo\\clips\\demo.mp4',
    ]);

    expect(fsMocks.readTextFileSample).not.toHaveBeenCalled();
    expect(block).toContain('Media file metadata only (image).');
    expect(block).toContain('Media file metadata only (video).');
    expect(block).toContain('Binary bytes were not read into the prompt.');
  });
});
