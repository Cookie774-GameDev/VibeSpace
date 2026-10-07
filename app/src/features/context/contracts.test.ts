import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONTEXT_EDGE_KINDS,
  CONTEXT_ENTITY_KINDS,
  CONTEXT_SOURCE_KINDS,
  CONTEXT_SOURCE_STATUSES,
  parseContextGraphSnapshotV2,
  parseContextSourceV2,
  parseContextEntityV2,
} from './contracts';

function snapshotFixture(): Record<string, unknown> {
  return {
    version: 2,
    map: {
      version: 2,
      id: 'context-map-1',
      accountId: 'account-1',
      projectId: 'project-1',
      name: 'VibeSpace',
      status: 'active',
      sourceIds: ['context-source-1'],
      selectedWorkspaceId: 'workspace-1',
      summary: 'Current project knowledge.',
      recommendedEntryPoints: [
        {
          entityId: 'entity-file-1',
          kind: 'file',
          label: 'contracts.ts',
          sourceId: 'context-source-1',
          path: 'app/src/features/context/contracts.ts',
          lineStart: 1,
          lineEnd: 20,
        },
      ],
      statistics: {
        sourceCount: 1,
        entityCount: 2,
        edgeCount: 1,
        noteCount: 0,
        attachmentCount: 0,
        staleSourceCount: 0,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
      lastIndexedAt: 1_900,
      knowledgeRevision: 1,
    },
    sources: [
      {
        version: 2,
        id: 'context-source-1',
        accountId: 'account-1',
        mapId: 'context-map-1',
        kind: 'local_folder',
        label: 'VibeSpace checkout',
        status: 'ready',
        localRoot: 'C:\\Projects\\VibeSpace',
        createdAt: 1_000,
        updatedAt: 2_000,
        lastIndexedAt: 1_900,
        lastVerifiedAt: 1_950,
        sourceRevision: 'local-revision-1',
        parserVersion: 1,
      },
    ],
    entities: [
      {
        version: 2,
        id: 'entity-file-1',
        accountId: 'account-1',
        mapId: 'context-map-1',
        sourceId: 'context-source-1',
        kind: 'file',
        label: 'contracts.ts',
        path: 'app/src/features/context/contracts.ts',
        summary: 'Context Map v2 contracts.',
        sourceRevision: 'local-revision-1',
        provenanceIds: ['provenance-1'],
        createdAt: 1_100,
        updatedAt: 1_900,
      },
      {
        version: 2,
        id: 'entity-test-1',
        accountId: 'account-1',
        mapId: 'context-map-1',
        sourceId: 'context-source-1',
        kind: 'test',
        label: 'contracts.test.ts',
        path: 'app/src/features/context/contracts.test.ts',
        sourceRevision: 'local-revision-1',
        provenanceIds: ['provenance-2'],
        createdAt: 1_100,
        updatedAt: 1_900,
      },
    ],
    edges: [
      {
        version: 2,
        id: 'edge-tested-by-1',
        accountId: 'account-1',
        mapId: 'context-map-1',
        sourceEntityId: 'entity-file-1',
        targetEntityId: 'entity-test-1',
        kind: 'tested_by',
        provenanceIds: ['provenance-3'],
        confidence: 1,
        sourceRevision: 'local-revision-1',
        createdAt: 1_200,
        updatedAt: 1_900,
      },
    ],
    provenance: [
      {
        version: 2,
        id: 'provenance-1',
        accountId: 'account-1',
        mapId: 'context-map-1',
        targetKind: 'entity',
        targetId: 'entity-file-1',
        sourceId: 'context-source-1',
        sourceKind: 'local_folder',
        path: 'app/src/features/context/contracts.ts',
        lineStart: 1,
        lineEnd: 20,
        extractedAt: 1_900,
        parser: 'typescript@1',
        confidence: 1,
        sourceRevision: 'local-revision-1',
      },
      {
        version: 2,
        id: 'provenance-2',
        accountId: 'account-1',
        mapId: 'context-map-1',
        targetKind: 'entity',
        targetId: 'entity-test-1',
        sourceId: 'context-source-1',
        sourceKind: 'local_folder',
        path: 'app/src/features/context/contracts.test.ts',
        extractedAt: 1_900,
        parser: 'typescript@1',
        confidence: 1,
        sourceRevision: 'local-revision-1',
      },
      {
        version: 2,
        id: 'provenance-3',
        accountId: 'account-1',
        mapId: 'context-map-1',
        targetKind: 'edge',
        targetId: 'edge-tested-by-1',
        sourceId: 'context-source-1',
        sourceKind: 'local_folder',
        path: 'app/src/features/context/contracts.test.ts',
        extractedAt: 1_900,
        parser: 'typescript@1',
        confidence: 1,
        sourceRevision: 'local-revision-1',
      },
    ],
  };
}

describe('Context Map 2.0 contracts', () => {
  it('pins the canonical source, entity, and edge vocabularies', () => {
    expect(CONTEXT_SOURCE_KINDS).toEqual([
      'local_folder',
      'local_file',
      'github_repository',
      'linked_vibespace_content',
      'portable_markdown_folder',
    ]);
    expect(CONTEXT_SOURCE_STATUSES).toEqual([
      'pending',
      'indexing',
      'ready',
      'stale',
      'offline',
      'permission_required',
      'error',
      'removed',
    ]);
    expect(CONTEXT_ENTITY_KINDS).toEqual([
      'map',
      'source',
      'folder',
      'file',
      'markdown_note',
      'heading',
      'block',
      'symbol',
      'module',
      'class',
      'function',
      'method',
      'component',
      'route',
      'endpoint',
      'database_table',
      'migration',
      'test',
      'dependency',
      'task',
      'property',
      'tag',
      'attachment',
      'image',
      'audio',
      'video',
      'pdf',
      'url',
      'chat',
      'message',
      'terminal',
      'agent',
      'skill',
      'canvas',
      'canvas_object',
      'github_repository',
      'github_branch',
      'github_commit',
      'github_issue',
      'github_pull_request',
      'github_release',
      'github_workflow',
    ]);
    expect(CONTEXT_EDGE_KINDS).toEqual([
      'contains',
      'links_to',
      'embeds',
      'backlinks_to',
      'mentions',
      'unlinked_mention',
      'imports',
      'exports',
      'calls',
      'implements',
      'extends',
      'depends_on',
      'tested_by',
      'documents',
      'generated_from',
      'related_to',
      'owned_by',
      'assigned_to',
      'used_by',
      'changed_by',
      'introduced_in',
      'fixed_by',
      'references_file',
      'references_symbol',
      'attached_to',
      'derived_from',
    ]);
  });

  it('accepts one coherent snapshot and returns a detached deeply frozen value', () => {
    const input = snapshotFixture();
    const result = parseContextGraphSnapshotV2(input);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.reason);
    expectTypeOf(result.value.map.sourceIds).toEqualTypeOf<readonly string[]>();
    expect(result.value.map.sourceIds).toEqual(['context-source-1']);
    expect(result.value.edges[0]?.kind).toBe('tested_by');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.map.statistics)).toBe(true);
    expect(Object.isFrozen(result.value.provenance[0])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);

    (input.map as { name: string }).name = 'mutated';
    expect(result.value.map.name).toBe('VibeSpace');
  });

  it('requires the exact locator for each source kind and rejects secret-shaped extra fields', () => {
    const base = (snapshotFixture().sources as Array<Record<string, unknown>>)[0]!;
    expect(
      parseContextSourceV2({
        ...base,
        kind: 'local_file',
        localRoot: undefined,
        localFile: 'C:\\Projects\\VibeSpace\\README.md',
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseContextSourceV2({
        ...base,
        kind: 'github_repository',
        localRoot: undefined,
        github: {
          installationId: 'installation-1',
          owner: 'Cookie774-GameDev',
          repository: 'VibeSpace',
          selectedRef: 'main',
          resolvedCommitSha: '0123456789abcdef0123456789abcdef01234567',
          visibility: 'private',
        },
      }),
    ).toMatchObject({ ok: true });
    expect(parseContextSourceV2({ ...base, localFile: 'README.md' })).toMatchObject({
      ok: false,
      reason: 'source_locator_invalid',
    });
    expect(parseContextSourceV2({ ...base, token: 'must-not-be-stored' })).toMatchObject({
      ok: false,
      reason: 'source_keys_invalid',
    });
  });

  it('fails closed on cross-account ownership, unknown endpoints, and broken provenance', () => {
    const crossAccount = snapshotFixture();
    (crossAccount.sources as Array<{ accountId: string }>)[0]!.accountId = 'account-2';
    expect(parseContextGraphSnapshotV2(crossAccount)).toMatchObject({
      ok: false,
      reason: 'snapshot_ownership_mismatch',
    });

    const missingEndpoint = snapshotFixture();
    (missingEndpoint.edges as Array<{ targetEntityId: string }>)[0]!.targetEntityId =
      'entity-missing';
    expect(parseContextGraphSnapshotV2(missingEndpoint)).toMatchObject({
      ok: false,
      reason: 'edge_target_missing',
    });

    const brokenProvenance = snapshotFixture();
    (brokenProvenance.edges as Array<{ provenanceIds: string[] }>)[0]!.provenanceIds = [
      'provenance-1',
    ];
    expect(parseContextGraphSnapshotV2(brokenProvenance)).toMatchObject({
      ok: false,
      reason: 'edge_provenance_target_mismatch',
    });
  });

  it('rejects map statistics that disagree with typed entities', () => {
    const incorrectNotes = snapshotFixture();
    (incorrectNotes.map as { statistics: { noteCount: number } }).statistics.noteCount = 1;
    expect(parseContextGraphSnapshotV2(incorrectNotes)).toMatchObject({
      ok: false,
      reason: 'snapshot_statistics_mismatch',
    });

    const incorrectAttachments = snapshotFixture();
    (
      incorrectAttachments.map as { statistics: { attachmentCount: number } }
    ).statistics.attachmentCount = 1;
    expect(parseContextGraphSnapshotV2(incorrectAttachments)).toMatchObject({
      ok: false,
      reason: 'snapshot_statistics_mismatch',
    });
  });

  it('rejects invalid revisions, confidence, line ranges, timestamps, and self edges', () => {
    const invalidRevision = snapshotFixture();
    (invalidRevision.map as { knowledgeRevision: number }).knowledgeRevision = -1;
    expect(parseContextGraphSnapshotV2(invalidRevision)).toMatchObject({
      ok: false,
      reason: 'map_knowledge_revision_invalid',
    });

    const invalidConfidence = snapshotFixture();
    (invalidConfidence.edges as Array<{ confidence: number }>)[0]!.confidence = 1.01;
    expect(parseContextGraphSnapshotV2(invalidConfidence)).toMatchObject({
      ok: false,
      reason: 'edge_confidence_invalid',
    });

    const invalidLines = snapshotFixture();
    (invalidLines.provenance as Array<{ lineStart?: number; lineEnd?: number }>)[0]!.lineStart = 20;
    (invalidLines.provenance as Array<{ lineStart?: number; lineEnd?: number }>)[0]!.lineEnd = 1;
    expect(parseContextGraphSnapshotV2(invalidLines)).toMatchObject({
      ok: false,
      reason: 'provenance_line_range_invalid',
    });

    const invalidTime = snapshotFixture();
    (invalidTime.sources as Array<{ createdAt: number; updatedAt: number }>)[0]!.updatedAt = 999;
    expect(parseContextGraphSnapshotV2(invalidTime)).toMatchObject({
      ok: false,
      reason: 'source_time_order_invalid',
    });

    const selfEdge = snapshotFixture();
    (
      selfEdge.edges as Array<{ sourceEntityId: string; targetEntityId: string }>
    )[0]!.targetEntityId = 'entity-file-1';
    expect(parseContextGraphSnapshotV2(selfEdge)).toMatchObject({
      ok: false,
      reason: 'edge_self_reference_invalid',
    });
  });
});


describe('physical source metadata compatibility', () => {
  const entity = () => (snapshotFixture().entities as Array<Record<string, unknown>>)[0]!;
  it('accepts legacy missing metadata and preserves actual physical zero/older timestamps', () => {
    expect(parseContextEntityV2(entity()).ok).toBe(true);
    const result = parseContextEntityV2({ ...entity(), sourceSizeBytes: 0, sourceModifiedAt: 12 });
    expect(result).toMatchObject({ ok: true, value: { sourceSizeBytes: 0, sourceModifiedAt: 12 } });
  });
  it.each(['sourceSizeBytes', 'sourceModifiedAt'] as const)('rejects invalid %s instead of fabricating an observation', field => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseContextEntityV2({ ...entity(), [field]: value }).ok).toBe(false);
    }
  });
});
