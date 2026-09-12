import type { ProviderId } from '@/types';

export const PROMPT_FORGE_STATUSES = Object.freeze([
  'idle',
  'collecting_context',
  'searching_project',
  'searching_public_sources',
  'building_source_pack',
  'generating',
  'validating',
  'ready',
  'cancelled',
  'failed',
] as const);

export type PromptForgeStatus = (typeof PROMPT_FORGE_STATUSES)[number];

export type PromptForgeModelSelection =
  | Readonly<{ mode: 'current_chat_model' }>
  | Readonly<{ mode: 'prefer_local' }>
  | Readonly<{
      mode: 'single';
      providerId: ProviderId;
      modelId: string;
      connectionId?: string;
    }>;

export type PromptForgePrivacyMode = 'local_only' | 'provider_allowed';

export type PromptForgeAttachmentKind =
  | 'file'
  | 'image'
  | 'terminal'
  | 'context_map'
  | 'plugin'
  | 'skill'
  | 'agent';

export type PromptForgeAttachmentSnapshot = Readonly<{
  id: string;
  kind: PromptForgeAttachmentKind;
  label: string;
  reference: string;
}>;

export type PromptForgeSourceMetadata = Readonly<{
  id: string;
  kind: string;
  label: string;
  reference: string;
  observedAt: number;
  whySelected: string;
}>;

export type PromptForgeValidationSnapshot = Readonly<{
  passed: boolean;
  missingCount: number;
  checkedAt: number;
}>;

export type PromptForgeResolvedModelSnapshot = Readonly<{
  providerId: ProviderId;
  modelId: string;
  label: string;
  connectionId: string | null;
  connectionMode: 'native-api' | 'external-cli' | 'local' | null;
  local: boolean;
  billingClass: 'local_free' | 'subscription_connection' | 'provider_billed';
}>;

export type PromptForgeUsageSnapshot = Readonly<{
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  finishReason: string | null;
  startedAt: number;
  completedAt: number;
}>;

export type PromptForgeJob = Readonly<{
  schemaVersion: 1;
  id: string;
  revision: number;
  accountId: string;
  chatId: string;
  projectId: string | null;
  originalDraft: string;
  regenerationInstructions: string | null;
  originalAttachments: readonly PromptForgeAttachmentSnapshot[];
  modelSelection: PromptForgeModelSelection;
  privacyMode: PromptForgePrivacyMode;
  allowPublicResearch: boolean;
  selectedSourceIds: readonly string[];
  retrievedSources: readonly PromptForgeSourceMetadata[];
  resolvedModel: PromptForgeResolvedModelSnapshot | null;
  usage: PromptForgeUsageSnapshot | null;
  status: PromptForgeStatus;
  generatedDraft: string | null;
  validation: PromptForgeValidationSnapshot | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  errorCode: string | null;
}>;

export type PromptForgeJobScope = Readonly<{
  accountId: string;
  chatId: string;
  projectId: string | null;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const CONTROL_AND_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const PROMPT_CONTROL_AND_BIDI =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const MAX_DRAFT_CHARS = 100_000;
const MAX_REGENERATION_INSTRUCTIONS_CHARS = 10_000;
const MAX_GENERATED_CHARS = 200_000;
const MAX_ATTACHMENTS = 64;
const MAX_SOURCES = 128;
const MAX_USAGE_TOKENS = 1_000_000_000_000;
const MAX_USAGE_COST_USD = 1_000_000;
const ATTACHMENT_KINDS = new Set<PromptForgeAttachmentKind>([
  'file',
  'image',
  'terminal',
  'context_map',
  'plugin',
  'skill',
  'agent',
]);
const PROVIDERS = new Set<ProviderId>([
  'google',
  'groq',
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'mistral',
  'together',
  'xai',
  'ollama',
  'local',
]);
const STATUSES = new Set<PromptForgeStatus>(PROMPT_FORGE_STATUSES);
const CONNECTION_MODES = new Set(['native-api', 'external-cli', 'local'] as const);
const BILLING_CLASSES = new Set([
  'local_free',
  'subscription_connection',
  'provider_billed',
] as const);
const JOB_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'revision',
  'accountId',
  'chatId',
  'projectId',
  'originalDraft',
  'regenerationInstructions',
  'originalAttachments',
  'modelSelection',
  'privacyMode',
  'allowPublicResearch',
  'selectedSourceIds',
  'retrievedSources',
  'resolvedModel',
  'usage',
  'status',
  'generatedDraft',
  'validation',
  'createdAt',
  'updatedAt',
  'completedAt',
  'errorCode',
] as const);
function fail(detail: string): never {
  throw new Error(`Invalid Prompt Forge ${detail}`);
}

