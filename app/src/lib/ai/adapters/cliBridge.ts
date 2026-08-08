import type {
  AuthProbeResult,
  DetectionResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  UsageSnapshot,
  UsageValue,
} from './types';

export const CLI_BRIDGE_EVENT = 'cli-bridge://event';
export const MAX_CLI_PROMPT_CHARS = 128_000;

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const DEFAULT_PROBE_OUTPUT_LIMIT_BYTES = 16_384;

export interface CliInvocationRequest {
  prompt: string;
  modelId?: string;
  reasoningEffort?: string;
  workingDirectory?: string;
  sessionId?: string;
}

export interface CliInvocation {
  args: string[];
  stdin?: string;
  cwd?: string;
}

export interface CliScanRequest {
  executableNames: string[];
  customPath: string | null;
  customPathConfirmed: boolean;
}

export interface DetectedExecutable {
  executableId: string;
  requestedName?: string;
  executablePath: string;
}

export interface CliDetectionResult {
  executables: DetectedExecutable[];
}

export interface CliProbeRequest {
  executableId: string;
  args: string[];
  timeoutMs: number;
  outputLimitBytes: number;
}

export interface SanitizedOutput {
  data: string;
  truncated: boolean;
}

export interface CliProbeResult {
  exitCode: number | null;
  stdout: SanitizedOutput;
  stderr: SanitizedOutput;
  timedOut: boolean;
}

export interface CliStartRequest {
  requestId: string;
  executableId: string;
  args: string[];
  cwd: string | null;
  stdin: string | null;
  timeoutMs: number;
  outputLimitBytes: number;
}

export type CliEventStream = 'stdout' | 'stderr' | 'status';
export type CliEventStatus = 'started' | 'data' | 'completed' | 'failed' | 'cancelled' | 'timedOut';

export interface CliBridgeEvent {
  requestId: string;
  stream: CliEventStream;
  data: string;
  exitCode: number | null;
  status: CliEventStatus;
  truncated?: boolean;
}

export interface JsonlParserLimits {
  maxLineChars: number;
  maxTotalChars: number;
  maxEvents: number;
  maxTextChars: number;
  maxMessageChars: number;
  maxIdentifierChars: number;
}

export const DEFAULT_JSONL_LIMITS: Readonly<JsonlParserLimits> = Object.freeze({
  maxLineChars: 65_536,
  maxTotalChars: 1_048_576,
  maxEvents: 4_096,
  maxTextChars: 32_768,
  maxMessageChars: 2_048,
  maxIdentifierChars: 256,
});

export interface ProviderRecordNormalization {
  events: ProviderEvent[];
  recognized: boolean;
  ignored?: boolean;
}

export interface ProviderRecordContext {
  state: Map<string, unknown>;
}

export type ProviderRecordNormalizer = (
  record: Readonly<Record<string, unknown>>,
  context: ProviderRecordContext,
) => ProviderRecordNormalization;

export interface CliProviderDefinition {
  adapterId: string;
  connectionId: string;
  promptTransport: 'prefixed-preamble' | 'unsupported';
  executableName: string;
  versionArgs: readonly string[];
  authProbeArgs?: readonly string[];
  classifyAuthProbe?: (probe: Readonly<CliProbeResult>) => AuthProbeResult;
  modelListArgs?: readonly string[];
  buildInvocation: (request: CliInvocationRequest) => CliInvocation;
  normalizeRecord: ProviderRecordNormalizer;
}

export const KERNEL_SMOKE_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'vibespace-kernel-smoke-cli',
  connectionId: 'vibespace-kernel-smoke-cli',
  promptTransport: 'prefixed-preamble',
  executableName: 'vibespace_kernel_smoke_cli',
  versionArgs: Object.freeze(['--version']),
  buildInvocation(request: CliInvocationRequest): CliInvocation {
    assertCliPrompt(request.prompt);
    return {
      args: ['--model', requireModelId(request.modelId, 'VibeSpace kernel smoke')],
      stdin: request.prompt,
      ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
    };
  },
  normalizeRecord(record: Readonly<Record<string, unknown>>): ProviderRecordNormalization {
    if (record.type === 'text' && typeof record.delta === 'string') {
      return { recognized: true, events: [{ type: 'text', delta: record.delta }] };
    }
    if (record.type === 'done') {
      return {
        recognized: true,
        events: [
          {
            type: 'done',
            ...(typeof record.finish_reason === 'string'
              ? { finishReason: record.finish_reason }
              : {}),
          },
        ],
      };
    }
    if (record.type === 'error') {
      return {
        recognized: true,
        events: [
          {
            type: 'error',
            message:
              typeof record.message === 'string'
                ? record.message
                : 'Kernel smoke provider reported an error.',
          },
        ],
      };
    }
    return { recognized: false, events: [] };
  },
});

