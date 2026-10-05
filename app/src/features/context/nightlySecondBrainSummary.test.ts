import { describe, expect, it, vi } from 'vitest';
import {
  secondBrainSummaryMarker,
  secondBrainSummaryPath,
  writeManagedSecondBrainSummary,
  readSecondBrainCoverage,
  commitSecondBrainCoverage,
} from './nightlySecondBrainSummary';

describe('managed nightly summaries', () => {
  it('recovers durable coverage on restart and keeps the old watermark when the next write fails', async () => {
    const files = new Map<string, string>();
    const ports = {
      read: vi.fn(async (path: string) => files.get(path) ?? null),
      mkdir: vi.fn(async () => {}),
      replace: vi.fn(async (path: string, expected: string | null, content: string) => {
        expect(files.get(path) ?? null).toBe(expected);
        files.set(path, content);
      }),
    };
    const input = {
      root: 'C:/project',
      scopeKey: 'account/workspace/project',
      start: 0,
      end: 100,
      assertActive: vi.fn(),
      ports,
    };
    await commitSecondBrainCoverage(input);
    expect(await readSecondBrainCoverage(input.root, input.scopeKey, ports)).toBe(100);
    ports.replace.mockRejectedValueOnce(new Error('disk full'));
    await expect(commitSecondBrainCoverage({ ...input, start: 100, end: 200 })).rejects.toThrow(
      'disk full',
    );
    expect(await readSecondBrainCoverage(input.root, input.scopeKey, ports)).toBe(100);
    await expect(commitSecondBrainCoverage({ ...input, start: 150, end: 200 })).rejects.toThrow(
      'unprocessed gap',
    );
    expect(await readSecondBrainCoverage(input.root, 'different account', ports)).toBe(0);
  });
  async function fixture() {
    const root = 'C:/project';
    const scopeKey = '["account-a","workspace-a","project-a"]';
    const window = { start: 100, end: 200 };
    let content: string | null = null;
    const change = {
      id: 'summary',
      target: 'related_markdown' as const,
      managedSummary: true as const,
      path: await secondBrainSummaryPath(root, scopeKey, window),
      before: '',
      after: `${await secondBrainSummaryMarker(scopeKey, window)}\n\n# Work summary\n\nBuilt the parser.\n`,
      provenance: ['chat:1'],
      confidence: 1,
    };
    const ports = {
      read: vi.fn(async () => content),
      mkdir: vi.fn(async () => {}),
      replace: vi.fn(async (_path: string, expected: string | null, next: string) => {
        expect(content).toBe(expected);
        content = next;
      }),
    };
    return {
      change,
      root,
      scopeKey,
      assertActive: vi.fn(),
      ports,
      setContent: (next: string | null) => {
        content = next;
      },
    };
  }
  it('uses a distinct folder per account and replays the same durable write without duplication', async () => {
    const f = await fixture();
    await writeManagedSecondBrainSummary({ ...f, direction: 'apply' });
    await writeManagedSecondBrainSummary({ ...f, direction: 'apply' });
    expect(f.ports.replace).toHaveBeenCalledTimes(1);
    expect(
      await secondBrainSummaryPath(f.root, 'other-account', { start: 100, end: 200 }),
    ).not.toBe(f.change.path);
  });
  it('preserves edited files, foreign scopes and failed writes', async () => {
    const f = await fixture();
    f.setContent('# User work');
    await expect(writeManagedSecondBrainSummary({ ...f, direction: 'apply' })).rejects.toThrow(
      'refusing to overwrite',
    );
    f.setContent(null);
    await expect(
      writeManagedSecondBrainSummary({ ...f, scopeKey: 'foreign', direction: 'apply' }),
    ).rejects.toThrow('another scope');
    f.ports.replace.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeManagedSecondBrainSummary({ ...f, direction: 'apply' })).rejects.toThrow(
      'disk full',
    );
  });
  it('rejects stale account completion and verifies the bytes before reporting success', async () => {
    const f = await fixture();
    f.ports.replace.mockImplementationOnce(async () => {});
    await expect(writeManagedSecondBrainSummary({ ...f, direction: 'apply' })).rejects.toThrow(
      'could not be verified',
    );
    f.assertActive.mockImplementation(() => {
      throw new Error('account changed');
    });
    await expect(writeManagedSecondBrainSummary({ ...f, direction: 'apply' })).rejects.toThrow(
      'account changed',
    );
  });
});
