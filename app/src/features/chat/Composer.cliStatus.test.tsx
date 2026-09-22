import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { chatRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { getProviderConnectionDescriptor } from '@/lib/ai/adapters/catalog';
import { Composer } from './Composer';

const state = vi.hoisted(() => ({ version: 1, backend: 'codex' as 'codex' | 'opencode', locked: true, selectedAt: 1, lockedAt: 2 }));
const selectBackend = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/backend/chatBackendPersistence', async original => ({
  ...(await original<typeof import('@/lib/ai/backend/chatBackendPersistence')>()),
  selectPersistedChatBackend: selectBackend,
}));
const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./useChatBackendAffinity', () => ({
  useChatBackendAffinity: () => state,
}));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
const originalAuth = useAuthStore.getState();
beforeEach(() => {
  state.locked = true;
  selectBackend.mockReset().mockResolvedValue({ backend: 'codex', locked: false });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ workspaceId: 'workspace-cli-status' as never, projectId: 'project-cli-status' as never });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ workspaceId: originalAuth.workspaceId, projectId: originalAuth.projectId, chatModelSelection: originalAuth.chatModelSelection });
});

it('preserves the exact selected provider route when choosing the Codex CLI', async () => {
  const notice = vi.spyOn(toast, 'info');
  const update = vi.spyOn(chatRepo, 'update').mockResolvedValue(undefined as never);
  state.locked = false;
  state.backend = 'opencode';
  const connection = getProviderConnectionDescriptor('opencode-cli');
  const selection = {
    mode: 'single',
    connectionId: connection.id,
    connectionMode: connection.mode,
    authSource: connection.authSource,
    capabilities: connection.capabilities,
    providerId: connection.providerId as never,
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
  } as const;
  useAuthStore.setState({ chatModelSelection: selection });
  render(<TooltipProvider><Composer chatId={'chat-cli-status' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '/cli codex', selectionStart: 10 } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(selectBackend).toHaveBeenCalled());
  await waitFor(() => expect(notice).toHaveBeenCalledWith('Codex selected', expect.any(String)));
  expect(useAuthStore.getState().chatModelSelection).toEqual(selection);
  expect(update).not.toHaveBeenCalled();
});

it.each(['codex', 'opencode'] as const)('shows the locked %s backend when opening /cli', async backend => {
  state.backend = backend;
  render(<TooltipProvider><Composer chatId={'chat-cli-status' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '/cli', selectionStart: 4 } });
  fireEvent.click(await screen.findByRole('option', { name: /\/cli/ }));
  const current = await screen.findByRole('button', { name: /Current CLI.*locked for this chat/i });
  expect(current.textContent).toContain(backend === 'codex' ? 'Codex' : 'OpenCode');
  expect(screen.queryByRole('button', { name: /native route verification|Use the authenticated OpenCode backend/ })).toBeNull();
  fireEvent.click(current);
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  expect(screen.queryByRole('option', { name: /\/cli/ })).toBeNull();
});
