import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';

const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'missing' }),
}));

const originalAuth = useAuthStore.getState();
const originalRoute = useUIStore.getState().route;
beforeEach(() => {
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
    workspaceId: 'workspace-local-test' as never,
    projectId: 'project-local-test' as never,
    chatModelSelection: { mode: 'none' },
  });
  useUIStore.setState({ route: 'account' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({
    workspaceId: originalAuth.workspaceId,
    projectId: originalAuth.projectId,
    chatModelSelection: originalAuth.chatModelSelection,
  });
  useUIStore.setState({ route: originalRoute });
});

it.each([
  'chat',
  'canvas',
  'workbench',
  'kanban',
  'schedule',
  'agents',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'notes',
] as const)(
  'sends open %s through the real local authority with no model or harness',
  async (route) => {
    render(
      <TooltipProvider>
        <Composer chatId={`chat-local-${route}` as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: `open ${route}` } });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    let elapsed: number | undefined;
    const started = performance.now();
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.route === route && elapsed === undefined) elapsed = performance.now() - started;
    });
    try {
      fireEvent.click(send);
      await waitFor(() => expect(useUIStore.getState().route).toBe(route));
      expect(elapsed).toBeLessThan(500);
      console.info(
        `LOCAL_COMMAND_TIMING ${JSON.stringify({ command: `open ${route}`, clickToRouteMs: elapsed })}`,
      );
    } finally {
      unsubscribe();
    }
  },
);

it('keeps ordinary questions blocked when the model backend is missing', () => {
  render(
    <TooltipProvider>
      <Composer chatId={'chat-local-question' as never} />
    </TooltipProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'What is 2 + 2?' },
  });
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('allows a mapped local-only two-Claude request while the model backend is missing', async () => {
  const { sharedLocalCommandPreModelBridge } =
    await import('@/features/local-command-bridge/preModelBridge');
  const inputText = 'spawn 2 Claude terminals';
  const process = vi.spyOn(sharedLocalCommandPreModelBridge, 'process').mockResolvedValue({
    originalText: inputText,
    modelText: '',
    detectedCommands: [],
    executableCommands: [],
    unsupportedCommands: [],
    unexecutedCommands: [],
    receipts: [],
    executions: [],
    commandOnly: true,
    holdModel: false,
    classification: 'command_only',
    interactionId: 'local-ui-test',
  });
  const sends = vi.fn();
  window.addEventListener('jarvis:send', sends);
  try {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-local-offline-two-claude' as never} />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: inputText },
    });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(process).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );
    expect(sends).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('jarvis:send', sends);
  }
});

it('does not navigate when an exact local command is queued during a running turn', async () => {
  const { act } = await import('@testing-library/react');
  const chatId = 'chat-local-queued-navigation';
  render(
    <TooltipProvider>
      <Composer chatId={chatId as never} />
    </TooltipProvider>,
  );
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', { detail: { chatId, status: 'running' } }),
    );
  });
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'open files' } });
  fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
  await waitFor(() => expect(document.querySelectorAll('[data-queued-message-id]').length).toBe(1));
  expect(useUIStore.getState().route).toBe('account');
});

it.each(['open settings', 'spawn 2 Claude terminals and tell both of them to audit the project'])(
  'routes queued local actions through cancel-and-dispatch instead of raw provider steering: %s',
  async (text) => {
    const runState = await import('./runtime/chatRunState');
    const chatId = text.startsWith('spawn') ? 'chat-local-steer-mixed' : 'chat-local-steer-only';
    vi.spyOn(runState, 'getChatRunState').mockReturnValue({
      chatId,
      status: 'running',
      cancellationKey: 'active-local-steer-proof',
    });
    const cancel = vi.fn();
    const steer = vi.fn();
    window.addEventListener('jarvis:cancel', cancel);
    window.addEventListener('jarvis:steer', steer);
    try {
      render(
        <TooltipProvider>
          <Composer chatId={chatId as never} />
        </TooltipProvider>,
      );
      const input = screen.getByRole('textbox', { name: 'Message' });
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
      const button = await screen.findByRole('button', { name: 'Steer queued message' });
      fireEvent.click(button);
      expect(cancel).toHaveBeenCalledOnce();
      expect(steer).not.toHaveBeenCalled();
      expect(document.querySelectorAll('[data-queued-message-id]').length).toBe(1);
      expect(useUIStore.getState().route).toBe('account');
    } finally {
      window.removeEventListener('jarvis:cancel', cancel);
      window.removeEventListener('jarvis:steer', steer);
    }
  },
);
