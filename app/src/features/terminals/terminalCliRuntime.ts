import {
  TERMINAL_LOCAL_IPC_METHODS,
  type TerminalLocalIpcMethod,
} from './terminalCommandFoundation';
import {
  getOrCreateTerminalContextSession,
  rebindTerminalContextSessionProject,
  updateTerminalContextSession,
  type TerminalContextScope,
} from './terminalContextSessionStore';
import type { PreparedContextTurn } from '@/features/context/gateway/contextGatewayContracts';
import type { TerminalContextBridgeIdentity } from './terminalContextBridgeIdentity';

export type TerminalCliFrontendRequest = Readonly<{
  protocolVersion: 1;
  requestId: string;
  terminalSessionId: string | null;
  paneId: string | null;
  projectId: string | null;
  runIdentity: string | null;
  method: TerminalLocalIpcMethod;
  params: Readonly<Record<string, unknown>>;
}>;

export type TerminalCliRuntimeCode =
  | 'ok'
  | 'app_not_running'
  | 'authentication_failed'
  | 'invalid_request'
  | 'unsupported_version'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'context_unavailable'
  | 'internal_error';

export type TerminalCliRuntimeResponse = Readonly<{
  requestId: string;
  ok: boolean;
  code: TerminalCliRuntimeCode;
  message: string;
  data?: unknown;
}>;

export type TerminalCliProject = Readonly<{
  id: string;
  name: string;
  workspaceId: string;
}>;

export type TerminalCliContextMap = Readonly<{
  id: string;
  name: string;
  status: 'active' | 'deleted';
  sourceType?: string;
  sourceLabel?: string;
  updatedAt: number;
}>;

export type TerminalCliContextEntity = Readonly<{
  id: string;
  label: string;
  path?: string;
  mapId: string;
}>;

export type TerminalCliSkill = Readonly<{
  id: string;
  name: string;
  description: string;
}>;

export type TerminalCliAgent = Readonly<{
  slug: string;
  name: string;
  status: string;
}>;

export type TerminalCliCaoIdentityParams = Readonly<{
  opencodeSessionId: string;
  providerId: string;
  modelId: string;
  variant: string;
  processInstanceId: string;
}>;

export type TerminalCliCaoIdentityInput = Readonly<{
  terminalSessionId: string;
  paneId: string;
  projectId: string;
  identity: TerminalCliCaoIdentityParams;
}>;

export interface TerminalCliRuntimeDependencies {
  now(): number;
  currentProject(): TerminalCliProject | null | Promise<TerminalCliProject | null>;
  resolveProject(projectId: string): Promise<TerminalCliProject | null>;
  switchProject(projectId: string): Promise<TerminalCliProject>;
  listContextMaps(projectId: string | null): Promise<readonly TerminalCliContextMap[]>;
  selectContextMap(projectId: string | null, mapId: string): Promise<TerminalCliContextMap>;
  searchContext(
    projectId: string | null,
    mapIds: readonly string[],
    query: string,
  ): Promise<readonly TerminalCliContextEntity[]>;
  resolveContextEntity(
    projectId: string | null,
    target: string,
  ): Promise<TerminalCliContextEntity | null>;
  openContextEntity(projectId: string | null, entity: TerminalCliContextEntity): Promise<void>;
  refreshContextMap(projectId: string | null, mapId: string | null): Promise<TerminalCliContextMap>;
  createContextMap(
    projectId: string | null,
    input: Readonly<{
      sourceKind: 'folder' | 'file' | 'github';
      source: string;
      ref?: string;
    }>,
  ): Promise<TerminalCliContextMap>;
  listSkills(): readonly TerminalCliSkill[];
  listAgents(): readonly TerminalCliAgent[];
  createNote(
    projectId: string | null,
    mapId: string,
  ): Promise<Readonly<{ id: string; name: string }>>;
  openNote(
    projectId: string | null,
    mapId: string,
    name: string,
  ): Promise<Readonly<{ id: string; name: string }>>;
  linkNotes(
    projectId: string | null,
    mapId: string,
    source: string,
    target: string,
  ): Promise<unknown>;
  openDailyNote(
    projectId: string | null,
    mapId: string,
  ): Promise<Readonly<{ id: string; name: string }>>;
  addDailyNoteText(projectId: string | null, mapId: string, text: string): Promise<unknown>;
  authorizeContextIdentity(
    input: Readonly<{
      identityId: string;
      terminalSessionId: string | null;
      paneId: string | null;
      projectId: string | null;
    }>,
  ): TerminalContextBridgeIdentity | null;
  askContext(
    input: Readonly<{
      requestId: string;
      question: string;
      identity: TerminalContextBridgeIdentity;
    }>,
  ): Promise<Readonly<PreparedContextTurn>>;
  verifyContextReceipt(
    input: Readonly<{
      receiptId: string;
      requestId: string;
      scope: Readonly<{
        accountId: string;
        workspaceId: string;
        projectId: string;
        worktreeId: string;
        revision: string;
      }>;
      minimumRoute: 'focused' | 'deep';
    }>,
  ): boolean;
  recordCaoTerminalIdentity(input: TerminalCliCaoIdentityInput): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SAFE_OPENCODE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/u;
const SAFE_VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const MAX_TEXT = 4_096;
const MAX_PARAM_KEYS = 32;
const MAX_PARAM_DEPTH = 4;
const MAX_PARAM_ARRAY = 32;

export class TerminalCliRuntimeServiceError extends Error {
  constructor(
    readonly code: Exclude<TerminalCliRuntimeCode, 'ok'>,
    message: string,
  ) {
    super(message);
    this.name = 'TerminalCliRuntimeServiceError';
  }
}

const TerminalCliRuntimeError = TerminalCliRuntimeServiceError;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

function safeIdentityValue(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && safeText(value);
}

function descriptorValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error('Invalid terminal CLI frontend request');
  }
  return descriptor.value;
}

function cloneJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid terminal CLI frontend request');
    return value;
  }
  if (typeof value === 'string') {
    if (!safeText(value)) throw new Error('Invalid terminal CLI frontend request');
    return value;
  }
  if (depth >= MAX_PARAM_DEPTH) throw new Error('Invalid terminal CLI frontend request');
  if (Array.isArray(value)) {
    if (value.length > MAX_PARAM_ARRAY) {
      throw new Error('Invalid terminal CLI frontend request');
    }
    return Object.freeze(value.map((entry) => cloneJson(entry, depth + 1)));
  }
  if (!plainRecord(value)) throw new Error('Invalid terminal CLI frontend request');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_PARAM_KEYS ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !SAFE_ID.test(key) ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype',
    )
  ) {
    throw new Error('Invalid terminal CLI frontend request');
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of (keys as string[]).sort()) {
    copy[key] = cloneJson(descriptorValue(value, key), depth + 1);
  }
  return Object.freeze(copy);
}

export function parseTerminalCliFrontendRequest(input: unknown): TerminalCliFrontendRequest {
  if (!plainRecord(input)) throw new Error('Invalid terminal CLI frontend request');
  const allowed = new Set([
    'protocolVersion',
    'requestId',
    'terminalSessionId',
    'paneId',
    'projectId',
    'runIdentity',
    'method',
    'params',
  ]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    !['protocolVersion', 'requestId', 'method', 'params'].every((key) => keys.includes(key))
  ) {
    throw new Error('Invalid terminal CLI frontend request');
  }
  const protocolVersion = descriptorValue(input, 'protocolVersion');
  const requestId = descriptorValue(input, 'requestId');
  const method = descriptorValue(input, 'method');
  const terminalSessionId = keys.includes('terminalSessionId')
    ? descriptorValue(input, 'terminalSessionId')
    : null;
  const paneId = keys.includes('paneId') ? descriptorValue(input, 'paneId') : null;
  const projectId = keys.includes('projectId') ? descriptorValue(input, 'projectId') : null;
  const runIdentity = keys.includes('runIdentity') ? descriptorValue(input, 'runIdentity') : null;
  if (
    protocolVersion !== 1 ||
    !safeId(requestId) ||
    typeof method !== 'string' ||
    !TERMINAL_LOCAL_IPC_METHODS.includes(method as TerminalLocalIpcMethod) ||
    (terminalSessionId !== null && !safeId(terminalSessionId)) ||
    (paneId !== null && !safeId(paneId)) ||
    (projectId !== null && !safeId(projectId)) ||
    (runIdentity !== null && !safeId(runIdentity))
  ) {
    throw new Error('Invalid terminal CLI frontend request');
  }
  const params = cloneJson(descriptorValue(input, 'params'));
  if (!plainRecord(params)) throw new Error('Invalid terminal CLI frontend request');
  return Object.freeze({
    protocolVersion: 1,
    requestId,
    terminalSessionId,
    paneId,
    projectId,
    runIdentity,
    method: method as TerminalLocalIpcMethod,
    params,
  });
}

