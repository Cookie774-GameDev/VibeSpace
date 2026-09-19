import { describe, expect, it } from 'vitest';
import { readTurnCheckpoint, writeTurnCheckpoint, type TurnCheckpointStorage } from './turnCheckpointStore';
import { reduceTurn } from './turnReducer';

function memoryStorage(): TurnCheckpointStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('turn checkpoint store', () => {
  it('round-trips bounded public recovery state without adding authority', () => {
    const storage = memoryStorage();
    let state = reduceTurn(undefined, {
      type: 'turn.accepted',
      at: 1,
      identity: {
        accountId: 'account',
        workspaceId: 'workspace',
        chatId: 'chat',
        runId: 'run',
        requestId: 'request',
        attempt: 1,
      },
    });
    state = reduceTurn(state, {
      type: 'public.snapshot',
      at: 2,
      snapshot: {
        text: 'Safe public text',
        segments: [{ kind: 'text', id: 'text', text: 'Safe public text' }],
        updatedAt: 2,
      },
    });

    writeTurnCheckpoint(state, storage);
    const restored = readTurnCheckpoint('account', 'chat', storage);
    expect(restored).toMatchObject({
      status: 'running',
      identity: { runId: 'run', requestId: 'request' },
      public: { text: 'Safe public text' },
    });
    expect(Object.isFrozen(restored?.public.segments)).toBe(true);
  });

  it('rejects a checkpoint from another account/chat', () => {
    const storage = memoryStorage();
    expect(readTurnCheckpoint('other', 'chat', storage)).toBeNull();
  });
});
