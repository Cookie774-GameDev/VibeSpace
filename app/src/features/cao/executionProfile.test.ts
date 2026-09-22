import { describe, expect, it } from 'vitest';
import {
  assertCaoExecutionProfileScope,
  loadCaoExecutionProfile,
  persistCaoExecutionProfile,
  selectCaoExecutionProfile,
  type CaoLiveExecutionCatalog,
} from './executionProfile';

const catalog: CaoLiveExecutionCatalog = {
  source: 'live',
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  catalogGeneration: 'generation-4',
  catalogHash: 'a'.repeat(64),
  verifiedAt: 100,
  entries: [
    {
      backend: 'codex',
      connectionId: 'openai-codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  ],
};

describe('CAO execution profile', () => {
  it('selects an exact live catalog entry and records the observed catalog receipt', () => {
    const profile = selectCaoExecutionProfile({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      catalog,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      now: 123,
    });
    expect(profile).toMatchObject({
      schemaVersion: 1,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      catalogReceipt: catalog,
      updatedAt: 123,
    });
  });

  it('fails closed when the requested route is absent or the catalog is not live', () => {
    expect(() =>
      selectCaoExecutionProfile({
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        catalog,
        modelId: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      }),
    ).toThrow('cao_execution_profile_route_unavailable');
    expect(() =>
      selectCaoExecutionProfile({
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        catalog: { ...catalog, source: 'cached' },
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'high',
      }),
    ).toThrow('cao_execution_profile_catalog_unavailable');
  });

  it('rejects profile scope mismatch and does not substitute another account', () => {
    const profile = selectCaoExecutionProfile({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      catalog,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    });
    expect(() => assertCaoExecutionProfileScope(profile, { accountId: 'account-2', workspaceId: 'workspace-1' })).toThrow(
      'cao_execution_profile_scope_mismatch',
    );
  });

  it('keeps account/workspace row keys unambiguous when identifiers contain separators', async () => {
    const rows = new Map<string, { id: string; accountId: string; workspaceId: string; serializedProfile: string; schemaVersion: 1; updatedAt: number }>();
    const database = {
      cao_execution_profiles: {
        put: async (row: (typeof rows extends Map<string, infer Value> ? Value : never)) => {
          rows.set(row.id, row);
        },
        get: async (id: string) => rows.get(id),
      },
    } as never;
    const firstCatalog = { ...catalog, accountId: 'account:workspace', workspaceId: 'project' };
    const secondCatalog = { ...catalog, accountId: 'account', workspaceId: 'workspace:project' };
    const first = selectCaoExecutionProfile({
      accountId: firstCatalog.accountId,
      workspaceId: firstCatalog.workspaceId,
      catalog: firstCatalog,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    });
    const second = selectCaoExecutionProfile({
      accountId: secondCatalog.accountId,
      workspaceId: secondCatalog.workspaceId,
      catalog: secondCatalog,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    });
    await persistCaoExecutionProfile(database, first);
    await persistCaoExecutionProfile(database, second);
    await expect(loadCaoExecutionProfile(database, { accountId: first.accountId, workspaceId: first.workspaceId })).resolves.toMatchObject(first);
    await expect(loadCaoExecutionProfile(database, { accountId: second.accountId, workspaceId: second.workspaceId })).resolves.toMatchObject(second);
    expect(rows.size).toBe(2);
  });
});
