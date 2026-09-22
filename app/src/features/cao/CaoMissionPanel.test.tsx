import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';
import type { Chat } from '@/types/chat';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import type { CaoLiveExecutionCatalog } from './executionProfile';
import type { CaoMission } from './mission/types';
import type { CaoMissionStartResult } from './mission/productionController';
import type { CaoMissionController } from './CaoMissionPanel';
import {
  CaoMissionPanel,
  readCaoChatTargetIdentity,
  readCaoTerminalTargetIdentity,
} from './CaoMissionPanel';
import {
  invalidateCaoTerminalExecutionIdentity,
  observeCaoTerminalOpenCodeEvent,
  resetCaoTerminalExecutionIdentityForTests,
} from './terminalExecutionIdentity';

const mocks = vi.hoisted(() => ({
  targets: [] as unknown[],
  missionRows: [] as unknown[],
  readCatalog: vi.fn(),
  recoverScope: vi.fn(),
  loadProfile: vi.fn(),
  persistProfile: vi.fn(),
  listChats: vi.fn(),
  listTerminals: vi.fn(),
  listCaoTerminals: vi.fn(),
  database: { cao_missions: { toArray: vi.fn() } },
  productionController: {
    start: vi.fn(),
    get: vi.fn(async () => undefined),
    cancel: vi.fn(),
  },
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, deps?: readonly unknown[]) =>
    deps?.[0] === 'mission-1'
      ? { chats: [], messages: [], jev: [] }
      : deps?.length === 4
        ? mocks.targets
        : mocks.missionRows,
}));
vi.mock('@/lib/db', () => ({ db: mocks.database }));
vi.mock('@/features/access/workspaceRestore', () => ({
  recoverMissingPersistedLocalScope: mocks.recoverScope,
}));
vi.mock('./CaoModelPicker', () => ({
  CaoModelPicker: ({
    label,
    value,
    disabled,
  }: {
    label: string;
    value?: { modelId: string };
    disabled?: boolean;
  }) => (
    <button aria-label={label} disabled={disabled}>
      {value?.modelId ?? 'Choose a model'}
    </button>
  ),
}));
vi.mock('./CaoDeskScene', () => ({ CaoDeskScene: () => <div aria-label="Desk scene" /> }));
vi.mock('@/features/settings/components/JevCredentialCard', () => ({
  JevCredentialCard: () => <div>Shared Jev settings</div>,
}));
vi.mock('./missionDraft', async () => {
  const actual = await vi.importActual<typeof import('./missionDraft')>('./missionDraft');
  const { useState } = await import('react');
  return {
    ...actual,
    useCaoSetupDraft: () => {
      const [draft, setDraft] = useState<import('./missionDraft').CaoSetupDraft>({
        objective: '',
        step: 0,
        targets: [],
        editing: false,
      });
      return {
        draft,
        update: (field: keyof typeof draft, action: unknown) =>
          setDraft((current) => ({
            ...current,
            [field]: typeof action === 'function' ? action(current[field]) : action,
          })),
      };
    },
  };
});

vi.mock('@/lib/db/repositories', () => ({
  chatRepo: { listByProject: mocks.listChats },
  terminalSessionRepo: { listByProject: mocks.listTerminals },
}));
vi.mock('./productionLifecycle', () => ({ readLiveCaoExecutionCatalog: mocks.readCatalog }));
vi.mock('./terminalControlProduction', () => ({ listCaoTerminals: mocks.listCaoTerminals }));
vi.mock('./mission/productionController', () => ({
  caoProductionController: mocks.productionController,
}));
vi.mock('./executionProfile', async () => {
  const actual = await vi.importActual<typeof import('./executionProfile')>('./executionProfile');
  return {
    ...actual,
    loadCaoExecutionProfile: mocks.loadProfile,
    persistCaoExecutionProfile: mocks.persistProfile,
  };
});

