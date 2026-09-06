import { describe, expect, it, vi } from 'vitest';
import { loadChatDebugLog, type ChatDebugLogSource } from './chatDebugLogData';

function source(): ChatDebugLogSource {
  return {
    accountId: 'account',
    chatId: 'chat',
    listMessages: vi.fn(async () => []),
    activity: [],
    isCurrent: () => true,
  };
}

describe('HTML debug log collection', () => {
  it('pages beyond 500 events and retains collected evidence when artifacts fail', async () => {
    const input = source();
    const getEventsForRun = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({ runId: 'run', seq: index + 1 })),
      )
      .mockResolvedValueOnce([{ runId: 'run', seq: 502 }]);
    input.dataPort = {
      getRunsForChat: vi.fn(async () => [
        { id: 'run', accountId: 'account', chatId: 'chat', model: {} },
      ]),
      getEventsForRun,
      getArtifactsForRun: vi.fn(async () => {
        throw new Error('private backend failure');
      }),
    } as unknown as NonNullable<ChatDebugLogSource['dataPort']>;
    const log = await loadChatDebugLog(input);
    expect(log.runs[0].events).toHaveLength(501);
    expect(getEventsForRun).toHaveBeenLastCalledWith({
      accountId: 'account',
      runId: 'run',
      afterSeq: 500,
      limit: 500,
    });
    expect(log.coverage.join(' ')).toContain('sequence gaps');
    expect(log.coverage.join(' ')).toContain('partial');
    expect(JSON.stringify(log)).not.toContain('private backend failure');
  });
  it('reads the full saved transcript even when the UI is paged, and labels missing journal access', async () => {
    const input = source();
    const result = await loadChatDebugLog(input);
    expect(input.listMessages).toHaveBeenCalledOnce();
    expect(result.coverage.join(' ')).toContain('unavailable');
  });
  it('rejects a changed account before publishing any content', async () => {
    const input = source();
    let current = true;
    input.isCurrent = () => current;
    input.listMessages = async () => {
      current = false;
      return [];
    };
    await expect(loadChatDebugLog(input)).rejects.toThrow('changed');
  });
  it('filters foreign runs and events and uses an explicit forward journal cursor', async () => {
    const input = source();
    const getEventsForRun = vi.fn(async () => [
      { runId: 'run', seq: 1, createdAt: 1 },
      { runId: 'foreign', seq: 2, createdAt: 2 },
    ]);
    input.dataPort = {
      getRunsForChat: vi.fn(async () => [
        { id: 'run', accountId: 'account', chatId: 'chat', model: { modelId: 'exact' } },
        { id: 'foreign', accountId: 'other', chatId: 'chat' },
      ]),
      getEventsForRun,
      getArtifactsForRun: vi.fn(async () => []),
    } as unknown as NonNullable<ChatDebugLogSource['dataPort']>;
    const log = await loadChatDebugLog(input);
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].events).toHaveLength(1);
    expect(getEventsForRun).toHaveBeenCalledWith({
      accountId: 'account',
      runId: 'run',
      afterSeq: 0,
      limit: 500,
    });
  });
});
