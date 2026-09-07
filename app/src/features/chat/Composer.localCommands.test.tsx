import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
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
