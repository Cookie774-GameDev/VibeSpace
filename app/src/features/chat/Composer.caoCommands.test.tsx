import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { messageRepo } from '@/lib/db';
import { publishChatRunState } from './runtime/chatRunState';
import { Composer } from './Composer';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('./HarnessReadinessGate', async original => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('@/features/cao/CaoCommandPanel', () => ({
  CaoCommandPanel: ({ request }: { request?: { command: { action: string } } }) => request
    ? <div role="status">Submitted {request.command.action}</div> : null,
}));
const originalAuth = useAuthStore.getState();
const originalUI = useUIStore.getState();
afterEach(() => {
  cleanup();
  publishChatRunState({ chatId: 'chat-cao-keyboard', status: 'done' });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  useAuthStore.setState(originalAuth); useUIStore.setState(originalUI);
});
it('submits an exact CAO stop command immediately with Enter while its target is running', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ localUserId: 'account-cao-keyboard' as never, cloudSession: null,
    workspaceId: 'workspace-cao-keyboard' as never, projectId: 'project-cao-keyboard' as never });
  useUIStore.setState({ activeChatId: 'chat-cao-keyboard' as never });
  const create = vi.spyOn(messageRepo, 'create').mockResolvedValue({ id: 'command-user-message' } as never);
  const sent = vi.fn(); window.addEventListener('jarvis:send', sent);
  try {
    render(<TooltipProvider><Composer chatId={'chat-cao-keyboard' as never} /></TooltipProvider>);
    act(() => publishChatRunState({ chatId: 'chat-cao-keyboard', status: 'running', cancellationKey: 'exact-current-turn' }));
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'CAO cancel chat:chat-cao-keyboard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Submitted cancel')).toBeTruthy());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', chat_id: 'chat-cao-keyboard' }));
    expect(sent).not.toHaveBeenCalled();
  } finally { window.removeEventListener('jarvis:send', sent); }
});