function exactParams(
  request: TerminalCliFrontendRequest,
  keys: readonly string[],
): Record<string, unknown> {
  const actual = Object.keys(request.params);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TerminalCliRuntimeError('invalid_request', 'The terminal CLI request is invalid.');
  }
  return request.params;
}

function stringParam(
  request: TerminalCliFrontendRequest,
  key: string,
  keys: readonly string[] = [key],
): string {
  const value = exactParams(request, keys)[key];
  if (!safeText(value)) {
    throw new TerminalCliRuntimeError('invalid_request', 'The terminal CLI request is invalid.');
  }
  return value;
}

function ok(
  request: TerminalCliFrontendRequest,
  message: string,
  data?: unknown,
): TerminalCliRuntimeResponse {
  return Object.freeze({
    requestId: request.requestId,
    ok: true,
    code: 'ok',
    message,
    ...(data === undefined ? {} : { data }),
  });
}

const CONTEXT_RELOAD_NOTICE =
  'Restart the current agent session or begin a supported fresh turn to guarantee the updated Context is loaded.';

function contextChanged(message: string): string {
  return `${message} ${CONTEXT_RELOAD_NOTICE}`;
}

function exactTerminalContextReceipt(
  prepared: Readonly<PreparedContextTurn>,
  identity: Readonly<TerminalContextBridgeIdentity>,
): boolean {
  const receipt = prepared.receipt;
  const scope = receipt.scopeRevision;
  const execution = receipt.executionIdentity;
  return (
    receipt.required &&
    receipt.safeFailure === null &&
    receipt.route !== 'direct' &&
    scope.accountId === identity.accountId &&
    scope.workspaceId === identity.workspaceId &&
    scope.projectId === identity.projectId &&
    scope.worktreeId === identity.worktreeId &&
    scope.revision === identity.scopeRevision &&
    execution.transportConnectionId === 'vibespace-terminal-context' &&
    execution.transportAdapterId === 'terminal-local-ipc' &&
    execution.upstreamProviderId === 'local-context-gateway' &&
    execution.upstreamModelId === 'context-only' &&
    execution.providerQualifiedModelId === 'local-context-gateway/context-only' &&
    execution.authBillingRoute === 'local-only' &&
    execution.effort === 'not-applicable' &&
    execution.fastVariant === 'not-applicable' &&
    execution.catalogRevision === identity.scopeRevision &&
    execution.observedProviderIdentity === 'local-context-gateway'
  );
}

function fail(
  request: TerminalCliFrontendRequest,
  code: Exclude<TerminalCliRuntimeCode, 'ok'>,
  message: string,
): TerminalCliRuntimeResponse {
  return Object.freeze({ requestId: request.requestId, ok: false, code, message });
}

