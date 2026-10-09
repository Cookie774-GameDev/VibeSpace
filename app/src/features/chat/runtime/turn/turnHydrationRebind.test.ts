import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPreview } from '../../streamingPreviewStore';
import { clearTurnCheckpoint, readTurnCheckpoint } from './turnCheckpointStore';
import { acceptTurn, getLatestTurn, getTurn, hydrateLatestTurn, resetTurnStoreForTests } from './turnStore';

const identity = {
  accountId: 'hydrate-account', chatId: 'chat-a', runId: 'moving-run', requestId: 'request-a', attempt: 1,
};

describe('checkpoint recovery after supported preview rebinding', () => {
  beforeEach(() => {
    resetTurnStoreForTests();
    clearTurnCheckpoint(identity.accountId, 'chat-a');
    clearTurnCheckpoint(identity.accountId, 'chat-b');
  });
  afterEach(async () => {
    await Promise.resolve();
    resetTurnStoreForTests();
    clearTurnCheckpoint(identity.accountId, 'chat-a');
    clearTurnCheckpoint(identity.accountId, 'chat-b');
  });

  it('does not replace the live rebound chat with another chat’s valid saved checkpoint', async () => {
    setPreview({ ...identity, text: 'Original chat answer', updatedAt: 1 });
    await Promise.resolve();
    expect(readTurnCheckpoint(identity.accountId, 'chat-a')?.public.text).toBe('Original chat answer');

    setPreview({ ...identity, chatId: 'chat-b', text: 'Live moved answer', updatedAt: 2 });
    await Promise.resolve();
    const live = getLatestTurn(identity.accountId, 'chat-b');
    expect(live).toMatchObject({ identity: { chatId: 'chat-b' }, status: 'running' });

    const restored = hydrateLatestTurn(identity.accountId, 'chat-a');

    expect.soft(restored).toBeNull();
    expect.soft(getTurn(identity.accountId, identity.runId)).toBe(live);
    expect(getLatestTurn(identity.accountId, 'chat-b')).toMatchObject({
      identity: { chatId: 'chat-b' }, status: 'running', public: { text: 'Live moved answer' },
    });
  });

  it('restores an ordinary valid checkpoint after renderer restart', async () => {
    setPreview({ ...identity, text: 'Saved answer', updatedAt: 1 });
    await Promise.resolve();
    resetTurnStoreForTests();
    expect(hydrateLatestTurn(identity.accountId, 'chat-a')).toMatchObject({
      identity, status: 'interrupted', public: { text: 'Saved answer' },
    });
  });

  it('preserves ordinary idempotent acceptance and the existing selected turn on hydrate', () => {
    const accepted = acceptTurn(identity, 1, 'cancel-a');
    expect(acceptTurn({ ...identity }, 2, 'cancel-a')).toBe(accepted);
    expect(hydrateLatestTurn(identity.accountId, 'chat-a')).toBe(accepted);
  });
});
