import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';

const harness = vi.hoisted(() => {
  class CommitRejected extends Error {
    constructor(readonly reason: 'cancelled' | 'authority_changed') {
      super(`sync_mutation_commit_${reason}`);
    }
  }
  const settings = new Map<string, { key: string; value: unknown; updated_at: number }>();
  let identity: { accountId: string; source: 'supabase' | 'local' } | null = {
    accountId: 'account-1',
    source: 'supabase',
  };
  let plan = 'starter';
  return {
    settings,
    CommitRejected,
    enqueue: vi.fn(async (...args: unknown[]) => {
      const boundary = args[5] as
        | {
            signal: AbortSignal;
            validate(settings: { get(key: string): Promise<unknown> }): Promise<boolean>;
          }
        | undefined;
      if (boundary?.signal.aborted) throw new CommitRejected('cancelled');
      if (
        boundary &&
        !(await boundary.validate({
          get: async (key: string) => settings.get(key),
        }))
      ) {
        throw new CommitRejected('authority_changed');
      }
      return 'queue-1';
    }),
    openDb: vi.fn(async () => undefined),
    getIdentity: () => identity,
    getPlan: () => plan,
    reset() {
      settings.clear();
      identity = { accountId: 'account-1', source: 'supabase' };
      plan = 'starter';
      vi.clearAllMocks();
    },
    setIdentity(next: typeof identity) {
      identity = next;
    },
    setPlan(next: string) {
      plan = next;
    },
  };
});

vi.mock('@/lib/db', () => ({
  openDb: harness.openDb,
  db: {
    settings: {
      get: vi.fn(async (key: string) => harness.settings.get(key)),
      where: vi.fn(() => ({
        startsWith: vi.fn((prefix: string) => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(async () =>
              [...harness.settings.values()].filter((row) => row.key.startsWith(prefix)),
            ),
          })),
        })),
      })),
      put: vi.fn(async (row: { key: string; value: unknown; updated_at: number }) => {
        harness.settings.set(row.key, row);
        return row.key;
      }),
    },
  },
}));

vi.mock('@/lib/db/signalBoundTransaction', () => ({
  runSignalBoundWrite: vi.fn(
    async (
      _database: unknown,
      signal: AbortSignal,
      _tables: unknown,
      scope: (transaction: {
        table(): {
          get(key: string): Promise<unknown>;
          put(row: { key: string; value: unknown; updated_at: number }): Promise<string>;
        };
      }) => Promise<unknown>,
    ) => {
      if (signal.aborted) return { kind: 'cancelled', reason: signal.reason };
      const value = await scope({
        table: () => ({
          get: async (key: string) => harness.settings.get(key),
          put: async (row: { key: string; value: unknown; updated_at: number }) => {
            harness.settings.set(row.key, row);
            return row.key;
          },
          delete: async (key: string) => {
            harness.settings.delete(key);
          },
        }),
      });
      return signal.aborted
        ? { kind: 'cancelled', reason: signal.reason }
        : { kind: 'committed', value };
    },
  ),
}));

vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: harness.getIdentity,
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ plan: harness.getPlan() }),
  },
}));

vi.mock('@/lib/entitlements', () => ({
  getPlan: (plan: string) => ({ cloudSync: plan !== 'free' }),
}));

vi.mock('@/lib/sync', () => ({
  enqueueMutation: harness.enqueue,
  SyncMutationCommitRejectedError: harness.CommitRejected,
}));

import {
  CONTEXT_CLOUD_SYNC_KINDS,
  CONTEXT_CLOUD_SYNC_TABLE,
  assertContextCloudUploadAuthorized,
  contextCloudSyncRowId,
  listStagedContextCloudRecords,
  mergeContextCloudDocuments,
  queueContextCloudDocument,
  resolveStagedContextCloudRecord,
  setContextCloudSyncPreference,
  stageContextCloudRecord,
  type ContextCloudDocumentV1,
  type ContextCloudJson,
} from './contextCloudSync';