export function assertCliPrompt(prompt: string): void {
  if (prompt.length > MAX_CLI_PROMPT_CHARS) {
    throw new Error(`CLI prompt exceeds ${MAX_CLI_PROMPT_CHARS} characters`);
  }
}

export function requireModelId(modelId: string | undefined, provider: string): string {
  const value = modelId?.trim();
  if (!value) throw new Error(`${provider} CLI requires an explicit model`);
  if (value.length > 512) throw new Error(`${provider} CLI model ID exceeds 512 characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) {
    throw new Error(`${provider} CLI model ID contains unsafe characters`);
  }
  return value;
}

export async function scanCliBridge(request: CliScanRequest): Promise<CliDetectionResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CliDetectionResult>('cli_bridge_scan', { request });
}

export async function probeCliBridge(request: CliProbeRequest): Promise<CliProbeResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CliProbeResult>('cli_bridge_probe', { request });
}

export async function cancelCliBridge(requestId: string): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('cli_bridge_cancel', { requestId });
}

function isTerminalBridgeStatus(status: CliEventStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timedOut'
  );
}

function cliAbortError(): DOMException {
  return new DOMException('The provider CLI request was aborted.', 'AbortError');
}

/**
 * Starts one already-discovered executable through Task 2's Tauri supervisor.
 * The event listener is installed before start so short-lived CLIs cannot race it.
 */
export async function* streamCliBridge(
  request: CliStartRequest,
  signal?: AbortSignal,
): AsyncGenerator<CliBridgeEvent> {
  if (signal?.aborted) throw cliAbortError();
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  const queue: CliBridgeEvent[] = [];
  let wake: (() => void) | undefined;
  let terminalSeen = false;
  let started = false;
  let cancelledAfterStart = false;

  const unlisten = await listen<CliBridgeEvent>(CLI_BRIDGE_EVENT, ({ payload }) => {
    if (payload.requestId !== request.requestId) return;
    queue.push(payload);
    terminalSeen ||= isTerminalBridgeStatus(payload.status);
    wake?.();
    wake = undefined;
  });

  const abort = () => {
    void cancelCliBridge(request.requestId).catch(() => false);
    wake?.();
    wake = undefined;
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    if (signal?.aborted) {
      throw cliAbortError();
    }
    await invoke<void>('cli_bridge_start', { request });
    started = true;
    if (signal?.aborted) {
      await cancelCliBridge(request.requestId).catch(() => false);
      cancelledAfterStart = true;
    }

    while (!terminalSeen || queue.length > 0) {
      if (signal?.aborted) throw cliAbortError();
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = queue.shift();
      if (event) yield event;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    unlisten();
    if (started && !terminalSeen && !cancelledAfterStart) {
      await cancelCliBridge(request.requestId).catch(() => false);
    }
  }
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

export function boundedProviderText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return redactSecrets(stripTerminalControls(value)).slice(0, maxChars);
}

export function boundedProviderIdentifier(value: unknown): string | undefined {
  const bounded = boundedProviderText(value, DEFAULT_JSONL_LIMITS.maxIdentifierChars)?.trim();
  return bounded || undefined;
}

export function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function exactUsageValue(value: unknown): UsageValue<number> | undefined {
  const number = finiteNonNegativeNumber(value);
  return number === undefined ? undefined : { value: number, provenance: 'provider-reported' };
}

export function responseUsageSnapshot(input: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  costUsd?: unknown;
}): UsageSnapshot {
  const inputTokens = exactUsageValue(input.inputTokens);
  const outputTokens = exactUsageValue(input.outputTokens);
  const explicitTotal = exactUsageValue(input.totalTokens);
  const derivedTotal =
    inputTokens?.value !== undefined && outputTokens?.value !== undefined
      ? { value: inputTokens.value + outputTokens.value, provenance: 'locally-observed' as const }
      : undefined;
  return {
    capturedAt: Date.now(),
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(explicitTotal || derivedTotal ? { totalTokens: explicitTotal ?? derivedTotal } : {}),
    ...(exactUsageValue(input.costUsd) ? { costUsd: exactUsageValue(input.costUsd) } : {}),
    quota: {
      value: undefined,
      provenance: 'unavailable',
      reason: 'Subscription quota is not reported by this response.',
    },
  };
}

function isSensitiveRecordType(type: unknown): boolean {
  return (
    typeof type === 'string' &&
    /(?:^|[._-])(auth|account|profile|credential|token)(?:$|[._-])/i.test(type)
  );
}

function sanitizeUsageSnapshot(usage: UsageSnapshot): UsageSnapshot {
  const sanitizeValue = <T>(value: UsageValue<T> | undefined): UsageValue<T> | undefined => {
    if (!value) return undefined;
    return {
      ...(value.value !== undefined ? { value: value.value } : {}),
      provenance: value.provenance,
      ...(value.reason
        ? { reason: boundedProviderText(value.reason, DEFAULT_JSONL_LIMITS.maxMessageChars) }
        : {}),
    };
  };
  return {
    capturedAt: Number.isFinite(usage.capturedAt) ? usage.capturedAt : Date.now(),
    ...(sanitizeValue(usage.inputTokens) ? { inputTokens: sanitizeValue(usage.inputTokens) } : {}),
    ...(sanitizeValue(usage.outputTokens)
      ? { outputTokens: sanitizeValue(usage.outputTokens) }
      : {}),
    ...(sanitizeValue(usage.totalTokens) ? { totalTokens: sanitizeValue(usage.totalTokens) } : {}),
    ...(sanitizeValue(usage.costUsd) ? { costUsd: sanitizeValue(usage.costUsd) } : {}),
    ...(sanitizeValue(usage.quota) ? { quota: sanitizeValue(usage.quota) } : {}),
    ...(sanitizeValue(usage.resetsAt) ? { resetsAt: sanitizeValue(usage.resetsAt) } : {}),
  };
}

function sanitizeProviderEvent(
  event: ProviderEvent,
  limits: JsonlParserLimits,
): ProviderEvent | undefined {
  switch (event.type) {
    case 'text': {
      const delta = boundedProviderText(event.delta, limits.maxTextChars);
      return delta ? { type: 'text', delta } : undefined;
    }
    case 'reasoning': {
      const delta = boundedProviderText(event.delta, limits.maxTextChars);
      return delta ? { type: 'reasoning', delta } : undefined;
    }
    case 'session': {
      const sessionId = boundedProviderText(event.sessionId, limits.maxIdentifierChars)?.trim();
      return sessionId ? { type: 'session', sessionId } : undefined;
    }
    case 'tool': {
      const name = boundedProviderText(event.name, limits.maxIdentifierChars)?.trim();
      const callId = boundedProviderText(event.callId, limits.maxIdentifierChars)?.trim();
      return name
        ? {
            type: 'tool',
            name,
            status: event.status,
            ...(callId ? { callId } : {}),
          }
        : undefined;
    }
    case 'model': {
      const modelId = boundedProviderText(event.modelId, limits.maxIdentifierChars)?.trim();
      return modelId ? { type: 'model', modelId } : undefined;
    }
    case 'usage':
      return { type: 'usage', usage: sanitizeUsageSnapshot(event.usage) };
    case 'warning': {
      const message = boundedProviderText(event.message, limits.maxMessageChars)?.trim();
      return message ? { type: 'warning', message } : undefined;
    }
    case 'error': {
      const message = boundedProviderText(event.message, limits.maxMessageChars)?.trim();
      return { type: 'error', message: message || 'Provider CLI reported an error.' };
    }
    case 'done': {
      const finishReason = boundedProviderText(
        event.finishReason,
        limits.maxIdentifierChars,
      )?.trim();
      return { type: 'done', ...(finishReason ? { finishReason } : {}) };
    }
  }
}

export class BoundedJsonlNormalizer {
  private buffer = '';
  private totalChars = 0;
  private emittedEvents = 0;
  private lineNumber = 0;
  private terminalSeen = false;
  private unknownWarningSeen = false;
  private readonly context: ProviderRecordContext = { state: new Map() };

  constructor(
    private readonly normalizeRecord: ProviderRecordNormalizer,
    private readonly limits: JsonlParserLimits = DEFAULT_JSONL_LIMITS,
  ) {}

  push(chunk: string): ProviderEvent[] {
    this.totalChars += chunk.length;
    if (this.totalChars > this.limits.maxTotalChars) {
      throw new Error(`Provider JSONL input exceeds ${this.limits.maxTotalChars} characters`);
    }
    this.buffer += chunk;
    const events: ProviderEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...this.consumeLine(line));
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.limits.maxLineChars) {
      throw new Error(`Provider JSONL line exceeds ${this.limits.maxLineChars} characters`);
    }
    return events;
  }

  finish(requireTerminal = true): ProviderEvent[] {
    const events = this.buffer ? this.consumeLine(this.buffer.replace(/\r$/, '')) : [];
    this.buffer = '';
    if (requireTerminal && !this.terminalSeen) {
      throw new Error('Provider stream ended without a terminal event');
    }
    return events;
  }

  private consumeLine(line: string): ProviderEvent[] {
    this.lineNumber += 1;
    if (!line.trim()) return [];
    if (line.length > this.limits.maxLineChars) {
      throw new Error(`Provider JSONL line exceeds ${this.limits.maxLineChars} characters`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Malformed provider JSONL at line ${this.lineNumber}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Malformed provider JSONL object at line ${this.lineNumber}`);
    }
    const record = parsed as Record<string, unknown>;
    if (isSensitiveRecordType(record.type)) return [];
    if (record.type === 'warning') {
      const message = boundedProviderText(
        record.message ?? record.warning,
        this.limits.maxMessageChars,
      );
      return this.acceptEvents([
        {
          type: 'warning',
          message: message || 'Provider CLI reported a warning.',
        },
      ]);
    }

    const normalized = this.normalizeRecord(record, this.context);
    if (normalized.ignored) return [];
    if (!normalized.recognized) {
      if (this.unknownWarningSeen) return [];
      this.unknownWarningSeen = true;
      const type = boundedProviderText(record.type, 192)?.trim() || 'untyped';
      return this.acceptEvents([
        { type: 'warning', message: `Unsupported provider event: ${type}` },
      ]);
    }
    return this.acceptEvents(normalized.events);
  }

  private acceptEvents(events: ProviderEvent[]): ProviderEvent[] {
    const safeEvents: ProviderEvent[] = [];
    for (const event of events) {
      const safe = sanitizeProviderEvent(event, this.limits);
      if (!safe) continue;
      this.emittedEvents += 1;
      if (this.emittedEvents > this.limits.maxEvents) {
        throw new Error(`Provider event count exceeds ${this.limits.maxEvents}`);
      }
      this.terminalSeen ||= safe.type === 'done' || safe.type === 'error';
      safeEvents.push(safe);
    }
    return safeEvents;
  }
}

