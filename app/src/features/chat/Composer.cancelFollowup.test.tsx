import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';
import { chatRepo, messageRepo } from '@/lib/db';
import { OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { publishChatRunState } from './runtime/chatRunState';
const backendState = vi.hoisted(() => ({ locked: false }));
vi.mock('./useChatBackendAffinity', () => ({
  useChatBackendAffinity: () => backendState.locked
    ? { version: 1, backend: 'codex', locked: true, selectedAt: 1, lockedAt: 2 }
    : undefined,
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
const originalAuth = useAuthStore.getState();
describe('Composer follow-up after user cancellation', () => {
  beforeEach(() => {
    backendState.locked = false;
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
      workspaceId: 'workspace-followup' as never,
      projectId: 'project-followup' as never,
    });
    useUIStore.setState({ activeChatId: 'chat-followup' as never });
  });
  afterEach(() => {
    cleanup();
    publishChatRunState({ chatId: 'chat-followup', status: 'done' });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAuthStore.setState({
      workspaceId: originalAuth.workspaceId,
      projectId: originalAuth.projectId,
      chatModelSelection: originalAuth.chatModelSelection,
    });
  });
  it('restores Stop and Resume after leaving and remounting a running chat', async () => {
    const mount = () => render(
      <TooltipProvider><Composer chatId={'chat-followup' as never} /></TooltipProvider>,
    );
    let view = mount();
    act(() => publishChatRunState({ chatId: 'chat-followup', status: 'running', cancellationKey: 'current-turn' }));
    expect(await screen.findByRole('button', { name: 'Stop current request' })).toBeTruthy();
    view.unmount();
    view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop current request' }));
    act(() => publishChatRunState({ chatId: 'chat-followup', status: 'cancelled', cancellationKey: 'current-turn' }));
    expect(await screen.findByRole('button', { name: 'Resume current request' })).toBeTruthy();
    view.unmount();
    view = mount();
    expect(await screen.findByRole('button', { name: 'Resume current request' })).toBeTruthy();
    view.unmount();
    act(() => publishChatRunState({ chatId: 'chat-followup', status: 'done' }));
    mount();
    expect(screen.queryByRole('button', { name: 'Resume current request' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop current request' })).toBeNull();
  });
  it('restores the upstream model separately from the Codex backend after reload', async () => {
    backendState.locked = true;
    vi.spyOn(chatRepo, 'getById').mockResolvedValue({
      id: 'chat-followup',
      created_at: 1,
      updated_at: 1,
      backend_affinity: { version: 1, backend: 'codex', locked: true, selectedAt: 1, lockedAt: 2 },
      connection: {
        ...OPENCODE_CLI_CONNECTION,
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      },
    } as never);
    vi.spyOn(messageRepo, 'listByChat').mockResolvedValue([]);
    render(
      <TooltipProvider>
        <Composer chatId={'chat-followup' as never} />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(useAuthStore.getState().chatModelSelection).toMatchObject({
        mode: 'single',
        connectionId: 'opencode-cli',
        providerId: 'opencode',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      }),
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '/cli', selectionStart: 4 } });
    fireEvent.click(await screen.findByRole('option', { name: /\/cli/ }));
    expect((await screen.findByRole('button', { name: /Current CLI.*locked for this chat/i })).textContent).toContain('Codex');
  });
  it('offers Send for a new draft after Stop, and retains Resume when the draft is cleared', async () => {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-followup' as never} />
      </TooltipProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('jarvis:run-state', {
          detail: { chatId: 'chat-followup', status: 'running' },
        }),
      );
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop current request' }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('jarvis:run-state', {
          detail: { chatId: 'chat-followup', status: 'cancelled' },
        }),
      );
    });
    expect(await screen.findByRole('button', { name: 'Resume current request' })).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Continue with the marker only.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Resume current request' })).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(await screen.findByRole('button', { name: 'Resume current request' })).toBeTruthy();
  });
});
