import { beforeEach, expect, it, vi } from 'vitest';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from '@/features/jarvis-memory/caoGuidance';
const mocks = vi.hoisted(() => ({
  account: 'account',
  owner: 'account',
  generation: 'generation',
  permission: { enabled: true, mode: 'approve-before-send', learningEpoch: 'epoch' },
  invoke: vi.fn(),
  put: vi.fn(),
  model: vi.fn(),
  pendingRows: new Map<string, unknown>(),
  readLiveTargetSnapshot: vi.fn(async () => [
    {
      sessionId: 'tty',
      paneId: 'pane',
      projectId: 'project',
      ordinal: 1,
      processIdentity: {
        projectId: 'project',
        processInstanceId: 'instance',
        pid: 42,
        processStartedAt: 100,
        runtimeGeneration: mocks.generation,
      },
    },
  ]),
  profile: {} as Record<string, unknown>,
  input: '',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: mocks.account }),
}));
vi.mock('@/lib/db', () => ({
  db: {
    projects: { get: async () => ({ workspace_id: 'workspace' }) },
    workspaces: { get: async () => ({ owner_id: mocks.owner }) },
    settings: {
      get: async () => ({ value: mocks.permission }),
      put: mocks.put,
      delete: async () => undefined,
    },
  },
}));
vi.mock('@/features/jarvis-memory/learningStore', () => ({
  useJarvisLearningStore: {
    getState: () => ({ activeAccountId: mocks.account, currentProfile: () => mocks.profile }),
  },
}));
vi.mock('@/features/jarvis-memory/caoChatControlProduction', () => ({
  caoPermissionKey: (id: string) => id,
  caoChatProposalPersistence: {
    save: async (entry: { proposal: { id: string } }) => {
      mocks.pendingRows.set(entry.proposal.id, entry);
    },
    take: async (id: string) => {
      const entry = mocks.pendingRows.get(id);
      mocks.pendingRows.delete(id);
      return entry;
    },
    remove: async (id: string) => {
      mocks.pendingRows.delete(id);
    },
  },
}));
vi.mock('@/features/instant-command/targetSnapshot', () => ({
  readLiveTargetSnapshot: mocks.readLiveTargetSnapshot,
}));
vi.mock('@/features/terminals/transcriptStore', () => ({
  useTerminalTranscriptStore: {
    getState: () => ({
      sessions: {
        tty: {
          paneId: 'pane',
          projectId: 'project',
          text: 'Observed build output',
          lastWriteAt: 100,
          currentInput: mocks.input,
        },
      },
    }),
  },
}));
vi.mock('./terminalControlModel', () => ({ caoTerminalModel: mocks.model }));
import {
  caoTerminalControl,
  listCaoTerminals,
  reviewCaoTerminal,
} from './terminalControlProduction';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pendingRows.clear();
  mocks.account = 'account';
  mocks.owner = 'account';
  mocks.generation = 'generation';
  mocks.input = '';
  mocks.permission = { enabled: true, mode: 'approve-before-send', learningEpoch: 'epoch' };
  mocks.profile = {
    enabled: true,
    caoLearningEpoch: 'epoch',
    caoGuidance: parseCaoGuidance(
      JSON.stringify({
        sections: Object.fromEntries(
          CAO_GUIDANCE_AREAS.map((area) => [
            area,
            {
              guidance: 'Use observed results and focused instructions when coordinating an agent.',
              sourceIds: ['m1'],
            },
          ]),
        ),
      }),
      ['m1'],
    ),
  };
  mocks.invoke.mockImplementation(async (command) =>
    command === 'terminal_list'
      ? [{ sessionId: 'tty', command: 'C:\\agents\\opencode.exe', cwd: 'C:\\game' }]
      : undefined,
  );
  mocks.model.mockResolvedValue({
    text: 'Please build and verify the game.',
    receipt: { requestId: 'request' },
  });
});
it('binds delivery to exact native process and keeps learned output out of user learning events', async () => {
  const proposal = await caoTerminalControl.prepare(
    'account',
    'tty',
    'Build game',
    new AbortController().signal,
  );
  await caoTerminalControl.approve(proposal.id);
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_write', {
    sessionId: 'tty',
    data: proposal.text,
    agentMessage: true,
    expectedBinding: {
      projectId: 'project',
      processInstanceId: 'instance',
      pid: 42,
      processStartedAt: 100,
      runtimeGeneration: 'generation',
    },
  });
  expect(mocks.model).toHaveBeenCalledWith(
    expect.objectContaining({
      evidence: expect.stringContaining('Observed build output'),
      guidance: mocks.profile.caoGuidance,
    }),
  );
});
it.each(['generation', 'owner', 'input', 'permission'] as const)(
  'rejects changed %s before delivery',
  async (change) => {
    const proposal = await caoTerminalControl.prepare(
      'account',
      'tty',
      'Build game',
      new AbortController().signal,
    );
    if (change === 'permission') mocks.permission.enabled = false;
    else mocks[change] = 'changed';
    await expect(caoTerminalControl.approve(proposal.id)).rejects.toThrow();
    expect(mocks.invoke.mock.calls.some((call) => call[0] === 'terminal_write')).toBe(false);
  },
);
it('excludes another account’s terminals', async () => {
  mocks.owner = 'other';
  expect(await listCaoTerminals('account')).toEqual([]);
});
it('forwards an explicit project scope to live terminal discovery', async () => {
  await listCaoTerminals('account', 'project');
  expect(mocks.readLiveTargetSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'project' }),
  );
});
it('persists a model review without sending terminal input', async () => {
  await reviewCaoTerminal('account', 'tty', 'Check quality', 'grade', new AbortController().signal);
  expect(mocks.put).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'cao.terminal.review.v1:account:request' }),
  );
  expect(mocks.invoke.mock.calls.some((call) => call[0] === 'terminal_write')).toBe(false);
});

it('requires approval before stopping the exact terminal and records observed exit', async () => {
 const { caoTerminalLifecycleControls }=await import('./terminalControlProduction');
 const { caoTerminalPaneRegistry }=await import('./terminalPaneControl');
 const { newLeaf }=await import('@/features/terminals/paneTree');
 const pane={...newLeaf({command:'C:\\agents\\opencode.exe'}),kind:'leaf' as const,id:'pane',sessionId:'tty'};
 const release=caoTerminalPaneRegistry.register('account','project',()=>true,()=>pane,()=>{});
 let stopped=false;
 mocks.invoke.mockImplementation(async command=>{if(command==='terminal_list')return stopped?[]:[{sessionId:'tty',command:'C:\\agents\\opencode.exe',cwd:'C:\\game'}];if(command==='terminal_kill'){stopped=true;return {kind:'signal_delivered'}}});
 try {const proposal=await caoTerminalLifecycleControls.cancel.prepare('account','tty','Stop the captured completed game agent',new AbortController().signal);
 expect(stopped).toBe(false);await caoTerminalLifecycleControls.cancel.approve(proposal.id);
 expect(mocks.invoke).toHaveBeenCalledWith('terminal_kill',expect.objectContaining({sessionId:'tty',expectedBinding:expect.objectContaining({pid:42,processInstanceId:'instance'})}));
 expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({value:expect.objectContaining({status:'stopped',stopped:true})}));
 await expect(caoTerminalLifecycleControls.cancel.approve(proposal.id)).rejects.toThrow('cao_proposal_unavailable');
 } finally {release()}
});
