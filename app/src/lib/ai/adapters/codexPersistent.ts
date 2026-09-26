import { decodeCodexThreadCache, encodeCodexThreadCache } from './codexThreadCache';
import { createCodexControlBridge } from './codexControlBridge';
import {
  buildCodexGoalSetRequest,
  parseCodexGoalObjective,
  validateCodexGoalSetResult,
} from './codexGoalCommand';
import { restoredConversationPrompt } from './restoredConversationPrompt';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { codexTurnLease } from './codexTurnLease';
import {
  CODEX_CONTEXT_TOOL,
  createCodexToolGateway,
  type CodexContextToolBridge,
} from './codexContextTool';
import { resolveCodexWorkingDirectory } from './codexWorkingDirectory';
import {
  nativeCodexFrames,
  startNativeCodexAppServer,
  stopNativeCodexAppServer,
  writeNativeCodexFrame,
  type CodexNativeStartRoute,
} from '@/lib/harness/codexNativeTransport';
import {
  buildCodexModelListRequest,
  buildCodexSkillsListRequest,
  buildCodexSkillsRefreshRequest,
  buildCodexSkillUserInputs,
  buildCodexThreadResumeRequest,
  buildCodexThreadPolicyUpdateRequest,
  buildCodexThreadStartRequest,
  buildCodexThreadQueueAddRequest,
  buildCodexThreadQueueListRequest,
  buildCodexThreadQueueStartRequest,
  buildCodexThreadReadRequest,
  buildCodexTurnSteerRequest,
  buildCodexTurnInterruptRequest,
  buildCodexTurnStartRequest,
  validateCodexModelListResponse,
  validateCodexSkillsListResponse,
  isCodexSkillsChangedNotification,
  validateCodexThreadStartResponse,
  validateCodexThreadQueueAddResponse,
  validateCodexThreadQueueListResponse,
  validateCodexThreadQueueStartResponse,
  validateCodexTurnSteerResponse,
  type CodexBackendIdentity,
  type CodexDiscoveredSkill,
  type CodexSkillsListEntry,
  type CodexExecutionMode,
} from './codexAppServerProtocol';
import { reconcileCodexQueue } from './codexQueueReconcile';
import {
  normalizeCodexAppServerMessage,
  normalizeCodexThreadBindingResponse,
} from './codexAppServer';
import { findCliExecutable, probeCliBridge } from './cliBridge';
import type { DetectedExecutable } from './cliBridge';
import type {
  ProviderAdapter,
  ProviderDiscoveredModel,
  ProviderEvent,
  ProviderRequest,
  ProviderLiveTurnControl,
  UsageSnapshot,
} from './types';
import { publicToolDetails } from '../publicToolDetails';
import { NativeTurnControlOutcomeUnknownError } from '../nativeSteer';
import { codexRuntimeManager, type CodexRuntimeManager } from '@/lib/harness/codexRuntimeManager';
import { redactHarnessText } from '@/lib/harness/errors';
import {
  isProviderRuntimeError,
  providerErrorDetails,
  richestProviderErrorDetails,
  ProviderRuntimeError,
} from '../providerError';

type NativeFrame = Record<string, unknown>;
type CodexSkillRequest = ProviderRequest;

function codexSkillPathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function selectDiscoveredCodexSkills(
  selected: readonly CodexDiscoveredSkill[] | undefined,
  entry: CodexSkillsListEntry,
): readonly CodexDiscoveredSkill[] {
  if (!selected?.length) return [];
  const discovered = new Map(
    entry.skills.map((skill) => [`${skill.name}\u0000${codexSkillPathKey(skill.path)}`, skill]),
  );
  const result: CodexDiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const reference of selected) {
    if (!reference || reference.enabled !== true || reference.cwd !== entry.cwd) {
      throw new Error('Selected Codex skill is unavailable for the active working directory.');
    }
    const key = `${reference.name}\u0000${codexSkillPathKey(reference.path)}`;
    const skill = discovered.get(key);
    if (!skill || !skill.enabled || seen.has(key)) {
      throw new Error(
        'Selected Codex skill is missing, disabled, or duplicated in native discovery.',
      );
    }
    seen.add(key);
    result.push(skill);
  }
  // Reuse the protocol's count, name, path, and duplicate validation before
  // any native turn/steer/queue request is sent.
  buildCodexSkillUserInputs('Validate selected native skill references.', result);
  return result;
}

const CODEX_CONTROL_RESPONSE_TIMEOUT_MS = 15_000;
const CODEX_MCP_STATUS_STAGE_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function prepare<T>(
  request: ProviderRequest,
  phase: string,
  action: () => Promise<T>,
): Promise<T> {
  // Record phase timing without copying native frames, policies, paths or credentials.
  let result!: T;
  await appActivityLog.trace(
    `model.prepare.codex.${phase}`,
    {
      chatId: request.chatId,
      requestId: request.requestId,
      modelId: request.modelId,
    },
    async () => {
      result = await action();
    },
  );
  return result;
}

export interface CodexPersistentDependencies {
  contextTool?(request: ProviderRequest): Promise<CodexContextToolBridge | null>;
  workingDirectory?(selected: string | undefined): Promise<string>;
  findExecutable(): Promise<Readonly<{ executableId: string }> | undefined>;
  start(
    executableId: string,
    ownerId: string,
    modelId: string,
    route: CodexNativeStartRoute,
  ): Promise<Readonly<{ generation: string }>>;
  frames(
    generation: string,
    signal?: AbortSignal,
  ): Readonly<{
    stream: AsyncIterable<NativeFrame>;
    ready: Promise<void>;
  }>;
  write(generation: string, message: NativeFrame): Promise<void>;
  stop(generation: string): Promise<boolean>;
}

export interface CodexExecutableResolverDependencies {
  manager: Pick<CodexRuntimeManager, 'refresh' | 'getSnapshot'>;
  findSystem(): Promise<DetectedExecutable | undefined>;
  probeSystemVersion?(executableId: string): Promise<string | undefined>;
  allowSystemPromotion?(executable: DetectedExecutable): Promise<boolean>;
}

async function officialCodexAppExecutable(executable: DetectedExecutable): Promise<boolean> {
  const { localDataDir } = await import('@tauri-apps/api/path');
  const localRoot = (await localDataDir())
    .replace(/^\\\\\?\\/u, '')
    .replaceAll('\\', '/')
    .replace(/\/+$/u, '');
  const candidate = executable.executablePath.replace(/^\\\\\?\\/u, '').replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//u.test(localRoot)) return false;
  const prefix = `${localRoot}/OpenAI/Codex/bin/`;
  return (
    candidate.toLocaleLowerCase('en-US').startsWith(prefix.toLocaleLowerCase('en-US')) &&
    /^[a-f0-9]{16}\/codex\.exe$/iu.test(candidate.slice(prefix.length))
  );
}

const defaultResolverDependencies: CodexExecutableResolverDependencies = {
  manager: codexRuntimeManager,
  findSystem: () => findCliExecutable('codex'),
  allowSystemPromotion: officialCodexAppExecutable,
  probeSystemVersion: async (executableId) => {
    const probe = await probeCliBridge({
      executableId,
      args: ['--version'],
      timeoutMs: 3_000,
      outputLimitBytes: 1_024,
    });
    return probe.exitCode === 0 && !probe.timedOut ? probe.stdout.data : undefined;
  },
};

function codexVersionParts(value: string): readonly number[] | undefined {
  const match = /(?:^|\s)(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/u.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isNewerCodexVersion(candidate: string, current: string): boolean {
  const next = codexVersionParts(candidate);
  const baseline = codexVersionParts(current);
  if (!next || !baseline) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== baseline[index]) return next[index] > baseline[index];
  }
  return false;
}

const systemChoiceCache = new WeakMap<
  CodexExecutableResolverDependencies,
  {
    readonly managedId: string;
    readonly managedVersion: string;
    readonly checkedAt: number;
    readonly selected?: DetectedExecutable;
  }
>();

async function newerSystemExecutable(
  dependencies: CodexExecutableResolverDependencies,
  managed: Readonly<{ executableId: string; codexVersion: string }>,
): Promise<DetectedExecutable | undefined> {
  if (!dependencies.probeSystemVersion) return undefined;
  const cached = systemChoiceCache.get(dependencies);
  if (
    cached &&
    cached.managedId === managed.executableId &&
    cached.managedVersion === managed.codexVersion &&
    Date.now() - cached.checkedAt < 60_000
  ) {
    return cached.selected;
  }
  const system = await dependencies.findSystem().catch(() => undefined);
  if (!system) return undefined;
  if (
    dependencies.allowSystemPromotion &&
    !(await dependencies.allowSystemPromotion(system).catch(() => false))
  )
    return undefined;
  const version = await dependencies.probeSystemVersion(system.executableId).catch(() => undefined);
  if (!version || !codexVersionParts(version)) return undefined;
  const selected = isNewerCodexVersion(version, managed.codexVersion) ? system : undefined;
  systemChoiceCache.set(dependencies, {
    managedId: managed.executableId,
    managedVersion: managed.codexVersion,
    checkedAt: Date.now(),
    selected,
  });
  return selected;
}