export function normalizeProviderJsonl(
  input: string,
  normalizeRecord: ProviderRecordNormalizer,
  limits: JsonlParserLimits = DEFAULT_JSONL_LIMITS,
): ProviderEvent[] {
  const parser = new BoundedJsonlNormalizer(normalizeRecord, limits);
  return [...parser.push(input), ...parser.finish(true)];
}

function safeDetail(value: string): string {
  return boundedProviderText(value, DEFAULT_JSONL_LIMITS.maxMessageChars)?.trim() || '';
}

async function findExecutable(executableName: string): Promise<DetectedExecutable | undefined> {
  const result = await scanCliBridge({
    executableNames: [executableName],
    customPath: null,
    customPathConfirmed: false,
  });
  return (
    result.executables.find((item) => item.requestedName === executableName) ??
    result.executables[0]
  );
}

async function detectProvider(definition: CliProviderDefinition): Promise<DetectionResult> {
  try {
    const executable = await findExecutable(definition.executableName);
    if (!executable) return { status: 'unavailable' };
    const probe = await probeCliBridge({
      executableId: executable.executableId,
      args: [...definition.versionArgs],
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      outputLimitBytes: DEFAULT_PROBE_OUTPUT_LIMIT_BYTES,
    });
    if (probe.timedOut) {
      return {
        status: 'requires_attention',
        executablePath: executable.executablePath,
        detail: 'Version probe timed out.',
      };
    }
    if (probe.exitCode !== 0) {
      return {
        status: 'requires_attention',
        executablePath: executable.executablePath,
        detail: 'Version probe exited unsuccessfully.',
      };
    }
    const version = safeDetail(probe.stdout.data).split(/\r?\n/, 1)[0]?.trim();
    return {
      status: 'available',
      executablePath: executable.executablePath,
      ...(version ? { version } : {}),
    };
  } catch (error) {
    return {
      status: 'requires_attention',
      detail: safeDetail(error instanceof Error ? error.message : 'CLI detection failed.'),
    };
  }
}

