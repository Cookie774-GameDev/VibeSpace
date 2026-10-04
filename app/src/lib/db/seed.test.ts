import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentId, ProjectId, WorkspaceId } from '@/types';
import { useAuthStore } from '@/stores/auth';

const idHarness = vi.hoisted(() => ({
  nanoid: vi.fn(() => 'generated-local-user'),
  newProjectId: vi.fn(() => 'prj_generated'),
  newWorkspaceId: vi.fn(() => 'wsp_generated'),
}));

type StoredRow = Record<string, unknown> & { id: string };

const seedHarness = vi.hoisted(() => {
  const workspaces = new Map<string, StoredRow>();
  const projects = new Map<string, StoredRow>();
  const agents = new Map<string, StoredRow>();
  const factoryTransactionStates: boolean[] = [];
  let transactionActive = false;

  const workspacesTable = {
    count: vi.fn(async () => workspaces.size),
    get: vi.fn(async (id: string) => {
      const row = workspaces.get(id);
      return row ? structuredClone(row) : undefined;
    }),
    add: vi.fn(async (row: StoredRow) => {
      workspaces.set(row.id, structuredClone(row));
      return row.id;
    }),
    toCollection: vi.fn(() => ({
      first: vi.fn(async () => {
        const row = workspaces.values().next().value as StoredRow | undefined;
        return row ? structuredClone(row) : undefined;
      }),
    })),
  };
  const projectsTable = {
    add: vi.fn(async (row: StoredRow) => {
      projects.set(row.id, structuredClone(row));
      return row.id;
    }),
    where: vi.fn((index: string) => ({
      equals: vi.fn((value: unknown) => ({
        first: vi.fn(async () => {
          const row = [...projects.values()].find((candidate) => candidate[index] === value);
          return row ? structuredClone(row) : undefined;
        }),
      })),
    })),
  };
  const agentsTable = {
    add: vi.fn(async (row: StoredRow) => {
      agents.set(row.id, structuredClone(row));
      return row.id;
    }),
    bulkAdd: vi.fn(async (rows: StoredRow[]) => {
      for (const row of rows) agents.set(row.id, structuredClone(row));
    }),
  };
  const db = {
    workspaces: workspacesTable,
    projects: projectsTable,
    agents: agentsTable,
    transaction: vi.fn(async (...args: unknown[]) => {
      const body = args.at(-1);
      if (typeof body !== 'function') throw new Error('missing transaction body');
      transactionActive = true;
      try {
        return await body();
      } finally {
        transactionActive = false;
      }
    }),
  };
  const openDb = vi.fn(async () => db);
  const createBuiltinAgentRoster = vi.fn();

  return {
    agents,
    agentsTable,
    createBuiltinAgentRoster,
    db,
    factoryTransactionStates,
    openDb,
    projects,
    projectsTable,
    reset() {
      workspaces.clear();
      projects.clear();
      agents.clear();
      factoryTransactionStates.length = 0;
      transactionActive = false;
      vi.clearAllMocks();
    },
    recordFactoryCall() {
      factoryTransactionStates.push(transactionActive);
    },
    workspaces,
    workspacesTable,
  };
});

vi.mock('./database', () => ({
  db: seedHarness.db,
  openDb: seedHarness.openDb,
}));

vi.mock('@/lib/jarvis/builtinAgents', () => ({
  createBuiltinAgentRoster: seedHarness.createBuiltinAgentRoster,
}));

vi.mock('nanoid', () => ({ nanoid: idHarness.nanoid }));

vi.mock('@/lib/ids', () => ({
  newProjectId: idHarness.newProjectId,
  newWorkspaceId: idHarness.newWorkspaceId,
}));

import { seedIfEmpty } from './seed';

const NOW = 1_786_000_000_456;

