import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAccountPreviews,
  clearPreview,
  getPreview,
  getChatPreview,
  previewIdentityForPlaceholder,
  setPreview,
  subscribeChatPreviews,
  subscribePreviews,
} from './streamingPreviewStore';
import { getTurn, publishTurnEvent, resetTurnStoreForTests } from './runtime/turn/turnStore';

const preview = {
  accountId: 'account-a',
  runId: 'run-1',
  requestId: 'request-1',
  chatId: 'chat-1',
  text: 'Safe preview.',
  updatedAt: 10,
};

describe('streaming preview store', () => {
  it('retires an interrupted chat preview without erasing saved public evidence', () => {
    setPreview(preview);
    publishTurnEvent(preview, { type: 'turn.interrupted', at: 11, reason: 'restored_without_live_owner' });
    expect(getChatPreview('account-a', 'chat-1')).toBeNull();
    expect(getPreview('account-a', 'run-1')?.text).toBe('Safe preview.');
    expect(getTurn('account-a', 'run-1')).toMatchObject({
      status: 'interrupted', errorCode: 'restored_without_live_owner',
      public: { text: 'Safe preview.' },
    });
  });

  beforeEach(() => {
    resetTurnStoreForTests();
    clearAccountPreviews('account-a');
    clearAccountPreviews('account-b');
  });

  it('disposes account publication counters even after a temporary preview clear', () => {
    setPreview(preview);
    setPreview({ ...preview, text: 'Second publication' });
    clearPreview('account-a', 'run-1');
    clearAccountPreviews('account-a');
    setPreview({ ...preview, requestId: 'new-request' });
    expect(getPreview('account-a', 'run-1')?.runPublicationSequence).toBe(1);
  });

  it('retires an explicitly terminal run counter even when its preview is already clear', () => {
    setPreview(preview);
    setPreview({ ...preview, text: 'Second publication' });
    clearPreview('account-a', 'run-1');
    clearPreview('account-a', 'run-1', { terminal: true });
    setPreview({ ...preview, requestId: 'next-logical-request' });
    expect(getPreview('account-a', 'run-1')?.runPublicationSequence).toBe(1);
  });

  it('preserves sequence continuity across a temporary clear within the same run', () => {
    setPreview(preview);
    const initial = getPreview('account-a', 'run-1')!.runPublicationSequence!;
    clearPreview('account-a', 'run-1');
    setPreview({ ...preview, text: 'Resumed public stream' });
    expect(getPreview('account-a', 'run-1')?.runPublicationSequence).toBe(initial + 1);
  });

  it('replaces and clears previews by exact account and run', () => {
    setPreview(preview);
    setPreview({ ...preview, text: 'Replacement.', updatedAt: 11 });
    setPreview({ ...preview, accountId: 'account-b', text: 'Other account.' });

    expect(getPreview('account-a', 'run-1')?.text).toBe('Replacement.');
    expect(getPreview('account-b', 'run-1')?.text).toBe('Other account.');

    clearPreview('account-a', 'run-1');
    expect(getPreview('account-a', 'run-1')).toBeNull();
    expect(getPreview('account-b', 'run-1')).not.toBeNull();

    clearAccountPreviews('account-b');
    expect(getPreview('account-b', 'run-1')).toBeNull();
  });

  it('detaches and freezes caller-owned preview data', () => {
    const caller = { ...preview };
    setPreview(caller);
    caller.text = 'Mutated';

    const stored = getPreview('account-a', 'run-1');
    expect(stored?.text).toBe('Safe preview.');
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it('detaches segment metadata so caller mutations cannot alter a published snapshot', () => {
    const segment = {
      kind: 'tool' as const,
      id: 'tool-1',
      name: 'read',
      status: 'started' as const,
    };
    setPreview({ ...preview, segments: [segment] });
    segment.name = 'changed outside store';
    expect(getPreview('account-a', 'run-1')?.segments?.[0]).toMatchObject({ name: 'read' });
  });

  it('publishes ordered public reasoning segments through the existing preview contract', () => {
    const identity = previewIdentityForPlaceholder({
      accountId: 'account-a',
      chatId: 'chat-1',
      placeholderId: 'msg_42',
    });
    setPreview({
      ...identity,
      text: 'Answer',
      updatedAt: 11,
      segments: [
        { kind: 'reasoning', id: 'reasoning-1', text: 'Thinking publicly.' },
        { kind: 'tool', id: 'tool-1', name: 'read', status: 'completed' },
        { kind: 'text', id: 'text-1', text: 'Answer' },
      ],
    });
    expect(getPreview('account-a', 'chat-preview:msg_42')?.segments).toEqual([
      { kind: 'reasoning', id: 'reasoning-1', text: 'Thinking publicly.' },
      { kind: 'tool', id: 'tool-1', name: 'read', status: 'completed' },
      { kind: 'text', id: 'text-1', text: 'Answer' },
    ]);
  });

  it('derives a stable preview identity without manufacturing a message id', () => {
    expect(
      previewIdentityForPlaceholder({
        accountId: ' account-a ',
        chatId: ' chat-1 ',
        placeholderId: 'msg_42',
      }),
    ).toEqual({
      accountId: 'account-a',
      chatId: 'chat-1',
      requestId: 'msg_42',
      runId: 'chat-preview:msg_42',
    });
    expect(() =>
      previewIdentityForPlaceholder({ accountId: '', chatId: 'chat-1', placeholderId: 'x' }),
    ).toThrow('invalid_streaming_preview_identity');
  });

  it('publishes a changed trusted root even when display text is unchanged', () => {
    setPreview({ ...preview, projectRoot: 'C:/first' });
    setPreview({ ...preview, projectRoot: 'C:/second' });
    expect(getPreview('account-a', 'run-1')?.projectRoot).toBe('C:/second');
  });

  it('skips unchanged tool metadata but publishes output and lifecycle changes', () => {
    const details = Object.freeze({ command: 'node verify.cjs' });
    const segment = {
      kind: 'tool' as const,
      id: 'tool-1',
      name: 'command',
      status: 'started' as const,
      details,
    };
    const listener = vi.fn();
    const stop = subscribeChatPreviews('account-a', 'chat-1', listener);
    try {
      setPreview({ ...preview, segments: [segment] });
      const revision = getPreview('account-a', 'run-1')?.publicationRevision;
      setPreview({ ...preview, segments: [{ ...segment }], updatedAt: 20 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getPreview('account-a', 'run-1')?.publicationRevision).toBe(revision);
      setPreview({
        ...preview,
        segments: [{ ...segment, status: 'completed', details: { ...details, exitCode: 0 } }],
      });
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getPreview('account-a', 'run-1')?.publicationRevision).toBeGreaterThan(revision!);
    } finally {
      stop();
    }
  });

  it('never reads or writes browser persistence', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    setPreview(preview);
    getPreview('account-a', 'run-1');
    clearPreview('account-a', 'run-1');
    clearAccountPreviews('account-a');

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('notifies only the changed account/chat while preserving global subscribers', () => {
    const changed = vi.fn();
    const otherChat = vi.fn();
    const otherAccount = vi.fn();
    const all = vi.fn();
    const stops = [
      subscribeChatPreviews('account-a', 'chat-1', changed),
      subscribeChatPreviews('account-a', 'chat-2', otherChat),
      subscribeChatPreviews('account-b', 'chat-1', otherAccount),
      subscribePreviews(all),
    ];
    try {
      setPreview(preview);
      setPreview({ ...preview, updatedAt: 99 }); // Existing no-op semantics.
      expect(changed).toHaveBeenCalledTimes(1);
      expect(all).toHaveBeenCalledTimes(1);
      expect(otherChat).not.toHaveBeenCalled();
      expect(otherAccount).not.toHaveBeenCalled();
      expect(getChatPreview('account-a', 'chat-1')?.updatedAt).toBe(10);
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it('invalidates both chats when a run moves and preserves latest-preview ordering', () => {
    setPreview(preview);
    setPreview({ ...preview, runId: 'run-2', text: 'Later', updatedAt: 20 });
    const oldChat = vi.fn();
    const newChat = vi.fn();
    const stops = [
      subscribeChatPreviews('account-a', 'chat-1', oldChat),
      subscribeChatPreviews('account-a', 'chat-2', newChat),
    ];
    try {
      setPreview({ ...preview, runId: 'run-2', chatId: 'chat-2', text: 'Moved', updatedAt: 30 });
      expect(oldChat).toHaveBeenCalledTimes(1);
      expect(newChat).toHaveBeenCalledTimes(1);
      expect(getChatPreview('account-a', 'chat-1')?.runId).toBe('run-1');
      expect(getChatPreview('account-a', 'chat-2')?.text).toBe('Moved');
      clearPreview('account-a', 'run-2');
      expect(newChat).toHaveBeenCalledTimes(2);
      expect(getChatPreview('account-a', 'chat-2')).toBeNull();
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it('clears each affected chat once and releases subscriptions', () => {
    setPreview(preview);
    setPreview({ ...preview, runId: 'run-2' });
    const changed = vi.fn();
    const other = vi.fn();
    const stop = subscribeChatPreviews('account-a', 'chat-1', changed);
    const stopOther = subscribeChatPreviews('account-b', 'chat-1', other);
    try {
      clearAccountPreviews('account-a');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      clearAccountPreviews('account-a');
      expect(changed).toHaveBeenCalledTimes(1);
      stop();
      stop();
      setPreview(preview);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopOther();
    }
  });

  it('avoids unrelated snapshot checks across 20 mounted chats', () => {
    const listeners = Array.from({ length: 20 }, () => vi.fn());
    const legacyListeners = Array.from({ length: 20 }, () => vi.fn());
    const stops = [
      ...listeners.map((listener, i) => subscribeChatPreviews('account-a', `chat-${i}`, listener)),
      ...legacyListeners.map(subscribePreviews),
    ];
    try {
      for (let i = 0; i < 100; i++) setPreview({ ...preview, text: `Delta ${i}`, updatedAt: i });
      expect(listeners[1]).toHaveBeenCalledTimes(100);
      expect(listeners.reduce((sum, listener) => sum + listener.mock.calls.length, 0)).toBe(100);
      expect(legacyListeners.reduce((sum, listener) => sum + listener.mock.calls.length, 0)).toBe(
        2_000,
      );
    } finally {
      stops.forEach((stop) => stop());
    }
  });
});

it('assigns monotonic publication time itself and preserves it for no-op updates', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    setPreview({ ...preview, publicationMonotonicMs: -999, text: 'new timing fixture' });
    expect(getPreview('account-a', 'run-1')?.publicationMonotonicMs).toBe(100);
    clock.mockReturnValue(120);
    setPreview({ ...preview, text: 'new timing fixture', updatedAt: 50 });
    expect(getPreview('account-a', 'run-1')?.publicationMonotonicMs).toBe(100);
  } finally {
    clock.mockRestore();
    clearAccountPreviews('account-a');
  }
});
