import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useComposerQueueSession } from './composerQueueSession';

describe('composer queue view lifetime', () => {
  it('retains complete queued snapshots and handoff receipts across unmount', () => {
    const first = renderHook(() => useComposerQueueSession('account/workspace/project/chat-one'));
    const message = { id: 'one', text: 'Read attachment', createdAt: 1, flushMode: 'after-run' as const,
      attachments: { files: ['C:/fixture/record.json'], images: [], terminals: [], plugins: [], contexts: [], commands: [], agents: [], catalog: [] } };
    act(() => first.result.current.setMessages([message]));
    const handoff = { payload: { text: 'accepted snapshot' }, visibleHandoffKey: 'receipt-one' } as never;
    first.result.current.handoffs.current.set('one', handoff);
    first.unmount();
    const restored = renderHook(() => useComposerQueueSession('account/workspace/project/chat-one'));
    expect(restored.result.current.messages).toEqual([message]);
    expect(restored.result.current.handoffs.current.get('one')).toBe(handoff);
    restored.unmount();
  });

  it('isolates scopes and applies late acceptance only to the original queue', () => {
    const view = renderHook(({ scope }) => useComposerQueueSession(scope), { initialProps: { scope: 'old-account/chat' } });
    act(() => view.result.current.setMessages([{ id: 'old', text: 'old', createdAt: 1, flushMode: 'after-run' }]));
    const accepted = view.result.current.setMessages;
    view.rerender({ scope: 'new-account/chat' });
    expect(view.result.current.messages).toEqual([]);
    act(() => view.result.current.setMessages([{ id: 'new', text: 'new', createdAt: 2, flushMode: 'after-run' }]));
    act(() => accepted(items => items.filter(item => item.id !== 'old')));
    expect(view.result.current.messages.map(item => item.id)).toEqual(['new']);
    view.rerender({ scope: 'old-account/chat' });
    expect(view.result.current.messages).toEqual([]);
    view.unmount();
  });

  it('shares dispatch and steer guards between overlapping mounts until acceptance', () => {
    const first = renderHook(() => useComposerQueueSession('shared/chat'));
    const second = renderHook(() => useComposerQueueSession('shared/chat'));
    first.result.current.dispatchInFlight.current = 'pending';
    first.result.current.interruptInFlight.current = 'steer';
    expect(second.result.current.dispatchInFlight.current).toBe('pending');
    expect(second.result.current.interruptInFlight.current).toBe('steer');
    first.unmount();
    expect(second.result.current.dispatchInFlight.current).toBe('pending');
    act(() => second.result.current.setMessages([{ id: 'pending', text: 'keep on rejection', createdAt: 3, flushMode: 'after-run' }]));
    second.result.current.dispatchInFlight.current = null;
    expect(second.result.current.messages).toHaveLength(1);
    second.unmount();
  });
});
