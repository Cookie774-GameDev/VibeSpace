import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';

const mocks = vi.hoisted(() => ({
  manager: vi.fn(),
  catalog: {
    generation: 'test-generation',
    commands: [
      { name: 'mcp', identifier: 'mcp', identity: 'opencode:command:mcp', source: 'command', executionCapability: 'session-command', description: 'OpenCode MCP status' },
      { name: 'unroutable', identifier: 'unroutable', identity: 'opencode:future:unroutable', source: 'future', executionCapability: 'requires-native-cli-ui', description: 'Future native only' },
    ],
  },
}));

vi.mock('./openCodeCommandCatalog', () => ({ useOpenCodeCommandCatalog: () => mocks.catalog }));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => ({ version: 1, backend: 'opencode', locked: true, selectedAt: 1, lockedAt: 2 }) }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('@/features/plugins/openMcpManager', () => ({ requestOpenMcpManager: mocks.manager }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) => fallback }));

const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  mocks.manager.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ workspaceId: originalAuth.workspaceId, projectId: originalAuth.projectId, chatModelSelection: originalAuth.chatModelSelection });
});

it('keeps VibeSpace /mcp and OpenCode /mcp distinct, selecting the native route without opening the local manager', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ workspaceId: 'workspace-harness-command' as never, projectId: 'project-harness-command' as never });
  render(<TooltipProvider><Composer chatId={'chat-harness-command' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/mcp', selectionStart: 4 } });
  const options = await screen.findAllByRole('option', { name: /\/mcp/u });
  expect(options.length).toBeGreaterThanOrEqual(2);
  const native = options.find((option) => option.textContent?.includes('OpenCode MCP status'));
  expect(native).toBeTruthy();
  fireEvent.click(native!);
  await waitFor(() => expect(input.value).toBe('/mcp '));
  expect(mocks.manager).not.toHaveBeenCalled();
});

it('labels an unknown upstream command as native-CLI-only and prevents selection', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useAuthStore.setState({ workspaceId: 'workspace-harness-command' as never, projectId: 'project-harness-command' as never });
  render(<TooltipProvider><Composer chatId={'chat-harness-command-2' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/unroutable', selectionStart: 11 } });
  const nativeOnly = await screen.findByRole('option', { name: /unroutable.*Requires native CLI UI/iu });
  expect(nativeOnly.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(nativeOnly);
  expect(input.value).toBe('/unroutable');
});
