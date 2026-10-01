import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
import { publishChatRunState } from './runtime/chatRunState';

const mocks = vi.hoisted(() => ({
  backend: 'codex' as 'codex' | 'opencode',
  projectRoot: 'C:\\skill-project',
  chooseProjectFolder: vi.fn(),
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
  getStoredProjectRoot: () => mocks.projectRoot,
  chooseProjectFolder: mocks.chooseProjectFolder,
  setStoredProjectRoot: (projectId: string | null, path: string) => {
    mocks.projectRoot = path;
    window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', { detail: { projectId, path } }));
  },
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
  mocks.projectRoot = skill.cwd;
  mocks.chooseProjectFolder.mockReset();
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

it('chooses a folder from $skill and discovers skills without a project record', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.projectRoot = '';
  mocks.chooseProjectFolder.mockResolvedValue(skill.cwd);
  mocks.listSkills.mockResolvedValue([{ cwd: skill.cwd, skills: [skill], errors: [] }]);
  useAuthStore.setState({
    localUserId: 'skill-folder-account', cloudSession: null,
    workspaceId: 'skill-workspace' as never, projectId: null,
  });
  render(<TooltipProvider><Composer chatId={'skill-folder-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  expect(await screen.findByText('Choose a project folder to use native skills.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(mocks.chooseProjectFolder).toHaveBeenCalledOnce());
  await waitFor(() => expect(mocks.listSkills).toHaveBeenCalledWith({ workingDirectory: skill.cwd, forceReload: false }));
  expect(await screen.findByRole('option', { name: /review-diff/u })).toBeTruthy();
  expect(input.value).toBe('$rev');
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
  if (backend === 'codex') expect(mocks.listSkills).toHaveBeenCalledWith({ workingDirectory: skill.cwd, forceReload: false });
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

type SkillScopeFixture = {
  accountId: string;
  workspaceId: string;
  projectId: string;
  chatId: string;
  harness: 'codex' | 'opencode';
};

function renderScopedComposer(scope: SkillScopeFixture) {
  mocks.backend = scope.harness;
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as never,
    projectId: scope.projectId as never,
  });
  return render(<TooltipProvider><Composer chatId={scope.chatId as never} /></TooltipProvider>);
}

function nativeSkillSelectionStorageKey(scope: SkillScopeFixture): string {
  return `vibespace.nativeSkillSelection.v2:${encodeURIComponent(JSON.stringify({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    chatId: scope.chatId,
    harness: scope.harness,
    executionHost: 'local',
    workingDirectory: skill.cwd,
  }))}`;
}

it.each(['codex', 'opencode'] as const)(
  'reuses the live %s skill catalog across selection and another mention until Refresh',
  async (backend) => {
    mocks.backend = backend;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    mocks.listSkills.mockResolvedValue([{ cwd: skill.cwd, skills: [skill], errors: [] }]);
    mocks.listOpenCodeSkills.mockResolvedValue([
      { name: skill.name, location: skill.path, description: skill.description },
    ]);
    useAuthStore.setState({
      localUserId: 'skill-discovery-reuse-account',
      cloudSession: null,
      workspaceId: 'skill-discovery-reuse-workspace' as never,
      projectId: 'skill-discovery-reuse-project' as never,
    });

    render(<TooltipProvider><Composer chatId={`skill-discovery-reuse-${backend}-chat` as never} /></TooltipProvider>);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    const discover = backend === 'codex' ? mocks.listSkills : mocks.listOpenCodeSkills;
    fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const firstOption = await screen.findByRole('option', { name: /review-diff/u });
    if (backend === 'codex') {
      expect(mocks.listSkills).toHaveBeenNthCalledWith(1, {
        workingDirectory: skill.cwd,
        forceReload: false,
      });
    } else {
      expect(mocks.listOpenCodeSkills).toHaveBeenNthCalledWith(1, {
        accountId: 'skill-discovery-reuse-account',
        workspaceId: 'skill-discovery-reuse-workspace',
        projectId: 'skill-discovery-reuse-project',
        workingDirectory: skill.cwd,
      });
    }

    fireEvent.click(firstOption);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy(),
    );
    expect(discover).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
    expect(await screen.findByRole('option', { name: /review-diff/u })).toBeTruthy();
    expect(discover).toHaveBeenCalledTimes(1);

    const refresh = screen.getByRole('button', { name: 'Refresh skills' });
    await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    if (backend === 'codex') expect(mocks.listSkills).toHaveBeenNthCalledWith(2, {
      workingDirectory: skill.cwd,
      forceReload: true,
    });
    expect(screen.getByRole('option', { name: /review-diff/u })).toBeTruthy();
  },
);

it('hides native owner-route details when Codex skill discovery is busy', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listSkills.mockRejectedValue(new Error('Codex app-server is already active for another owner or route.'));
  useAuthStore.setState({ localUserId: 'skill-owner-account', cloudSession: null,
    workspaceId: 'skill-workspace' as never, projectId: 'skill-project' as never });
  render(<TooltipProvider><Composer chatId={'skill-owner-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Skills are busy with another session. Retry shortly.');
  expect(alert.textContent).not.toContain('app-server');
});

it('keeps the exact live skill catalog usable when a manual refresh finds the native route busy', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listSkills.mockResolvedValueOnce([{ cwd: skill.cwd, skills: [skill], errors: [] }])
    .mockRejectedValueOnce(new Error('Codex app-server is already active for another owner or route.'));
  useAuthStore.setState({ localUserId: 'skill-busy-refresh-account', cloudSession: null,
    workspaceId: 'skill-workspace' as never, projectId: 'skill-project' as never });
  render(<TooltipProvider><Composer chatId={'skill-busy-refresh-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  expect(await screen.findByRole('option', { name: /review-diff/u })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Skills are busy'));
  fireEvent.click(screen.getByRole('option', { name: /review-diff/u }));
  expect(await screen.findByRole('button', { name: 'Remove $review-diff' })).toBeTruthy();
});

it('persists a native skill only for its exact account, workspace, project, chat, and harness scope', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.listSkills.mockResolvedValue([{ cwd: skill.cwd, skills: [skill], errors: [] }]);
  const originalScope: SkillScopeFixture = {
    accountId: 'skill-scope-account',
    workspaceId: 'skill-scope-workspace',
    projectId: 'skill-scope-project',
    chatId: 'skill-scope-chat',
    harness: 'codex',
  };
  const otherScopes: SkillScopeFixture[] = [
    { ...originalScope, accountId: 'skill-scope-other-account' },
    { ...originalScope, workspaceId: 'skill-scope-other-workspace' },
    { ...originalScope, projectId: 'skill-scope-other-project' },
    { ...originalScope, chatId: 'skill-scope-other-chat' },
    { ...originalScope, harness: 'opencode' },
  ];
  const ownedKeys = [originalScope, ...otherScopes].map(nativeSkillSelectionStorageKey);
  ownedKeys.forEach((key) => localStorage.removeItem(key));

  try {
    const original = renderScopedComposer(originalScope);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
    const option = await screen.findByRole('option', { name: /review-diff/u });
    fireEvent.click(option);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy(),
    );
    const saved = localStorage.getItem(nativeSkillSelectionStorageKey(originalScope));
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).scope).toEqual({
      accountId: originalScope.accountId,
      workspaceId: originalScope.workspaceId,
      projectId: originalScope.projectId,
      chatId: originalScope.chatId,
      harness: originalScope.harness,
      executionHost: 'local',
      workingDirectory: skill.cwd,
    });
    expect(JSON.parse(saved!).entries).toHaveLength(1);
    original.unmount();

    for (const scope of otherScopes) {
      const isolated = renderScopedComposer(scope);
      expect(screen.queryByRole('button', { name: 'Remove $review-diff' })).toBeNull();
      isolated.unmount();
    }

    const restored = renderScopedComposer(originalScope);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove $review-diff' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove $review-diff' }));
    expect(screen.queryByRole('button', { name: 'Remove $review-diff' })).toBeNull();
    restored.unmount();

    renderScopedComposer(originalScope);
    expect(screen.queryByRole('button', { name: 'Remove $review-diff' })).toBeNull();
  } finally {
    cleanup();
    ownedKeys.forEach((key) => localStorage.removeItem(key));
  }
});
it('clears loading after closing the skill picker during manual refresh', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const initialCatalog = [{ cwd: skill.cwd, skills: [skill], errors: [] }];
  let resolveRefresh!: (entries: typeof initialCatalog) => void;
  const pendingRefresh = new Promise<typeof initialCatalog>((resolve) => {
    resolveRefresh = resolve;
  });
  mocks.listSkills.mockResolvedValueOnce(initialCatalog).mockReturnValueOnce(pendingRefresh);
  useAuthStore.setState({
    localUserId: 'skill-refresh-close-account',
    cloudSession: null,
    workspaceId: 'skill-refresh-close-workspace' as never,
    projectId: 'skill-refresh-close-project' as never,
  });

  render(<TooltipProvider><Composer chatId={'skill-refresh-close-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  expect(await screen.findByRole('option', { name: /review-diff/u })).toBeTruthy();
  await waitFor(() => expect(mocks.listSkills).toHaveBeenCalledTimes(1));

  const refresh = screen.getByRole('button', { name: 'Refresh skills' });
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
  fireEvent.click(refresh);
  await waitFor(() => expect(mocks.listSkills).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(true));

  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox', { name: 'Codex skills' })).toBeNull();
  fireEvent.change(input, { target: { value: 'ordinary prompt', selectionStart: 15 } });
  fireEvent.keyUp(input, { key: 'm' });
  await act(async () => {
    resolveRefresh(initialCatalog);
    await pendingRefresh;
  });

  fireEvent.change(input, { target: { value: '$rev', selectionStart: 4 } });
  fireEvent.keyUp(input, { key: 'v' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh skills' }).hasAttribute('disabled')).toBe(false),
  );
  expect(mocks.listSkills).toHaveBeenCalledTimes(2);
});

it('rediscovers OpenCode skills when project changes with the same working directory', async () => {
  mocks.backend = 'opencode';
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const firstProjectSkill = {
    name: 'project-one-skill',
    location: `${skill.cwd}\\.opencode\\skills\\project-one-skill\\SKILL.md`,
    description: 'First project skill',
  };
  const secondProjectSkill = {
    name: 'project-two-skill',
    location: `${skill.cwd}\\.opencode\\skills\\project-two-skill\\SKILL.md`,
    description: 'Second project skill',
  };
  mocks.listOpenCodeSkills
    .mockResolvedValueOnce([firstProjectSkill])
    .mockResolvedValueOnce([secondProjectSkill]);
  useAuthStore.setState({
    localUserId: 'skill-project-cache-account',
    cloudSession: null,
    workspaceId: 'skill-project-cache-workspace' as never,
    projectId: 'skill-project-cache-one' as never,
  });

  render(<TooltipProvider><Composer chatId={'skill-project-cache-chat' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '$project-one', selectionStart: 12 } });
  await waitFor(() => expect(mocks.listOpenCodeSkills).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('option', { name: /project-one-skill/u })).toBeTruthy();
  expect(mocks.listOpenCodeSkills).toHaveBeenNthCalledWith(1, {
    accountId: 'skill-project-cache-account',
    workspaceId: 'skill-project-cache-workspace',
    projectId: 'skill-project-cache-one',
    workingDirectory: skill.cwd,
  });

  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox', { name: 'OpenCode skills' })).toBeNull();
  act(() => useAuthStore.setState({ projectId: 'skill-project-cache-two' as never }));
  fireEvent.change(input, { target: { value: '$project-two', selectionStart: 12 } });

  await waitFor(() => expect(mocks.listOpenCodeSkills).toHaveBeenCalledTimes(2));
  expect(mocks.listOpenCodeSkills).toHaveBeenNthCalledWith(2, {
    accountId: 'skill-project-cache-account',
    workspaceId: 'skill-project-cache-workspace',
    projectId: 'skill-project-cache-two',
    workingDirectory: skill.cwd,
  });
  expect(await screen.findByRole('option', { name: /project-two-skill/u })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /project-one-skill/u })).toBeNull();
});
