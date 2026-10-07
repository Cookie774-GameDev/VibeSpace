import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
import { useComposerQueueSession } from './composerQueueSession';
import { publishChatRunState } from './runtime/chatRunState';
import { resetTurnStoreForTests } from './runtime/turn/turnStore';

const fixture = vi.hoisted(() => ({ backend: 'opencode' as 'opencode' | 'codex', empty: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({
  useChatBackendAffinity: () => ({ version: 1, backend: fixture.backend, locked: true,
    selectedAt: 1, lockedAt: 2 }),
}));
vi.mock('./HarnessReadinessGate', async original => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('./CodexReadinessGate', async original => ({
  ...(await original<typeof import('./CodexReadinessGate')>()),
  useCodexRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
  CodexReadinessGate: () => null,
}));

const originalAuth = useAuthStore.getState();
beforeEach(() => {
  resetTurnStoreForTests();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ localUserId: 'blocked-followup-owner', cloudSession: null,
    workspaceId: 'blocked-followup-workspace' as never, projectId: 'blocked-followup-project' as never,
    chatModelSelection: { mode: 'none' } });
});
afterEach(() => {
  cleanup(); resetTurnStoreForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState(originalAuth);
});

it.each(['opencode', 'codex'] as const)(
  'explains a blocked %s follow-up without claiming provider acceptance and retains its queue', async backend => {
    fixture.backend = backend;
    const chatId = `blocked-followup-${backend}`;
    const scope = JSON.stringify(['blocked-followup-owner', 'blocked-followup-workspace', 'blocked-followup-project', chatId]);
    const queue = renderHook(() => useComposerQueueSession(scope));
    const rows = [
      { id: `${chatId}-one`, text: 'Inspect the synthetic marker.', createdAt: 1, flushMode: 'after-run' as const },
      { id: `${chatId}-two`, text: 'Then summarize the result.', createdAt: 2, flushMode: 'after-run' as const },
    ];
    act(() => queue.result.current.setMessages(rows));
    const error = vi.spyOn(toast, 'error');
    const interference = vi.fn();
    const steer = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; text: string; onBlocked(): void }>).detail;
      expect(detail).toMatchObject({ chatId, text: rows[0].text });
      detail.onBlocked();
    });
    window.addEventListener('jarvis:steer', steer);
    for (const name of ['jarvis:send', 'jarvis:cancel', 'jarvis:queue']) window.addEventListener(name, interference);
    try {
      act(() => publishChatRunState({ chatId, status: 'running', cancellationKey: 'original-turn' }));
      render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
      const label = backend === 'opencode' ? 'Stop current reply and follow up' : 'Steer queued message';
      fireEvent.click((await screen.findAllByRole('button', { name: label }))[0]!);
      await waitFor(() => expect(steer).toHaveBeenCalledOnce());
      expect(error).toHaveBeenCalledOnce();
      const [title, body] = error.mock.calls[0]!;
      expect(title).toBe('Steer needs review');
      expect(body).toMatch(/saved/u);
      expect(body).toMatch(/may have reached the provider/u);
      expect(body).toMatch(/review the thread before retrying/iu);
      expect(body).not.toMatch(/Codex|OpenCode/u);
      expect(queue.result.current.messages).toEqual(rows);
      expect(document.querySelectorAll('[data-queued-message-id]')).toHaveLength(2);
      expect(interference).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:steer', steer);
      for (const name of ['jarvis:send', 'jarvis:cancel', 'jarvis:queue']) window.removeEventListener(name, interference);
    }
  },
);
