import 'fake-indexeddb/auto';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { chatRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
import { useComposerQueueSession } from './composerQueueSession';
import { publishChatRunState } from './runtime/chatRunState';
import { resetTurnStoreForTests } from './runtime/turn/turnStore';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[], dispatch: vi.fn() }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('./QueuedMessagesBar', async (original) => ({
  ...(await original<typeof import('./QueuedMessagesBar')>()),
  // Observe the real Composer scheduling boundary without calling a model.
  // Provider dispatch/acknowledgement is covered separately by its own tests.
  dispatchQueuedMessageAfterAcceptance: fixture.dispatch,
}));

const originalAuth = useAuthStore.getState();

describe('Composer queue after a turn finishes while its view is closed', () => {
  beforeEach(() => {
    resetTurnStoreForTests();
    fixture.dispatch.mockReset().mockResolvedValue(false);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    useAuthStore.setState({
      localUserId: 'queue-remount-owner' as never,
      cloudSession: null,
      workspaceId: 'queue-remount-workspace' as never,
      projectId: 'queue-remount-project' as never,
      chatModelSelection: { mode: 'none' },
    });
    vi.spyOn(chatRepo, 'getById').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    resetTurnStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAuthStore.setState(originalAuth);
  });

  function retainQueue(chatId: string) {
    const scope = JSON.stringify([
      'queue-remount-owner', 'queue-remount-workspace', 'queue-remount-project', chatId,
    ]);
    const queue = renderHook(() => useComposerQueueSession(scope));
    const first = { id: `${chatId}-first`, text: 'First retained request', createdAt: 1,
      flushMode: 'after-run' as const };
    const second = { id: `${chatId}-second`, text: 'Second retained request', createdAt: 2,
      flushMode: 'after-run' as const };
    act(() => queue.result.current.setMessages([first, second]));
    queue.unmount();
    return { scope, first, second };
  }

  function mount(chatId: string) {
    return render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
  }

  it.each(['done', 'error'] as const)('retries only the FIFO head after retained %s state', async (status) => {
    const chatId = `queue-remount-${status}`;
    const { scope, first, second } = retainQueue(chatId);
    act(() => publishChatRunState({ chatId, status: 'running', cancellationKey: 'prior-turn' }));
    const prior = mount(chatId);
    await waitFor(() => expect(chatRepo.getById).toHaveBeenCalledWith(chatId));
    prior.unmount();
    act(() => publishChatRunState({ chatId, status, cancellationKey: 'prior-turn' }));

    mount(chatId);

    await waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(1));
    expect(fixture.dispatch.mock.calls[0]?.[0]).toEqual(first);
    // Rejected/unaccepted dispatch must not drop the first or second request.
    const retained = renderHook(() => useComposerQueueSession(scope));
    expect(retained.result.current.messages).toEqual([first, second]);
    retained.unmount();
  });

  it.each(['running', 'cancelled'] as const)('keeps retained %s work queued without automatic dispatch', async (status) => {
    const chatId = `queue-remount-${status}`;
    const { scope, first, second } = retainQueue(chatId);
    act(() => publishChatRunState({ chatId, status, cancellationKey: 'prior-turn' }));

    mount(chatId);

    await waitFor(() => expect(chatRepo.getById).toHaveBeenCalledWith(chatId));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const retained = renderHook(() => useComposerQueueSession(scope));
    expect(retained.result.current.messages).toEqual([first, second]);
    retained.unmount();
  });

  it.each(['done', 'error'] as const)('attempts one FIFO dispatch when a mounted turn reaches %s', async (status) => {
    const chatId = `queue-mounted-${status}`;
    const { scope, first, second } = retainQueue(chatId);
    act(() => publishChatRunState({ chatId, status: 'running', cancellationKey: 'prior-turn' }));
    mount(chatId);
    await waitFor(() => expect(chatRepo.getById).toHaveBeenCalledWith(chatId));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(fixture.dispatch).not.toHaveBeenCalled();

    act(() => publishChatRunState({ chatId, status, cancellationKey: 'prior-turn' }));

    // A fast rejected send releases the in-flight guard between timer callbacks.
    // Terminal-event and restoration effects must not each retry the same head.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]?.[0]).toEqual(first);
    const retained = renderHook(() => useComposerQueueSession(scope));
    expect(retained.result.current.messages).toEqual([first, second]);
    retained.unmount();
  });
});
