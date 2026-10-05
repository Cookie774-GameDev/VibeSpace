import 'fake-indexeddb/auto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';
import { GEMINI_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';

const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[], ready: false }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () =>
    liveQueryFixture.ready ? { kind: 'ready', source: 'managed' } : { kind: 'missing' },
}));

const originalAuth = useAuthStore.getState();
const originalRoute = useUIStore.getState().route;
function enableFixtureModel() {
  liveQueryFixture.ready = true;
  setDiscoveredConnectionModels(GEMINI_API_CONNECTION.id, [
    { id: 'gemini-2.5-flash', label: 'Fixture model', source: 'provider_list', lastVerifiedAt: 1 },
  ]);
  useAuthStore.setState({
    apiKeys: { google: 'synthetic-test-key' },
    offlineMode: false,
    chatModelSelection: selectionFromOption('google', 'gemini-2.5-flash', GEMINI_API_CONNECTION),
  });
}
beforeEach(() => {
  liveQueryFixture.ready = false;
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
    localUserId: 'account-local-test',
    cloudSession: null,
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
    apiKeys: originalAuth.apiKeys,
    offlineMode: originalAuth.offlineMode,
    localUserId: originalAuth.localUserId,
    cloudSession: originalAuth.cloudSession,
  });
  resetDiscoveredConnectionModelsForTests();
  useUIStore.setState({ route: originalRoute });
});

it('sends ordinary text through production dispatch without entering an unavailable local action bridge', async () => {
  const { sharedLocalCommandPreModelBridge } =
    await import('@/features/local-command-bridge/preModelBridge');
  const process = vi
    .spyOn(sharedLocalCommandPreModelBridge, 'process')
    .mockRejectedValue(new Error('Synthetic local authority outage'));
  enableFixtureModel();
  const send = vi.fn();
  window.addEventListener('jarvis:send', send);
  try {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-local-ordinary-outage' as never} />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Hello, please explain this project.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(process).not.toHaveBeenCalled();
    expect((send.mock.calls[0]![0] as CustomEvent).detail.text).toBe(
      'Hello, please explain this project.',
    );
  } finally {
    window.removeEventListener('jarvis:send', send);
  }
});

it('executes a mapped bridge-only local command during an active run without model dispatch or interruption', async () => {
  const chatId = 'chat-local-active-status';
  const { messageRepo } = await import('@/lib/db/repositories');
  const { sharedLocalCommandPreModelBridge } =
    await import('@/features/local-command-bridge/preModelBridge');
  const process = vi.spyOn(sharedLocalCommandPreModelBridge, 'process');
  const localText = 'show router status!';
  const { canRunLocalCommandWithoutModel } =
    await import('@/features/local-command-bridge/preModelBridge');
  const { isComposerInstantCommandSource } = await import('./composerInstantCommand');
  expect(canRunLocalCommandWithoutModel(localText)).toBe(true);
  expect(isComposerInstantCommandSource(localText)).toBe(false);
  const interference = vi.fn();
  for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
    window.addEventListener(event, interference);
  try {
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: localText },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
      key: 'Enter',
      code: 'Enter',
    });
    await waitFor(async () => {
      const messages = await messageRepo.listByChat(chatId as never);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.parts).toEqual(
        expect.arrayContaining([
          { kind: 'text', text: localText },
          {
            kind: 'local_command_receipt',
            version: 1,
            modelDispatch: 'skipped',
            receipts: [{ commandId: 'status.show', status: 'completed' }],
          },
        ]),
      );
    });
    expect(document.querySelectorAll('[data-queued-message-id]')).toHaveLength(0);
    expect(interference).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledOnce();
  } finally {
    for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
      window.removeEventListener(event, interference);
  }
});

it.each(['open codec', 'open settings and open codec'])(
  'preserves ambiguous local text and holds production model dispatch: %s',
  async (text) => {
    enableFixtureModel();
    const { sharedLocalCommandPreModelBridge } =
      await import('@/features/local-command-bridge/preModelBridge');
    const process = vi.spyOn(sharedLocalCommandPreModelBridge, 'process');
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      render(
        <TooltipProvider>
          <Composer chatId={`chat-local-ambiguous-${text}` as never} />
        </TooltipProvider>,
      );
      const input = screen.getByRole('textbox', { name: 'Message' });
      fireEvent.change(input, { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(process).toHaveBeenCalledOnce());
      expect(await process.mock.results[0]!.value).toMatchObject({
        holdModel: true,
        modelText: text,
      });
      expect((input as HTMLTextAreaElement).value).toBe(text);
      expect(useUIStore.getState().route).toBe('account');
      expect(send).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:send', send);
    }
  },
);

