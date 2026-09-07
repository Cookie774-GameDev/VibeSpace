import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { chatRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';

const state = vi.hoisted(() => ({ version: 1, backend: 'codex' as 'codex' | 'opencode', locked: true, selectedAt: 1, lockedAt: 2 }));
const selectBackend = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/backend/chatBackendPersistence', async original => ({
  ...(await original<typeof import('@/lib/ai/backend/chatBackendPersistence')>()),
  selectPersistedChatBackend: selectBackend,
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
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

it('keeps the selected Go model when choosing the Codex CLI', async () => {
  const notice = vi.spyOn(toast, 'info');
  vi.spyOn(chatRepo, 'update').mockResolvedValue(undefined as never);
  state.locked = false;
  state.backend = 'opencode';
  const selection = { mode: 'single', connectionId: 'opencode-cli', providerId: 'opencode', modelId: 'opencode-go/deepseek-v4-flash-vision-exp' } as const;
  useAuthStore.setState({ chatModelSelection: selection });
  render(<TooltipProvider><Composer chatId={'chat-cli-status' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '/cli codex', selectionStart: 10 } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(selectBackend).toHaveBeenCalled());
  await waitFor(() => expect(notice).toHaveBeenCalledWith('Codex selected', expect.any(String)));
  expect(useAuthStore.getState().chatModelSelection).toEqual(selection);
});

it.each(['codex', 'opencode'] as const)('shows the locked %s backend when opening /cli', async backend => {
  state.backend = backend;
  render(<TooltipProvider><Composer chatId={'chat-cli-status' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '/cli', selectionStart: 4 } });
  fireEvent.click(await screen.findByRole('option', { name: /\/cli/ }));
  const current = await screen.findByRole('button', { name: /Current CLI.*locked for this chat/i });
  expect(current.textContent).toContain(backend === 'codex' ? 'Codex' : 'OpenCode');
  expect(screen.queryByRole('button', { name: /Use Codex CLI|Use the authenticated OpenCode backend/ })).toBeNull();
  fireEvent.click(current);
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  expect(screen.queryByRole('option')).toBeNull();
});
