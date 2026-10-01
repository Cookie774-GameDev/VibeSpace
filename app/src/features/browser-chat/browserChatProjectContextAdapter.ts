import { db, type JarvisDexie } from '@/lib/db';
import {
  retrieveLiveRepositoryContext,
  type LiveRepositoryRetrievalInput,
} from '@/features/context/repositoryRetrievalRuntime';
import type {
  RepositoryRetrievalItem,
  RepositoryRetrievalResult,
} from '@/features/context/repositoryRetrieval';
import { applySecretPolicy, type SecretPolicyAction } from '@/lib/security/secretDetector';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import type { BrowserChatCapabilityId, BrowserChatCapabilityLease } from './permissionRegistry';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_PROJECTS = 50;
const MAX_MAPS = 20;
const MAX_OUTPUTS = 50;
const MAX_QUERY = 1_024;
const MAX_CONTEXT_ITEMS = 8;
const MAX_CONTEXT_CONTENT_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS = 32 * 1024;

export interface BrowserChatProjectContextDependencies {
  retrieveLiveRepositoryContext(
    input: Readonly<LiveRepositoryRetrievalInput>,
  ): Promise<Readonly<RepositoryRetrievalResult>>;
}

export type BrowserChatProjectContextErrorCode =
  | 'scope_invalid'
  | 'project_unavailable'
  | 'capability_mismatch'
  | 'query_invalid'
  | 'operation_cancelled'
  | 'runtime_denied'
  | 'result_invalid';

export class BrowserChatProjectContextError extends Error {
  constructor(readonly code: BrowserChatProjectContextErrorCode) {
    super(`Browser Chat project context operation rejected: ${code}.`);
    this.name = 'BrowserChatProjectContextError';
  }
}

type AdapterOptions = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  approvalBroker: BrowserChatApprovalBroker;
  database?: JarvisDexie;
  dependencies?: Partial<BrowserChatProjectContextDependencies>;
  sensitiveContentPolicy?: SecretPolicyAction;
}>;

function stableText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function portablePath(value: unknown): value is string {
  return (
    stableText(value, 4_096) &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    value
      .split('/')
      .every(
        (segment) =>
          segment.length > 0 && segment !== '.' && segment !== '..' && !/[. ]$/u.test(segment),
      )
  );
}

function assertCapability(
  lease: BrowserChatCapabilityLease,
  capabilityId: BrowserChatCapabilityId,
  scope: Pick<AdapterOptions, 'accountId' | 'workspaceId'>,
): void {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatProjectContextError('capability_mismatch');
  }
  if (lease.accountId !== scope.accountId || lease.workspaceId !== scope.workspaceId) {
    throw new BrowserChatProjectContextError('scope_invalid');
  }
}

function validateScope(options: AdapterOptions): void {
  if (
    !SAFE_ID.test(options.accountId) ||
    !SAFE_ID.test(options.workspaceId) ||
    !SAFE_ID.test(options.projectId)
  ) {
    throw new BrowserChatProjectContextError('scope_invalid');
  }
}

function safeOptionalText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function validInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateRetrievedItem(item: Readonly<RepositoryRetrievalItem>): boolean {
  const evidence = item?.evidence;
  return (
    item !== null &&
    typeof item === 'object' &&
    portablePath(item.path) &&
    stableText(item.language, 80) &&
    ['full', 'signatures', 'metadata'].includes(item.representation) &&
    typeof item.content === 'string' &&
    new TextEncoder().encode(item.content).byteLength <= MAX_CONTEXT_CONTENT_BYTES &&
    validInteger(item.tokens) &&
    evidence !== null &&
    typeof evidence === 'object' &&
    SAFE_ID.test(evidence.mapId) &&
    SAFE_ID.test(evidence.entityId) &&
    SAFE_ID.test(evidence.sourceId) &&
    SAFE_ID.test(evidence.provenanceId) &&
    stableText(evidence.sourceRevision, 512) &&
    stableText(evidence.repositoryRevision, 512) &&
    HASH.test(evidence.contentHash) &&
    HASH.test(evidence.astHash) &&
    stableText(evidence.parserId, 160) &&
    stableText(evidence.parserVersion, 80)
  );
}