function rosterFixture(): Agent[] {
  return [
    {
      id: 'agt_seed_jarvis' as AgentId,
      slug: 'jarvis',
      name: 'Jarvis',
      description: 'Voice supervisor. Routes intents and decomposes tasks.',
      system_prompt: 'compatibility prompt',
      model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
      tools_allowed: ['*'],
      memory_scope: 'project',
      temperature: 0.3,
      max_output_tokens: 4096,
      color_hue: 195,
      capabilities: ['voice_supervision', 'planning'],
      builtin: true,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'agt_seed_coder' as AgentId,
      slug: 'coder',
      name: 'Coder',
      description: 'Writes, refactors, debugs, and explains code.',
      system_prompt: 'coder prompt',
      model: { provider: 'mock', model: 'mock-default' },
      tools_allowed: ['*'],
      memory_scope: 'project',
      temperature: 0.2,
      max_output_tokens: 8192,
      color_hue: 158,
      capabilities: ['code'],
      builtin: true,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

describe('seedIfEmpty canonical built-ins', () => {
  beforeEach(() => {
    seedHarness.reset();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'usr_seed_test',
      workspaceId: null,
      projectId: null,
    });
    seedHarness.createBuiltinAgentRoster.mockImplementation(() => {
      seedHarness.recordFactoryCall();
      return rosterFixture();
    });
  });

  it('bulk-adds the canonical roster exactly once inside the fresh database transaction', async () => {
    const result = await seedIfEmpty();

    expect(result).toMatchObject({
      seeded: true,
      user_id: 'usr_seed_test',
    });
    expect(seedHarness.createBuiltinAgentRoster).toHaveBeenCalledTimes(1);
    expect(seedHarness.createBuiltinAgentRoster).toHaveBeenCalledWith({ now: NOW });
    expect(seedHarness.factoryTransactionStates).toEqual([true]);
    expect(seedHarness.agentsTable.bulkAdd).toHaveBeenCalledTimes(1);
    expect(seedHarness.agentsTable.bulkAdd).toHaveBeenCalledWith(rosterFixture());
    expect(seedHarness.agentsTable.add).not.toHaveBeenCalled();
    expect([...seedHarness.agents.values()]).toStrictEqual(rosterFixture());

    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });
    expect(seedHarness.createBuiltinAgentRoster).toHaveBeenCalledTimes(1);
    expect(seedHarness.agentsTable.bulkAdd).toHaveBeenCalledTimes(1);
  });

  it('does not replace a complete persisted scope when local workspace rows are temporarily absent', async () => {
    useAuthStore.setState({
      localUserId: 'usr_persisted_scope',
      workspaceId: 'wsp_persisted_scope' as WorkspaceId,
      projectId: 'prj_persisted_scope' as ProjectId,
    });

    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });

    expect(seedHarness.workspacesTable.count).not.toHaveBeenCalled();
    expect(seedHarness.workspacesTable.add).not.toHaveBeenCalled();
    expect(seedHarness.projectsTable.add).not.toHaveBeenCalled();
    expect(seedHarness.agentsTable.bulkAdd).not.toHaveBeenCalled();
    expect(idHarness.newWorkspaceId).not.toHaveBeenCalled();
    expect(idHarness.newProjectId).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      localUserId: 'usr_persisted_scope',
      workspaceId: 'wsp_persisted_scope',
      projectId: 'prj_persisted_scope',
    });
  });

  it('restores a missing local user from the selected saved workspace', async () => {
    seedHarness.workspaces.set('wsp_saved', {
      id: 'wsp_saved', owner_id: 'usr_saved', name: 'Personal', created_at: 1, updated_at: 1,
    });
    useAuthStore.setState({
      localUserId: null,
      workspaceId: 'wsp_saved' as WorkspaceId,
      projectId: 'prj_saved' as ProjectId,
    });
    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });
    expect(useAuthStore.getState().localUserId).toBe('usr_saved');
    expect(useAuthStore.getState().workspaceId).toBe('wsp_saved');
    expect(seedHarness.workspacesTable.add).not.toHaveBeenCalled();
  });

  it('rebinds a stale local identity to the selected saved workspace owner', async () => {
    seedHarness.workspaces.set('wsp_saved', {
      id: 'wsp_saved', owner_id: 'usr_saved', name: 'Personal', created_at: 1, updated_at: 1,
    });
    useAuthStore.setState({
      localUserId: 'usr_stale',
      workspaceId: 'wsp_saved' as WorkspaceId,
      projectId: 'prj_saved' as ProjectId,
    });
    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });
    expect(useAuthStore.getState().localUserId).toBe('usr_saved');
    expect(useAuthStore.getState().workspaceId).toBe('wsp_saved');
    expect(seedHarness.workspacesTable.add).not.toHaveBeenCalled();
  });

  it('rechecks freshness inside the transaction and adopts a concurrent seed winner', async () => {
    const workspace = {
      id: 'wsp_concurrent_winner' as WorkspaceId,
      name: 'Concurrent winner',
      owner_id: 'usr_concurrent_winner',
      created_at: 1,
      updated_at: 1,
    };
    const project = {
      id: 'prj_concurrent_winner' as ProjectId,
      workspace_id: workspace.id,
      name: 'Concurrent project',
      color_hue: 210,
      created_at: 1,
      updated_at: 1,
    };
    seedHarness.workspaces.set(workspace.id, structuredClone(workspace));
    seedHarness.projects.set(project.id, structuredClone(project));
    seedHarness.workspacesTable.count.mockResolvedValueOnce(0);
    useAuthStore.setState({
      localUserId: null,
      workspaceId: 'wsp_stale' as WorkspaceId,
      projectId: 'prj_stale' as ProjectId,
    });

    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });

    expect(seedHarness.workspacesTable.count).toHaveBeenCalledTimes(2);
    expect(seedHarness.createBuiltinAgentRoster).not.toHaveBeenCalled();
    expect(seedHarness.workspacesTable.add).not.toHaveBeenCalled();
    expect(seedHarness.projectsTable.add).not.toHaveBeenCalled();
    expect(seedHarness.agentsTable.bulkAdd).not.toHaveBeenCalled();
    expect(idHarness.nanoid).not.toHaveBeenCalled();
    expect(idHarness.newWorkspaceId).not.toHaveBeenCalled();
    expect(idHarness.newProjectId).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      localUserId: workspace.owner_id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
  });

  it('preserves historical and custom agents byte-for-byte on a non-fresh database', async () => {
    const workspace = {
      id: 'wsp_existing' as WorkspaceId,
      name: 'Historical workspace',
      owner_id: 'usr_historical',
      created_at: 1,
      updated_at: 2,
    };
    const project = {
      id: 'prj_existing' as ProjectId,
      workspace_id: workspace.id,
      name: 'Historical project',
      color_hue: 77,
      created_at: 3,
      updated_at: 4,
    };
    seedHarness.workspaces.set(workspace.id, structuredClone(workspace));
    seedHarness.projects.set(project.id, structuredClone(project));
    seedHarness.agents.set('agt_historical', {
      ...rosterFixture()[0]!,
      id: 'agt_historical',
      system_prompt: 'historical prompt must remain byte-for-byte',
      temperature: 0.6,
      capabilities: ['voice_supervision', 'reasoning'],
    });
    seedHarness.agents.set('agt_custom', {
      ...rosterFixture()[1]!,
      id: 'agt_custom',
      slug: 'custom-agent',
      builtin: false,
      model: { provider: 'openai', model: 'custom-model' },
    });
    const before = structuredClone([...seedHarness.agents.entries()]);
    useAuthStore.setState({ localUserId: null, workspaceId: null, projectId: null });

    await expect(seedIfEmpty()).resolves.toEqual({ seeded: false });

    expect(seedHarness.createBuiltinAgentRoster).not.toHaveBeenCalled();
    expect(seedHarness.agentsTable.add).not.toHaveBeenCalled();
    expect(seedHarness.agentsTable.bulkAdd).not.toHaveBeenCalled();
    expect([...seedHarness.agents.entries()]).toStrictEqual(before);
    expect(useAuthStore.getState()).toMatchObject({
      localUserId: 'usr_historical',
      workspaceId: workspace.id,
      projectId: project.id,
    });
  });
});