function id(value: unknown, detail: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(detail);
  return value;
}

function text(value: unknown, maximum: number, detail: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!allowEmpty && value.trim().length === 0) ||
    CONTROL_AND_BIDI.test(value)
  ) {
    fail(detail);
  }
  return value;
}

function promptText(value: unknown, maximum: number, detail: string): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    value.trim().length === 0 ||
    PROMPT_CONTROL_AND_BIDI.test(value)
  ) {
    fail(detail);
  }
  return value;
}

function time(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(detail);
  return value as number;
}

function closedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  detail: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(detail);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(detail);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== allowedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
  ) {
    fail(detail);
  }
  const output: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail(detail);
    output[key] = descriptor.value;
  }
  return output;
}

export function normalizePromptForgeModelSelection(value: unknown): PromptForgeModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('model selection');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return fail('model selection');
  const modeDescriptor = Object.getOwnPropertyDescriptor(value, 'mode');
  if (!modeDescriptor || !('value' in modeDescriptor)) return fail('model selection');
  if (modeDescriptor.value === 'current_chat_model' || modeDescriptor.value === 'prefer_local') {
    closedRecord(value, ['mode'], 'model selection');
    return Object.freeze({ mode: modeDescriptor.value });
  }
  const singleKeys = keys.includes('connectionId')
    ? ['mode', 'providerId', 'modelId', 'connectionId']
    : ['mode', 'providerId', 'modelId'];
  const record = closedRecord(value, singleKeys, 'model selection');
  if (
    record.mode !== 'single' ||
    typeof record.providerId !== 'string' ||
    !PROVIDERS.has(record.providerId as ProviderId)
  ) {
    return fail('model selection');
  }
  return Object.freeze({
    mode: 'single',
    providerId: record.providerId as ProviderId,
    modelId: text(record.modelId, 200, 'model selection'),
    ...(record.connectionId === undefined
      ? {}
      : { connectionId: id(record.connectionId, 'model selection') }),
  });
}

function attachment(value: unknown): PromptForgeAttachmentSnapshot {
  const record = closedRecord(value, ['id', 'kind', 'label', 'reference'], 'attachment');
  if (!ATTACHMENT_KINDS.has(record.kind as PromptForgeAttachmentKind)) fail('attachment');
  return Object.freeze({
    id: id(record.id, 'attachment ID'),
    kind: record.kind as PromptForgeAttachmentKind,
    label: text(record.label, 500, 'attachment label'),
    reference: text(record.reference, 2_048, 'attachment reference'),
  });
}

function sourceMetadata(value: unknown): PromptForgeSourceMetadata {
  const record = closedRecord(
    value,
    ['id', 'kind', 'label', 'reference', 'observedAt', 'whySelected'],
    'source metadata',
  );
  return Object.freeze({
    id: id(record.id, 'source ID'),
    kind: id(record.kind, 'source kind'),
    label: text(record.label, 500, 'source label'),
    reference: text(record.reference, 2_048, 'source reference'),
    observedAt: time(record.observedAt, 'source observation time'),
    whySelected: text(record.whySelected, 1_000, 'source reason'),
  });
}

function validationSnapshot(value: unknown): PromptForgeValidationSnapshot | null {
  if (value === null) return null;
  const record = closedRecord(value, ['passed', 'missingCount', 'checkedAt'], 'validation');
  if (
    typeof record.passed !== 'boolean' ||
    !Number.isSafeInteger(record.missingCount) ||
    (record.missingCount as number) < 0
  ) {
    return fail('validation');
  }
  return Object.freeze({
    passed: record.passed,
    missingCount: record.missingCount as number,
    checkedAt: time(record.checkedAt, 'validation time'),
  });
}

