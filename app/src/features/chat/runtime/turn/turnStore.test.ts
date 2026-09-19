import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTurnCheckpoint, writeTurnCheckpoint } from './turnCheckpointStore';
import {
  acceptTurn,
  clearTurnPublic,
  getCompatibilityRunState,
  getLatestTurn,
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