export async function resolveCodexExecutable(
  dependencies: CodexExecutableResolverDependencies = defaultResolverDependencies,
): Promise<Readonly<{ executableId: string }> | DetectedExecutable | undefined> {
  try {
    // Native launch revalidates the registered executable and seals OpenCodex.
    // Repeating full managed discovery here adds cold-start work to every turn.
    const ready = dependencies.manager.getSnapshot();
    if (ready.kind === 'ready') {
      const system = await newerSystemExecutable(dependencies, ready);
      if (system) return system;
      return Object.freeze({ executableId: ready.executableId });
    }
    await dependencies.manager.refresh();
    const managed = dependencies.manager.getSnapshot();
    if (managed.kind === 'ready') {
      const system = await newerSystemExecutable(dependencies, managed);
      if (system) return system;
      return Object.freeze({ executableId: managed.executableId });
    }
  } catch {
    // The existing fingerprinted system scan remains an independent trusted authority.
  }
  return dependencies.findSystem();
}

const defaultDependencies: CodexPersistentDependencies = {
  contextTool: createCodexToolGateway,
  workingDirectory: resolveCodexWorkingDirectory,
  findExecutable: () => resolveCodexExecutable(),
  start: startNativeCodexAppServer,
  frames: (generation, signal) => {
    let subscribed!: () => void;
    const ready = new Promise<void>((resolve) => {
      subscribed = resolve;
    });
    return {
      stream: nativeCodexFrames(generation, signal, undefined, subscribed),
      ready,
    };
  },
  write: writeNativeCodexFrame,
  stop: stopNativeCodexAppServer,
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u;
const CODEX_MODEL_CATALOG_OWNER = 'vibespace-codex-model-catalog';
const CODEX_MODEL_CATALOG_BOOTSTRAP = 'gpt-5.6-luna';
const CODEX_SKILL_CATALOG_OWNER = 'vibespace-codex-skill-catalog';
const CODEX_MCP_STATUS_OWNER = 'vibespace-codex-mcp-status';
const CODEX_MODEL_PAGE_LIMIT = 100;
const CODEX_MODEL_MAX_PAGES = 32;
const CODEX_MCP_STATUS_PAGE_LIMIT = 100;
const CODEX_MCP_STATUS_MAX_PAGES = 32;
const codexModelCatalogInvalidators = new Set<() => void>();

export type CodexMcpServerRuntimeStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled';

/** Safe public projection; native auth, error and inventory fields are omitted. */
export interface CodexMcpServerConnectionStatus {
  readonly name: string;
  readonly runtimeStatus: CodexMcpServerRuntimeStatus | null;
}

interface CodexMcpServerStatusPage {
  readonly servers: readonly CodexMcpServerConnectionStatus[];
  readonly nextCursor: string | null;
}

const CODEX_MCP_RUNTIME_STATUSES = new Set<CodexMcpServerRuntimeStatus>([
  'notStarted',
  'starting',
  'connected',
  'authenticationRequired',
  'failed',
  'cancelled',
  'disabled',
]);

function parseCodexMcpServerStatusPage(
  value: unknown,
  expectedRequestId: string,
): CodexMcpServerStatusPage {
  const envelope = recordOf(value);
  if (!envelope || envelope.id !== expectedRequestId) {
    throw new Error('Codex MCP server status response identity is invalid.');
  }
  const result = recordOf(envelope.result);
  if (!result || !Array.isArray(result.data) || result.data.length > CODEX_MCP_STATUS_PAGE_LIMIT) {
    throw new Error('Codex MCP server status response data is invalid.');
  }
  const nextCursor = result.nextCursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' ||
      !nextCursor ||
      nextCursor.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(nextCursor))
  ) {
    throw new Error('Codex MCP server status cursor is invalid.');
  }
  const servers = result.data.map((value): CodexMcpServerConnectionStatus => {
    const row = recordOf(value);
    const name = row?.name;
    const runtimeStatus = row?.runtimeStatus;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name !== name.trim() ||
      name.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error('Codex MCP server status name is invalid.');
    }
    if (
      runtimeStatus !== null &&
      (typeof runtimeStatus !== 'string' ||
        !CODEX_MCP_RUNTIME_STATUSES.has(runtimeStatus as CodexMcpServerRuntimeStatus))
    ) {
      throw new Error('Codex MCP server runtime status is invalid.');
    }
    return { name, runtimeStatus: runtimeStatus as CodexMcpServerRuntimeStatus | null };
  });
  return { servers, nextCursor: typeof nextCursor === 'string' ? nextCursor : null };
}

export function invalidateCodexPersistentModelCache(): void {
  codexModelCatalogInvalidators.forEach((invalidate) => invalidate());
}

function safeCodexModelText(value: unknown, fallback: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return fallback;
  }
  return value.trim();
}