function document(patch: Partial<ContextCloudDocumentV1> = {}): ContextCloudDocumentV1 {
  return {
    version: 1,
    accountId: 'account-1',
    projectId: 'project-1',
    kind: 'note',
    id: 'note-1',
    revisionId: 'revision-2',
    baseRevisionId: 'revision-1',
    provenance: {
      origin: 'user_authored',
      producer: 'context_note_editor',
    },
    updatedAt: 2,
    fields: { title: 'Plan', markdown: '# Plan\nNext step.' },
    ...patch,
  };
}

beforeEach(() => {
  harness.reset();
});

describe('Context optional cloud sync boundary', () => {
  it('is local-first until an entitled verified cloud account explicitly opts in', async () => {
    const signal = new AbortController().signal;

    await expect(queueContextCloudDocument('account-1', document(), signal)).resolves.toEqual({
      queued: false,
      reason: 'disabled',
    });
    expect(harness.enqueue).not.toHaveBeenCalled();

    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    await expect(queueContextCloudDocument('account-1', document(), signal)).resolves.toEqual({
      queued: true,
      queueId: 'queue-1',
    });
    expect(harness.enqueue).toHaveBeenCalledWith(
      'update',
      CONTEXT_CLOUD_SYNC_TABLE,
      contextCloudSyncRowId(document()),
      document(),
      expect.objectContaining({
        state: 'cloud',
        userId: 'account-1',
      }),
      expect.objectContaining({ signal }),
    );

    harness.setIdentity({ accountId: 'account-1', source: 'local' });
    await expect(queueContextCloudDocument('account-1', document(), signal)).resolves.toEqual({
      queued: false,
      reason: 'cloud_authority_required',
    });
  });

  it('rechecks the current opt-in immediately before a queued document may upload', async () => {
    const signal = new AbortController().signal;
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    await expect(
      assertContextCloudUploadAuthorized(document(), 'account-1', signal),
    ).resolves.toEqual(document());

    await setContextCloudSyncPreference('account-1', {
      enabled: false,
      derivedSummaries: false,
    });
    await expect(
      assertContextCloudUploadAuthorized(document(), 'account-1', signal),
    ).rejects.toThrow(/upload_disabled/u);
  });

  it('allows only the approved document families and keeps derived summaries separately opted in', async () => {
    expect(CONTEXT_CLOUD_SYNC_KINDS).toEqual([
      'note',
      'properties',
      'link',
      'view',
      'template',
      'workspace',
      'map_metadata',
      'derived_summary',
    ]);
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const signal = new AbortController().signal;

    await expect(
      queueContextCloudDocument(
        'account-1',
        document({
          kind: 'derived_summary',
          id: 'summary-1',
          provenance: {
            origin: 'derived',
            producer: 'context_summary_generator',
          },
          fields: { summary: 'Generated summary.', sourceRevision: 'revision-1' },
        }),
        signal,
      ),
    ).resolves.toEqual({ queued: false, reason: 'derived_summaries_disabled' });
    await expect(
      queueContextCloudDocument(
        'account-1',
        { ...document(), kind: 'embedding' } as unknown as ContextCloudDocumentV1,
        signal,
      ),
    ).resolves.toEqual({ queued: false, reason: 'document_invalid' });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('uses strict per-kind projections and never smuggles summaries through map metadata', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const mapMetadata = document({
      kind: 'map_metadata',
      id: 'map-1',
      provenance: {
        origin: 'app_metadata',
        producer: 'context_map_persistence',
      },
      fields: {
        name: 'Project',
        status: 'active',
        statistics: { sourceCount: 1 },
        knowledgeRevision: 2,
        summary: 'Generated content must use the separate opt-in.',
      },
    });

    await expect(
      queueContextCloudDocument('account-1', mapMetadata, new AbortController().signal),
    ).resolves.toEqual({ queued: false, reason: 'document_invalid' });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing or private raw-data payloads before queueing', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const signal = new AbortController().signal;

    const protectedFields: Array<Record<string, ContextCloudJson>> = [
      { providerToken: 'ordinary-looking-value' },
      { markdown: '-----BEGIN PRIVATE KEY-----\nsecret' },
      { apiKey: 'sk-proj-secret-secret-secret-secret' },
      { note: 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl+/' },
      { terminalTranscript: '$ printenv' },
      { embedding: [0.1, 0.2] },
      { rawRepositoryCode: 'export const privateSource = true;' },
    ];
    for (const fields of protectedFields) {
      await expect(
        queueContextCloudDocument('account-1', document({ fields }), signal),
      ).resolves.toEqual({ queued: false, reason: 'protected_content' });
    }
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('rejects nested camelCase credentials, JWTs, and raw-code containers', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const signal = new AbortController().signal;
    const protectedDocuments = [
      document({
        kind: 'properties',
        provenance: {
          origin: 'user_authored',
          producer: 'context_properties_editor',
        },
        fields: {
          noteId: 'note-1',
          properties: { authToken: 'opaque-session-material' },
        },
      }),
      document({
        kind: 'view',
        provenance: {
          origin: 'user_authored',
          producer: 'context_view_editor',
        },
        fields: {
          name: 'Private view',
          definition: { headers: { authorization: 'opaque' } },
        },
      }),
      document({
        kind: 'workspace',
        provenance: {
          origin: 'user_authored',
          producer: 'context_workspace_editor',
        },
        fields: {
          name: 'Workspace',
          arrangement: { searchQuery: 'export const privateSource = true;' },
        },
      }),
      document({
        fields: {
          title: 'Token',
          markdown: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlLXVzZXIifQ.c2lnbmF0dXJlLW1hdGVyaWFs',
        },
      }),
    ];

    for (const protectedDocument of protectedDocuments) {
      await expect(
        queueContextCloudDocument('account-1', protectedDocument, signal),
      ).resolves.toEqual({ queued: false, reason: 'protected_content' });
    }
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  const secretIdentifier = syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890');

  it.each([
    ['projectId', { projectId: secretIdentifier }],
    ['id', { id: secretIdentifier }],
    ['revisionId', { revisionId: secretIdentifier }],
    ['baseRevisionId', { baseRevisionId: secretIdentifier }],
  ] as const)('rejects a secret-bearing %s envelope identifier', async (_field, patch) => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });

    await expect(
      queueContextCloudDocument('account-1', document(patch), new AbortController().signal),
    ).resolves.toEqual({ queued: false, reason: 'protected_content' });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('stages validated inbound records for visible review without overwriting local Context data', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const remote = document();
    const applied = await stageContextCloudRecord(
      {
        user_id: 'account-1',
        table_name: CONTEXT_CLOUD_SYNC_TABLE,
        row_id: contextCloudSyncRowId(remote),
        op: 'update',
        payload: remote as unknown as Record<string, unknown>,
        deleted_at: null,
        updated_at: new Date(remote.updatedAt).toISOString(),
      },
      new AbortController().signal,
    );

    expect(applied).toBe(true);
    await expect(listStagedContextCloudRecords('account-1')).resolves.toEqual([
      expect.objectContaining({
        status: 'pending_review',
        document: remote,
        resolutionRequired: true,
      }),
    ]);
  });

  it('completes a direct-user keep-local resolution with durable audit and inbox cleanup', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const remote = document();
    const rowId = contextCloudSyncRowId(remote);
    await stageContextCloudRecord(
      {
        user_id: 'account-1',
        table_name: CONTEXT_CLOUD_SYNC_TABLE,
        row_id: rowId,
        op: 'update',
        payload: remote as unknown as Record<string, unknown>,
        deleted_at: null,
        updated_at: new Date(remote.updatedAt).toISOString(),
      },
      new AbortController().signal,
    );

    await expect(
      resolveStagedContextCloudRecord(
        {
          kind: 'direct_user_action',
          accountId: 'account-1',
          requestId: 'resolution-1',
          signal: new AbortController().signal,
        },
        rowId,
        'keep_local',
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      choice: 'keep_local',
      appliedDocumentIds: [],
    });
    await expect(listStagedContextCloudRecords('account-1')).resolves.toEqual([]);
    expect(
      [...harness.settings.values()].some(
        (row) =>
          (row.value as { status?: string }).status === 'completed' &&
          (row.value as { requestId?: string }).requestId === 'resolution-1',
      ),
    ).toBe(true);
  });

  it('serializes same-row resolution requests and runs one idempotent adapter application', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const remote = document();
    const rowId = contextCloudSyncRowId(remote);
    await stageContextCloudRecord(
      {
        user_id: 'account-1',
        table_name: CONTEXT_CLOUD_SYNC_TABLE,
        row_id: rowId,
        op: 'update',
        payload: remote as unknown as Record<string, unknown>,
        deleted_at: null,
        updated_at: new Date(remote.updatedAt).toISOString(),
      },
      new AbortController().signal,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      lookupReceipt: vi.fn(async () => null),
      apply: vi.fn(async () => {
        await gate;
        return { receiptId: 'receipt-1' };
      }),
    };
    const authority = {
      kind: 'direct_user_action' as const,
      accountId: 'account-1',
      requestId: 'resolution-shared',
      signal: new AbortController().signal,
    };
    const first = resolveStagedContextCloudRecord(authority, rowId, 'use_remote', adapter);
    const duplicate = resolveStagedContextCloudRecord(authority, rowId, 'use_remote', adapter);
    await vi.waitFor(() => expect(adapter.apply).toHaveBeenCalledTimes(1));

    await expect(
      resolveStagedContextCloudRecord(
        { ...authority, requestId: 'resolution-other' },
        rowId,
        'use_remote',
        adapter,
      ),
    ).rejects.toThrow(/already_claimed/u);
    release();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ status: 'completed', appliedDocumentIds: ['note-1'] }),
      expect.objectContaining({ status: 'completed', appliedDocumentIds: ['note-1'] }),
    ]);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after adapter success from its durable receipt without reapplying', async () => {
    await setContextCloudSyncPreference('account-1', {
      enabled: true,
      derivedSummaries: false,
    });
    const remote = document();
    const rowId = contextCloudSyncRowId(remote);
    await stageContextCloudRecord(
      {
        user_id: 'account-1',
        table_name: CONTEXT_CLOUD_SYNC_TABLE,
        row_id: rowId,
        op: 'update',
        payload: remote as unknown as Record<string, unknown>,
        deleted_at: null,
        updated_at: new Date(remote.updatedAt).toISOString(),
      },
      new AbortController().signal,
    );
    let externalReceipt: string | null = null;
    const firstController = new AbortController();
    const adapter = {
      lookupReceipt: vi.fn(async () => externalReceipt),
      apply: vi.fn(async () => {
        externalReceipt = 'receipt-recovered';
        firstController.abort();
        return { receiptId: externalReceipt };
      }),
    };
    await expect(
      resolveStagedContextCloudRecord(
        {
          kind: 'direct_user_action',
          accountId: 'account-1',
          requestId: 'resolution-crash',
          signal: firstController.signal,
        },
        rowId,
        'use_remote',
        adapter,
      ),
    ).rejects.toThrow(/cancelled/u);

    await expect(
      resolveStagedContextCloudRecord(
        {
          kind: 'direct_user_action',
          accountId: 'account-1',
          requestId: 'resolution-crash',
          signal: new AbortController().signal,
        },
        rowId,
        'use_remote',
        adapter,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      appliedDocumentIds: ['note-1'],
    });
    expect(adapter.apply).toHaveBeenCalledTimes(1);
  });

  it('uses safe field-level and Markdown three-way merges for disjoint edits', async () => {
    const base = document({
      revisionId: 'revision-1',
      baseRevisionId: null,
      updatedAt: 1,
      fields: {
        title: 'Plan',
        markdown: '# Plan\nAlpha\nBeta\nGamma',
        status: 'active',
      },
    });
    const local = document({
      revisionId: 'revision-local',
      fields: {
        title: 'Release plan',
        markdown: '# Plan\nAlpha local\nBeta\nGamma',
        status: 'active',
      },
    });
    const remote = document({
      revisionId: 'revision-remote',
      fields: {
        title: 'Plan',
        markdown: '# Plan\nAlpha\nBeta\nGamma remote',
        status: 'archived',
      },
    });

    expect(await mergeContextCloudDocuments({ base, local, remote })).toMatchObject({
      kind: 'merged',
      resolution: { visible: true, status: 'auto_merged' },
      document: {
        fields: {
          title: 'Release plan',
          markdown: '# Plan\nAlpha local\nBeta\nGamma remote',
          status: 'archived',
        },
      },
    });
  });

  it('creates a visible conflict copy for overlapping Markdown edits', async () => {
    const base = document({
      revisionId: 'revision-1',
      baseRevisionId: null,
      fields: { title: 'Plan', markdown: '# Plan\nOriginal' },
    });
    const local = document({
      revisionId: 'revision-local',
      fields: { title: 'Plan', markdown: '# Plan\nLocal' },
    });
    const remote = document({
      revisionId: 'revision-remote',
      fields: { title: 'Plan', markdown: '# Plan\nRemote' },
    });

    expect(await mergeContextCloudDocuments({ base, local, remote })).toMatchObject({
      kind: 'conflict',
      preserved: local,
      conflictCopy: {
        kind: 'note',
        fields: { markdown: '# Plan\nRemote' },
      },
      resolution: {
        visible: true,
        status: 'requires_user',
        reason: 'overlapping_change',
      },
    });
  });

  it('preserves changed local data when a remote tombstone races it', async () => {
    const base = document({
      revisionId: 'revision-1',
      baseRevisionId: null,
      updatedAt: 1,
    });
    const local = document({
      revisionId: 'revision-local',
      fields: { title: 'Changed locally', markdown: '# Changed' },
    });
    const remote = document({
      revisionId: 'revision-remote',
      deletedAt: 3,
      fields: {},
    });

    expect(await mergeContextCloudDocuments({ base, local, remote })).toMatchObject({
      kind: 'conflict',
      preserved: local,
      resolution: {
        visible: true,
        status: 'requires_user',
        reason: 'delete_update_conflict',
      },
    });
  });

  it('rejects divergent content with the same revision id and never auto-resurrects a tombstone', async () => {
    const base = document({
      revisionId: 'revision-1',
      baseRevisionId: null,
      fields: { title: 'Plan', markdown: '# Original' },
    });
    const local = document({
      revisionId: 'revision-shared',
      fields: { title: 'Plan', markdown: '# Local' },
    });
    const remote = document({
      revisionId: 'revision-shared',
      fields: { title: 'Plan', markdown: '# Remote' },
    });
    expect(await mergeContextCloudDocuments({ base, local, remote })).toMatchObject({
      kind: 'conflict',
      preserved: local,
      resolution: { reason: 'revision_chain_invalid' },
    });

    const deletedBase = document({
      revisionId: 'revision-deleted',
      baseRevisionId: null,
      deletedAt: 1,
      fields: {},
    });
    const restoredLocal = document({
      revisionId: 'revision-local',
      baseRevisionId: 'revision-deleted',
    });
    const restoredRemote = document({
      revisionId: 'revision-remote',
      baseRevisionId: 'revision-deleted',
    });
    expect(
      await mergeContextCloudDocuments({
        base: deletedBase,
        local: restoredLocal,
        remote: restoredRemote,
      }),
    ).toMatchObject({
      kind: 'conflict',
      preserved: restoredLocal,
      resolution: { reason: 'delete_update_conflict' },
    });
  });

  it('keeps the local tombstone primary when a remote update conflicts', async () => {
    const base = document({
      revisionId: 'revision-1',
      baseRevisionId: null,
    });
    const local = document({
      revisionId: 'revision-local',
      deletedAt: 3,
      fields: {},
    });
    const remote = document({
      revisionId: 'revision-remote',
      fields: { title: 'Remote change', markdown: '# Remote' },
    });
    expect(await mergeContextCloudDocuments({ base, local, remote })).toMatchObject({
      kind: 'conflict',
      preserved: local,
      conflictCopy: { fields: remote.fields },
      resolution: { reason: 'delete_update_conflict' },
    });
  });

  it('does not claim real-time collaboration', async () => {
    expect(
      (
        await mergeContextCloudDocuments({
          base: document({ revisionId: 'revision-1', baseRevisionId: null }),
          local: document({ revisionId: 'revision-local' }),
          remote: document({ revisionId: 'revision-remote' }),
        })
      ).capabilities,
    ).toEqual({ realTimeCollaboration: false });
  });
});