function resolvedModelSnapshot(value: unknown): PromptForgeResolvedModelSnapshot | null {
  if (value === null) return null;
  const record = closedRecord(
    value,
    ['providerId', 'modelId', 'label', 'connectionId', 'connectionMode', 'local', 'billingClass'],
    'resolved model',
  );
  if (
    typeof record.providerId !== 'string' ||
    !PROVIDERS.has(record.providerId as ProviderId) ||
    (record.connectionMode !== null &&
      !CONNECTION_MODES.has(record.connectionMode as 'native-api' | 'external-cli' | 'local')) ||
    typeof record.local !== 'boolean' ||
    typeof record.billingClass !== 'string' ||
    !BILLING_CLASSES.has(
      record.billingClass as 'local_free' | 'subscription_connection' | 'provider_billed',
    )
  ) {
    return fail('resolved model');
  }
  if (
    (record.local && record.billingClass !== 'local_free') ||
    (!record.local && record.billingClass === 'local_free') ||
    (record.billingClass === 'subscription_connection' && record.connectionMode !== 'external-cli')
  ) {
    return fail('resolved model');
  }
  return Object.freeze({
    providerId: record.providerId as ProviderId,
    modelId: text(record.modelId, 200, 'resolved model'),
    label: text(record.label, 500, 'resolved model'),
    connectionId: record.connectionId === null ? null : id(record.connectionId, 'resolved model'),
    connectionMode: record.connectionMode as 'native-api' | 'external-cli' | 'local' | null,
    local: record.local,
    billingClass: record.billingClass as
      | 'local_free'
      | 'subscription_connection'
      | 'provider_billed',
  });
}

function usageSnapshot(value: unknown): PromptForgeUsageSnapshot | null {
  if (value === null) return null;
  const record = closedRecord(
    value,
    ['inputTokens', 'outputTokens', 'costUsd', 'finishReason', 'startedAt', 'completedAt'],
    'usage',
  );
  if (
    !Number.isSafeInteger(record.inputTokens) ||
    (record.inputTokens as number) < 0 ||
    (record.inputTokens as number) > MAX_USAGE_TOKENS ||
    !Number.isSafeInteger(record.outputTokens) ||
    (record.outputTokens as number) < 0 ||
    (record.outputTokens as number) > MAX_USAGE_TOKENS ||
    typeof record.costUsd !== 'number' ||
    !Number.isFinite(record.costUsd) ||
    record.costUsd < 0 ||
    record.costUsd > MAX_USAGE_COST_USD
  ) {
    return fail('usage');
  }
  const startedAt = time(record.startedAt, 'usage');
  const completedAt = time(record.completedAt, 'usage');
  if (completedAt < startedAt) fail('usage');
  return Object.freeze({
    inputTokens: record.inputTokens as number,
    outputTokens: record.outputTokens as number,
    costUsd: record.costUsd,
    finishReason:
      record.finishReason === null ? null : text(record.finishReason, 200, 'usage finish reason'),
    startedAt,
    completedAt,
  });
}

export function createPromptForgeJob(input: {
  id: string;
  accountId: string;
  chatId: string;
  projectId: string | null;
  originalDraft: string;
  regenerationInstructions?: string | null;
  originalAttachments: readonly PromptForgeAttachmentSnapshot[];
  modelSelection: PromptForgeModelSelection;
  privacyMode: PromptForgePrivacyMode;
  allowPublicResearch: boolean;
  now: number;
}): PromptForgeJob {
  if (
    !Array.isArray(input.originalAttachments) ||
    input.originalAttachments.length > MAX_ATTACHMENTS
  ) {
    return fail('attachments');
  }
  if (!['local_only', 'provider_allowed'].includes(input.privacyMode)) {
    return fail('privacy mode');
  }
  if (typeof input.allowPublicResearch !== 'boolean') {
    return fail('public research authority');
  }
  const now = time(input.now, 'job time');
  return Object.freeze({
    schemaVersion: 1,
    id: id(input.id, 'job ID'),
    revision: 1,
    accountId: id(input.accountId, 'account ID'),
    chatId: id(input.chatId, 'chat ID'),
    projectId: input.projectId === null ? null : id(input.projectId, 'project ID'),
    originalDraft: promptText(input.originalDraft, MAX_DRAFT_CHARS, 'draft'),
    regenerationInstructions:
      input.regenerationInstructions === undefined || input.regenerationInstructions === null
        ? null
        : promptText(
            input.regenerationInstructions,
            MAX_REGENERATION_INSTRUCTIONS_CHARS,
            'regeneration instructions',
          ),
    originalAttachments: Object.freeze(input.originalAttachments.map(attachment)),
    modelSelection: normalizePromptForgeModelSelection(input.modelSelection),
    privacyMode: input.privacyMode,
    allowPublicResearch: input.allowPublicResearch,
    selectedSourceIds: Object.freeze([]),
    retrievedSources: Object.freeze([]),
    resolvedModel: null,
    usage: null,
    status: 'idle',
    generatedDraft: null,
    validation: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    errorCode: null,
  });
}