function parseCodexModelListPage(
  value: unknown,
  expectedRequestId: string,
): { models: readonly ProviderDiscoveredModel[]; nextCursor?: string } {
  const envelope = recordOf(value);
  if (!envelope || envelope.id !== expectedRequestId) {
    throw new Error('Codex model catalog response identity is invalid.');
  }
  const result = recordOf(envelope.result);
  if (!result || !Array.isArray(result.data) || result.data.length > CODEX_MODEL_PAGE_LIMIT) {
    throw new Error('Codex model catalog response data is invalid.');
  }
  const nextCursor = result.nextCursor;
  if (
    nextCursor !== null &&
    nextCursor !== undefined &&
    (typeof nextCursor !== 'string' ||
      nextCursor.length === 0 ||
      nextCursor.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(nextCursor))
  ) {
    throw new Error('Codex model catalog cursor is invalid.');
  }
  const models: ProviderDiscoveredModel[] = [];
  for (const row of result.data) {
    const model = recordOf(row);
    const id = typeof model?.model === 'string' ? model.model : '';
    if (!CODEX_MODEL_ID.test(id)) throw new Error('Codex model catalog model identity is invalid.');
    const rawEfforts = model?.supportedReasoningEfforts;
    const variants = Array.isArray(rawEfforts)
      ? rawEfforts
          .map((entry) => recordOf(entry)?.reasoningEffort)
          .filter(
            (entry): entry is string => typeof entry === 'string' && CODEX_MODEL_ID.test(entry),
          )
      : [];
    const uniqueVariants = [...new Set(variants)];
    const advertisedDefault = model?.defaultReasoningEffort;
    const defaultReasoningEffort =
      typeof advertisedDefault === 'string' &&
      CODEX_MODEL_ID.test(advertisedDefault) &&
      uniqueVariants.includes(advertisedDefault)
        ? advertisedDefault
        : undefined;
    models.push({
      id,
      label: safeCodexModelText(model?.displayName ?? model?.name, id),
      ...(uniqueVariants.length > 0 ? { variants: uniqueVariants } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }
  return {
    models,
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  };
}

function parsePublicToolResult(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function codexRequestError(fallbackMessage: string, value: unknown): Error {
  const envelope = recordOf(value);
  const nested = recordOf(envelope?.error) ?? envelope;
  const rawMessage = nested?.message ?? envelope?.message;
  const reason =
    typeof rawMessage === 'string' && rawMessage.trim()
      ? redactHarnessText(rawMessage).slice(0, 2_048)
      : undefined;
  const error = new Error(reason ? `${fallbackMessage}: ${reason}` : fallbackMessage) as Error &
    Record<string, unknown>;
  const rawCode = nested?.code ?? nested?.errorCode ?? nested?.error_code;
  const code =
    typeof rawCode === 'string' && rawCode.trim()
      ? rawCode.trim().slice(0, 128)
      : typeof rawCode === 'number' && Number.isFinite(rawCode)
        ? String(rawCode)
        : undefined;
  const providerId =
    typeof nested?.providerId === 'string'
      ? nested.providerId
      : typeof nested?.providerID === 'string'
        ? nested.providerID
        : typeof nested?.provider === 'string'
          ? nested.provider
          : undefined;
  const modelId =
    typeof nested?.modelId === 'string'
      ? nested.modelId
      : typeof nested?.modelID === 'string'
        ? nested.modelID
        : typeof nested?.model === 'string'
          ? nested.model
          : undefined;
  const retryAfterMs =
    nested?.retryAfterMs ?? nested?.retry_after_ms ?? nested?.retryAfter ?? nested?.retry_after;
  const resetAt = nested?.resetAt ?? nested?.reset_at ?? nested?.resetsAt;
  if (code) error.code = code;
  if (providerId) error.providerId = providerId;
  if (modelId) error.modelId = modelId;
  if (typeof nested?.retryable === 'boolean') error.retryable = nested.retryable;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    error.retryAfterMs = retryAfterMs;
  }
  if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt >= 0) {
    error.resetAt = resetAt;
  }
  return error;
}

function codexFrameError(frame: NativeFrame, fallbackMessage: string): Error | undefined {
  if (recordOf(frame.error)) return codexRequestError(fallbackMessage, frame.error);
  if (frame.method === 'error') {
    const params = recordOf(frame.params);
    return codexRequestError(fallbackMessage, params?.error ?? params ?? frame);
  }
  return undefined;
}

function codexFrameWillRetry(frame: NativeFrame): boolean {
  if (frame.method !== 'error') return false;
  const params = recordOf(frame.params);
  return params?.willRetry === true || recordOf(params?.error)?.willRetry === true;
}

function promptText(request: Readonly<ProviderRequest>, newThread = false): string {
  return newThread ? restoredConversationPrompt(request) : request.prompt;
}

function developerInstructions(request: Readonly<ProviderRequest>): string {
  return [
    request.systemPrompt?.trim(),
    '## Codex native execution',
    'For coding work, use the available native file and command tools when the current mode permits them. Do not replace those tools with textual files.create, files.edit, or terminal action proposals.',
    'Native sandbox and approval rules remain authoritative. Ask and Plan remain read-only; never bypass a denied tool or approval through another connector.',
    'Textual VibeSpace action proposals are only for app operations without an available native tool. Finish the response after such a proposal so the chat can present its approval; do not wait for approval inside the active turn.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function effort(request: Readonly<ProviderRequest>): string | null {
  const value = request.reasoningEffort ?? request.runtimeSettings?.effort;
  if (!value || value === 'auto') return null;
  // Codex app-server currently exposes Luna's lowest native effort as `low`.
  // Keep direct adapter callers aligned with the shared route policy instead
  // of allowing a stale `minimal`/`none` alias to reach thread/start or
  // turn/start and fail after the request has already begun.
  if (request.modelId === 'gpt-5.6-luna' && (value === 'minimal' || value === 'none')) {
    return 'low';
  }
  if (value === 'ultra') return 'xhigh';
  return value;
}

function createTurnUsageAccumulator() {
  const baseline = new Map<string, number | null>();
  return (usage: UsageSnapshot, frame: NativeFrame): UsageSnapshot => {
    const totals = recordOf(recordOf(recordOf(frame.params)?.tokenUsage)?.total);
    const result = { ...usage };
    for (const [key, source] of [
      ['inputTokens', 'inputTokens'],
      ['outputTokens', 'outputTokens'],
      ['totalTokens', 'totalTokens'],
      ['cacheReadTokens', 'cachedInputTokens'],
      ['cacheWriteTokens', 'cacheWriteInputTokens'],
      ['reasoningTokens', 'reasoningOutputTokens'],
    ] as const) {
      const total = totals?.[source];
      const last = usage[key]?.value;
      const valid = typeof total === 'number' && Number.isFinite(total) && total >= 0;
      if (!baseline.has(key)) {
        baseline.set(key, valid && last !== undefined && total >= last ? total - last : null);
      }
      const before = baseline.get(key);
      result[key] =
        valid && before !== null && before !== undefined && total >= before
          ? { value: total - before, provenance: 'provider-reported' }
          : { provenance: 'unavailable', reason: 'Codex did not report a complete turn counter.' };
    }
    return result;
  };
}

export function codexApprovalPolicyForRequest(
  request: Pick<ProviderRequest, 'agentApprovalMode' | 'approveAllForRun'>,
): 'never' | 'on-request' {
  if (request.agentApprovalMode === 'full') return 'never';
  if (request.agentApprovalMode === 'review') return 'on-request';
  return request.approveAllForRun ? 'never' : 'on-request';
}

function executionMode(request: Readonly<ProviderRequest>): CodexExecutionMode {
  const mode = request.interactionMode ?? 'agent';
  if (mode === 'ask' || mode === 'plan') return { kind: mode };
  const cwd = request.workingDirectory;
  if (!cwd) throw new Error('Codex Agent mode requires an exact working directory.');
  if (request.accessLevel === 'read-only') return { kind: 'ask' };
  if (request.agentApprovalMode === 'full') {
    return {
      kind: 'agent',
      approvalPolicy: codexApprovalPolicyForRequest(request),
      sandbox: { kind: 'danger-full-access' },
    };
  }
  return {
    kind: 'agent',
    approvalPolicy: codexApprovalPolicyForRequest(request),
    sandbox: {
      kind: 'workspace-write',
      writableRoots: [cwd],
      networkAccess: false,
    },
  };
}

function nativeStartRoute(request: Readonly<ProviderRequest>): CodexNativeStartRoute {
  const route = request.codexRoute;
  if (!route) throw new Error('Codex route authority is missing.');
  if (route.kind === 'official-codex') {
    if (request.connection.id !== 'openai-codex' || route.connectionId !== 'openai-codex') {
      throw new Error('Official Codex requires the exact Codex connection.');
    }
    return Object.freeze({ kind: 'official-codex', connectionId: 'openai-codex' });
  }
  if (
    !request.accountId ||
    route.accountId !== request.accountId ||
    route.connectionId !== request.connection.id
  ) {
    throw new Error('Codex route authority does not match this account or connection.');
  }
  return Object.freeze({
    kind: route.kind,
    accountId: route.accountId,
    connectionId: route.connectionId,
    routeHandle: route.routeHandle,
    configurationGeneration: route.configurationGeneration,
  });
}

function identity(request: Readonly<ProviderRequest>): CodexBackendIdentity {
  if (!request.modelId) throw new Error('Codex requires an exact selected model.');
  if (!request.workingDirectory) throw new Error('Codex requires an exact working directory.');
  return {
    modelProvider: 'openai',
    model: request.modelId,
    effort: effort(request),
    serviceTier: request.runtimeSettings?.fastMode === 'on' ? 'fast' : null,
    cwd: request.workingDirectory,
  };
}

function requestId(base: string, suffix: string): string {
  const normalized = base.replace(/[^A-Za-z0-9._:@/+/-]/gu, '_').slice(0, 220);
  if (!normalized) throw new Error('Codex request identity is invalid.');
  return normalized + '_' + suffix;
}

async function nextFrame(
  iterator: AsyncIterator<NativeFrame>,
  failure: string,
): Promise<NativeFrame> {
  const next = await iterator.next();
  if (next.done) throw new Error(failure);
  return next.value;
}

async function responseFrame(
  iterator: AsyncIterator<NativeFrame>,
  id: string,
): Promise<NativeFrame> {
  for (let count = 0; count < 4_096; count += 1) {
    const frame = await nextFrame(iterator, 'Codex app-server ended before its response.');
    if (frame.id === id) return frame;
    if (frame.method === 'error') {
      throw codexRequestError('Codex app-server rejected the request.', frame);
    }
  }
  throw new Error('Codex app-server response exceeded its safe event bound.');
}

function createCodexFrameReader(
  source: AsyncIterator<NativeFrame>,
  firstFrame: Promise<IteratorResult<NativeFrame>>,
  handleControlResponse: (frame: NativeFrame) => boolean,
  hasPendingControl: () => boolean,
): AsyncIterator<NativeFrame> & { wake(): void; close(): void } {
  const buffered: NativeFrame[] = [];
  const readers: {
    resolve: (result: IteratorResult<NativeFrame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let started = false;
  let ended = false;
  let failure: unknown;
  let wakePump: (() => void) | undefined;

  const hasDemand = () => readers.length > 0 || hasPendingControl();
  const waitForDemand = () => {
    if (hasDemand()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      wakePump = resolve;
      if (hasDemand()) {
        wakePump = undefined;
        resolve();
      }
    });
  };
  const wake = () => {
    const resume = wakePump;
    wakePump = undefined;
    resume?.();
  };

  const deliver = (frame: NativeFrame) => {
    if (handleControlResponse(frame)) return;
    const reader = readers.shift();
    if (reader) reader.resolve({ done: false, value: frame });
    else {
      if (buffered.length >= 65_536)
        throw new Error('Codex app-server frame buffer exceeded its safe bound.');
      buffered.push(frame);
    }
  };
  const finish = (error?: unknown) => {
    ended = true;
    failure = error;
    for (const reader of readers.splice(0)) {
      if (error !== undefined) reader.reject(error);
      else reader.resolve({ done: true, value: undefined });
    }
  };
  const pump = async () => {
    try {
      let next = await firstFrame;
      while (!next.done && !ended) {
        deliver(next.value);
        await waitForDemand();
        if (ended) break;
        next = await source.next();
      }
      finish();
    } catch (error) {
      finish(error);
    }
  };
  const start = () => {
    if (started) return;
    started = true;
    void pump();
  };

  return {
    wake,
    close: () => {
      if (ended) return;
      finish();
      wake();
    },
    next: () => {
      start();
      const frame = buffered.shift();
      if (frame) return Promise.resolve({ done: false, value: frame });
      if (failure !== undefined) return Promise.reject(failure);
      if (ended) return Promise.resolve({ done: true, value: undefined });
      const next = new Promise<IteratorResult<NativeFrame>>((resolve, reject) =>
        readers.push({ resolve, reject }),
      );
      wake();
      return next;
    },
  };
}

async function listCodexModels(
  dependencies: CodexPersistentDependencies,
): Promise<readonly ProviderDiscoveredModel[]> {
  const release = await codexTurnLease.acquire();
  let generation: string | undefined;
  let iterator: AsyncIterator<NativeFrame> | undefined;
  const streamAbort = new AbortController();
  try {
    // Discovery is serialized by the lease, but it must never recover by
    // stopping a generation that may belong to an active provider turn in a
    // previous renderer lifetime or another WebView. The native controller
    // retires exited generations itself; an active owner makes this bounded
    // discovery fail closed and the next refresh can retry after it releases.
    const executable = await dependencies.findExecutable();
    if (!executable) return [];
    ({ generation } = await dependencies.start(
      executable.executableId,
      CODEX_MODEL_CATALOG_OWNER,
      CODEX_MODEL_CATALOG_BOOTSTRAP,
      { kind: 'official-codex', connectionId: 'openai-codex' },
    ));
    codexTurnLease.remember(generation);
    const subscription = dependencies.frames(generation, streamAbort.signal);
    iterator = subscription.stream[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    let prefetched: Promise<IteratorResult<NativeFrame>> | undefined = firstFrame;
    const reader: AsyncIterator<NativeFrame> = {
      next: () => {
        if (prefetched) {
          const next = prefetched;
          prefetched = undefined;
          return next;
        }
        return iterator!.next();
      },
    };
    await Promise.race([
      subscription.ready,
      firstFrame.then((first) => {
        if (first.done)
          throw new Error('Codex app-server ended before model catalog subscription.');
        return new Promise<never>(() => {});
      }),
    ]);

    const models: ProviderDiscoveredModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < CODEX_MODEL_MAX_PAGES; page += 1) {
      const id = requestId(CODEX_MODEL_CATALOG_OWNER, `model_${page + 1}`);
      await dependencies.write(generation, buildCodexModelListRequest({ requestId: id, cursor }));
      const response = await responseFrame(reader, id);
      const error = codexFrameError(response, 'Codex model catalog request failed.');
      if (error) throw error;
      const parsed = parseCodexModelListPage(response, id);
      models.push(...parsed.models);
      if (parsed.nextCursor === undefined) return models;
      cursor = parsed.nextCursor;
    }
    throw new Error('Codex model catalog pagination exceeded its safe bound.');
  } finally {
    if (generation) {
      await dependencies.stop(generation).catch(() => false);
      codexTurnLease.forget(generation);
    }
    streamAbort.abort();
    // Stop wakes a native frame iterator blocked on its next event. Returning
    // that iterator first can hang catalog discovery while its app-server
    // remains owned by the catalog route and every real turn is rejected.
    await iterator?.return?.();
    release();
  }
}

async function listCodexSkills(
  dependencies: CodexPersistentDependencies,
  workingDirectory: string,
  forceReload = true,
): Promise<readonly CodexSkillsListEntry[]> {
  const release = await codexTurnLease.acquire();
  let generation: string | undefined;
  let iterator: AsyncIterator<NativeFrame> | undefined;
  const streamAbort = new AbortController();
  try {
    const executable = await dependencies.findExecutable();
    if (!executable) throw new Error('Codex CLI is not installed.');
    ({ generation } = await dependencies.start(
      executable.executableId,
      CODEX_SKILL_CATALOG_OWNER,
      CODEX_MODEL_CATALOG_BOOTSTRAP,
      { kind: 'official-codex', connectionId: 'openai-codex' },
    ));
    codexTurnLease.remember(generation);
    const subscription = dependencies.frames(generation, streamAbort.signal);
    iterator = subscription.stream[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    let prefetched: Promise<IteratorResult<NativeFrame>> | undefined = firstFrame;
    const reader: AsyncIterator<NativeFrame> = {
      next: () => {
        if (prefetched) {
          const next = prefetched;
          prefetched = undefined;
          return next;
        }
        return iterator!.next();
      },
    };
    await Promise.race([
      subscription.ready,
      firstFrame.then((first) => {
        if (first.done)
          throw new Error('Codex app-server ended before skills discovery subscription.');
        return new Promise<never>(() => {});
      }),
    ]);
    const id = requestId(CODEX_SKILL_CATALOG_OWNER, 'list');
    await dependencies.write(
      generation,
      buildCodexSkillsListRequest({
        requestId: id,
        cwds: [workingDirectory],
        forceReload,
      }),
    );
    const response = await responseFrame(reader, id);
    const error = codexFrameError(response, 'Codex native skills discovery failed.');
    if (error) throw error;
    const validation = validateCodexSkillsListResponse(response, id, [workingDirectory]);
    if (!validation.ok)
      throw new Error(`Codex native skills discovery was invalid: ${validation.field}.`);
    return validation.entries;
  } finally {
    if (generation) {
      await dependencies.stop(generation).catch(() => false);
      codexTurnLease.forget(generation);
    }
    streamAbort.abort();
    await iterator?.return?.();
    release();
  }
}

async function listCodexMcpServerStatus(
  dependencies: CodexPersistentDependencies,
): Promise<readonly CodexMcpServerConnectionStatus[]> {
  const release = await codexTurnLease.acquire();
  let generation: string | undefined;
  let iterator: AsyncIterator<NativeFrame> | undefined;
  const streamAbort = new AbortController();
  try {
    const executable = await withTimeout(
      dependencies.findExecutable(),
      CODEX_MCP_STATUS_STAGE_TIMEOUT_MS,
      'Codex MCP status executable lookup timed out.',
    );
    if (!executable) throw new Error('Codex CLI is not installed.');
    ({ generation } = await dependencies.start(
      executable.executableId,
      CODEX_MCP_STATUS_OWNER,
      CODEX_MODEL_CATALOG_BOOTSTRAP,
      { kind: 'official-codex', connectionId: 'openai-codex' },
    ));
    codexTurnLease.remember(generation);
    const subscription = dependencies.frames(generation, streamAbort.signal);
    iterator = subscription.stream[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    let prefetched: Promise<IteratorResult<NativeFrame>> | undefined = firstFrame;
    const reader: AsyncIterator<NativeFrame> = {
      next: () => {
        if (prefetched) {
          const next = prefetched;
          prefetched = undefined;
          return next;
        }
        return iterator!.next();
      },
    };
    await withTimeout(
      Promise.race([
        subscription.ready,
        firstFrame.then((first) => {
          if (first.done) throw new Error('Codex app-server ended before MCP status subscription.');
          return new Promise<never>(() => {});
        }),
      ]),
      CODEX_MCP_STATUS_STAGE_TIMEOUT_MS,
      'Codex MCP status subscription timed out.',
    );

    const servers: CodexMcpServerConnectionStatus[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < CODEX_MCP_STATUS_MAX_PAGES; page += 1) {
      const id = requestId(CODEX_MCP_STATUS_OWNER, `list_${page + 1}`);
      await withTimeout(
        dependencies.write(generation, {
          id,
          method: 'mcpServerStatus/list',
          params: {
            detail: 'toolsAndAuthOnly',
            limit: CODEX_MCP_STATUS_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          },
        }),
        CODEX_MCP_STATUS_STAGE_TIMEOUT_MS,
        'Codex MCP status request write timed out.',
      );
      const response = await withTimeout(
        responseFrame(reader, id),
        CODEX_MCP_STATUS_STAGE_TIMEOUT_MS,
        'Codex MCP status response timed out.',
      );
      const error = codexFrameError(response, 'Codex MCP server status request failed.');
      if (error) throw error;
      const parsed = parseCodexMcpServerStatusPage(response, id);
      for (const server of parsed.servers) {
        if (names.has(server.name))
          throw new Error('Codex MCP server status contains duplicate server names.');
        names.add(server.name);
        servers.push(Object.freeze(server));
      }
      if (parsed.nextCursor === null) return Object.freeze(servers);
      if (cursors.has(parsed.nextCursor))
        throw new Error('Codex MCP server status pagination cursor repeated.');
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw new Error('Codex MCP server status pagination exceeded its safe bound.');
  } finally {
    if (generation) {
      await dependencies.stop(generation).catch(() => false);
      codexTurnLease.forget(generation);
    }
    streamAbort.abort();
    await iterator?.return?.();
    release();
  }
}

async function validateModelCapability(
  generation: string,
  iterator: AsyncIterator<NativeFrame>,
  exactIdentity: Readonly<CodexBackendIdentity>,
  write: CodexPersistentDependencies['write'],
  baseRequestId: string,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 32; page += 1) {
    const id = requestId(baseRequestId, 'model_' + String(page + 1));
    await write(generation, buildCodexModelListRequest({ requestId: id, cursor }));
    const response = await responseFrame(iterator, id);
    const requestError = codexFrameError(response, 'Codex model capability request failed.');
    if (requestError) throw requestError;
    const validation = validateCodexModelListResponse(response, id, exactIdentity);
    if (validation.ok) return;
    if (validation.reason === 'next_page') {
      cursor = validation.cursor;
      continue;
    }
    throw new Error('Codex model capability mismatch: ' + validation.field + '.');
  }
  throw new Error('Codex model capability pagination exceeded its safe bound.');
}

async function* sendCodexRequest(
  request: ProviderRequest,
  dependencies: CodexPersistentDependencies,
  recoverImplicitThread = false,
  contextTool: CodexContextToolBridge | null = null,
): AsyncGenerator<ProviderEvent> {
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const goalObjective = parseCodexGoalObjective(request.prompt);
  if (goalObjective !== undefined) request = { ...request, prompt: goalObjective };
  const startRoute = nativeStartRoute(request);
  request = {
    ...request,
    workingDirectory: await prepare(request, 'directory', () =>
      (dependencies.workingDirectory ?? resolveCodexWorkingDirectory)(request.workingDirectory),
    ),
  };
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const mode = executionMode(request);
  const executable = await prepare(request, 'executable', () => dependencies.findExecutable());
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  if (!executable) throw new Error('Codex CLI is not installed.');
  const ownerId = request.chatId ?? request.requestId;
  if (!request.modelId) throw new Error('Codex requires an exact selected model.');
  const modelId = request.modelId;
  const { generation } = await prepare(request, 'start', () =>
    dependencies.start(executable.executableId, ownerId, modelId, startRoute),
  );
  if (request.signal?.aborted) {
    await dependencies.stop(generation).catch(() => false);
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  let iterator: AsyncIterator<NativeFrame> | undefined;
  let frameReader: ReturnType<typeof createCodexFrameReader> | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let terminal = false;
  const acceptedNativeQueue = new Map<string, string>();
  let nativeQueueAddInFlight = false;
  let drainingAcceptedNativeQueue = false;
  let drainedNativeTurnCount = 0;
  const controls = createCodexControlBridge(
    (message) => dependencies.write(generation, message),
    mode,
  );
  const pendingControlResponses = new Map<
    string,
    {
      resolve: (frame: NativeFrame) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const controlRequestIds = new Set<string>();
  let wakeControlFrameReader = () => {};
  const sendControlRequest = (message: NativeFrame): Promise<NativeFrame> => {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id || controlRequestIds.has(id) || controlRequestIds.size >= 4_096) {
      return Promise.reject(new Error('Codex native control request identity is invalid.'));
    }
    controlRequestIds.add(id);
    return new Promise<NativeFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingControlResponses.get(id);
        if (!pending) return;
        pendingControlResponses.delete(id);
        reject(new NativeTurnControlOutcomeUnknownError());
      }, CODEX_CONTROL_RESPONSE_TIMEOUT_MS);
      pendingControlResponses.set(id, { resolve, reject, timeout });
      wakeControlFrameReader();
      void dependencies.write(generation, message).catch((error: unknown) => {
        const pending = pendingControlResponses.get(id);
        if (!pending || !pendingControlResponses.delete(id)) return;
        clearTimeout(pending.timeout);
        reject(error);
      });
    });
  };
  const rejectPendingControlResponses = (error: unknown) => {
    for (const pending of pendingControlResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingControlResponses.clear();
  };
  let cancelPendingWaits!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelPendingWaits = resolve;
  });
  const streamAbort = new AbortController();
  let cancellationCleanup: Promise<void> | undefined;
  let stopPromise: Promise<boolean> | undefined;
  const stopGeneration = () => {
    if (!stopPromise) {
      try {
        stopPromise = dependencies.stop(generation).catch(() => false);
      } catch {
        stopPromise = Promise.resolve(false);
      }
    }
    return stopPromise;
  };
  const abort = () => {
    // A stalled public projection must not retain this turn or its approval handles.
    controls.dispose();
    request.onLiveTurnControl?.(null);
    rejectPendingControlResponses(new DOMException('The request was aborted.', 'AbortError'));
    cancelPendingWaits();
    if (threadId && turnId) {
      const interruptResponse = sendControlRequest(
          buildCodexTurnInterruptRequest({
            requestId: requestId(request.requestId, 'interrupt'),
            threadId,
            turnId,
          }),
        );
      // Keep the native ingress alive until Codex confirms interruption or its
      // bounded control deadline/write failure ends the wait. The host is stopped
      // by finally only after this cleanup settles.
      cancellationCleanup = interruptResponse
        .then(() => undefined, () => undefined)
        .finally(() => streamAbort.abort());
    } else {
      // Before a turn starts there is no native interrupt to await. Stop now so
      // pending startup/subscription reads can finish and release the lease.
      streamAbort.abort();
      void stopGeneration();
    }
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const subscription = dependencies.frames(generation, streamAbort.signal);
    const activeIterator = subscription.stream[Symbol.asyncIterator]();
    iterator = activeIterator;
    const firstFrame = activeIterator.next();
    const reader = createCodexFrameReader(
      activeIterator,
      firstFrame,
      (frame) => {
        const id = typeof frame.id === 'string' ? frame.id : '';
        if (!id || !controlRequestIds.delete(id)) return false;
        const pending = pendingControlResponses.get(id);
        if (!pending) return true;
        pendingControlResponses.delete(id);
        clearTimeout(pending.timeout);
        if (recordOf(frame.error))
          pending.reject(codexRequestError('Codex native control failed.', frame.error));
        else pending.resolve(frame);
        return true;
      },
      () => pendingControlResponses.size > 0,
    );
    frameReader = reader;
    wakeControlFrameReader = reader.wake;
    // Opening the bridge can fail before nativeCodexFrames acknowledges subscription.
    // Observe that failure immediately instead of leaving readiness pending forever.
    await prepare(request, 'subscription', () =>
      Promise.race([
        subscription.ready,
        firstFrame.then((first) => {
          if (first.done) throw new Error('Codex app-server ended before subscription.');
          return new Promise<never>(() => {});
        }),
      ]),
    );
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const skillAwareRequest = request as CodexSkillRequest;
    let skillRefreshSequence = 0;
    let skillRefreshInFlight: Promise<CodexSkillsListEntry> | undefined;
    const refreshNativeSkills = (forceReload = true): Promise<CodexSkillsListEntry> => {
      if (skillRefreshInFlight) return skillRefreshInFlight;
      const pending = (async () => {
        const id = requestId(request.requestId, `skills_${++skillRefreshSequence}`);
        const frame = await sendControlRequest(
          forceReload
            ? buildCodexSkillsRefreshRequest({ requestId: id, cwds: [request.workingDirectory!] })
            : buildCodexSkillsListRequest({ requestId: id, cwds: [request.workingDirectory!] }),
        );
        const error = codexFrameError(frame, 'Codex native skills refresh failed.');
        if (error) throw error;
        const validation = validateCodexSkillsListResponse(frame, id, [request.workingDirectory!]);
        if (!validation.ok || validation.entries.length !== 1) {
          throw new Error('Codex native skills refresh was invalid.');
        }
        return validation.entries[0];
      })();
      skillRefreshInFlight = pending;
      void pending
        .finally(() => {
          if (skillRefreshInFlight === pending) skillRefreshInFlight = undefined;
        })
        .catch(() => undefined);
      return pending;
    };
    const exactIdentity = identity(request);
    if (request.codexRoute?.kind === 'official-codex') {
      await prepare(request, 'catalog', () =>
        validateModelCapability(
          generation,
          reader,
          exactIdentity,
          dependencies.write,
          request.requestId,
        ),
      );
    }
    let threadRequestId = requestId(request.requestId, request.sessionId ? 'resume' : 'thread');
    const threadRequest = request.sessionId
      ? buildCodexThreadResumeRequest({
          requestId: threadRequestId,
          threadId: request.sessionId,
          identity: exactIdentity,
          mode,
          developerInstructions: developerInstructions(request),
        })
      : buildCodexThreadStartRequest({
          requestId: threadRequestId,
          identity: exactIdentity,
          mode,
          developerInstructions: developerInstructions(request),
          ...(contextTool
            ? { dynamicTools: contextTool.dynamicTools ?? [CODEX_CONTEXT_TOOL] }
            : {}),
        });
    await dependencies.write(generation, threadRequest);
    let threadResponse = await prepare(request, request.sessionId ? 'resume' : 'thread', () =>
      responseFrame(reader, threadRequestId),
    );
    let resumed = Boolean(request.sessionId);
    const resumeError = recordOf(threadResponse.error);
    if (
      resumed &&
      recoverImplicitThread &&
      !request.expectedSessionId &&
      resumeError?.code === -32600 &&
      typeof resumeError.message === 'string' &&
      /^no rollout found for thread id\b/i.test(resumeError.message)
    ) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      // Isolated provider profiles may not contain an implicitly cached thread.
      // No turn was sent: start once and restore the supplied chat context.
      threadRequestId = requestId(request.requestId, 'thread');
      await dependencies.write(
        generation,
        buildCodexThreadStartRequest({
          requestId: threadRequestId,
          identity: exactIdentity,
          mode,
          developerInstructions: developerInstructions(request),
          ...(contextTool
            ? { dynamicTools: contextTool.dynamicTools ?? [CODEX_CONTEXT_TOOL] }
            : {}),
        }),
      );
      threadResponse = await responseFrame(reader, threadRequestId);
      resumed = false;
    }
    if (recordOf(threadResponse.error)) {
      throw codexRequestError('Codex thread request failed.', threadResponse.error);
    }
    if (resumed) {
      const projection = normalizeCodexThreadBindingResponse(threadResponse, threadRequestId);
      const session = projection.events.find(
        (event): event is Extract<ProviderEvent, { type: 'session' }> => event.type === 'session',
      );
      threadId = session?.sessionId;
    } else {
      const validation = validateCodexThreadStartResponse(
        threadResponse,
        threadRequestId,
        exactIdentity,
        mode,
      );
      if (!validation.ok) {
        throw new Error('Codex thread identity mismatch: ' + validation.field + '.');
      }
      threadId = validation.threadId;
    }
    if (!threadId) throw new Error('Codex thread binding is unavailable.');
    if (contextTool) {
      const validated = validateCodexThreadStartResponse(
        threadResponse,
        threadRequestId,
        exactIdentity,
        mode,
      );
      if (!validated.ok)
        throw new Error('Codex Context thread identity mismatch: ' + validated.field + '.');
      contextTool.bind(threadId, exactIdentity, generation);
    }
    if (resumed && request.systemPrompt?.trim()) {
      // Resume restores the old developer message. Publish this turn's compiled
      // policy explicitly while retaining Codex's built-in Ask/Plan instructions.
      const policyRequestId = requestId(request.requestId, 'policy');
      await dependencies.write(
        generation,
        buildCodexThreadPolicyUpdateRequest({
          requestId: policyRequestId,
          threadId,
          developerInstructions: developerInstructions(request),
        }),
      );
      const policyResponse = await prepare(request, 'policy', () =>
        responseFrame(reader, policyRequestId),
      );
      const policyError = codexFrameError(
        policyResponse,
        'Codex current-turn policy update failed.',
      );
      if (policyError) throw policyError;
      if (!recordOf(policyResponse.result))
        throw new Error('Codex current-turn policy update failed.');
    }
    yield { type: 'session', sessionId: threadId };
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    await Promise.race([request.onSessionBound?.({ sessionId: threadId }), cancelled]);
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');

    if (goalObjective !== undefined) {
      const goalRequestId = requestId(request.requestId, 'goal');
      await dependencies.write(
        generation,
        buildCodexGoalSetRequest(goalRequestId, threadId, goalObjective),
      );
      const goalResponse = await prepare(request, 'goal', () =>
        responseFrame(reader, goalRequestId),
      );
      const goalError = codexFrameError(goalResponse, 'Codex native goal could not be set.');
      if (goalError) throw goalError;
      validateCodexGoalSetResult(goalResponse.result, threadId, goalObjective);
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    }

    const selectedNativeSkills =
      request.nativeQueuedSubmission || !skillAwareRequest.codexSkills?.length
        ? []
        : selectDiscoveredCodexSkills(
            skillAwareRequest.codexSkills,
            await prepare(request, 'skills', () => refreshNativeSkills(true)),
          );

    const queued = request.nativeQueuedSubmission;
    if (
      queued &&
      (!queued.previousTurnCompleted ||
        !resumed ||
        request.expectedSessionId !== queued.threadId ||
        threadId !== queued.threadId ||
        !queued.addedDuringTurnId ||
        !queued.clientUserMessageId)
    ) {
      throw new Error('Codex queued submission lost its completed turn or thread binding.');
    }
    let queuedStartRequestId: string | undefined;
    let queuedStartAcknowledged = !queued;
    const queuedReadPages: NativeFrame[] = [];
    let queuedAutoObserved = false;
    if (queued) {
      let cursor: string | undefined;
      let completeListing = false;
      for (let pageIndex = 0; pageIndex < 16; pageIndex += 1) {
        const listId = requestId(request.requestId, `queue_list_${pageIndex}`);
        await dependencies.write(
          generation,
          buildCodexThreadQueueListRequest({
            requestId: listId,
            threadId,
            ...(cursor ? { cursor } : {}),
          }),
        );
        const page = await prepare(request, 'queue_list', () => responseFrame(reader, listId));
        const error = codexFrameError(page, 'Codex native queue could not be listed.');
        if (error) throw error;
        const validation = validateCodexThreadQueueListResponse(page, listId);
        if (!validation.ok) throw new Error('Codex native queue listing was invalid.');
        queuedReadPages.push(page);
        if (validation.nextCursor === null) {
          completeListing = true;
          break;
        }
        cursor = validation.nextCursor;
      }
      if (!completeListing) throw new Error('Codex native queue listing needs review.');
      const readId = requestId(request.requestId, 'queue_read');
      await dependencies.write(
        generation,
        buildCodexThreadReadRequest({ requestId: readId, threadId }),
      );
      const read = await prepare(request, 'queue_read', () => responseFrame(reader, readId));
      const readError = codexFrameError(read, 'Codex queued turn history could not be read.');
      if (readError) throw readError;
      const reconciliation = reconcileCodexQueue({
        threadReadFrame: read,
        queuePages: queuedReadPages,
        threadId,
        submissionId: queued.submissionId,
        clientUserMessageId: queued.clientUserMessageId,
      });
      if (reconciliation.state === 'pending') {
        queuedStartRequestId = requestId(request.requestId, 'queue');
        await dependencies.write(
          generation,
          buildCodexThreadQueueStartRequest({
            requestId: queuedStartRequestId,
            threadId,
            queuedSubmissionId: queued.submissionId,
          }),
        );
      } else if (reconciliation.state === 'consumed_in_progress') {
        turnId = reconciliation.turnId;
        queuedStartAcknowledged = true;
        queuedAutoObserved = true;
      } else if (
        reconciliation.state === 'consumed_terminal' &&
        reconciliation.turnStatus === 'completed' &&
        reconciliation.terminalResponseText
      ) {
        yield { type: 'text', delta: reconciliation.terminalResponseText };
        yield { type: 'done', finishReason: 'completed' };
        terminal = true;
        return;
      } else {
        throw new Error(
          'Codex queued turn needs review before retry; no second submission was sent.',
        );
      }
    } else {
      await dependencies.write(
        generation,
        buildCodexTurnStartRequest({
          requestId: requestId(request.requestId, 'turn'),
          threadId,
          clientUserMessageId: requestId(request.requestId, 'message'),
          text: promptText(request, !resumed),
          identity: exactIdentity,
          mode,
          skills: selectedNativeSkills,
        }),
      );
    }

    const turnUsage = createTurnUsageAccumulator();
    let priorProviderFailure: Readonly<ReturnType<typeof providerErrorDetails>> | undefined;
    const providerFailureFallback = {
      providerId: request.connection.providerId,
      modelId: request.modelId,
      connectionId: request.connection.id,
      requestId: request.requestId,
      ...(request.protectedAttempt?.runId ? { runId: request.protectedAttempt.runId } : {}),
    } as const;
    const dynamicToolNames = new Set(
      (contextTool?.dynamicTools ?? (contextTool ? [CODEX_CONTEXT_TOOL] : [])).map(
        (tool) => tool.name,
      ),
    );
    for (let count = 0; count < 65_536; count += 1) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const frame = await nextFrame(reader, 'Codex app-server ended before terminal state.');
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      if (isCodexSkillsChangedNotification(frame)) {
        try {
          const entry = await prepare(request, 'skills_changed', () => refreshNativeSkills(true));
          await skillAwareRequest.onCodexSkillsChanged?.(entry);
        } catch {
          // A catalog refresh is advisory for the running turn. Any later
          // selected skill use performs its own fail-closed fresh validation.
          yield { type: 'warning', message: 'Codex native skills could not be refreshed yet.' };
        }
        continue;
      }
      if (frame.id === requestId(request.requestId, 'turn') && recordOf(frame.error)) {
        const code = recordOf(frame.error)?.code;
        const requestError = codexFrameError(
          frame,
          `Codex rejected turn/start (${Number.isInteger(code) ? code : 'unknown'}).`,
        );
        if (requestError) throw requestError;
      }
      if (queuedStartRequestId && frame.id === queuedStartRequestId) {
        const queueError = codexFrameError(frame, 'Codex rejected thread/queue/start.');
        if (queueError) throw queueError;
        const validation = validateCodexThreadQueueStartResponse(frame, queuedStartRequestId);
        if (
          !validation.ok ||
          !validation.turnId ||
          (turnId && turnId !== validation.turnId) ||
          validation.turnStatus === 'failed' ||
          validation.turnStatus === 'interrupted'
        ) {
          throw new Error('Codex queued turn acknowledgement was invalid.');
        }
        turnId = validation.turnId;
        queuedStartAcknowledged = true;
        continue;
      }
      if (frame.method === 'item/tool/call') {
        // The queued turn has not yet received its own request authority. Never
        // run its dynamic tools through the predecessor's context bridge.
        if (drainingAcceptedNativeQueue) {
          throw new Error('Codex queued tool call needs review before execution.');
        }
        const params = recordOf(frame.params);
        const toolName = typeof params?.tool === 'string' ? params.tool : undefined;
        if (
          !contextTool ||
          !turnId ||
          params?.threadId !== threadId ||
          params.turnId !== turnId ||
          !toolName ||
          !dynamicToolNames.has(toolName) ||
          params.namespace != null ||
          typeof params.callId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(params.callId) ||
          (typeof frame.id !== 'string' && typeof frame.id !== 'number')
        ) {
          throw new Error('Codex dynamic tool call has an invalid turn or tool binding.');
        }
        yield {
          type: 'tool',
          name: toolName,
          status: 'started',
          callId: params.callId,
          details: publicToolDetails({ arguments: params.arguments }),
        };
        let result;
        try {
          result = contextTool.executeTool
            ? await contextTool.executeTool(
                toolName as Parameters<NonNullable<CodexContextToolBridge['executeTool']>>[0],
                params.arguments,
                params.callId,
              )
            : await contextTool.execute(params.arguments, params.callId);
        } catch {
          result = {
            success: false,
            contentItems: [
              {
                type: 'inputText' as const,
                text: 'The scoped VibeSpace dynamic tool request could not be completed.',
              },
            ],
          };
        }
        if (request.signal?.aborted)
          throw new DOMException('The request was aborted.', 'AbortError');
        await dependencies.write(generation, { id: frame.id, result });
        // Project the executed result into the public timeline; writing it back
        // to the app-server alone leaves the visible card with arguments only.
        const resultText = result.contentItems
          .map((item: { type: string; text?: string }) => item.text ?? '')
          .filter((text: string) => text.length > 0)
          .join('\n');
        const publicResult = parsePublicToolResult(resultText);
        yield {
          type: 'tool',
          name: toolName,
          status: result.success ? 'completed' : 'failed',
          callId: params.callId,
          details: publicToolDetails({
            arguments: params.arguments,
            ...(publicResult === undefined ? { output: resultText } : { result: publicResult }),
            outputComplete: true,
          }),
        };
        continue;
      }
      const projection = normalizeCodexAppServerMessage(frame, {
        scope: {
          activeGeneration: 1,
          messageGeneration: 1,
          threadId,
          ...(turnId ? { turnId } : {}),
        },
      });
      if (frame.method === 'error' && projection.events.some((event) => event.type === 'warning')) {
        const rawProviderFailure = codexFrameError(frame, 'Codex app-server reported an error.');
        // A retry notification is progress, not terminal provider evidence.
        // Do not let its transient "Reconnecting..." text outrank the later
        // terminal turn failure if the app-server eventually gives up. The
        // normalizer's warning is also the active thread/turn scope gate.
        if (rawProviderFailure && !codexFrameWillRetry(frame)) {
          priorProviderFailure = richestProviderErrorDetails(
            [priorProviderFailure, rawProviderFailure],
            providerFailureFallback,
          );
        }
      }
      for (const control of projection.controls) {
        if (
          drainingAcceptedNativeQueue &&
          control.type !== 'turn_binding' &&
          control.type !== 'resolved'
        ) {
          throw new Error('Codex queued interactive control needs review before execution.');
        }
        if (control.type === 'approval') {
          const approval = controls.approval(
            control,
            frame.id as string | number,
            recordOf(
              recordOf(frame.params)?.permissions ?? recordOf(frame.params)?.additionalPermissions,
            ),
          );
          if (!request.onApprovalRequested)
            throw new Error('Codex approval handler is unavailable.');
          await Promise.race([request.onApprovalRequested(approval), cancelled]);
          if (request.signal?.aborted)
            throw new DOMException('The request was aborted.', 'AbortError');
        } else if (control.type === 'question') {
          const id = controls.question(control, frame.id as string | number);
          for (const event of projection.events)
            if (event.type === 'question') event.request = { ...event.request, id };
        } else if (control.type === 'resolved') {
          const event = controls.resolve(control.requestId);
          if (event) projection.events.push(event);
        } else if (control.type === 'secure_question') {
          throw new Error('Codex requested secure input. Complete it in the Codex CLI.');
        }
        if (control.type === 'turn_binding') {
          if (control.threadId !== threadId || (turnId && turnId !== control.turnId)) {
            throw new Error('Codex turn binding changed unexpectedly.');
          }
          turnId = control.turnId;
          if (request.onLiveTurnControl && !drainingAcceptedNativeQueue) {
            const boundThreadId = threadId;
            const boundTurnId = turnId;
            const liveControl: ProviderLiveTurnControl = {
              steer: async (input: {
                clientUserMessageId: string;
                text: string;
                skills?: readonly CodexDiscoveredSkill[];
              }) => {
                if (
                  terminal ||
                  request.signal?.aborted ||
                  threadId !== boundThreadId ||
                  turnId !== boundTurnId
                ) {
                  throw new Error('Codex active turn is no longer available for steering.');
                }
                const selectedSkills = input.skills?.length
                  ? selectDiscoveredCodexSkills(input.skills, await refreshNativeSkills(true))
                  : [];
                const requestHandle = requestId(
                  request.requestId,
                  `s_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
                );
                const response = await sendControlRequest(
                  buildCodexTurnSteerRequest({
                    requestId: requestHandle,
                    threadId: boundThreadId,
                    expectedTurnId: boundTurnId,
                    clientUserMessageId: input.clientUserMessageId,
                    text: input.text,
                    skills: selectedSkills,
                  }),
                );
                const validation = validateCodexTurnSteerResponse(
                  response,
                  requestHandle,
                  boundTurnId,
                );
                if (!validation.ok)
                  throw new Error('Codex rejected a steer outside the active turn.');
              },
              enqueue: async (input: {
                clientUserMessageId: string;
                text: string;
                skills?: readonly CodexDiscoveredSkill[];
              }) => {
                if (
                  terminal ||
                  request.signal?.aborted ||
                  threadId !== boundThreadId ||
                  turnId !== boundTurnId
                ) {
                  throw new Error('Codex active thread is no longer available for queueing.');
                }
                if (acceptedNativeQueue.size > 0 || nativeQueueAddInFlight) {
                  throw new Error('Codex already has an accepted queued follow-up for this turn.');
                }
                nativeQueueAddInFlight = true;
                try {
                  const selectedSkills = input.skills?.length
                    ? selectDiscoveredCodexSkills(input.skills, await refreshNativeSkills(true))
                    : [];
                  const requestHandle = requestId(
                    request.requestId,
                    `q_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
                  );
                  const response = await sendControlRequest(
                    buildCodexThreadQueueAddRequest({
                      requestId: requestHandle,
                      threadId: boundThreadId,
                      clientUserMessageId: input.clientUserMessageId,
                      text: input.text,
                      skills: selectedSkills,
                    }),
                  );
                  const validation = validateCodexThreadQueueAddResponse(
                    response,
                    requestHandle,
                    input.clientUserMessageId,
                  );
                  if (!validation.ok || !validation.submissionId) {
                    throw new Error('Codex did not confirm the queued submission.');
                  }
                  acceptedNativeQueue.set(validation.submissionId, input.clientUserMessageId);
                  return {
                    submissionId: validation.submissionId,
                    threadId: boundThreadId,
                    turnId: boundTurnId,
                  };
                } finally {
                  nativeQueueAddInFlight = false;
                }
              },
            };
            request.onLiveTurnControl(liveControl);
          }
        }
      }
      for (const event of projection.events) {
        if (event.type === 'done') {
          if (drainingAcceptedNativeQueue) {
            drainedNativeTurnCount += 1;
            turnId = undefined;
            if (drainedNativeTurnCount < acceptedNativeQueue.size) continue;
            const drainedQueuePages: NativeFrame[] = [];
            let cursor: string | undefined;
            let completeListing = false;
            for (let pageIndex = 0; pageIndex < 16; pageIndex += 1) {
              const listId = requestId(request.requestId, `drained_queue_list_${pageIndex}`);
              await dependencies.write(
                generation,
                buildCodexThreadQueueListRequest({
                  requestId: listId,
                  threadId,
                  ...(cursor ? { cursor } : {}),
                }),
              );
              const page = await responseFrame(reader, listId);
              const error = codexFrameError(page, 'Codex native queue drain could not be listed.');
              if (error) throw error;
              const validation = validateCodexThreadQueueListResponse(page, listId);
              if (!validation.ok) throw new Error('Codex native queue drain listing was invalid.');
              drainedQueuePages.push(page);
              if (validation.nextCursor === null) {
                completeListing = true;
                break;
              }
              cursor = validation.nextCursor;
            }
            if (!completeListing) throw new Error('Codex native queue drain listing needs review.');
            const readId = requestId(request.requestId, 'drained_queue_read');
            await dependencies.write(
              generation,
              buildCodexThreadReadRequest({ requestId: readId, threadId }),
            );
            const read = await responseFrame(reader, readId);
            const readError = codexFrameError(read, 'Codex native queue drain could not be read.');
            if (readError) throw readError;
            for (const [submissionId, clientUserMessageId] of acceptedNativeQueue) {
              const reconciliation = reconcileCodexQueue({
                threadReadFrame: read,
                queuePages: drainedQueuePages,
                threadId,
                submissionId,
                clientUserMessageId,
              });
              if (
                reconciliation.state !== 'consumed_terminal' ||
                reconciliation.turnStatus !== 'completed' ||
                !reconciliation.terminalResponseText
              ) {
                throw new Error('Codex native queued turn needs review before handoff.');
              }
            }
            terminal = true;
            yield event;
            continue;
          }
          if (!queuedStartAcknowledged)
            throw new Error('Codex queued turn completed without an exact start acknowledgement.');
          if (queuedAutoObserved && queued) {
            const finalReadId = requestId(request.requestId, 'queue_final_read');
            await dependencies.write(
              generation,
              buildCodexThreadReadRequest({
                requestId: finalReadId,
                threadId,
              }),
            );
            const finalRead = await responseFrame(reader, finalReadId);
            const finalReadError = codexFrameError(
              finalRead,
              'Codex queued turn result could not be read.',
            );
            if (finalReadError) throw finalReadError;
            const final = reconcileCodexQueue({
              threadReadFrame: finalRead,
              queuePages: queuedReadPages,
              threadId,
              submissionId: queued.submissionId,
              clientUserMessageId: queued.clientUserMessageId,
            });
            if (
              final.state !== 'consumed_terminal' ||
              final.turnStatus !== 'completed' ||
              final.turnId !== turnId ||
              !final.terminalResponseText
            ) {
              throw new Error('Codex queued turn result needs review before retry.');
            }
            yield { type: 'text', delta: final.terminalResponseText };
          }
          if (!queued && acceptedNativeQueue.size > 0) {
            drainingAcceptedNativeQueue = true;
            turnId = undefined;
            request.onLiveTurnControl?.(null);
            continue;
          }
          terminal = true;
          yield event;
          continue;
        }
        if (drainingAcceptedNativeQueue) {
          if (event.type === 'error') {
            terminal = true;
            yield { type: 'done', finishReason: 'completed' };
          }
          continue;
        }
        if (event.type === 'error') {
          terminal = true;
          const richest = richestProviderErrorDetails(
            [priorProviderFailure, event],
            providerFailureFallback,
          );
          yield {
            type: 'error',
            message: richest.message,
            ...(richest.code ? { code: richest.code } : {}),
            ...(richest.providerId ? { providerId: richest.providerId } : {}),
            ...(richest.modelId ? { modelId: richest.modelId } : {}),
            ...(richest.connectionId ? { connectionId: richest.connectionId } : {}),
            ...(richest.retryable === undefined ? {} : { retryable: richest.retryable }),
            ...(richest.retryAfterMs === undefined ? {} : { retryAfterMs: richest.retryAfterMs }),
            ...(richest.resetAt === undefined ? {} : { resetAt: richest.resetAt }),
            ...(richest.requestId ? { requestId: richest.requestId } : {}),
            ...(richest.runId ? { runId: richest.runId } : {}),
          };
          continue;
        }
        if (queuedAutoObserved && event.type === 'text') continue;
        yield event.type === 'usage' ? { ...event, usage: turnUsage(event.usage, frame) } : event;
      }
      if (terminal) return;
    }
    throw new Error('Codex turn exceeded its safe event bound.');
  } catch (error) {
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    throw error;
  } finally {
    request.onLiveTurnControl?.(null);
    if (cancellationCleanup) await cancellationCleanup;
    rejectPendingControlResponses(
      new Error('Codex active turn ended before control confirmation.'),
    );
    controlRequestIds.clear();
    controls.dispose();
    request.signal?.removeEventListener('abort', abort);
    await stopGeneration();
    streamAbort.abort();
    frameReader?.close();
    await iterator?.return?.();
  }
}