const scope = {
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
} as const;
const terminalProcess: ExpectedTerminalProcessBinding = {
  projectId: scope.projectId,
  processInstanceId: 'terminal-process-a',
  pid: 42,
  processStartedAt: 1_780_000_000_000,
  runtimeGeneration: 'terminal-runtime-a',
};
const liveTerminal = {
  sessionId: 'terminal-a',
  paneId: 'pane-a',
  projectId: scope.projectId,
  processIdentity: terminalProcess,
};
const catalog: CaoLiveExecutionCatalog = {
  source: 'live',
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  catalogGeneration: 'live-test',
  catalogHash: 'a'.repeat(64),
  verifiedAt: 100,
  entries: [
    {
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    },
    {
      backend: 'opencode',
      providerId: 'opencode',
      connectionId: 'opencode-cli',
      modelId: 'openai/gpt-5.6-luna',
      reasoningEffort: 'low',
    },
  ],
};
const persistedCodexChat = {
  id: 'chat-codex',
  workspace_id: scope.workspaceId,
  project_id: scope.projectId,
  title: 'Persisted Codex chat',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 1,
  updated_at: 2,
  connection: {
    id: 'openai-codex',
    providerId: 'openai',
    modelId: 'gpt-5.6-luna',
  },
} as unknown as Chat;
const codexDiscoveryModel = {
  id: 'gpt-5.6-luna',
  label: 'GPT-5.6 Luna',
  variants: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  source: 'cli_model' as const,
  lastVerifiedAt: 100,
};
const mission: CaoMission = {
  id: 'mission-1',
  schemaVersion: 1,
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  projectId: scope.projectId,
  objective: 'Review the selected work',
  createdAt: 1,
  updatedAt: 2,
  status: 'running',
  contextMapId: null,
  workers: [],
  milestones: [],
  latestPlanRevision: 1,
  lastCaoWakeAt: null,
};

function controller(): CaoMissionController {
  return {
    start: vi.fn(async () => ({
      mission,
      profile: {
        schemaVersion: 1 as const,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        backend: 'codex' as const,
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
        catalogReceipt: { ...catalog, source: 'live' as const },
        updatedAt: 1,
      },
      planText: 'Plan the selected work and wait for verified receipts.',
      receipt: {} as CaoMissionStartResult['receipt'],
      assignments: [],
    })),
    cancel: vi.fn(async () => ({ ...mission, status: 'cancelled' as const })),
    get: vi.fn(async () => undefined),
  };
}

