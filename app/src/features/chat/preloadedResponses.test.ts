import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  messageRepo: { create: vi.fn(async () => undefined) },
}));

import { messageRepo } from '@/lib/db';
import {
  PRELOADED_RESPONSES,
  nextPreloadedResponse,
  seedPreloadedChatResponse,
} from './preloadedResponses';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const store = { ...initial };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

beforeEach(() => {
  vi.mocked(messageRepo.create).mockClear();
  window.localStorage.clear();
});

describe('PRELOADED_RESPONSES', () => {
  it('holds exactly one hundred unique very short responses', () => {
    expect(PRELOADED_RESPONSES).toHaveLength(100);
    expect(new Set(PRELOADED_RESPONSES).size).toBe(100);
    for (const line of PRELOADED_RESPONSES) {
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(48);
    }
  });
});

describe('nextPreloadedResponse', () => {
  it('cycles through every response in order and wraps back to the first', () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    for (let i = 0; i < PRELOADED_RESPONSES.length + 3; i += 1) {
      seen.push(nextPreloadedResponse(storage));
    }
    expect(seen.slice(0, PRELOADED_RESPONSES.length)).toEqual([...PRELOADED_RESPONSES]);
    expect(seen[PRELOADED_RESPONSES.length]).toBe(PRELOADED_RESPONSES[0]);
    expect(seen[PRELOADED_RESPONSES.length + 1]).toBe(PRELOADED_RESPONSES[1]);
  });

  it('resumes the cycle across separate storage reads', () => {
    const storage = memoryStorage();
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[0]);
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[1]);
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[2]);
  });

  it('ignores corrupt cursor state instead of throwing', () => {
    const storage = memoryStorage({ 'vibespace:preloaded-response:v1': '{not json' });
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[0]);
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[1]);
  });

  it('treats a negative or fractional cursor as zero', () => {
    const storage = memoryStorage({
      'vibespace:preloaded-response:v1': JSON.stringify({ cursor: -5 }),
    });
    expect(nextPreloadedResponse(storage)).toBe(PRELOADED_RESPONSES[0]);
    const fractional = memoryStorage({
      'vibespace:preloaded-response:v1': JSON.stringify({ cursor: 2.9 }),
    });
    expect(nextPreloadedResponse(fractional)).toBe(PRELOADED_RESPONSES[2]);
  });
});

describe('seedPreloadedChatResponse', () => {
  it('creates one assistant text message with the next response in the cycle', async () => {
    await seedPreloadedChatResponse({ id: 'chat-seed-1' as never });
    expect(messageRepo.create).toHaveBeenCalledTimes(1);
    expect(messageRepo.create).toHaveBeenCalledWith({
      chat_id: 'chat-seed-1',
      role: 'assistant',
      parts: [{ kind: 'text', text: PRELOADED_RESPONSES[0] }],
    });
    await seedPreloadedChatResponse({ id: 'chat-seed-2' as never });
    expect(messageRepo.create).toHaveBeenLastCalledWith({
      chat_id: 'chat-seed-2',
      role: 'assistant',
      parts: [{ kind: 'text', text: PRELOADED_RESPONSES[1] }],
    });
  });

  it('swallows persistence failures so chat creation never breaks', async () => {
    vi.mocked(messageRepo.create).mockRejectedValueOnce(new Error('indexeddb gone'));
    await expect(seedPreloadedChatResponse({ id: 'chat-seed-3' as never })).resolves.toBeUndefined();
  });
});
