import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from '@/features/chat/Composer';
const fixture = vi.hoisted(() => ({ empty: [] as unknown[], backend: 'codex' as 'codex' | 'opencode' }));
vi.mock('@/features/chat/runtime/chatRunState', () => ({ getChatRunState: () => ({ chatId: 'resume-review', status: 'cancelled' }) }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _d: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('@/features/chat/useChatBackendAffinity', () => ({ useChatBackendAffinity: () => ({ version: 1, backend: fixture.backend, locked: true, selectedAt: 1 }) }));
vi.mock('@/features/chat/HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('@/features/chat/HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'missing' }),
}));

const originalAuth = useAuthStore.getState();
beforeEach(() => {
  fixture.backend = 'codex';
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useAuthStore.setState({
    localUserId: 'draft-test-user' as never,
    cloudSession: null,
    workspaceId: 'draft-test-workspace' as never,
    projectId: 'draft-test-project' as never,
    chatModelSelection: { mode: 'none' },
  });
  vi.spyOn(messageRepo, 'create').mockResolvedValue({ id: 'draft-test-message' } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState(originalAuth);

});


function renderStopped() {
  render(<TooltipProvider><Composer chatId={'resume-review' as never} /></TooltipProvider>);
}
it('does not offer unsupported exact Resume or dispatch a new request for a stopped Codex chat', () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  renderStopped();
  expect(screen.queryByRole('button', { name: 'Resume current request' })).toBeNull();
  expect(screen.getByText(/Exact resume is unavailable/)).toBeTruthy();
  expect(screen.getByText(/requests with attachments need manual review/)).toBeTruthy();
  expect(dispatch.mock.calls.filter(([event]) => ['jarvis:resume', 'jarvis:send'].includes(event.type))).toEqual([]);
  expect(messageRepo.create).not.toHaveBeenCalled();
});
it('retains the existing explicit Resume event for a stopped OpenCode chat', () => {
  fixture.backend = 'opencode';
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  renderStopped();
  fireEvent.click(screen.getByRole('button', { name: 'Resume current request' }));
  const events = dispatch.mock.calls.map(([event]) => event).filter(event => event.type === 'jarvis:resume');
  expect(events).toHaveLength(1);
  expect((events[0] as CustomEvent).detail).toMatchObject({ chatId: 'resume-review' });
  expect(messageRepo.create).not.toHaveBeenCalled();
});
it('keeps a reviewed draft intact and offers ordinary Send without automatic resend', () => {
  renderStopped();
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Review this new request before sending.' } });
  expect(input.value).toBe('Review this new request before sending.');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume current request' })).toBeNull();
  expect(messageRepo.create).not.toHaveBeenCalled();
});
