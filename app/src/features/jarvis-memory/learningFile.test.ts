import { describe, expect, it, vi } from 'vitest';

import { loadLearningFile, saveLearningFile, type LearningFileIo } from './learningFile';

describe('learning.md persistence', () => {
  it('writes a backup before the primary account-scoped file', async () => {
    const writes: Array<[string, string]> = [];
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => (path.endsWith('learning.md') ? '# Jarvis Learning\n\nold' : null),
      writeText: async (path, value) => {
        writes.push([path, value]);
      },
    };

    const saved = await saveLearningFile('account-a', '# Jarvis Learning\n\nnew', io);

    expect(saved.path).toMatch(/^C:\\app-data\\Jarvis Memory\\account-[a-f0-9]{64}\\learning\.md$/);
    expect(saved.path).not.toContain('account-a');
    expect(saved.path).toMatch(/account-[a-f0-9]{64}[\\/]learning\.md$/);
    expect(writes.map(([path]) => path.split(/[\\/]/).pop())).toEqual([
      'learning.md.bak',
      'learning.md.tmp',
      'learning.md',
    ]);
  });

  it('uses distinct cryptographic account directories', async () => {
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async () => null,
      writeText: async () => undefined,
    };
    const [first, second] = await Promise.all([
      saveLearningFile('account-a', '# Jarvis Learning\n\nA', io),
      saveLearningFile('account-b', '# Jarvis Learning\n\nB', io),
    ]);
    expect(first.path).not.toBe(second.path);
  });

  it('recovers a corrupt primary from its valid backup', async () => {
    const writeText = vi.fn(async () => undefined);
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) =>
        path.endsWith('.bak') ? '# Jarvis Learning\n\n- valid backup' : 'not a learning file',
      writeText,
    };

    const loaded = await loadLearningFile('account-a', io);

    expect(loaded).toMatchObject({
      recovered: true,
      markdown: '# Jarvis Learning\n\n- valid backup',
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/learning\.md$/), loaded.markdown);
  });

  it('recovers a valid temporary write when primary and backup are corrupt', async () => {
    const writeText = vi.fn(async () => undefined);
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) =>
        path.endsWith('.tmp') ? '# Jarvis Learning\n\n- recovered' : 'corrupt',
      writeText,
    };
    const loaded = await loadLearningFile('account-a', io);
    expect(loaded).toMatchObject({ recovered: true, markdown: '# Jarvis Learning\n\n- recovered' });
  });
});