export function parsePromptForgeJob(value: unknown): PromptForgeJob {
  try {
    const rawKeys =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Reflect.ownKeys(value)
        : [];
    const legacyModelSnapshot = !rawKeys.includes('resolvedModel') && !rawKeys.includes('usage');
    const legacyInstructions = !rawKeys.includes('regenerationInstructions');
    const allowedKeys = JOB_KEYS.filter(
      (key) =>
        !(legacyModelSnapshot && (key === 'resolvedModel' || key === 'usage')) &&
        !(legacyInstructions && key === 'regenerationInstructions'),
    );
    const record = closedRecord(value, allowedKeys, 'persisted job');
    if (record.schemaVersion !== 1) fail('persisted job');
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
      fail('persisted job');
    }
    if (
      !Array.isArray(record.originalAttachments) ||
      record.originalAttachments.length > MAX_ATTACHMENTS
    ) {
      fail('persisted job');
    }
    if (!Array.isArray(record.selectedSourceIds) || record.selectedSourceIds.length > MAX_SOURCES) {
      fail('persisted job');
    }
    if (!Array.isArray(record.retrievedSources) || record.retrievedSources.length > MAX_SOURCES) {
      fail('persisted job');
    }
    if (record.privacyMode !== 'local_only' && record.privacyMode !== 'provider_allowed') {
      fail('persisted job');
    }
    if (
      typeof record.allowPublicResearch !== 'boolean' ||
      !STATUSES.has(record.status as PromptForgeStatus)
    ) {
      fail('persisted job');
    }
    const createdAt = time(record.createdAt, 'persisted job');
    const updatedAt = time(record.updatedAt, 'persisted job');
    if (updatedAt < createdAt) fail('persisted job');
    const completedAt =
      record.completedAt === null ? null : time(record.completedAt, 'persisted job');
    if (completedAt !== null && completedAt < updatedAt) fail('persisted job');
    const terminal = ['ready', 'cancelled', 'failed'].includes(record.status as string);
    if (terminal !== (completedAt !== null)) fail('persisted job');
    const selectedSourceIds = record.selectedSourceIds.map((sourceId) =>
      id(sourceId, 'persisted job'),
    );
    if (new Set(selectedSourceIds).size !== selectedSourceIds.length) fail('persisted job');
    return Object.freeze({
      schemaVersion: 1,
      id: id(record.id, 'persisted job'),
      revision: record.revision as number,
      accountId: id(record.accountId, 'persisted job'),
      chatId: id(record.chatId, 'persisted job'),
      projectId: record.projectId === null ? null : id(record.projectId, 'persisted job'),
      originalDraft: promptText(record.originalDraft, MAX_DRAFT_CHARS, 'persisted job'),
      regenerationInstructions:
        legacyInstructions || record.regenerationInstructions === null
          ? null
          : promptText(
              record.regenerationInstructions,
              MAX_REGENERATION_INSTRUCTIONS_CHARS,
              'persisted job',
            ),
      originalAttachments: Object.freeze(record.originalAttachments.map(attachment)),
      modelSelection: normalizePromptForgeModelSelection(record.modelSelection),
      privacyMode: record.privacyMode,
      allowPublicResearch: record.allowPublicResearch,
      selectedSourceIds: Object.freeze(selectedSourceIds),
      retrievedSources: Object.freeze(record.retrievedSources.map(sourceMetadata)),
      resolvedModel: legacyModelSnapshot ? null : resolvedModelSnapshot(record.resolvedModel),
      usage: legacyModelSnapshot ? null : usageSnapshot(record.usage),
      status: record.status as PromptForgeStatus,
      generatedDraft:
        record.generatedDraft === null
          ? null
          : promptText(record.generatedDraft, MAX_GENERATED_CHARS, 'persisted job'),
      validation: validationSnapshot(record.validation),
      createdAt,
      updatedAt,
      completedAt,
      errorCode: record.errorCode === null ? null : id(record.errorCode, 'persisted job'),
    });
  } catch (error) {
    if (error instanceof Error && /Invalid Prompt Forge persisted job/u.test(error.message)) {
      throw error;
    }
    throw new Error('Invalid Prompt Forge persisted job.', { cause: error });
  }
}

