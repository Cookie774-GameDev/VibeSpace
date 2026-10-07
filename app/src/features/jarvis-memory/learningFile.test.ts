import { describe, expect, it, vi } from 'vitest';

import { loadLearningFile, saveLearningFile, type LearningFileIo } from './learningFile';
import * as fs from '@/lib/fs';
import * as projectFiles from '@/features/files/projectFiles';
import { renderMarkdown } from './learningStore';

function profileMarkdown(accountId = 'account-a'): string {
  return renderMarkdown({
    accountId,
    enabled: false,
    items: [],
    meaningfulMessageCount: 0,
    lastEvaluationCount: 0,
    updatedAt: 1,
  });
}

vi.mock('@/features/files/projectFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/files/projectFiles')>()),
  getJarvisRootDir: vi.fn(),
}));

describe('learning.md persistence', () => {
  it.each(['backup', 'temporary'] as const)(
    'preserves a foreign %s rather than repairing the primary from it',
    async (candidate) => {
      const writeText = vi.fn(async () => undefined);
      await expect(
        loadLearningFile('account-a', {
          resolveRoot: async () => 'C:\\app-data',
          createDirectory: async () => undefined,
          readText: async (path) =>
            path.endsWith(candidate === 'backup' ? '.bak' : '.tmp')
              ? profileMarkdown('foreign')
              : 'corrupt',
          writeText,
        }),
      ).rejects.toThrow(/profile.*rejected/);
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it.each(['backup', 'temporary'] as const)(
    'preserves a malformed %s rather than repairing the primary from it',
    async (candidate) => {
      const writeText = vi.fn(async () => undefined);
      await expect(
        loadLearningFile('account-a', {
          resolveRoot: async () => 'C:\\app-data',
          createDirectory: async () => undefined,
          readText: async (path) =>
            path.endsWith(candidate === 'backup' ? '.bak' : '.tmp')
              ? '# Jarvis Learning\n<!-- jarvis-learning-v1:%7Bbroken -->\n'
              : 'corrupt',
          writeText,
        }),
      ).rejects.toThrow(/profile.*rejected/);
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it('attests absence only after every owned candidate is missing', async () => {
    const readText = vi.fn(async () => null);
    const writeText = vi.fn(async () => undefined);
    const loaded = await loadLearningFile('account-a', {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText,
      writeText,
    });
    expect(loaded).toMatchObject({ missing: true, recovered: false });
    expect(readText).toHaveBeenCalledTimes(3);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does not attest absence from text identical to the empty-file placeholder', async () => {
    const loaded = await loadLearningFile('account-a', {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async () => '# Jarvis Learning\n\nNo saved learning yet.\n',
      writeText: async () => undefined,
    });
    expect(loaded.missing).not.toBe(true);
  });

  it('does not turn native read unavailability into verified absence', async () => {
    vi.mocked(projectFiles.getJarvisRootDir).mockResolvedValue('C:\\app-data');
    vi.spyOn(fs, 'createDirectory').mockImplementation(async (path) => ({
      ok: true,
      path,
    }));
    const read = vi.spyOn(fs, 'readTextFile').mockImplementation(async (path) => ({
      ok: false,
      path,
      error: { code: 'unavailable' },
    }));
    const write = vi.spyOn(fs, 'writeTextFile');
    try {
      await expect(loadLearningFile('account-a')).rejects.toThrow(/unavailable/);
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('writes a backup before the primary account-scoped file', async () => {
    const writes: Array<[string, string]> = [];
    const values = new Map<string, string>();
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) =>
        values.get(path) ?? (path.endsWith('learning.md') ? '# Jarvis Learning\n\nold' : null),
      writeText: async (path, value) => {
        writes.push([path, value]);
        values.set(path, value);
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
    const values = new Map<string, string>();
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => values.get(path) ?? null,
      writeText: async (path, value) => {
        values.set(path, value);
      },
    };
    const [first, second] = await Promise.all([
      saveLearningFile('account-a', '# Jarvis Learning\n\nA', io),
      saveLearningFile('account-b', '# Jarvis Learning\n\nB', io),
    ]);
    expect(first.path).not.toBe(second.path);
  });

  it('recovers a corrupt primary from its valid backup', async () => {
    let primary = 'not a learning file';
    const writeText = vi.fn(async (_path: string, _value: string) => undefined);
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => (path.endsWith('.bak') ? profileMarkdown() : primary),
      writeText: async (path, value) => {
        writeText(path, value);
        if (path.endsWith('learning.md')) primary = value;
      },
    };

    const loaded = await loadLearningFile('account-a', io);

    expect(loaded).toMatchObject({
      recovered: true,
      markdown: profileMarkdown(),
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/learning\.md$/), loaded.markdown);
  });

  it('recovers a valid temporary write when primary and backup are corrupt', async () => {
    let primary = 'corrupt';
    const writeText = vi.fn(async (_path: string, _value: string) => undefined);
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => (path.endsWith('.tmp') ? profileMarkdown() : primary),
      writeText: async (path, value) => {
        writeText(path, value);
        if (path.endsWith('learning.md')) primary = value;
      },
    };
    const loaded = await loadLearningFile('account-a', io);
    expect(loaded).toMatchObject({
      recovered: true,
      recoverySource: 'temporary',
      markdown: profileMarkdown(),
    });
  });

  it('fails closed when persisted candidates exist but all are corrupt', async () => {
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async () => 'corrupt durable memory',
      writeText: async () => undefined,
    };

    await expect(loadLearningFile('account-a', io)).rejects.toThrow(/recovery failed/i);
  });

  it('verifies the primary read-back before reporting a save as durable', async () => {
    let primaryWrites = 0;
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => {
        if (path.endsWith('learning.md') && primaryWrites > 0) return 'truncated';
        return null;
      },
      writeText: async (path) => {
        if (path.endsWith('learning.md')) primaryWrites += 1;
      },
    };

    await expect(
      saveLearningFile('account-a', '# Jarvis Learning\n\nverified', io),
    ).rejects.toThrow(/could not be verified/i);
  });

  it('verifies a recovered primary before reporting recovery success', async () => {
    let repaired = false;
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\app-data',
      createDirectory: async () => undefined,
      readText: async (path) => {
        if (path.endsWith('.bak')) return profileMarkdown();
        if (path.endsWith('learning.md')) return repaired ? 'still corrupt' : 'corrupt';
        return null;
      },
      writeText: async (path) => {
        if (path.endsWith('learning.md')) repaired = true;
      },
    };

    await expect(loadLearningFile('account-a', io)).rejects.toThrow(
      /repair could not be verified/i,
    );
  });
});
