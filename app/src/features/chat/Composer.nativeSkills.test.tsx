import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
import { publishChatRunState } from './runtime/chatRunState';

const mocks = vi.hoisted(() => ({
  backend: 'codex' as 'codex' | 'opencode',
  listOpenCodeSkills: vi.fn(),
  listSkills: vi.fn(),
  listMcpServerStatus: vi.fn(),
}));

vi.mock('./useChatBackendAffinity', () => ({
  useChatBackendAffinity: () => ({ version: 1, backend: mocks.backend, locked: true, selectedAt: 1, lockedAt: 2 }),
}));
vi.mock('@/lib/ai/adapters/opencodePersistent', async (original) => ({
  ...(await original<typeof import('@/lib/ai/adapters/opencodePersistent')>()),
  listPersistentOpenCodeSkills: mocks.listOpenCodeSkills,
}));
vi.mock('@/features/files/projectFiles', async (original) => ({
  ...(await original<typeof import('@/features/files/projectFiles')>()),
  getStoredProjectRoot: () => 'C:\\skill-project',
}));
vi.mock('@/lib/ai/adapters/codexPersistent', async (original) => {
  const actual = await original<typeof import('@/lib/ai/adapters/codexPersistent')>();
  return { ...actual, codexPersistentAdapter: { ...actual.codexPersistentAdapter, listSkills: mocks.listSkills, listMcpServerStatus: mocks.listMcpServerStatus } };
});
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('./CodexReadinessGate', async (original) => ({
  ...(await original<typeof import('./CodexReadinessGate')>()),
  useCodexRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
  CodexReadinessGate: () => null,
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) => fallback }));

const skill = {
  cwd: 'C:\\skill-project',
  name: 'review-diff',
  description: 'Review the current changes',
  path: 'C:\\skill-project\\.codex\\skills\\review-diff\\SKILL.md',
  scope: 'repo' as const,
  enabled: true,
  pluginId: null,
};
const originalAuth = useAuthStore.getState();

afterEach(() => {
  cleanup();
  publishChatRunState({ chatId: 'skill-controls-steer', status: 'done' });
  publishChatRunState({ chatId: 'skill-controls-queue', status: 'done' });
  mocks.backend = 'codex';
  mocks.listOpenCodeSkills.mockReset();
  mocks.listSkills.mockReset();
  mocks.listMcpServerStatus.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({
    localUserId: originalAuth.localUserId,
    cloudSession: originalAuth.cloudSession,
    workspaceId: originalAuth.workspaceId,
    projectId: originalAuth.projectId,
    chatModelSelection: originalAuth.chatModelSelection,
  });
});

it.each(['steer', 'queue'] as const)('forwards selected Codex skills through native %s without cancelling the turn', async (action) => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listSkills.mockResolvedValue([{ cwd: skill.cwd, skills: [skill], errors: [] }]);
  useAuthStore.setState({ localUserId: 'skill-controls-account', cloudSession: null, workspaceId: 'skill-workspace' as never, projectId: 'skill-project' as never });
  const chatId = `skill-controls-${action}`;
  render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
  act(() => publishChatRunState({ chatId, status: 'running', cancellationKey: 'current-turn' }));
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  const option = await screen.findByRole('option', { name: /review-diff/u });
  await waitFor(() => {
    fireEvent.click(option);
    expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy();
  });
  fireEvent.change(input, { target: { value: 'Review the changes with the selected skill.', selectionStart: 42 } });
  fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
  const onControl = vi.fn();
  const onCancel = vi.fn();
  window.addEventListener(`jarvis:${action}`, onControl);
  window.addEventListener('jarvis:cancel', onCancel);
  try {
    if (action === 'steer') fireEvent.click(await screen.findByRole('button', { name: 'Steer queued message' }));
    else {
      fireEvent.click(await screen.findByRole('button', { name: 'Queued message options' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Queue on active Codex turn' }));
    }
    await waitFor(() => expect(onControl).toHaveBeenCalledTimes(1));
    expect((onControl.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      chatId, codexSkills: [{ name: skill.name, path: skill.path }],
    });
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(`jarvis:${action}`, onControl);
    window.removeEventListener('jarvis:cancel', onCancel);
  }
});

it('offers distinct VibeSpace and native Codex MCP commands and invokes the native status API', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listMcpServerStatus.mockResolvedValue([]);
  const createMessage = vi.spyOn(messageRepo, 'create').mockImplementation(async (input) => ({
    id: input.role === 'user' ? 'local-mcp-request' : 'local-mcp-result',
    ...input,
  }) as never);
  const updateMessage = vi.spyOn(messageRepo, 'update').mockResolvedValue({} as never);
  useAuthStore.setState({ workspaceId: 'skill-workspace' as never, projectId: 'skill-project' as never });
  render(<TooltipProvider><Composer chatId={'codex-mcp-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/mcp', selectionStart: 4 } });
  const options = await screen.findAllByRole('option', { name: /\/mcp/u });
  expect(options.length).toBeGreaterThanOrEqual(2);
  const native = options.find((option) => option.textContent?.includes('Codex MCP server status'));
  expect(native).toBeTruthy();
  fireEvent.click(native!);
  await waitFor(() => expect(mocks.listMcpServerStatus).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(updateMessage).toHaveBeenCalledWith('local-mcp-request', {
    parts: [
      { kind: 'text', text: '/mcp' },
      { kind: 'local_command_receipt', version: 1, modelDispatch: 'skipped',
        receipts: [{ commandId: 'codex-mcp-status', status: 'completed' }] },
    ],
  }));
  expect(createMessage).toHaveBeenCalledTimes(2);
  expect(updateMessage.mock.invocationCallOrder[0]).toBeGreaterThan(createMessage.mock.invocationCallOrder[1]!);
});

it.each(['codex', 'opencode'] as const)('discovers the exact native %s skill and creates a removable blue chip', async (backend) => {
  mocks.backend = backend;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listSkills.mockResolvedValue([{ cwd: skill.cwd, skills: [skill], errors: [] }]);
  mocks.listOpenCodeSkills.mockResolvedValue([{ name: skill.name, location: skill.path, description: skill.description }]);
  useAuthStore.setState({ localUserId: 'skill-test-account', cloudSession: null, workspaceId: 'skill-workspace' as never, projectId: 'skill-project' as never });
  const view = render(<TooltipProvider><Composer chatId={'skill-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  const option = await screen.findByRole('option', { name: /review-diff/u });
  if (backend === 'codex') expect(mocks.listSkills).toHaveBeenCalledWith({ workingDirectory: skill.cwd, forceReload: true });
  else expect(mocks.listOpenCodeSkills).toHaveBeenCalledWith({ accountId: 'skill-test-account', workspaceId: 'skill-workspace', projectId: 'skill-project', workingDirectory: skill.cwd });
  await waitFor(() => {
    fireEvent.click(option);
    expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy();
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove $review-diff' }).closest('[data-composer-token-kind]')?.getAttribute('data-composer-token-kind')).toBe('native-skill'));
  expect(input.value).toBe('$review-diff ');
  view.unmount();
  render(<TooltipProvider><Composer chatId={'skill-chat' as never} /></TooltipProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('Selected native CLI skills').textContent).toContain('Selected'));
  expect(screen.getByLabelText('Selected native CLI skills').textContent).toContain('Codex · Selected');
  fireEvent.click(screen.getByRole('button', { name: 'Remove $review-diff' }));
  expect(screen.queryByLabelText('Selected native CLI skills')).toBeNull();
});
