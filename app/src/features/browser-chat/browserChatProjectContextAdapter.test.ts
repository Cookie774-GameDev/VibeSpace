import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { RepositoryRetrievalResult } from '@/features/context/repositoryRetrieval';
import { BrowserChatApprovalBroker } from './approvalBroker';
import {
  createBrowserChatProjectContextAdapter,
  type BrowserChatProjectContextDependencies,
} from './browserChatProjectContextAdapter';
import {
  BROWSER_CHAT_CAPABILITIES,
  type BrowserChatCapabilityId,
  type BrowserChatCapabilityLease,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

const ACCOUNT = 'account-a';
const WORKSPACE = 'workspace-a' as WorkspaceId;
const PROJECT = 'project-a' as ProjectId;

function profile(): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    plan: 'read',
    overrides: {},
    updatedAt: 1,
  };
}

function broker(): BrowserChatApprovalBroker {
  let token = 0;
  const capabilities = new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id));
  return new BrowserChatApprovalBroker({
    profile: profile(),
    grantedCapabilities: capabilities,
    availableCapabilities: capabilities,
    providerCapabilities: capabilities,
    providerBridgeAvailable: true,
    leaseIdFactory: () => `context-lease-${++token}`,
  });
}

function lease(
  approvalBroker: BrowserChatApprovalBroker,
  capabilityId: BrowserChatCapabilityId,
  now = 100,
): BrowserChatCapabilityLease {
  const decision = approvalBroker.authorize(capabilityId, { now, ttlMs: 5_000 });
  if (decision.kind !== 'granted') throw new Error(`expected ${capabilityId} grant`);
  return decision.lease;
}

async function database(): Promise<JarvisDexie> {
  const value = createJarvisDb(uniqueTestDbName('browser-chat-project-context'), TEST_INDEXED_DB);
  await value.open();
  await value.workspaces.bulkAdd([
    { id: WORKSPACE, name: 'Primary', owner_id: ACCOUNT, created_at: 1, updated_at: 1 },
    {
      id: 'workspace-b' as WorkspaceId,
      name: 'Foreign',
      owner_id: 'account-b',
      created_at: 1,
      updated_at: 1,
    },
  ]);
  await value.projects.bulkAdd([
    {
      id: PROJECT,
      workspace_id: WORKSPACE,
      name: 'VibeSpace',
      system_prompt_context: 'Prefer verified sources.',
      created_at: 1,
      updated_at: 20,
    },
    {
      id: 'project-b' as ProjectId,
      workspace_id: 'workspace-b' as WorkspaceId,
      name: 'Foreign project',
      system_prompt_context: 'Do not expose.',
      created_at: 1,
      updated_at: 30,
    },
  ]);
  await value.context_maps.bulkAdd([
    {
      version: 2,
      id: 'map-a',
      accountId: ACCOUNT,
      projectId: PROJECT,
      name: 'Repository map',
      status: 'active',
      sourceIds: ['source-a'],
      summary: 'Verified repository context.',
      recommendedEntryPoints: [],
      statistics: {
        sourceCount: 1,
        entityCount: 2,
        edgeCount: 1,
        noteCount: 0,
        attachmentCount: 0,
        staleSourceCount: 0,
      },
      createdAt: 1,
      updatedAt: 10,
      knowledgeRevision: 2,
    },
    {
      version: 2,
      id: 'map-foreign',
      accountId: 'account-b',
      projectId: PROJECT,
      name: 'Foreign map',
      status: 'active',
      sourceIds: [],
      summary: 'Do not expose.',
      recommendedEntryPoints: [],
      statistics: {
        sourceCount: 0,
        entityCount: 0,
        edgeCount: 0,
        noteCount: 0,
        attachmentCount: 0,
        staleSourceCount: 0,
      },
      createdAt: 1,
      updatedAt: 10,
      knowledgeRevision: 1,
    },
  ]);
  await value.jarvis_runs.bulkAdd([
    {
      id: 'run-a',
      account_id: ACCOUNT,
      workspace_id: WORKSPACE,
      project_id: PROJECT,
      source: 'browser_chat',
      status: 'completed',
      agent_id: 'jarvis',
      identity_version: 1,
      profile_revision_id: 'revision-a',
      model: {
        provider_id: 'local',
        model_id: 'fixture',
        connection_mode: 'local',
        capabilities: {},
        captured_at: 1,
      },
      created_at: 1,
      updated_at: 30,
      completed_at: 30,
    },
    {
      id: 'run-foreign',
      account_id: 'account-b',
      workspace_id: WORKSPACE,
      project_id: PROJECT,
      source: 'browser_chat',
      status: 'completed',
      agent_id: 'jarvis',
      identity_version: 1,
      profile_revision_id: 'revision-b',
      model: {
        provider_id: 'local',
        model_id: 'fixture',
        connection_mode: 'local',
        capabilities: {},
        captured_at: 1,
      },
      created_at: 1,
      updated_at: 40,
      completed_at: 40,
    },
  ]);
  await value.jarvis_artifacts.bulkAdd([
    {
      schema_version: 1,
      id: 'artifact-a',
      run_id: 'run-a',
      request_id: 'request-a',
      attempt_number: 1,
      state: 'ready',
      kind: 'code',
      title: 'Generated adapter',
      safe_summary: 'A verified generated source file.',
      content_hash: `sha256:${'a'.repeat(64)}`,
      size_bytes: 42,
      source_refs: [],
      created_at: 30,
    },
    {
      schema_version: 1,
      id: 'artifact-foreign',
      run_id: 'run-foreign',
      request_id: 'request-b',
      attempt_number: 1,
      state: 'ready',
      kind: 'text',
      title: 'Foreign output',
      source_refs: [],
      created_at: 40,
    },
  ]);
  return value;
}