export function createBrowserChatProjectContextAdapter(options: AdapterOptions) {
  validateScope(options);
  const database = options.database ?? db;
  const dependencies: BrowserChatProjectContextDependencies = {
    retrieveLiveRepositoryContext,
    ...options.dependencies,
  };
  const sensitiveContentPolicy = options.sensitiveContentPolicy ?? 'redact';

  function begin(
    lease: BrowserChatCapabilityLease,
    capabilityId: BrowserChatCapabilityId,
    now: number | undefined,
  ) {
    assertCapability(lease, capabilityId, options);
    return options.approvalBroker.begin(lease, now === undefined ? {} : { now });
  }

  async function activeWorkspace() {
    const workspace = await database.workspaces.get(options.workspaceId as WorkspaceId);
    if (!workspace || workspace.owner_id !== options.accountId) {
      throw new BrowserChatProjectContextError('scope_invalid');
    }
    return workspace;
  }

  async function activeProject() {
    await activeWorkspace();
    const project = await database.projects.get(options.projectId as ProjectId);
    if (!project || project.workspace_id !== options.workspaceId) {
      throw new BrowserChatProjectContextError('project_unavailable');
    }
    return project;
  }

  async function activeMaps() {
    const rows = await database.context_maps
      .where('accountId')
      .equals(options.accountId)
      .filter((row) => row.projectId === options.projectId && row.status === 'active')
      .toArray();
    return rows.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  }

  return Object.freeze({
    async listProjects(input: { lease: BrowserChatCapabilityLease; now?: number }) {
      const operation = begin(input.lease, 'project.list', input.now);
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        await activeWorkspace();
        const rows = await database.projects
          .where('workspace_id')
          .equals(options.workspaceId)
          .toArray();
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        const projects = rows
          .filter(
            (row) =>
              SAFE_ID.test(row.id) && stableText(row.name, 240) && validInteger(row.updated_at),
          )
          .sort(
            (left, right) =>
              right.updated_at - left.updated_at || left.name.localeCompare(right.name),
          )
          .map((row) => Object.freeze({ id: row.id, name: row.name, updatedAt: row.updated_at }));
        return Object.freeze({
          projects: Object.freeze(projects.slice(0, MAX_PROJECTS)),
          truncated: projects.length > MAX_PROJECTS,
        });
      } finally {
        operation.finish();
      }
    },

    async getActiveProject(input: { lease: BrowserChatCapabilityLease; now?: number }) {
      const operation = begin(input.lease, 'project.context', input.now);
      try {
        const project = await activeProject();
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        let instructions: string | undefined;
        let instructionsState: 'unavailable' | 'available' | 'redacted' | 'sensitive_blocked' =
          'unavailable';
        const rawInstructions = safeOptionalText(project.system_prompt_context, MAX_INSTRUCTIONS);
        if (rawInstructions) {
          const decision = applySecretPolicy(rawInstructions, sensitiveContentPolicy);
          if (decision.text !== undefined) {
            instructions = decision.text;
            instructionsState = decision.decision === 'redacted' ? 'redacted' : 'available';
          } else {
            instructionsState = 'sensitive_blocked';
          }
        }
        return Object.freeze({
          id: project.id,
          name: project.name,
          contextEnabled: project.no_context_mode !== true,
          instructionsState,
          ...(instructions === undefined ? {} : { instructions }),
          updatedAt: project.updated_at,
        });
      } finally {
        operation.finish();
      }
    },

    async listContextMaps(input: { lease: BrowserChatCapabilityLease; now?: number }) {
      const operation = begin(input.lease, 'project.context', input.now);
      try {
        await activeProject();
        const rows = await activeMaps();
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        const maps = rows
          .filter(
            (row) =>
              SAFE_ID.test(row.id) &&
              stableText(row.name, 240) &&
              typeof row.summary === 'string' &&
              row.summary.length <= 8_192 &&
              validInteger(row.knowledgeRevision) &&
              validInteger(row.updatedAt),
          )
          .map((row) =>
            Object.freeze({
              id: row.id,
              name: row.name,
              summary: row.summary,
              knowledgeRevision: row.knowledgeRevision,
              sourceCount: row.statistics.sourceCount,
              entityCount: row.statistics.entityCount,
              staleSourceCount: row.statistics.staleSourceCount,
              updatedAt: row.updatedAt,
              trust: 'app_verified' as const,
            }),
          );
        return Object.freeze({
          maps: Object.freeze(maps.slice(0, MAX_MAPS)),
          truncated: maps.length > MAX_MAPS,
        });
      } finally {
        operation.finish();
      }
    },

    async searchContext(input: {
      lease: BrowserChatCapabilityLease;
      query: string;
      tokenBudget: number;
      now?: number;
    }) {
      const query = typeof input.query === 'string' ? input.query.trim().normalize('NFKC') : '';
      if (
        query.length < 2 ||
        query.length > MAX_QUERY ||
        /[\u0000-\u001f\u007f]/u.test(query) ||
        !Number.isSafeInteger(input.tokenBudget) ||
        input.tokenBudget < 64 ||
        input.tokenBudget > 4_000
      ) {
        throw new BrowserChatProjectContextError('query_invalid');
      }
      const operation = begin(input.lease, 'project.context', input.now);
      try {
        await activeProject();
        const maps = await activeMaps();
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        let result: Readonly<RepositoryRetrievalResult>;
        try {
          result = await dependencies.retrieveLiveRepositoryContext({
            accountId: options.accountId,
            projectId: options.projectId,
            taskText: query,
            tokenBudget: input.tokenBudget,
          });
        } catch {
          throw new BrowserChatProjectContextError('runtime_denied');
        }
        if (
          operation.signal.aborted ||
          !result ||
          typeof result !== 'object' ||
          !SAFE_ID.test(result.mapId) ||
          !maps.some((map) => map.id === result.mapId) ||
          !stableText(result.repositoryRevision, 512) ||
          !validInteger(result.structuralRevision) ||
          !Array.isArray(result.items) ||
          !validInteger(result.totalTokens) ||
          !validInteger(result.remainingTokens)
        ) {
          throw new BrowserChatProjectContextError(
            operation.signal.aborted ? 'operation_cancelled' : 'result_invalid',
          );
        }
        const items = [];
        let contentBytes = 0;
        for (const item of result.items.slice(0, MAX_CONTEXT_ITEMS)) {
          if (
            !validateRetrievedItem(item) ||
            item.evidence.mapId !== result.mapId ||
            item.evidence.repositoryRevision !== result.repositoryRevision
          ) {
            throw new BrowserChatProjectContextError('result_invalid');
          }
          const decision = applySecretPolicy(item.content, sensitiveContentPolicy);
          if (decision.text === undefined) continue;
          const bytes = new TextEncoder().encode(decision.text).byteLength;
          if (contentBytes + bytes > MAX_CONTEXT_CONTENT_BYTES) break;
          contentBytes += bytes;
          items.push(
            Object.freeze({
              path: item.path,
              language: item.language,
              representation: item.representation,
              content: decision.text,
              redacted: decision.decision === 'redacted',
              tokens: item.tokens,
              evidence: Object.freeze({
                mapId: item.evidence.mapId,
                entityId: item.evidence.entityId,
                sourceId: item.evidence.sourceId,
                provenanceId: item.evidence.provenanceId,
                sourceRevision: item.evidence.sourceRevision,
                repositoryRevision: item.evidence.repositoryRevision,
                contentHash: item.evidence.contentHash,
                astHash: item.evidence.astHash,
                parserId: item.evidence.parserId,
                parserVersion: item.evidence.parserVersion,
                trust: 'app_verified' as const,
              }),
            }),
          );
        }
        return Object.freeze({
          mapId: result.mapId,
          repositoryRevision: result.repositoryRevision,
          structuralRevision: result.structuralRevision,
          items: Object.freeze(items),
          totalTokens: result.totalTokens,
          remainingTokens: result.remainingTokens,
          truncated:
            result.items.length > items.length || contentBytes >= MAX_CONTEXT_CONTENT_BYTES,
        });
      } finally {
        operation.finish();
      }
    },

    async listOutputs(input: { lease: BrowserChatCapabilityLease; now?: number }) {
      const operation = begin(input.lease, 'project.outputs', input.now);
      try {
        await activeProject();
        const runs = await database.jarvis_runs
          .where('account_id')
          .equals(options.accountId)
          .filter(
            (run) =>
              run.workspace_id === options.workspaceId && run.project_id === options.projectId,
          )
          .toArray();
        const orderedRuns = runs.sort(
          (left, right) => right.updated_at - left.updated_at || left.id.localeCompare(right.id),
        );
        const runIds = new Set(orderedRuns.slice(0, MAX_OUTPUTS).map((run) => run.id));
        const artifactRows = await database.jarvis_artifacts
          .filter((artifact) => runIds.has(artifact.run_id) && artifact.state !== 'quarantined')
          .toArray();
        if (operation.signal.aborted) {
          throw new BrowserChatProjectContextError('operation_cancelled');
        }
        const outputs = artifactRows
          .filter(
            (artifact) =>
              SAFE_ID.test(artifact.id) &&
              SAFE_ID.test(artifact.run_id) &&
              stableText(artifact.title, 400) &&
              validInteger(artifact.created_at) &&
              (artifact.content_hash === undefined || HASH.test(artifact.content_hash)) &&
              (artifact.size_bytes === undefined || validInteger(artifact.size_bytes)),
          )
          .sort(
            (left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id),
          )
          .map((artifact) =>
            Object.freeze({
              id: artifact.id,
              runId: artifact.run_id,
              state: artifact.state,
              kind: artifact.kind,
              title: artifact.title,
              ...(safeOptionalText(artifact.safe_summary, 2_000)
                ? { summary: artifact.safe_summary }
                : {}),
              ...(artifact.content_hash === undefined
                ? {}
                : { contentHash: artifact.content_hash }),
              ...(artifact.size_bytes === undefined ? {} : { sizeBytes: artifact.size_bytes }),
              createdAt: artifact.created_at,
              trust: 'app_verified' as const,
            }),
          );
        return Object.freeze({
          outputs: Object.freeze(outputs.slice(0, MAX_OUTPUTS)),
          truncated: outputs.length > MAX_OUTPUTS || runs.length > MAX_OUTPUTS,
        });
      } finally {
        operation.finish();
      }
    },
  });
}