function renderPanel(overrides: Partial<CaoMissionController> = {}) {
  const production = controller();
  const supplied = { ...production, ...overrides } as CaoMissionController;
  render(<CaoMissionPanel scope={scope} callerChatId="chat-caller" controller={supplied} />);
  return supplied;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDiscoveredConnectionModelsForTests();
  localStorage.removeItem('vibespace.chat-reasoning.v1');
  localStorage.removeItem('vibespace.chat-runtime-settings.v1');
  mocks.targets = [
    {
      kind: 'chat',
      targetId: 'chat-a',
      title: 'Chat A',
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      status: 'ready',
      identity: {
        backend: 'opencode',
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
    },
    {
      kind: 'terminal',
      targetId: 'terminal-a',
      title: 'Terminal A',
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      status: 'running',
      identity: {
        backend: 'opencode',
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
    },
  ];
  mocks.missionRows = [
    {
      id: mission.id,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      updatedAt: mission.updatedAt,
      status: mission.status,
    },
  ];
  mocks.readCatalog.mockResolvedValue(catalog);
  mocks.loadProfile.mockResolvedValue(undefined);
  mocks.persistProfile.mockResolvedValue(undefined);
  mocks.database.cao_missions.toArray.mockResolvedValue([]);
  mocks.listChats.mockResolvedValue([
    {
      id: 'chat-a',
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      title: 'Chat A',
      mode: 'chat',
      active_agent_ids: [],
      updated_at: 4,
      created_at: 1,
    },
    {
      id: 'chat-foreign',
      workspace_id: scope.workspaceId,
      project_id: 'project-foreign',
      title: 'Foreign Chat',
      mode: 'chat',
      active_agent_ids: [],
      updated_at: 3,
      created_at: 1,
    },
  ]);
  mocks.listTerminals.mockResolvedValue([
    {
      id: 'terminal-a',
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      title: 'Terminal A',
      shell_command: 'pwsh',
      shell_args: [],
      status: 'running',
      cols: 80,
      rows: 24,
      one_shot: false,
      created_at: 1,
      last_active_at: 4,
    },
  ]);
  mocks.listCaoTerminals.mockResolvedValue([liveTerminal]);
  observeCaoTerminalOpenCodeEvent(
    {
      accountId: scope.accountId,
      projectId: scope.projectId,
      paneId: liveTerminal.paneId,
      sessionId: liveTerminal.sessionId,
      process: terminalProcess,
    },
    {
      type: 'step_start',
      sessionID: liveTerminal.sessionId,
      part: { modelID: 'openai/gpt-5.6-luna', variant: 'low' },
    },
    1,
  );
});

afterEach(() => {
  resetCaoTerminalExecutionIdentityForTests();
  resetDiscoveredConnectionModelsForTests();
});

async function advanceToTeam() {
  fireEvent.change(screen.getByRole('textbox', { name: 'CAO mission objective' }), {
    target: { value: 'Review the selected work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'CAO coordination model' }).textContent).toContain(
      'gpt-5.6-luna',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('checkbox', { name: /^Chat A/ });
  expect(mocks.persistProfile).toHaveBeenCalledTimes(1);
}

describe('CAO mission entry', () => {
  it('shows a persisted launch failure when the mission panel is reopened', async () => {
    renderPanel({
      get: vi.fn(async () => ({
        ...mission,
        status: 'cancelled' as const,
        failureReason: 'cao_snapshot_target_invalid',
      })),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('cao snapshot target invalid');
    expect(screen.getByRole('button', { name: 'New mission' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New mission' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('uses guided setup and leaves assignments to CAO when starting verified project targets', async () => {
    const production = renderPanel();
    await advanceToTeam();
    expect(screen.getByRole('checkbox', { name: /^Chat A/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /^Terminal A/ })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Foreign Chat/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Assignment/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Chat A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review mission' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run mission' }));
    await waitFor(() => expect(production.start).toHaveBeenCalledTimes(1));
    expect(production.start).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        objective: 'Review the selected work',
        callerChatId: 'chat-caller',
        assignmentMode: 'automatic',
        mainProfile: {
          backend: 'codex',
          connectionId: 'openai-codex',
          modelId: 'gpt-5.6-luna',
          reasoningEffort: 'medium',
        },
        workers: [
          {
            targetId: 'chat-a',
            kind: 'chat',
            assignment: 'Awaiting CAO analysis',
            backend: 'opencode',
            connectionId: 'opencode-cli',
            modelId: 'openai/gpt-5.6-luna',
            reasoningEffort: 'low',
            ownedPaths: [],
          },
        ],
      }),
    );
  });

  it('explains an unavailable project without retrying or claiming the mission started', async () => {
    const start = vi.fn().mockRejectedValue(new Error('cao_mission_scope_unavailable'));
    renderPanel({ start });
    await advanceToTeam();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Chat A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review mission' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run mission' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Select an accessible project, then reopen CAO. The mission has not started.',
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel mission' })).toBeNull();
    mocks.recoverScope.mockResolvedValueOnce({ status: 'not_recoverable' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore local project' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not be safely recovered',
    );
    expect(mocks.recoverScope).toHaveBeenCalledWith(scope);
    expect(start).toHaveBeenCalledTimes(1);
    mocks.recoverScope.mockResolvedValueOnce({ status: 'recovered' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore local project' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('Local project restored');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('prevents execution without a selected team and never asks for manual assignments', async () => {
    const production = renderPanel();
    await advanceToTeam();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Choose at least one chat or terminal.',
    );
    expect(screen.queryByRole('button', { name: 'Run mission' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Assignment/ })).toBeNull();
    expect(production.start).not.toHaveBeenCalled();
  });

  it('cancels a live mission through the production controller', async () => {
    const get = vi.fn(async () => mission);
    const cancel = vi.fn(async () => ({ ...mission, status: 'cancelled' as const }));
    const production = renderPanel({ get, cancel });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel mission' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel mission' }));
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        ...scope,
        missionId: 'mission-1',
        reason: 'user_requested',
      }),
    );
  });

  it('shows Sentinel observation only for workers with persisted revisions', async () => {
    const observedMission: CaoMission = {
      ...mission,
      workers: [
        {
          targetId: 'chat-a',
          kind: 'chat',
          backend: 'opencode',
          connectionId: 'opencode-cli',
          modelId: 'openai/gpt-5.6-luna',
          reasoningEffort: 'low',
          assignment: 'Review chat evidence',
          ownedPaths: ['src/chat'],
          status: 'done',
          lastObservedRevision: 0,
        },
        {
          targetId: 'terminal-a',
          kind: 'terminal',
          backend: 'codex',
          connectionId: 'openai-codex',
          modelId: 'gpt-5.6-luna',
          reasoningEffort: 'medium',
          assignment: 'Review terminal evidence',
          ownedPaths: ['src/terminal'],
          status: 'assigned',
          lastObservedRevision: null,
        },
      ],
    };
    renderPanel({ get: vi.fn(async () => observedMission) });

    await waitFor(() => {
      const sentinel = screen.getByText('Sentinel observations').parentElement;
      expect(sentinel?.textContent).toContain('1/2 targets');
      expect(sentinel?.textContent).not.toContain('Jev');
    });
  });

  it('derives a persisted Codex chat route from the live catalog without a local effort override', () => {
    setDiscoveredConnectionModels('openai-codex', [codexDiscoveryModel]);

    expect(readCaoChatTargetIdentity(persistedCodexChat)).toEqual({
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    });
    expect(
      readCaoChatTargetIdentity({
        ...persistedCodexChat,
        connection: {
          id: 'openai-codex',
          providerId: 'openai',
          modelId: 'gpt-5.6-unknown',
        },
      } as Chat),
    ).toBeUndefined();

    localStorage.setItem(
      'vibespace.chat-reasoning.v1',
      JSON.stringify({
        version: 1,
        chats: { 'chat-codex': { mode: 'normal', effortOverride: 'ultra', updatedAt: 1 } },
      }),
    );
    expect(readCaoChatTargetIdentity(persistedCodexChat)).toBeUndefined();
  });

  it('refreshes the live CAO catalog when model discovery arrives after panel mount', async () => {
    mocks.readCatalog.mockReset();
    mocks.readCatalog
      .mockRejectedValueOnce(new Error('cao_execution_catalog_unavailable'))
      .mockResolvedValue(catalog);
    renderPanel();

    await waitFor(() => expect(mocks.readCatalog).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: 'CAO mission objective' }), {
      target: { value: 'Review the selected work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    act(() => {
      setDiscoveredConnectionModels('openai-codex', [
        { ...codexDiscoveryModel, variants: ['medium'] },
      ]);
    });

    await waitFor(() => expect(mocks.readCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'CAO coordination model' }).textContent).toContain(
        'gpt-5.6-luna',
      ),
    );
  });

  it('accepts only a current pane-bound terminal receipt in the requested scope', () => {
    expect(
      readCaoTerminalTargetIdentity(scope.accountId, scope.projectId, liveTerminal.sessionId, [
        liveTerminal,
      ]),
    ).toEqual({
      backend: 'opencode',
      providerId: 'opencode',
      connectionId: 'opencode-cli',
      modelId: 'openai/gpt-5.6-luna',
      reasoningEffort: 'low',
    });
    expect(
      readCaoTerminalTargetIdentity(scope.accountId, scope.projectId, liveTerminal.sessionId, [
        { ...liveTerminal, processIdentity: { ...terminalProcess, pid: 43 } },
      ]),
    ).toBeUndefined();
    expect(
      readCaoTerminalTargetIdentity('account-other', scope.projectId, liveTerminal.sessionId, [
        liveTerminal,
      ]),
    ).toBeUndefined();
    expect(
      readCaoTerminalTargetIdentity(scope.accountId, 'project-other', liveTerminal.sessionId, [
        liveTerminal,
      ]),
    ).toBeUndefined();
  });

  it('refreshes terminal route availability when the bound receipt changes', async () => {
    resetCaoTerminalExecutionIdentityForTests();
    const chatTarget = mocks.targets[0];
    const terminalTarget = mocks.targets[1] as Record<string, unknown>;
    mocks.targets = [chatTarget, { ...terminalTarget, identity: undefined }];

    renderPanel();
    await advanceToTeam();
    expect(screen.queryByRole('checkbox', { name: /^Terminal A/ })).toBeNull();

    const binding = {
      accountId: scope.accountId,
      projectId: scope.projectId,
      paneId: liveTerminal.paneId,
      sessionId: liveTerminal.sessionId,
      process: terminalProcess,
    };
    let receipt: ReturnType<typeof observeCaoTerminalOpenCodeEvent>;
    act(() => {
      receipt = observeCaoTerminalOpenCodeEvent(
        binding,
        {
          type: 'step_start',
          sessionID: liveTerminal.sessionId,
          part: { modelID: 'openai/gpt-5.6-luna', variant: 'low' },
        },
        2,
      );
      mocks.targets = [chatTarget, { ...terminalTarget, identity: receipt?.identity }];
    });
    expect(receipt).toBeTruthy();

    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /^Terminal A/ }) as HTMLInputElement).disabled,
      ).toBe(false),
    );

    act(() => {
      mocks.targets = [chatTarget, { ...terminalTarget, identity: undefined }];
      invalidateCaoTerminalExecutionIdentity(binding);
    });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /^Terminal A/ })).toBeNull());
  });
});