async function probeProviderAuth(definition: CliProviderDefinition): Promise<AuthProbeResult> {
  if (!definition.authProbeArgs) {
    return {
      status: 'unknown',
      detail: 'No approved read-only authentication status command is available.',
    };
  }
  const classifyUnavailable = (): AuthProbeResult =>
    definition.classifyAuthProbe?.({
      exitCode: null,
      stdout: { data: '', truncated: false },
      stderr: { data: '', truncated: false },
      timedOut: false,
    }) ?? {
      status: 'unknown',
      detail: 'Authentication status could not be verified.',
    };
  try {
    const executable = await findExecutable(definition.executableName);
    if (!executable) return classifyUnavailable();
    const probe = await probeCliBridge({
      executableId: executable.executableId,
      args: [...definition.authProbeArgs],
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      outputLimitBytes: DEFAULT_PROBE_OUTPUT_LIMIT_BYTES,
    });
    if (definition.classifyAuthProbe) return definition.classifyAuthProbe(probe);
    if (probe.timedOut) return { status: 'unknown', detail: 'Authentication probe timed out.' };
    return probe.exitCode === 0
      ? { status: 'authenticated', detail: 'Authenticated via the provider CLI.' }
      : { status: 'unauthenticated', detail: 'The provider CLI reported no active session.' };
  } catch {
    return classifyUnavailable();
  }
}

