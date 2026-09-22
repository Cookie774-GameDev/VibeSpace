import { OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';
import type { CaoExecutionIdentity } from './executionProfile';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_VARIANT_LENGTH = 128;
const OPEN_CODE_EVENT_TYPES = new Set(['step_start', 'message.updated', 'message.part.updated']);
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/u;
const SAFE_VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;

type RecordValue = Record<string, unknown>;
type CaoTerminalExecutionIdentityListener = () => void;

export type CaoTerminalExecutionBinding = Readonly<{
  accountId: string;
  projectId: string;
  paneId: string;
  sessionId: string;
  process: ExpectedTerminalProcessBinding;
}>;

export type CaoTerminalExecutionIdentityReceipt = Readonly<{
  source: 'opencode-cli-event';
  observedAt: number;
  binding: CaoTerminalExecutionBinding;
  identity: CaoExecutionIdentity;
  openCodeSessionId: string;
  observedProviderId: string;
  observedModelId: string;
  variant: string;
}>;

const receipts = new Map<string, CaoTerminalExecutionIdentityReceipt>();
const bindings = new Map<string, CaoTerminalExecutionBinding>();
const listeners = new Set<CaoTerminalExecutionIdentityListener>();
let revision = 0;

function notifyIdentityChange(): void {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Subscribers cannot make the identity registry mutation fail.
    }
  }
}