function retrieval(): RepositoryRetrievalResult {
  return {
    mapId: 'map-a',
    repositoryRevision: 'revision-a',
    structuralRevision: 2,
    items: [
      {
        path: 'src/index.ts',
        language: 'typescript',
        representation: 'full',
        content: 'export const ready = true;',
        tokens: 8,
        whySelected: ['task_relevance'],
        symbols: [],
        evidence: {
          mapId: 'map-a',
          entityId: 'entity-a',
          sourceId: 'source-a',
          provenanceId: 'provenance-a',
          sourceRevision: 'source-revision-a',
          repositoryRevision: 'revision-a',
          contentHash: `sha256:${'b'.repeat(64)}`,
          astHash: `sha256:${'c'.repeat(64)}`,
          parserId: 'tree-sitter',
          parserVersion: '1',
        },
      },
    ],
    relationships: [],
    exclusions: [],
    totalTokens: 8,
    remainingTokens: 248,
    parsedChangedPaths: [],
  };
}

describe('Browser Chat project/context adapter', () => {
  let db: JarvisDexie | undefined;
  afterEach(async () => {
    if (!db) return;
    db.close();
    await db.delete();
    db = undefined;
  });

  it('lists only the approved workspace and returns the exact active project summary', async () => {
    db = await database();
    const approvalBroker = broker();
    const adapter = createBrowserChatProjectContextAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      database: db,
    });

    await expect(
      adapter.listProjects({ lease: lease(approvalBroker, 'project.list'), now: 100 }),
    ).resolves.toEqual({
      projects: [{ id: PROJECT, name: 'VibeSpace', updatedAt: 20 }],
      truncated: false,
    });
    await expect(
      adapter.getActiveProject({ lease: lease(approvalBroker, 'project.context', 200), now: 200 }),
    ).resolves.toMatchObject({
      id: PROJECT,
      name: 'VibeSpace',
      instructions: 'Prefer verified sources.',
      instructionsState: 'available',
    });

    const mismatched = createBrowserChatProjectContextAdapter({
      accountId: ACCOUNT,
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      approvalBroker,
      database: db,
    });
    await expect(
      mismatched.listProjects({
        lease: lease(approvalBroker, 'project.list', 300),
        now: 300,
      }),
    ).rejects.toMatchObject({ code: 'scope_invalid' });
  });

  it('returns account-scoped map provenance and bounded verified retrieval evidence', async () => {
    db = await database();
    const approvalBroker = broker();
    const retrieveLiveRepositoryContext = vi.fn(async () => retrieval());
    const dependencies: Partial<BrowserChatProjectContextDependencies> = {
      retrieveLiveRepositoryContext,
    };
    const adapter = createBrowserChatProjectContextAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      database: db,
      dependencies,
    });

    await expect(
      adapter.listContextMaps({
        lease: lease(approvalBroker, 'project.context', 100),
        now: 100,
      }),
    ).resolves.toMatchObject({
      maps: [{ id: 'map-a', name: 'Repository map', knowledgeRevision: 2 }],
    });
    await expect(
      adapter.searchContext({
        lease: lease(approvalBroker, 'project.context', 200),
        query: 'entry point',
        tokenBudget: 256,
        now: 200,
      }),
    ).resolves.toMatchObject({
      mapId: 'map-a',
      repositoryRevision: 'revision-a',
      items: [
        {
          path: 'src/index.ts',
          content: 'export const ready = true;',
          evidence: {
            sourceId: 'source-a',
            provenanceId: 'provenance-a',
            contentHash: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
    });
    expect(retrieveLiveRepositoryContext).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      projectId: PROJECT,
      taskText: 'entry point',
      tokenBudget: 256,
    });
  });

  it('lists only safe local output metadata joined through exact account/project runs', async () => {
    db = await database();
    const approvalBroker = broker();
    const adapter = createBrowserChatProjectContextAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      database: db,
    });

    const result = await adapter.listOutputs({
      lease: lease(approvalBroker, 'project.outputs'),
      now: 100,
    });
    expect(result).toEqual({
      outputs: [
        {
          id: 'artifact-a',
          runId: 'run-a',
          state: 'ready',
          kind: 'code',
          title: 'Generated adapter',
          summary: 'A verified generated source file.',
          contentHash: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 42,
          createdAt: 30,
          trust: 'app_verified',
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('Foreign');
  });

  it('fails closed when retrieval claims a foreign account map', async () => {
    db = await database();
    const approvalBroker = broker();
    const adapter = createBrowserChatProjectContextAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      database: db,
      dependencies: {
        retrieveLiveRepositoryContext: vi.fn(async () => ({
          ...retrieval(),
          mapId: 'map-foreign',
        })),
      },
    });

    await expect(
      adapter.searchContext({
        lease: lease(approvalBroker, 'project.context'),
        query: 'entry point',
        tokenBudget: 256,
        now: 100,
      }),
    ).rejects.toMatchObject({ code: 'result_invalid' });
  });
});
