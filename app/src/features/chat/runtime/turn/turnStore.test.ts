import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTurnCheckpoint, readTurnCheckpoint, writeTurnCheckpoint } from './turnCheckpointStore';
import {
  acceptTurn,
  clearAccountTurns,
  clearTurn,
  clearTurnPublic,
  getCompatibilityRunState,
  getLatestTurn,
  getLatestTurnByChatId,
  getTurn,
  hydrateLatestTurn,
  publishCompatibilityRunState,
  publishTurnEvent,
  publishTurnPublicSnapshot,
  resetTurnStoreForTests,
  subscribeTurnChat,
  subscribeTurnChatPriority,
} from './turnStore';

const identity = {
  accountId: 'account',
  workspaceId: 'workspace',
  chatId: 'chat',
  runId: 'run',
  requestId: 'request',
  attempt: 1,
};

describe('canonical turn store', () => {
  beforeEach(() => resetTurnStoreForTests());

  it('absorbs legacy running state before canonical identity is allocated', () => {
    publishCompatibilityRunState({
      chatId: 'chat',
      status: 'running',
      cancellationKey: 'message-1',
      at: 1,
    });
    acceptTurn(identity, 2);
    expect(getCompatibilityRunState('chat')).toMatchObject({
      status: 'running',
      cancellationKey: 'message-1',
    });
  });

  it('absorbs a terminal compatibility state before canonical identity is allocated', () => {
    publishCompatibilityRunState({
      chatId: 'chat',
      status: 'error',
      errorCode: 'provider_busy',
      at: 1,
    });
    acceptTurn(identity, 2);
    expect(getLatestTurn('account', 'chat')).toMatchObject({
      status: 'failed',
      errorCode: 'provider_busy',
    });
    expect(getCompatibilityRunState('chat')).toMatchObject({
      status: 'error',
      errorCode: 'provider_busy',
    });
  });

  it('restores a nonterminal checkpoint as interrupted instead of resurrecting a spinner', () => {
    acceptTurn(identity, 1);
    publishTurnEvent({ accountId: 'account', runId: 'run' }, { type: 'turn.running', at: 2 });
    const running = getLatestTurn('account', 'chat');
    expect(running?.status).toBe('running');
    writeTurnCheckpoint(running!);
    resetTurnStoreForTests();

    try {
      const restored = hydrateLatestTurn('account', 'chat');
      expect(restored).toMatchObject({
        status: 'interrupted',
        errorCode: 'restored_without_live_owner',
      });
      expect(getCompatibilityRunState('chat')?.status).toBe('error');
    } finally {
      clearTurnCheckpoint('account', 'chat');
    }
  });

  it('retains terminal status after the public preview is cleared', () => {
    acceptTurn(identity, 1);
    publishTurnPublicSnapshot({
      identity,
      snapshot: { text: 'Answer', segments: [], updatedAt: 2 },
    });
    publishCompatibilityRunState({
      chatId: 'chat',
      status: 'error',
      errorCode: 'provider_busy',
      at: 3,
    });
    clearTurnPublic('account', 'run', 4);

    expect(getLatestTurn('account', 'chat')).toMatchObject({
      status: 'failed',
      public: { text: '' },
      errorCode: 'provider_busy',
    });
    expect(getCompatibilityRunState('chat')?.status).toBe('error');
  });

  it('keeps the current running turn selected when an older completed turn is cleaned up', () => {
    const currentIdentity = { ...identity, runId: 'current-run', requestId: 'current-request' };
    acceptTurn(identity, 1, 'old-message');
    publishTurnPublicSnapshot({ identity, snapshot: { text: 'Old answer', segments: [], updatedAt: 2 } });
    publishTurnEvent(identity, { type: 'turn.completed', at: 3 });
    acceptTurn(currentIdentity, 4, 'current-message');
    publishTurnPublicSnapshot({
      identity: currentIdentity,
      snapshot: { text: 'Current answer', segments: [], updatedAt: 5 },
    });

    clearTurnPublic('account', 'run', 6);

    expect(getTurn('account', 'run')).toMatchObject({ status: 'completed', public: { text: '' } });
    expect.soft(getLatestTurn('account', 'chat')?.identity.runId).toBe('current-run');
    expect.soft(getLatestTurnByChatId('chat')?.identity.runId).toBe('current-run');
    expect(getCompatibilityRunState('chat')).toMatchObject({
      status: 'running', cancellationKey: 'current-message',
    });
  });

  it('preserves the current recovery checkpoint after late cleanup of an older turn', async () => {
    const oldIdentity = { ...identity, chatId: 'checkpoint-cleanup-chat' };
    const currentIdentity = { ...oldIdentity, runId: 'current-run', requestId: 'current-request' };
    try {
      acceptTurn(oldIdentity, 1);
      publishTurnPublicSnapshot({
        identity: oldIdentity, snapshot: { text: 'Old answer', segments: [], updatedAt: 2 },
      });
      publishTurnEvent(oldIdentity, { type: 'turn.completed', at: 3 });
      acceptTurn(currentIdentity, 4);
      publishTurnPublicSnapshot({
        identity: currentIdentity,
        snapshot: { text: 'Current answer', segments: [], updatedAt: 5 },
      });
      await Promise.resolve();
      expect(readTurnCheckpoint('account', oldIdentity.chatId)?.identity.runId).toBe('current-run');

      clearTurnPublic('account', 'run', 6);
      await Promise.resolve();

      expect(readTurnCheckpoint('account', oldIdentity.chatId)).toMatchObject({
        identity: { runId: 'current-run' }, status: 'running', public: { text: 'Current answer' },
      });
    } finally {
      clearTurnCheckpoint('account', oldIdentity.chatId);
    }
  });

  it.each(['turn.cancelled', 'turn.failed'] as const)(
    'keeps retry identity and cancellation ownership after %s cleanup',
    (type) => {
      acceptTurn(identity, 10, 'old-message');
      publishTurnPublicSnapshot({ identity, snapshot: { text: 'Old answer', segments: [], updatedAt: 11 } });
      publishTurnEvent(identity, { type, at: 12 });
      const retry = { ...identity, runId: 'retry', requestId: 'retry-request', attempt: 2 };
      acceptTurn(retry, 10, 'retry-message');
      publishTurnEvent(retry, { type: 'turn.running', at: 13 });
      clearTurnPublic('account', 'run', 14);
      const cleared = getTurn('account', 'run');
      clearTurnPublic('account', 'run', 15);
      expect(getTurn('account', 'run')).toBe(cleared);
      expect(cleared?.public.text).toBe('');
      expect(getCompatibilityRunState('chat')).toMatchObject({ status: 'running', cancellationKey: 'retry-message' });
      publishTurnEvent(retry, { type: 'turn.cancelled', at: 16 });
      expect(getCompatibilityRunState('chat')?.status).toBe('cancelled');
    },
  );

  it('does not let a superseded delayed checkpoint overwrite the current turn on restart', async () => {
    vi.useFakeTimers();
    const oldIdentity = { ...identity, chatId: 'delayed-chat' };
    const currentIdentity = { ...oldIdentity, runId: 'current-run', requestId: 'current-request' };
    try {
      acceptTurn(oldIdentity, 1);
      publishTurnEvent(oldIdentity, { type: 'turn.running', at: 2 });
      publishTurnPublicSnapshot({ identity: oldIdentity, snapshot: { text: 'Old answer', segments: [], updatedAt: 3 } });
      acceptTurn(currentIdentity, 4);
      publishTurnPublicSnapshot({ identity: currentIdentity, snapshot: { text: 'Current answer', segments: [], updatedAt: 5 } });
      await vi.advanceTimersByTimeAsync(250);
      resetTurnStoreForTests();
      expect(hydrateLatestTurn('account', oldIdentity.chatId)).toMatchObject({
        identity: { runId: 'current-run' }, status: 'interrupted', public: { text: 'Current answer' },
      });
    } finally {
      resetTurnStoreForTests();
      clearTurnCheckpoint('account', oldIdentity.chatId);
      vi.useRealTimers();
    }
  });

  it.each(['chat', 'account'] as const)('discards queued writes after %s removal', async (scope) => {
    const removed = { ...identity, chatId: 'removed-chat' };
    try {
      clearTurnCheckpoint('account', removed.chatId);
      acceptTurn(removed, 1);
      if (scope === 'chat') clearTurn('account', 'run');
      else clearAccountTurns('account');
      acceptTurn({ ...removed, chatId: 'replacement-chat', requestId: 'replacement' }, 2);
      await Promise.resolve();
      expect(readTurnCheckpoint('account', removed.chatId)).toBeNull();
      expect(readTurnCheckpoint('account', 'replacement-chat')?.identity.requestId).toBe('replacement');
    } finally {
      clearTurnCheckpoint('account', removed.chatId);
      clearTurnCheckpoint('account', 'replacement-chat');
    }
  });

  it('keeps latest selection scoped while older callbacks arrive after an account or chat change', () => {
    acceptTurn(identity, 1);
    acceptTurn({ ...identity, accountId: 'other-account' }, 2);
    acceptTurn({ ...identity, runId: 'other-chat-run', chatId: 'other-chat' }, 3);
    publishTurnEvent(identity, { type: 'turn.running', at: 4 });
    expect(getLatestTurn('account', 'chat')?.identity.accountId).toBe('account');
    expect(getLatestTurnByChatId('chat')?.identity.accountId).toBe('other-account');
    expect(getLatestTurn('account', 'other-chat')?.identity.runId).toBe('other-chat-run');
    clearTurn('account', 'run');
    expect(getLatestTurnByChatId('chat')?.identity.accountId).toBe('other-account');
  });

  it('reindexes retained turns by admission order instead of late event timestamps', () => {
    acceptTurn(identity, 1);
    acceptTurn({ ...identity, runId: 'second', requestId: 'second' }, 1);
    acceptTurn({ ...identity, runId: 'third', requestId: 'third' }, 1);
    publishTurnEvent(identity, { type: 'turn.completed', at: 100 });
    clearTurn('account', 'third');
    expect(getLatestTurn('account', 'chat')?.identity.runId).toBe('second');
  });

  it('restores the remaining account selection when the selected account is cleared', () => {
    acceptTurn(identity, 1);
    acceptTurn({ ...identity, accountId: 'other-account' }, 2);
    clearAccountTurns('other-account');
    expect(getLatestTurnByChatId('chat')?.identity.accountId).toBe('account');
  });

  it('notifies priority visibility subscribers from committed state before ordinary subscribers', () => {
    const order: string[] = [];
    const stopPriority = subscribeTurnChatPriority('account', 'chat', () => {
      expect(getLatestTurn('account', 'chat')?.public.text).toBe('Immediate answer');
      order.push('priority');
    });
    const stopRegular = subscribeTurnChat('account', 'chat', () => order.push('regular'));
    try {
      publishTurnPublicSnapshot({
        identity,
        snapshot: { text: 'Immediate answer', segments: [], updatedAt: 2 },
      });
      expect(order).toEqual(['priority', 'regular']);
    } finally {
      stopPriority();
      stopRegular();
    }
  });

  it('notifies only the changed account/chat', () => {
    const changed = vi.fn();
    const other = vi.fn();
    const stopChanged = subscribeTurnChat('account', 'chat', changed);
    const stopOther = subscribeTurnChat('account', 'other', other);
    try {
      acceptTurn(identity, 1);
      publishTurnEvent({ accountId: 'account', runId: 'run' }, { type: 'turn.running', at: 2 });
      expect(changed).toHaveBeenCalledTimes(2);
      expect(other).not.toHaveBeenCalled();
    } finally {
      stopChanged();
      stopOther();
    }
  });
});