it('preserves a failed executable local request and does not fall through to model dispatch', async () => {
  enableFixtureModel();
  const { sharedLocalCommandPreModelBridge } =
    await import('@/features/local-command-bridge/preModelBridge');
  const process = vi
    .spyOn(sharedLocalCommandPreModelBridge, 'process')
    .mockRejectedValue(new Error('Synthetic local authority outage'));
  const send = vi.fn();
  window.addEventListener('jarvis:send', send);
  try {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-local-failed-action' as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'show router status!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(process).toHaveBeenCalledOnce());
    expect((input as HTMLTextAreaElement).value).toBe('show router status!');
    expect(send).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('jarvis:send', send);
  }
});

it('executes an older queued pure local command without cancelling the active reply', async () => {
  const { useComposerQueueSession } = await import('./composerQueueSession');
  const chatId = 'chat-local-legacy-queued';
  const runState = await import('./runtime/chatRunState');
  vi.spyOn(runState, 'getChatRunState').mockReturnValue({
    chatId,
    status: 'running',
    cancellationKey: 'active-legacy-local',
  });
  const scope = JSON.stringify([
    'account-local-test',
    'workspace-local-test',
    'project-local-test',
    chatId,
  ]);
  const session = renderHook(() => useComposerQueueSession(scope));
  act(() =>
    session.result.current.setMessages([
      { id: 'legacy-local-request', text: 'open files', createdAt: 1, flushMode: 'after-run' },
    ]),
  );
  const interference = vi.fn();
  for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
    window.addEventListener(event, interference);
  try {
    render(
      <TooltipProvider>
        <Composer chatId={chatId as never} />
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Steer queued message' }));
    await waitFor(() => expect(useUIStore.getState().route).toBe('files'));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-queued-message-id]')).toHaveLength(0),
    );
    expect(interference).not.toHaveBeenCalled();
  } finally {
    for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
      window.removeEventListener(event, interference);
  }
});

it.each([
  ['Enter', 'open files'],
  ['Tab', 'open files'],
  ['CtrlEnter', 'open files'],
  ['Enter', '/connect'],
])(
  'runs a pure local command through the real authority during an active run using %s: %s',
  async (key, text) => {
    const { act } = await import('@testing-library/react');
    const chatId = `chat-local-active-${key}-${text}`;
    const interference = vi.fn();
    for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
      window.addEventListener(event, interference);
    try {
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
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: text },
      });
      if (key === 'CtrlEnter')
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
          key: 'Enter',
          code: 'Enter',
          ctrlKey: true,
        });
      else fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key, code: key });
      if (text === 'open files')
        await waitFor(() => expect(useUIStore.getState().route).toBe('files'));
      expect(document.querySelectorAll('[data-queued-message-id]')).toHaveLength(0);
      expect(interference).not.toHaveBeenCalled();
      const { messageRepo } = await import('@/lib/db/repositories');
      await waitFor(async () => {
        const messages = await messageRepo.listByChat(chatId as never);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          role: 'user',
          parts: expect.arrayContaining([{ kind: 'text', text }]),
        });
      });
    } finally {
      for (const event of ['jarvis:send', 'jarvis:cancel', 'jarvis:steer'])
        window.removeEventListener(event, interference);
    }
  },
);

it('preserves a rejected /connect draft without dispatching a model request', async () => {
  const instant = await import('./composerInstantCommand');
  vi.spyOn(instant, 'submitComposerInstantCommand').mockResolvedValue({
    handled: true,
    ok: false,
    message: 'Synthetic rejection',
  });
  const send = vi.fn();
  window.addEventListener('jarvis:send', send);
  try {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-local-rejected-connect' as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '/connect' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(instant.submitComposerInstantCommand).toHaveBeenCalledOnce());
    expect((input as HTMLTextAreaElement).value).toBe('/connect');
    expect(send).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('jarvis:send', send);
  }
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

it('keeps a mixed local request queued without navigating during a running turn', async () => {
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
  fireEvent.change(input, { target: { value: 'open files and explain the project' } });
  fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
  await waitFor(() => expect(document.querySelectorAll('[data-queued-message-id]').length).toBe(1));
  expect(useUIStore.getState().route).toBe('account');
});

it.each(['spawn 2 Claude terminals and tell both of them to audit the project'])(
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