function contextScope(
  request: TerminalCliFrontendRequest,
  projectId: string | null,
): TerminalContextScope {
  return Object.freeze({
    terminalSessionId: request.terminalSessionId,
    paneId: request.paneId,
    projectId,
  });
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function findMap(maps: readonly TerminalCliContextMap[], selector: string): TerminalCliContextMap {
  const exact = maps.filter(
    (map) => map.id === selector || normalizedName(map.name) === normalizedName(selector),
  );
  if (exact.length === 0) {
    throw new TerminalCliRuntimeError('not_found', 'The requested Context Map was not found.');
  }
  if (exact.length > 1) {
    throw new TerminalCliRuntimeError(
      'conflict',
      'More than one Context Map matches that name; use its id.',
    );
  }
  return exact[0]!;
}

function findSkill(skills: readonly TerminalCliSkill[], selector: string): TerminalCliSkill {
  const skill = skills.find(
    (candidate) =>
      candidate.id === selector || normalizedName(candidate.name) === normalizedName(selector),
  );
  if (!skill) throw new TerminalCliRuntimeError('not_found', 'The requested skill was not found.');
  return skill;
}

function findAgent(agents: readonly TerminalCliAgent[], selector: string): TerminalCliAgent {
  const agent = agents.find(
    (candidate) =>
      candidate.slug === selector || normalizedName(candidate.name) === normalizedName(selector),
  );
  if (!agent) throw new TerminalCliRuntimeError('not_found', 'The requested agent was not found.');
  return agent;
}

function contextNoteMapId(scope: TerminalContextScope, now: number): string {
  const mapId = getOrCreateTerminalContextSession(scope, now).activeMapIds[0];
  if (!mapId) {
    throw new TerminalCliRuntimeError(
      'conflict',
      'Select a Context Map before using Context Notes.',
    );
  }
  return mapId;
}

async function projectForRequest(
  dependencies: TerminalCliRuntimeDependencies,
  request: TerminalCliFrontendRequest,
): Promise<TerminalCliProject | null> {
  if (!request.projectId) return await dependencies.currentProject();
  const project = await dependencies.resolveProject(request.projectId);
  if (!project) {
    throw new TerminalCliRuntimeError(
      'permission_denied',
      'The requested project is not available in the active workspace.',
    );
  }
  return project;
}

export function createTerminalCliRuntime(dependencies: TerminalCliRuntimeDependencies): Readonly<{
  execute(request: TerminalCliFrontendRequest): Promise<TerminalCliRuntimeResponse>;
}> {
  const execute = async (
    request: TerminalCliFrontendRequest,
  ): Promise<TerminalCliRuntimeResponse> => {
    try {
      const project = await projectForRequest(dependencies, request);
      const projectId = project?.id ?? null;
      const scope = contextScope(request, projectId);
      const now = dependencies.now();

      switch (request.method) {
        case 'cao.identity.publish': {
          if (
            !request.terminalSessionId ||
            !request.paneId ||
            !request.projectId ||
            !project ||
            project.id !== request.projectId
          ) {
            throw new TerminalCliRuntimeError(
              'permission_denied',
              'The OpenCode identity is outside this terminal scope.',
            );
          }
          const params = exactParams(request, [
            'opencodeSessionId',
            'providerId',
            'modelId',
            'variant',
            'processInstanceId',
          ]);
          const opencodeSessionId = params.opencodeSessionId;
          const providerId = params.providerId;
          const modelId = params.modelId;
          const variant = params.variant;
          const processInstanceId = params.processInstanceId;
          if (
            !safeIdentityValue(opencodeSessionId, SAFE_OPENCODE_SESSION_ID) ||
            !safeIdentityValue(providerId, SAFE_PROVIDER_ID) ||
            !safeIdentityValue(modelId, SAFE_MODEL_ID) ||
            !safeIdentityValue(variant, SAFE_VARIANT_ID) ||
            !safeIdentityValue(processInstanceId, SAFE_ID)
          ) {
            throw new TerminalCliRuntimeError(
              'invalid_request',
              'The terminal CLI request is invalid.',
            );
          }
          await dependencies.recordCaoTerminalIdentity({
            terminalSessionId: request.terminalSessionId,
            paneId: request.paneId,
            projectId: request.projectId,
            identity: {
              opencodeSessionId,
              providerId,
              modelId,
              variant,
              processInstanceId,
            },
          });
          return ok(request, 'OpenCode terminal identity observed.');
        }
        case 'context.list': {
          exactParams(request, []);
          const maps = (await dependencies.listContextMaps(projectId))
            .filter((map) => map.status === 'active')
            .slice(0, 50);
          return ok(request, `${maps.length} Context Map${maps.length === 1 ? '' : 's'}.`, {
            maps,
          });
        }
        case 'context.current': {
          exactParams(request, []);
          return ok(request, 'Terminal Context loaded.', {
            session: getOrCreateTerminalContextSession(scope, now),
          });
        }
        case 'context.use': {
          const selector = stringParam(request, 'map');
          const map = findMap(await dependencies.listContextMaps(projectId), selector);
          await dependencies.selectContextMap(projectId, map.id);
          const session = updateTerminalContextSession(
            scope,
            { activeMapIds: [map.id], mode: 'persistent' },
            now,
          );
          return ok(request, contextChanged(`Context Map: ${map.name}`), { map, session });
        }
        case 'context.clear': {
          exactParams(request, []);
          const session = updateTerminalContextSession(
            scope,
            { activeMapIds: [], pinnedEntityIds: [], mode: 'persistent' },
            now,
          );
          return ok(request, contextChanged('Terminal Context cleared.'), { session });
        }
        case 'context.search': {
          const query = stringParam(request, 'query');
          const session = getOrCreateTerminalContextSession(scope, now);
          if (session.activeMapIds.length === 0) {
            throw new TerminalCliRuntimeError('conflict', 'Select a Context Map before searching.');
          }
          const results = (
            await dependencies.searchContext(projectId, session.activeMapIds, query)
          ).slice(0, 50);
          return ok(
            request,
            `${results.length} Context result${results.length === 1 ? '' : 's'}.`,
            {
              results,
            },
          );
        }
        case 'context.ask': {
          const question = stringParam(request, 'question');
          if (!request.runIdentity) {
            throw new TerminalCliRuntimeError(
              'permission_denied',
              'This terminal does not have a current VibeSpace Context run identity.',
            );
          }
          const identity = dependencies.authorizeContextIdentity({
            identityId: request.runIdentity,
            terminalSessionId: request.terminalSessionId,
            paneId: request.paneId,
            projectId,
          });
          if (!identity || identity.workspaceId !== project?.workspaceId) {
            throw new TerminalCliRuntimeError(
              'permission_denied',
              'The VibeSpace Context run identity is expired or outside this terminal scope.',
            );
          }
          let prepared: Readonly<PreparedContextTurn>;
          try {
            prepared = await dependencies.askContext({
              requestId: request.requestId,
              question,
              identity,
            });
          } catch {
            throw new TerminalCliRuntimeError(
              'context_unavailable',
              'Required VibeSpace Context is currently unavailable.',
            );
          }
          const receiptScope = {
            accountId: identity.accountId,
            workspaceId: identity.workspaceId,
            projectId: identity.projectId,
            worktreeId: identity.worktreeId,
            revision: identity.scopeRevision,
          } as const;
          const verified =
            exactTerminalContextReceipt(prepared, identity) &&
            dependencies.verifyContextReceipt({
              receiptId: prepared.receipt.receiptId,
              requestId: request.requestId,
              scope: receiptScope,
              minimumRoute: prepared.receipt.route === 'deep' ? 'deep' : 'focused',
            });
          if (!verified) {
            throw new TerminalCliRuntimeError(
              'context_unavailable',
              'Required VibeSpace Context receipt verification failed.',
            );
          }
          const answer = prepared.promptBlock.slice(0, 14_000);
          if (!answer) {
            throw new TerminalCliRuntimeError(
              'context_unavailable',
              'Required VibeSpace Context returned no authorized evidence.',
            );
          }
          return ok(request, 'VibeSpace Context ready.', {
            answer,
            truncated: answer.length < prepared.promptBlock.length,
            receipt: prepared.receipt,
          });
        }
        case 'context.open': {
          const target = stringParam(request, 'target');
          const entity = await dependencies.resolveContextEntity(projectId, target);
          if (!entity) {
            throw new TerminalCliRuntimeError('not_found', 'The Context entity was not found.');
          }
          await dependencies.openContextEntity(projectId, entity);
          return ok(request, `Opened Context: ${entity.label}`, { entity });
        }
        case 'context.attach': {
          const params = exactParams(request, ['entity', 'mode']);
          if (
            !safeText(params.entity) ||
            !['persistent', 'one_turn'].includes(String(params.mode))
          ) {
            throw new TerminalCliRuntimeError(
              'invalid_request',
              'The terminal CLI request is invalid.',
            );
          }
          const entity = await dependencies.resolveContextEntity(projectId, params.entity);
          if (!entity) {
            throw new TerminalCliRuntimeError('not_found', 'The Context entity was not found.');
          }
          const current = getOrCreateTerminalContextSession(scope, now);
          const pinnedEntityIds = [...new Set([...current.pinnedEntityIds, entity.id])];
          const session = updateTerminalContextSession(
            scope,
            {
              pinnedEntityIds,
              mode: params.mode as 'persistent' | 'one_turn',
            },
            now,
          );
          return ok(
            request,
            contextChanged(
              params.mode === 'one_turn'
                ? `Attached ${entity.label} for the next supported agent turn.`
                : `Attached Context: ${entity.label}`,
            ),
            { entity, session },
          );
        }
        case 'context.refresh': {
          const params = exactParams(request, ['map']);
          if (params.map !== null && !safeText(params.map)) {
            throw new TerminalCliRuntimeError(
              'invalid_request',
              'The terminal CLI request is invalid.',
            );
          }
          let mapId: string | null = null;
          if (typeof params.map === 'string') {
            mapId = findMap(await dependencies.listContextMaps(projectId), params.map).id;
          } else {
            mapId = getOrCreateTerminalContextSession(scope, now).activeMapIds[0] ?? null;
          }
          const map = await dependencies.refreshContextMap(projectId, mapId);
          const current = getOrCreateTerminalContextSession(scope, now);
          const isActive = current.activeMapIds.includes(map.id);
          const session = isActive ? updateTerminalContextSession(scope, {}, now) : current;
          return ok(
            request,
            isActive
              ? contextChanged(`Refreshed Context Map: ${map.name}`)
              : `Refreshed Context Map: ${map.name}`,
            { map, session },
          );
        }
        case 'context.sources': {
          exactParams(request, []);
          const sources = (await dependencies.listContextMaps(projectId))
            .filter((map) => map.status === 'active')
            .slice(0, 50)
            .map(({ id, name, sourceType, sourceLabel, updatedAt }) => ({
              id,
              name,
              sourceType: sourceType ?? 'unknown',
              sourceLabel: sourceLabel ?? '',
              updatedAt,
            }));
          return ok(
            request,
            `${sources.length} Context source${sources.length === 1 ? '' : 's'}.`,
            {
              sources,
            },
          );
        }
        case 'context.status': {
          exactParams(request, []);
          const [session, maps] = await Promise.all([
            Promise.resolve(getOrCreateTerminalContextSession(scope, now)),
            dependencies.listContextMaps(projectId),
          ]);
          return ok(request, 'Terminal Context status ready.', {
            session,
            activeMapCount: maps.filter((map) => map.status === 'active').length,
          });
        }
        case 'context.create': {
          const params = request.params;
          const sourceKind = params.sourceKind;
          const keys =
            sourceKind === 'github' ? ['sourceKind', 'source', 'ref'] : ['sourceKind', 'source'];
          exactParams(request, keys);
          if (
            !['folder', 'file', 'github'].includes(String(sourceKind)) ||
            !safeText(params.source) ||
            (sourceKind === 'github' && !safeText(params.ref))
          ) {
            throw new TerminalCliRuntimeError(
              'invalid_request',
              'The terminal CLI request is invalid.',
            );
          }
          const map = await dependencies.createContextMap(projectId, {
            sourceKind: sourceKind as 'folder' | 'file' | 'github',
            source: params.source,
            ...(typeof params.ref === 'string' ? { ref: params.ref } : {}),
          });
          return ok(request, `Created Context Map: ${map.name}`, { map });
        }
        case 'skills.list': {
          exactParams(request, []);
          const skills = dependencies.listSkills().slice(0, 100);
          return ok(request, `${skills.length} skill${skills.length === 1 ? '' : 's'}.`, {
            skills,
          });
        }
        case 'skills.active': {
          exactParams(request, []);
          return ok(request, 'Active terminal skills.', {
            skills: getOrCreateTerminalContextSession(scope, now).activeSkillIds,
          });
        }
        case 'skills.use':
        case 'skills.add':
        case 'skills.remove': {
          const selector = stringParam(request, 'skill');
          const skill = findSkill(dependencies.listSkills(), selector);
          const current = getOrCreateTerminalContextSession(scope, now);
          const activeSkillIds =
            request.method === 'skills.use'
              ? [skill.id]
              : request.method === 'skills.add'
                ? [...new Set([...current.activeSkillIds, skill.id])]
                : current.activeSkillIds.filter((id) => id !== skill.id);
          const session = updateTerminalContextSession(scope, { activeSkillIds }, now);
          return ok(request, `Terminal skills: ${activeSkillIds.join(', ') || 'none'}`, {
            session,
          });
        }
        case 'skills.clear': {
          exactParams(request, []);
          const session = updateTerminalContextSession(scope, { activeSkillIds: [] }, now);
          return ok(request, 'Terminal skills cleared.', { session });
        }
        case 'skills.inspect': {
          const skill = findSkill(dependencies.listSkills(), stringParam(request, 'skill'));
          return ok(request, `${skill.name}: ${skill.description}`, { skill });
        }
        case 'agent.list': {
          exactParams(request, []);
          const agents = dependencies.listAgents().slice(0, 100);
          return ok(request, `${agents.length} agent${agents.length === 1 ? '' : 's'}.`, {
            agents,
          });
        }
        case 'agent.current': {
          exactParams(request, []);
          const slug = getOrCreateTerminalContextSession(scope, now).agentSlug;
          const agent = slug ? findAgent(dependencies.listAgents(), slug) : null;
          return ok(request, agent ? `Agent: ${agent.name}` : 'No terminal agent selected.', {
            agent,
          });
        }
        case 'agent.use': {
          const agent = findAgent(dependencies.listAgents(), stringParam(request, 'slug'));
          const session = updateTerminalContextSession(scope, { agentSlug: agent.slug }, now);
          return ok(request, `Agent: ${agent.name}`, { agent, session });
        }
        case 'agent.clear': {
          exactParams(request, []);
          const session = updateTerminalContextSession(scope, { agentSlug: null }, now);
          return ok(request, 'Terminal agent cleared.', { session });
        }
        case 'agent.status': {
          exactParams(request, []);
          const slug = getOrCreateTerminalContextSession(scope, now).agentSlug;
          const agent = slug ? findAgent(dependencies.listAgents(), slug) : null;
          return ok(
            request,
            agent ? `${agent.name}: ${agent.status}` : 'No terminal agent selected.',
            {
              agent,
            },
          );
        }
        case 'note.new': {
          exactParams(request, []);
          const note = await dependencies.createNote(projectId, contextNoteMapId(scope, now));
          return ok(request, `Created note: ${note.name}`, { note });
        }
        case 'note.open': {
          const note = await dependencies.openNote(
            projectId,
            contextNoteMapId(scope, now),
            stringParam(request, 'name'),
          );
          return ok(request, `Opened note: ${note.name}`, { note });
        }
        case 'note.link': {
          const params = exactParams(request, ['source', 'target']);
          if (!safeText(params.source) || !safeText(params.target)) {
            throw new TerminalCliRuntimeError(
              'invalid_request',
              'The terminal CLI request is invalid.',
            );
          }
          const link = await dependencies.linkNotes(
            projectId,
            contextNoteMapId(scope, now),
            params.source,
            params.target,
          );
          return ok(request, `Linked ${params.source} to ${params.target}.`, { link });
        }
        case 'daily.open': {
          exactParams(request, []);
          const note = await dependencies.openDailyNote(projectId, contextNoteMapId(scope, now));
          return ok(request, `Daily note: ${note.name}`, { note });
        }
        case 'daily.add': {
          const text = stringParam(request, 'text');
          const note = await dependencies.addDailyNoteText(
            projectId,
            contextNoteMapId(scope, now),
            text,
          );
          return ok(request, 'Added text to the daily note.', { note });
        }
        case 'project.current': {
          exactParams(request, []);
          return ok(request, project ? `Project: ${project.name}` : 'No project selected.', {
            project,
          });
        }
        case 'project.switch': {
          const projectIdToSelect = stringParam(request, 'projectId');
          const available = await dependencies.resolveProject(projectIdToSelect);
          if (!available) {
            throw new TerminalCliRuntimeError(
              'permission_denied',
              'The requested project is not available in the active workspace.',
            );
          }
          const selected = await dependencies.switchProject(projectIdToSelect);
          const session = rebindTerminalContextSessionProject(scope, selected.id, now);
          return ok(request, `Project: ${selected.name}`, { project: selected, session });
        }
        case 'status':
          return ok(request, 'VibeSpace is running.');
        case 'help':
          return ok(request, 'VibeSpace terminal CLI help.', {
            methods: TERMINAL_LOCAL_IPC_METHODS,
          });
      }
    } catch (error) {
      if (error instanceof TerminalCliRuntimeError) {
        return fail(request, error.code, error.message);
      }
      return fail(request, 'internal_error', 'The terminal CLI command could not be completed.');
    }
  };
  return Object.freeze({ execute });
}