function recordOf(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function boundedText(value: unknown, maximum = MAX_IDENTIFIER_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (
    !clean ||
    clean.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u.test(clean)
  ) {
    return undefined;
  }
  return clean;
}

function identifier(value: unknown): string | undefined {
  return boundedText(value);
}

function processBindingValid(process: ExpectedTerminalProcessBinding, projectId: string): boolean {
  return (
    process.projectId === projectId &&
    Boolean(identifier(process.processInstanceId)) &&
    Boolean(identifier(process.runtimeGeneration)) &&
    Number.isSafeInteger(process.pid) &&
    process.pid > 0 &&
    Number.isSafeInteger(process.processStartedAt) &&
    process.processStartedAt > 0
  );
}

function normalizeBinding(
  input: CaoTerminalExecutionBinding,
): CaoTerminalExecutionBinding | undefined {
  const accountId = identifier(input.accountId);
  const projectId = identifier(input.projectId);
  const paneId = identifier(input.paneId);
  const sessionId = identifier(input.sessionId);
  if (!accountId || !projectId || !paneId || !sessionId) return undefined;
  if (!processBindingValid(input.process, projectId)) return undefined;
  return Object.freeze({
    accountId,
    projectId,
    paneId,
    sessionId,
    process: Object.freeze({ ...input.process, projectId }),
  });
}

function bindingKey(binding: CaoTerminalExecutionBinding): string {
  return [binding.accountId, binding.projectId, binding.paneId].join('\u0000');
}

function sameProcess(
  left: ExpectedTerminalProcessBinding,
  right: ExpectedTerminalProcessBinding,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.processInstanceId === right.processInstanceId &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function sameBinding(
  left: CaoTerminalExecutionBinding,
  right: CaoTerminalExecutionBinding,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.paneId === right.paneId &&
    left.sessionId === right.sessionId &&
    sameProcess(left.process, right.process)
  );
}

function readField(
  sources: readonly (RecordValue | undefined)[],
  keys: readonly string[],
): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function eventParts(event: RecordValue): {
  properties?: RecordValue;
  part?: RecordValue;
  info?: RecordValue;
  message?: RecordValue;
} {
  const properties = recordOf(event.properties);
  const part = recordOf(event.part) ?? recordOf(properties?.part);
  const info = recordOf(event.info) ?? recordOf(properties?.info) ?? recordOf(properties?.message);
  const message = recordOf(event.message) ?? recordOf(properties?.message);
  return { properties, part, info, message };
}

function eventSessionId(
  event: RecordValue,
  parts: ReturnType<typeof eventParts>,
): string | undefined {
  return identifier(
    readField(
      [event, parts.properties, parts.part, parts.info, parts.message],
      ['sessionID', 'sessionId', 'session_id'],
    ),
  );
}

function eventIdentity(
  event: RecordValue,
  parts: ReturnType<typeof eventParts>,
): { providerId: string; modelId: string; variant: string } | undefined {
  const sources = [event, parts.properties, parts.info, parts.part, parts.message];
  const rawProvider = identifier(
    readField(sources, ['providerID', 'providerId', 'provider_id', 'provider']),
  );
  const rawModel = identifier(readField(sources, ['modelID', 'modelId', 'model_id', 'model']));
  const rawVariant = boundedText(
    readField(sources, ['variant', 'reasoningEffort', 'reasoning_effort', 'effort']),
    MAX_VARIANT_LENGTH,
  );
  if (!rawModel) return undefined;

  const hashIndex = rawModel.indexOf('#');
  const modelRoute = hashIndex >= 0 ? rawModel.slice(0, hashIndex) : rawModel;
  const suffixVariant = hashIndex >= 0 ? rawModel.slice(hashIndex + 1) : undefined;
  if (!modelRoute || (hashIndex >= 0 && !suffixVariant)) return undefined;
  // OpenCode reports providerID and modelID separately. A provider such as
  // OpenRouter may legitimately use a namespaced model ID, so a slash in
  // modelID is not evidence of a conflicting provider. Split only the
  // legacy qualified form when providerID is absent, or when OpenCode itself
  // is the provider envelope.
  const separator = modelRoute.indexOf('/');
  const qualifiedProvider = separator > 0 ? modelRoute.slice(0, separator) : undefined;
  const qualifiedModel = separator > 0 ? modelRoute.slice(separator + 1) : modelRoute;
  const providerId =
    rawProvider === 'opencode' && qualifiedProvider
      ? qualifiedProvider
      : (rawProvider ?? qualifiedProvider);
  const modelId =
    rawProvider && rawProvider !== 'opencode'
      ? modelRoute.startsWith(`${rawProvider}/`)
        ? modelRoute.slice(rawProvider.length + 1)
        : modelRoute
      : qualifiedModel;
  if (!providerId || !modelId) return undefined;
  if (rawVariant && suffixVariant && rawVariant !== suffixVariant) return undefined;
  const variant = rawVariant ?? suffixVariant;
  if (!SAFE_PROVIDER_ID.test(providerId) || !SAFE_MODEL_ID.test(modelId)) return undefined;
  if (!variant || !SAFE_VARIANT_ID.test(variant)) return undefined;
  return { providerId, modelId, variant };
}

function eventIsAuthoritative(
  event: RecordValue,
  type: string,
  parts: ReturnType<typeof eventParts>,
): boolean {
  if (type === 'step_start') return true;
  if (type === 'message.updated') return parts.info?.role === 'assistant';
  if (type === 'message.part.updated') {
    const partType = identifier(parts.part?.type);
    return partType === 'step-start' || partType === 'step_start';
  }
  return false;
}

/**
 * Register the current exact PTY binding for a pane. A changed process or
 * session retires the prior receipt before any new provider event is accepted.
 */
export function bindCaoTerminalExecutionIdentity(input: CaoTerminalExecutionBinding): boolean {
  const binding = normalizeBinding(input);
  if (!binding) return false;
  const key = bindingKey(binding);
  const priorBinding = bindings.get(key);
  const prior = receipts.get(key);
  if (priorBinding && !sameBinding(priorBinding, binding)) {
    receipts.delete(key);
  } else if (prior && !sameBinding(prior.binding, binding)) {
    receipts.delete(key);
  }
  bindings.set(key, binding);
  if (!priorBinding || !sameBinding(priorBinding, binding)) notifyIdentityChange();
  return true;
}

/**
 * Consume one real OpenCode CLI/SDK identity event for the exact PTY binding.
 * Terminal prose, startup commands, labels, and catalog membership are never
 * parsed or used as identity evidence.
 */
export function observeCaoTerminalOpenCodeEvent(
  input: CaoTerminalExecutionBinding,
  event: unknown,
  observedAt = Date.now(),
  expectedOpenCodeSessionId?: string,
): CaoTerminalExecutionIdentityReceipt | undefined {
  const binding = normalizeBinding(input);
  if (!binding || !Number.isSafeInteger(observedAt) || observedAt < 0) return undefined;
  bindCaoTerminalExecutionIdentity(binding);
  const row = recordOf(event);
  const type = identifier(row?.type);
  if (!row || !type || !OPEN_CODE_EVENT_TYPES.has(type)) return undefined;
  const parts = eventParts(row);
  const openCodeSessionId = eventSessionId(row, parts);
  const expectedSessionId =
    expectedOpenCodeSessionId === undefined
      ? binding.sessionId
      : identifier(expectedOpenCodeSessionId);
  if (
    !openCodeSessionId ||
    !expectedSessionId ||
    openCodeSessionId !== expectedSessionId ||
    !eventIsAuthoritative(row, type, parts)
  ) {
    return undefined;
  }
  const observed = eventIdentity(row, parts);
  if (!observed) return undefined;
  const qualifiedModelId = `${observed.providerId}/${observed.modelId}`;
  const receipt: CaoTerminalExecutionIdentityReceipt = Object.freeze({
    source: 'opencode-cli-event',
    observedAt,
    binding,
    identity: Object.freeze({
      backend: 'opencode',
      providerId: OPENCODE_CLI_CONNECTION.providerId,
      connectionId: OPENCODE_CLI_CONNECTION.id,
      modelId: qualifiedModelId,
      reasoningEffort: observed.variant,
    }),
    openCodeSessionId,
    observedProviderId: observed.providerId,
    observedModelId: observed.modelId,
    variant: observed.variant,
  });
  receipts.set(bindingKey(binding), receipt);
  notifyIdentityChange();
  return receipt;
}

export function readCaoTerminalExecutionIdentity(
  input: CaoTerminalExecutionBinding,
): CaoTerminalExecutionIdentityReceipt | undefined {
  const binding = normalizeBinding(input);
  if (!binding) return undefined;
  const receipt = receipts.get(bindingKey(binding));
  return receipt && sameBinding(receipt.binding, binding) ? receipt : undefined;
}

export function invalidateCaoTerminalExecutionIdentity(input: CaoTerminalExecutionBinding): void {
  const binding = normalizeBinding(input);
  if (!binding) return;
  const key = bindingKey(binding);
  const receipt = receipts.get(key);
  const currentBinding = bindings.get(key);
  const removedReceipt = Boolean(receipt && sameBinding(receipt.binding, binding));
  if (removedReceipt) receipts.delete(key);
  if (currentBinding && sameBinding(currentBinding, binding)) {
    bindings.delete(key);
  }
  if (removedReceipt || (currentBinding && sameBinding(currentBinding, binding))) {
    notifyIdentityChange();
  }
}

/**
 * Retire receipts for the exact native PTY process that just exited. The
 * native exit event has no account or pane, so match it against the complete
 * process/session tuple already held by each authenticated receipt.
 */
export function invalidateCaoTerminalExecutionIdentityOnExit(input: unknown): void {
  const row = recordOf(input);
  const sessionId = identifier(row?.sessionId);
  const processInstanceId = identifier(row?.processInstanceId);
  const runtimeGeneration = identifier(row?.runtimeGeneration);
  const pid = row?.pid;
  const processStartedAt = row?.processStartedAt;
  if (
    !sessionId ||
    !processInstanceId ||
    !runtimeGeneration ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof processStartedAt !== 'number' ||
    !Number.isSafeInteger(processStartedAt) ||
    processStartedAt <= 0
  ) {
    return;
  }
  let changed = false;
  for (const [key, binding] of bindings) {
    const process = binding.process;
    if (
      binding.sessionId === sessionId &&
      process.processInstanceId === processInstanceId &&
      process.pid === pid &&
      process.processStartedAt === processStartedAt &&
      process.runtimeGeneration === runtimeGeneration
    ) {
      receipts.delete(key);
      bindings.delete(key);
      changed = true;
    }
  }
  if (changed) notifyIdentityChange();
}

export function subscribeCaoTerminalExecutionIdentity(
  listener: CaoTerminalExecutionIdentityListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCaoTerminalExecutionIdentityRevision(): number {
  return revision;
}

export function resetCaoTerminalExecutionIdentityForTests(): void {
  receipts.clear();
  bindings.clear();
  revision = 0;
}