export interface CodexPersistentAdapter extends ProviderAdapter {
  /** Discover native skill metadata for one exact Codex working directory. */
  listSkills(
    input: Readonly<{ workingDirectory: string; forceReload?: boolean }>,
  ): Promise<readonly CodexSkillsListEntry[]>;
  /** List MCP server connection states without exposing auth or inventory data. */
  listMcpServerStatus(): Promise<readonly CodexMcpServerConnectionStatus[]>;
}

export function createCodexPersistentAdapter(
  dependencies: CodexPersistentDependencies = defaultDependencies,
): CodexPersistentAdapter {
  let modelCatalogCache:
    | { readonly loadedAt: number; readonly models: readonly ProviderDiscoveredModel[] }
    | undefined;
  let modelCatalogLoad: Promise<readonly ProviderDiscoveredModel[]> | undefined;
  let modelCatalogGeneration = 0;
  const invalidateModelCatalog = () => {
    modelCatalogGeneration += 1;
    modelCatalogCache = undefined;
    modelCatalogLoad = undefined;
  };
  codexModelCatalogInvalidators.add(invalidateModelCatalog);
  const listModels = async (): Promise<readonly ProviderDiscoveredModel[]> => {
    const now = Date.now();
    if (modelCatalogCache && now - modelCatalogCache.loadedAt < 60_000) {
      return modelCatalogCache.models;
    }
    if (modelCatalogLoad) return modelCatalogLoad;
    const generation = modelCatalogGeneration;
    const pending = appActivityLog
      .trace(
        'model.prepare.codex.catalog',
        { ownerId: CODEX_MODEL_CATALOG_OWNER, connectionId: 'openai-codex' },
        () => listCodexModels(dependencies),
      )
      .then((models) => {
        const frozen = Object.freeze([...models]);
        if (generation === modelCatalogGeneration) {
          modelCatalogCache = { loadedAt: Date.now(), models: frozen };
        }
        return frozen;
      })
      .catch(() => {
        // A rejected discovery is commonly transient while another WebView
        // owns the singleton native server. Do not turn that failure into a
        // 60-second authoritative empty catalog; the hook schedules a retry.
        if (generation === modelCatalogGeneration) modelCatalogCache = undefined;
        return Object.freeze([]) as readonly ProviderDiscoveredModel[];
      })
      .finally(() => {
        if (modelCatalogLoad === pending) modelCatalogLoad = undefined;
      });
    modelCatalogLoad = pending;
    return pending;
  };
  return Object.freeze({
    id: 'codex-app-server',
    listModels,
    listSkills: async ({
      workingDirectory,
      forceReload = true,
    }: {
      workingDirectory: string;
      forceReload?: boolean;
    }) => listCodexSkills(dependencies, workingDirectory, forceReload),
    listMcpServerStatus: () => listCodexMcpServerStatus(dependencies),
    send: async function* (request: ProviderRequest) {
      const release = await prepare(request, 'lease', () => codexTurnLease.acquire(request.signal));
      let contextTool: CodexContextToolBridge | null = null;
      try {
        await prepare(request, 'recover', () => codexTurnLease.recover(dependencies.stop));
        contextTool = await prepare(
          request,
          'context',
          async () => (await dependencies.contextTool?.(request)) ?? null,
        );
        const ownedDependencies = {
          ...dependencies,
          async start(...args: Parameters<CodexPersistentDependencies['start']>) {
            const result = await dependencies.start(...args);
            try {
              codexTurnLease.remember(result.generation);
            } catch (error) {
              await dependencies.stop(result.generation);
              throw error;
            }
            return result;
          },
          async stop(generation: string) {
            const stopped = await dependencies.stop(generation);
            codexTurnLease.forget(generation);
            return stopped;
          },
        };
        const dynamicManifest = contextTool
          ? (contextTool.dynamicTools ?? [CODEX_CONTEXT_TOOL])
          : undefined;
        const key =
          request.accountId && request.chatId && request.workingDirectory
            ? (contextTool ? 'vibespace.codex-context-thread.v2:' : 'vibespace.codex-thread.v1:') +
              JSON.stringify([
                request.accountId,
                request.workspaceId,
                request.projectId,
                request.chatId,
                request.workingDirectory,
              ])
            : undefined;
        let sessionId = request.sessionId;
        if (!sessionId && key) {
          try {
            const stored = localStorage.getItem(key);
            sessionId = decodeCodexThreadCache(stored, dynamicManifest);
          } catch {
            /* Native startup still works when local persistence is unavailable. */
          }
        }
        for await (const event of sendCodexRequest(
          { ...request, sessionId },
          ownedDependencies,
          !request.sessionId && !request.expectedSessionId,
          contextTool,
        )) {
          if (key && event.type === 'session' && !(contextTool && request.sessionId)) {
            // Never certify an explicitly resumed legacy thread as having newly
            // requested tools: its server-owned manifest may be different.
            try {
              localStorage.setItem(key, encodeCodexThreadCache(event.sessionId, dynamicManifest));
            } catch {
              /* Current turn remains usable. */
            }
          }
          yield event;
        }
      } catch (error) {
        if (
          request.signal?.aborted ||
          (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')
        ) {
          throw error;
        }
        if (isProviderRuntimeError(error)) throw error;
        throw new ProviderRuntimeError(
          providerErrorDetails(error, {
            providerId: request.connection.providerId,
            modelId: request.modelId,
            connectionId: request.connection.id,
            requestId: request.requestId,
          }),
        );
      } finally {
        contextTool?.dispose();
        release();
      }
    },
    cancel: async () => undefined,
  });
}

export const codexPersistentAdapter = createCodexPersistentAdapter();