const LEGAL_TRANSITIONS: Readonly<Record<PromptForgeStatus, readonly PromptForgeStatus[]>> =
  Object.freeze({
    idle: ['collecting_context', 'cancelled'],
    collecting_context: [
      'searching_project',
      'searching_public_sources',
      'building_source_pack',
      'generating',
      'cancelled',
      'failed',
    ],
    searching_project: ['searching_public_sources', 'building_source_pack', 'cancelled', 'failed'],
    searching_public_sources: ['building_source_pack', 'cancelled', 'failed'],
    building_source_pack: ['generating', 'cancelled', 'failed'],
    generating: ['validating', 'cancelled', 'failed'],
    validating: ['ready', 'cancelled', 'failed'],
    ready: ['collecting_context', 'generating', 'cancelled'],
    cancelled: ['collecting_context'],
    failed: ['collecting_context'],
  });

export function transitionPromptForgeJob(
  job: PromptForgeJob,
  update: {
    expectedRevision: number;
    status: PromptForgeStatus;
    selectedSourceIds?: readonly string[];
    retrievedSources?: readonly PromptForgeSourceMetadata[];
    resolvedModel?: PromptForgeResolvedModelSnapshot | null;
    usage?: PromptForgeUsageSnapshot | null;
    generatedDraft?: string | null;
    validation?: PromptForgeValidationSnapshot | null;
    errorCode?: string | null;
    now: number;
  },
): PromptForgeJob {
  if (update.expectedRevision !== job.revision) fail('job revision');
  if (!LEGAL_TRANSITIONS[job.status].includes(update.status)) fail('job transition');
  const now = time(update.now, 'job time');
  if (now < job.updatedAt) fail('job time');
  const selectedSourceIds = update.selectedSourceIds ?? job.selectedSourceIds;
  const retrievedSources = update.retrievedSources ?? job.retrievedSources;
  if (selectedSourceIds.length > MAX_SOURCES || retrievedSources.length > MAX_SOURCES) {
    fail('job sources');
  }
  const generatedDraft =
    update.generatedDraft === undefined
      ? job.generatedDraft
      : update.generatedDraft === null
        ? null
        : promptText(update.generatedDraft, MAX_GENERATED_CHARS, 'generated prompt');
  const terminal = ['ready', 'cancelled', 'failed'].includes(update.status);
  return Object.freeze({
    ...job,
    revision: job.revision + 1,
    status: update.status,
    selectedSourceIds: Object.freeze(selectedSourceIds.map((value) => id(value, 'source ID'))),
    retrievedSources: Object.freeze(retrievedSources.map(sourceMetadata)),
    resolvedModel:
      update.resolvedModel === undefined
        ? job.resolvedModel
        : resolvedModelSnapshot(update.resolvedModel),
    usage: update.usage === undefined ? job.usage : usageSnapshot(update.usage),
    generatedDraft,
    validation:
      update.validation === undefined ? job.validation : validationSnapshot(update.validation),
    updatedAt: now,
    completedAt: terminal ? now : null,
    errorCode:
      update.errorCode === undefined
        ? update.status === 'failed'
          ? job.errorCode
          : null
        : update.errorCode === null
          ? null
          : id(update.errorCode, 'error code'),
  });
}
