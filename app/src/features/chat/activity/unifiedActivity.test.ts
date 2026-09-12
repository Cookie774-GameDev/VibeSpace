import { describe, expect, it } from 'vitest';
import { mergeChatActivityEvents } from './unifiedActivity';
import type { ChatActivityEvent } from './types';

function event(id: string, ts: number, title = id): ChatActivityEvent {
  return { id, ts, title, chatId: 'chat-1', kind: 'agent', status: 'running' };
}

describe('mergeChatActivityEvents', () => {
  it('merges canonical and live events chronologically', () => {
    expect(
      mergeChatActivityEvents([event('canonical', 20)], [event('live', 10)]).map(({ id }) => id),
    ).toEqual(['live', 'canonical']);
  });

  it('deduplicates by id and keeps the newest event state', () => {
    const merged = mergeChatActivityEvents(
      [{ ...event('same', 10), status: 'pending' }],
      [{ ...event('same', 20), status: 'done' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'same', ts: 20, status: 'done' });
  });
});