async function* sendProviderRequest(
  definition: CliProviderDefinition,
  request: ProviderRequest,
): AsyncGenerator<ProviderEvent> {
  if (request.signal?.aborted) throw cliAbortError();
  if (
    request.connection.id !== definition.connectionId ||
    request.connection.promptTransport !== definition.promptTransport
  ) {
    throw new Error('CLI provider prompt transport declaration mismatch.');
  }
  const executable = await findExecutable(definition.executableName);
  if (!executable) {
    throw new Error(`${definition.executableName} CLI is not installed`);
  }
  const invocation = definition.buildInvocation({
    prompt: request.prompt,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    workingDirectory: request.workingDirectory,
    sessionId: request.sessionId,
  });
  const parser = new BoundedJsonlNormalizer(definition.normalizeRecord);
  let stderr = '';

  for await (const event of streamCliBridge(
    {
      requestId: request.requestId,
      executableId: executable.executableId,
      args: [...invocation.args],
      cwd: invocation.cwd ?? null,
      stdin: invocation.stdin ?? null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
    request.signal,
  )) {
    if (request.signal?.aborted) throw cliAbortError();
    if (event.status === 'data' && event.stream === 'stdout') {
      if (event.data.length > 0) {
        request.onResponseObservation?.({
          kind: 'bytes',
          byteLength: new TextEncoder().encode(event.data).byteLength,
          observedAt: Date.now(),
        });
      }
      for (const normalized of parser.push(event.data)) yield normalized;
      continue;
    }
    if (event.status === 'data' && event.stream === 'stderr') {
      stderr = safeDetail(`${stderr}${event.data}`);
      continue;
    }
    if (event.status === 'completed') {
      if (event.exitCode !== 0) {
        yield {
          type: 'error',
          message: stderr || `Provider CLI exited with code ${event.exitCode ?? 'unknown'}.`,
        };
        return;
      }
      if (stderr) yield { type: 'warning', message: stderr };
      for (const normalized of parser.finish(true)) yield normalized;
      return;
    }
    if (event.status === 'failed') {
      yield { type: 'error', message: safeDetail(event.data) || 'Provider CLI failed.' };
      return;
    }
    if (event.status === 'cancelled') {
      if (request.signal?.aborted) throw cliAbortError();
      yield { type: 'error', message: 'Provider CLI request was cancelled.' };
      return;
    }
    if (event.status === 'timedOut') {
      yield { type: 'error', message: 'Provider CLI request timed out.' };
      return;
    }
  }
}

export function createCliProviderAdapter(definition: CliProviderDefinition): ProviderAdapter {
  return Object.freeze({
    id: definition.adapterId,
    detect: () => detectProvider(definition),
    probeAuth: () => probeProviderAuth(definition),
    send: (request: ProviderRequest) => sendProviderRequest(definition, request),
    cancel: async (requestId: string) => {
      await cancelCliBridge(requestId);
    },
  });
}

export const kernelSmokeCliAdapter = createCliProviderAdapter(KERNEL_SMOKE_CLI_DEFINITION);
