import type { JarvisCapabilitySnapshot, JarvisModelSnapshot } from './capability';
import type {
  JarvisApprovalV1,
  JarvisArtifactV1,
  JarvisCanonicalResultEvidenceV1,
  JarvisDurableLiveEvidenceV1,
  JarvisEvent,
  JarvisExecutionEvidenceV1,
  JarvisPreEffectTransportFailureEvidence,
  JarvisProducerSourceEvidenceV1,
  JarvisRun,
  JarvisTransportAttemptV1,
  JarvisZeroConsequentialEffectEvidenceV1,
} from './execution';
import type { CompiledJarvisPrompt } from './prompt';
import type { JarvisRequestEnvelope } from './request';
import type { JarvisResponseEnvelope } from './response';
import type { JarvisContextPack, JarvisSourceRef } from './source';

export type JarvisContractValidationErrorCode =
  | 'missing_field'
  | 'invalid_type'
  | 'unknown_field'
  | 'unknown_enum'
  | 'non_finite_number'
  | 'invalid_identifier'
  | 'non_json_safe';

export interface JarvisContractValidationError {
  code: JarvisContractValidationErrorCode;
  path: readonly (string | number)[];
  message: string;
}

export type JarvisContractValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly JarvisContractValidationError[] };

type ValidationPath = readonly (string | number)[];
type ValidationErrors = JarvisContractValidationError[];
type RecordValue = Record<string, unknown>;
type ValueValidator = (value: unknown, path: ValidationPath, errors: ValidationErrors) => void;

const REQUEST_SURFACES = [
  'typed_chat',
  'voice',
  'schedule',
  'hive_final',
  'phone',
  'browser_chat',
] as const;

const INTERACTION_MODES = ['ask', 'plan', 'agent'] as const;

const RESPONSE_MODES = [
  'acknowledgement',
  'direct_answer',
  'status',
  'warning',
  'approval_required',
  'action_running',
  'action_success',
  'action_partial',
  'action_failure',
  'clarification',
  'recommendation',
  'long_form_delivery',
  'sensitive',
] as const;

const PROMPT_AUTHORITIES = [
  'immutable_security',
  'immutable_identity',
  'capability_policy',
  'user_approved_preference',
  'turn_policy',
  'untrusted_context',
  'output_contract',
] as const;

const SOURCE_KINDS = [
  'user_message',
  'chat',
  'project',
  'project_file',
  'context_node',
  'memory',
  'terminal',
  'tool_result',
  'plugin',
  'mcp',
  'web',
  'schedule',
  'artifact',
  'agent_output',
] as const;

const SOURCE_TRUST_VALUES = ['user_direct', 'app_verified', 'external_untrusted'] as const;
const SOURCE_ORIGIN_VALUES = [
  'user_authored',
  'app_observed',
  'model_inference',
  'mixed',
  'external_retrieved',
] as const;
const SOURCE_SENSITIVITIES = ['public', 'private', 'restricted', 'secret'] as const;
const CONTEXT_PURPOSES = [
  'answer',
  'execution',
  'preference',
  'history',
  'capability',
  'citation',
] as const;
const CONTEXT_FRESHNESS_VALUES = ['current', 'stale', 'unknown'] as const;
const CONTEXT_CONFLICT_STATUSES = ['unresolved', 'resolved'] as const;
const CONTEXT_CONFLICT_RESOLUTION_BASES = [
  'user_selected',
  'higher_authority',
  'newer_verified_observation',
] as const;

const CAPABILITY_STATES = [
  'available',
  'connected',
  'authenticated',
  'degraded',
  'unavailable',
  'planned',
] as const;
const ACTION_SCHEMA_TYPES = ['object', 'string', 'number', 'boolean', 'array'] as const;
const ACTION_RISKS = [
  'read-only',
  'safe-write',
  'external-side-effect',
  'destructive',
  'credential-sensitive',
] as const;
const ACTION_APPROVALS = ['never', 'first-time', 'always', 'depends-on-input'] as const;

const ENTITLEMENT_SOURCES = ['server', 'local_development', 'unavailable'] as const;
const CONNECTION_MODES = ['native-api', 'external-cli', 'local'] as const;
const VOICE_DELIVERY_VALUES = ['none', 'validated_stream', 'final_summary'] as const;
const EXECUTION_VERIFIERS = ['journal', 'executor', 'provider'] as const;

const RUN_STATUSES = [
  'queued',
  'compiling',
  'running',
  'awaiting_approval',
  'partial',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;

const EVENT_TYPES = [
  'run_state',
  'model',
  'context',
  'retrieval',
  'tool',
  'terminal',
  'approval',
  'artifact',
  'message',
  'warning',
  'error',
] as const;

const TRANSPORT_ATTEMPT_KINDS = ['initial', 'transport_retry'] as const;
const TRANSPORT_ATTEMPT_STATES = [
  'provider_in_flight',
  'retryable_failed',
  'completed',
  'effect_uncertain',
] as const;
const EFFECT_BARRIER_STATES = ['open', 'dirty', 'sealed_for_retry'] as const;
const EXECUTION_EVIDENCE_KINDS = [
  'consequential_effect_claimed',
  'consequential_effect_completed',
] as const;
const EXECUTION_OWNER_KINDS = [
  'approval',
  'artifact',
  'action',
  'file',
  'terminal',
  'plugin',
  'mcp',
  'browser',
  'schedule',
] as const;
const CANONICAL_RESULT_KINDS = [
  'kernel_turn_committed',
  'scheduled_transport_settled',
  'hive_child_provider_result',
] as const;
const TERMINAL_EVIDENCE_STATES = ['completed', 'degraded'] as const;
const LIVE_PRODUCER_KINDS = [
  'provider',
  'action',
  'file_action',
  'terminal',
  'plugin',
  'mcp',
  'schedule',
  'voice',
  'hive',
] as const;
const LIVE_TRANSITIONS = ['started', 'ready', 'busy', 'completed', 'degraded'] as const;
const LIVE_CAPABILITY_CATEGORIES = [
  'tool',
  'plugin',
  'mcp',
  'terminal',
  'agent',
  'entitlement',
] as const;
const MODEL_LIVE_OPERATIONS = ['generate', 'stream', 'embed'] as const;
const CAPABILITY_LIVE_OPERATIONS = ['execute', 'cancel', 'inspect'] as const;

const APPROVAL_RISKS = ['safe', 'confirm', 'dangerous'] as const;
const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'consumed'] as const;
const ARTIFACT_KINDS = [
  'file',
  'link',
  'text',
  'image',
  'document',
  'code',
  'terminal_output',
  'provider_result',
] as const;
const ARTIFACT_STATES = ['ready', 'partial', 'quarantined'] as const;
const ARTIFACT_PREVIEW_KINDS = ['text', 'image', 'none'] as const;
const ARTIFACT_LOCAL_REFERENCE_KINDS = ['path', 'blob_key', 'message_part'] as const;

const PROFILE_MEMORY_SCOPES = ['none', 'profile', 'shared_selected'] as const;
const LLM_ROLES = ['system', 'user', 'assistant'] as const;
const LLM_CONTENT_PART_TYPES = ['text', 'image'] as const;

const ERROR_MESSAGES: Record<JarvisContractValidationErrorCode, string> = {
  missing_field: 'Required field is missing.',
  invalid_type: 'Value does not match the expected schema type.',
  unknown_field: 'Field is not part of the version 1 schema.',
  unknown_enum: 'Value is not a recognized enum member.',
  non_finite_number: 'A finite number is required.',
  invalid_identifier: 'A non-empty identifier is required.',
  non_json_safe: 'A JSON-safe value is required.',
};

function addError(
  errors: ValidationErrors,
  code: JarvisContractValidationErrorCode,
  path: ValidationPath,
): void {
  errors.push({
    code,
    path: [...path],
    message: ERROR_MESSAGES[code],
  });
}

function childPath(path: ValidationPath, segment: string | number): ValidationPath {
  return [...path, segment];
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

interface JsonSafetyPathNode {
  readonly parent: JsonSafetyPathNode | undefined;
  readonly segment: string | number;
  readonly depth: number;
}

type JsonSafetyFrame =
  | {
      readonly kind: 'visit';
      readonly value: unknown;
      readonly path: JsonSafetyPathNode | undefined;
    }
  | {
      readonly kind: 'leave';
      readonly value: object;
    };

function appendJsonSafetyPath(
  parent: JsonSafetyPathNode | undefined,
  segment: string | number,
): JsonSafetyPathNode {
  return {
    parent,
    segment,
    depth: (parent?.depth ?? 0) + 1,
  };
}

function materializeJsonSafetyPath(path: JsonSafetyPathNode | undefined): ValidationPath {
  if (!path) return [];
  const result = new Array<string | number>(path.depth);
  let current: JsonSafetyPathNode | undefined = path;
  for (let index = path.depth - 1; index >= 0 && current; index -= 1) {
    result[index] = current.segment;
    current = current.parent;
  }
  return result;
}

function addJsonSafetyError(
  errors: ValidationErrors,
  code: Extract<JarvisContractValidationErrorCode, 'non_finite_number' | 'non_json_safe'>,
  path: JsonSafetyPathNode | undefined,
): void {
  addError(errors, code, materializeJsonSafetyPath(path));
}

function validateJsonSafety(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
  active: WeakSet<object>,
): void {
  let rootPath: JsonSafetyPathNode | undefined;
  for (const segment of path) rootPath = appendJsonSafetyPath(rootPath, segment);

  const stack: JsonSafetyFrame[] = [{ kind: 'visit', value, path: rootPath }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'leave') {
      active.delete(frame.value);
      continue;
    }

    const current = frame.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) addJsonSafetyError(errors, 'non_finite_number', frame.path);
      continue;
    }

    if (typeof current !== 'object') {
      addJsonSafetyError(errors, 'non_json_safe', frame.path);
      continue;
    }

    if (active.has(current)) {
      addJsonSafetyError(errors, 'non_json_safe', frame.path);
      continue;
    }

    let prototype: object | null;
    let ownKeys: readonly PropertyKey[];
    let isArray: boolean;
    try {
      prototype = Object.getPrototypeOf(current) as object | null;
      ownKeys = Reflect.ownKeys(current);
      isArray = Array.isArray(current);
    } catch {
      addJsonSafetyError(errors, 'non_json_safe', frame.path);
      continue;
    }

    let arrayLength = 0;
    if (isArray) {
      if (prototype !== Array.prototype) {
        addJsonSafetyError(errors, 'non_json_safe', frame.path);
        continue;
      }
      try {
        arrayLength = (current as unknown[]).length;
      } catch {
        addJsonSafetyError(errors, 'non_json_safe', frame.path);
        continue;
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      addJsonSafetyError(errors, 'non_json_safe', frame.path);
      continue;
    }

    active.add(current);
    stack.push({ kind: 'leave', value: current });
    const children: Extract<JsonSafetyFrame, { kind: 'visit' }>[] = [];

    if (isArray) {
      const indexedKeys = new Set<string>();
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          addJsonSafetyError(errors, 'non_json_safe', frame.path);
          continue;
        }
        if (key === 'length') continue;

        if (!isCanonicalArrayIndex(key, arrayLength)) {
          addJsonSafetyError(errors, 'non_json_safe', appendJsonSafetyPath(frame.path, key));
          continue;
        }

        indexedKeys.add(key);
        const indexPath = appendJsonSafetyPath(frame.path, Number(key));
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          addJsonSafetyError(errors, 'non_json_safe', indexPath);
          continue;
        }

        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          addJsonSafetyError(errors, 'non_json_safe', indexPath);
          continue;
        }

        children.push({ kind: 'visit', value: descriptor.value, path: indexPath });
      }

      for (let index = 0; index < arrayLength; index += 1) {
        if (!indexedKeys.has(String(index))) {
          addJsonSafetyError(errors, 'non_json_safe', appendJsonSafetyPath(frame.path, index));
          break;
        }
      }
    } else {
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          addJsonSafetyError(errors, 'non_json_safe', frame.path);
          continue;
        }

        const keyPath = appendJsonSafetyPath(frame.path, key);
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          addJsonSafetyError(errors, 'non_json_safe', keyPath);
          continue;
        }

        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          addJsonSafetyError(errors, 'non_json_safe', keyPath);
          continue;
        }

        children.push({ kind: 'visit', value: descriptor.value, path: keyPath });
      }
    }

    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
}

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

type OwnFieldInspection =
  | { kind: 'missing' }
  | { kind: 'accessor' }
  | { kind: 'data'; value: unknown };

function inspectOwnField(record: RecordValue, key: string): OwnFieldInspection {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { kind: 'missing' };
  if (!('value' in descriptor)) return { kind: 'accessor' };
  return { kind: 'data', value: descriptor.value };
}

function validateUnknownKeys(
  record: RecordValue,
  allowedKeys: readonly string[],
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === 'string' && !allowed.has(key)) {
      addError(errors, 'unknown_field', childPath(path, key));
    }
  }
}

function validateRecord(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): RecordValue | undefined {
  if (!isRecordValue(value)) {
    addError(errors, 'invalid_type', path);
    return undefined;
  }
  return value;
}

function validateClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  path: ValidationPath,
  errors: ValidationErrors,
): RecordValue | undefined {
  const record = validateRecord(value, path, errors);
  if (!record) return undefined;
  validateUnknownKeys(record, allowedKeys, path, errors);
  return record;
}

function validateRequiredField(
  record: RecordValue,
  key: string,
  path: ValidationPath,
  errors: ValidationErrors,
  validator: ValueValidator,
): void {
  const valuePath = childPath(path, key);
  const field = inspectOwnField(record, key);
  if (field.kind === 'missing') {
    addError(errors, 'missing_field', valuePath);
    return;
  }
  if (field.kind === 'data') validator(field.value, valuePath, errors);
}

function validateOptionalField(
  record: RecordValue,
  key: string,
  path: ValidationPath,
  errors: ValidationErrors,
  validator: ValueValidator,
): void {
  const field = inspectOwnField(record, key);
  if (field.kind === 'data') validator(field.value, childPath(path, key), errors);
}

function requireField(
  record: RecordValue,
  key: string,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (!hasOwn(record, key)) addError(errors, 'missing_field', childPath(path, key));
}

function validateString(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  if (typeof value !== 'string') addError(errors, 'invalid_type', path);
}

function validateIdentifier(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  if (typeof value !== 'string') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (value.trim().length === 0) addError(errors, 'invalid_identifier', path);
}

function validateBoolean(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  if (typeof value !== 'boolean') addError(errors, 'invalid_type', path);
}

function validateFiniteNumber(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (typeof value !== 'number') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (!Number.isFinite(value)) addError(errors, 'non_finite_number', path);
}

function validateSequence(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  if (typeof value !== 'number') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (!Number.isFinite(value)) {
    addError(errors, 'non_finite_number', path);
    return;
  }
  if (!Number.isInteger(value) || value < 0) addError(errors, 'invalid_type', path);
}

function validatePositiveInteger(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (typeof value !== 'number') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (!Number.isFinite(value)) {
    addError(errors, 'non_finite_number', path);
    return;
  }
  if (!Number.isSafeInteger(value) || value <= 0) addError(errors, 'invalid_type', path);
}

function validateNonNegativeInteger(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (typeof value !== 'number') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (!Number.isFinite(value)) {
    addError(errors, 'non_finite_number', path);
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) addError(errors, 'invalid_type', path);
}

function validatePrefixedIdentifier(
  value: unknown,
  prefix: string,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateIdentifier(value, path, errors);
  if (typeof value === 'string' && !value.startsWith(prefix)) {
    addError(errors, 'invalid_identifier', path);
  }
}

function requireEqualBinding(
  record: RecordValue,
  key: string,
  expected: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (dataField(record, key) !== expected) {
    addError(errors, 'invalid_identifier', childPath(path, key));
  }
}

function validateLiteral(
  value: unknown,
  literal: 0 | 1 | false | true,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (value !== literal) addError(errors, 'invalid_type', path);
}

function validateEnum(
  value: unknown,
  members: readonly string[],
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (typeof value !== 'string') {
    addError(errors, 'invalid_type', path);
    return;
  }
  if (!members.includes(value)) addError(errors, 'unknown_enum', path);
}

function validateArray(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
  elementValidator: ValueValidator,
): void {
  if (!Array.isArray(value)) {
    addError(errors, 'invalid_type', path);
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    elementValidator(value[index], childPath(path, index), errors);
  }
}

function dataField(record: RecordValue, key: string): unknown {
  const field = inspectOwnField(record, key);
  return field.kind === 'data' ? field.value : undefined;
}

function rejectUnlessEqual(
  actual: unknown,
  expected: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (actual !== expected) addError(errors, 'invalid_type', path);
}

function validateClosedOperationArray(
  value: unknown,
  members: readonly string[],
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateArray(value, path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, members, entryPath, entryErrors),
  );
  if (!Array.isArray(value)) return;
  if (value.length === 0 || new Set(value).size !== value.length) {
    addError(errors, 'invalid_type', path);
  }
}

function validateStringArray(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  validateArray(value, path, errors, validateString);
}

function validateIdentifierArray(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateArray(value, path, errors, validateIdentifier);
}

function validateConflictSourceIds(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateIdentifierArray(value, path, errors);
  if (!Array.isArray(value)) return;
  if (value.length < 2 || new Set(value).size !== value.length) {
    addError(errors, 'invalid_type', path);
  }
}

function validateSourceRefShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'id',
      'kind',
      'label',
      'uri',
      'accountId',
      'projectId',
      'trust',
      'origin',
      'sensitivity',
      'observedAt',
      'contentHash',
    ],
    path,
    errors,
  );
  if (!record) return;

  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, SOURCE_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'label', path, errors, validateString);
  validateOptionalField(record, 'uri', path, errors, validateString);
  validateRequiredField(record, 'accountId', path, errors, validateIdentifier);
  validateOptionalField(record, 'projectId', path, errors, validateIdentifier);
  validateRequiredField(record, 'trust', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, SOURCE_TRUST_VALUES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'origin', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, SOURCE_ORIGIN_VALUES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'sensitivity', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, SOURCE_SENSITIVITIES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'observedAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'contentHash', path, errors, validateIdentifier);
}

function validateSourceRefArray(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateArray(value, path, errors, validateSourceRefShape);
}

function validateContextItemShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['source', 'purpose', 'excerpt', 'score', 'freshness', 'conflict', 'truncated'],
    path,
    errors,
  );
  if (!record) return;

  validateRequiredField(record, 'source', path, errors, validateSourceRefShape);
  validateRequiredField(record, 'purpose', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CONTEXT_PURPOSES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'excerpt', path, errors, validateString);
  validateOptionalField(record, 'score', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'freshness', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CONTEXT_FRESHNESS_VALUES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'conflict', path, errors, validateContextConflictShape);
  validateRequiredField(record, 'truncated', path, errors, validateBoolean);
}

function validateContextConflictShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  const status = dataField(record, 'status');
  validateUnknownKeys(
    record,
    [
      'groupId',
      'status',
      'sourceIds',
      ...(status === 'resolved' ? ['winnerSourceId', 'basis'] : []),
    ],
    path,
    errors,
  );
  validateRequiredField(record, 'groupId', path, errors, validateIdentifier);
  validateRequiredField(record, 'status', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CONTEXT_CONFLICT_STATUSES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'sourceIds', path, errors, validateConflictSourceIds);
  if (status === 'resolved') {
    validateRequiredField(record, 'winnerSourceId', path, errors, validateIdentifier);
    validateRequiredField(record, 'basis', path, errors, (entry, entryPath, entryErrors) =>
      validateEnum(entry, CONTEXT_CONFLICT_RESOLUTION_BASES, entryPath, entryErrors),
    );
  }
}

function validateContextConflictBindings(
  items: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  if (!Array.isArray(items)) return;
  const itemBySourceId = new Map<string, RecordValue>();
  for (const item of items) {
    if (!isRecordValue(item)) continue;
    const source = dataField(item, 'source');
    if (!isRecordValue(source)) continue;
    const sourceId = dataField(source, 'id');
    if (typeof sourceId === 'string') itemBySourceId.set(sourceId, item);
  }

  const canonicalByGroup = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecordValue(item)) continue;
    const conflict = dataField(item, 'conflict');
    if (!isRecordValue(conflict)) continue;
    const conflictPath = childPath(childPath(path, index), 'conflict');
    const groupId = dataField(conflict, 'groupId');
    const sourceIds = dataField(conflict, 'sourceIds');
    const status = dataField(conflict, 'status');
    const source = dataField(item, 'source');
    const itemSourceId = isRecordValue(source) ? dataField(source, 'id') : undefined;
    if (!Array.isArray(sourceIds)) continue;

    if (typeof itemSourceId === 'string' && !sourceIds.includes(itemSourceId)) {
      addError(errors, 'invalid_type', childPath(conflictPath, 'sourceIds'));
    }
    for (const sourceId of sourceIds) {
      if (typeof sourceId !== 'string') continue;
      const member = itemBySourceId.get(sourceId);
      const memberConflict = member ? dataField(member, 'conflict') : undefined;
      if (
        !member ||
        !isRecordValue(memberConflict) ||
        dataField(memberConflict, 'groupId') !== groupId
      ) {
        addError(errors, 'invalid_type', childPath(conflictPath, 'sourceIds'));
        break;
      }
    }
    if (
      status === 'resolved' &&
      typeof dataField(conflict, 'winnerSourceId') === 'string' &&
      !sourceIds.includes(dataField(conflict, 'winnerSourceId'))
    ) {
      addError(errors, 'invalid_type', childPath(conflictPath, 'winnerSourceId'));
    }

    if (typeof groupId === 'string') {
      const canonical = JSON.stringify([
        groupId,
        status,
        sourceIds,
        status === 'resolved' ? dataField(conflict, 'winnerSourceId') : null,
        status === 'resolved' ? dataField(conflict, 'basis') : null,
      ]);
      const previous = canonicalByGroup.get(groupId);
      if (previous !== undefined && previous !== canonical) {
        addError(errors, 'invalid_type', conflictPath);
      } else {
        canonicalByGroup.set(groupId, canonical);
      }
    }
  }
}

function validateContextBudgetShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['maxChars', 'usedChars'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'maxChars', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'usedChars', path, errors, validateFiniteNumber);
}

function validateContextExclusionShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['source', 'reason'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'source', path, errors, validateSourceRefShape);
  validateRequiredField(record, 'reason', path, errors, validateString);
}

function validateContextPackShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['items', 'budget', 'exclusions'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'items', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateContextItemShape),
  );
  validateRequiredField(record, 'budget', path, errors, validateContextBudgetShape);
  validateRequiredField(record, 'exclusions', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateContextExclusionShape),
  );
  validateContextConflictBindings(dataField(record, 'items'), childPath(path, 'items'), errors);
}

function validateCapabilityRefShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['id', 'state', 'operations', 'evidenceRef', 'lastVerifiedAt'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CAPABILITY_STATES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'operations', path, errors, validateIdentifierArray);
  validateOptionalField(record, 'evidenceRef', path, errors, validateIdentifier);
  validateOptionalField(record, 'lastVerifiedAt', path, errors, validateFiniteNumber);
}

function validateActionJsonSchemaShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
  depth = 0,
): void {
  if (depth > 16) {
    addError(errors, 'invalid_type', path);
    return;
  }
  const record = validateClosedRecord(
    value,
    ['type', 'description', 'properties', 'required', 'additionalProperties', 'enum', 'oneOf'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'type', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ACTION_SCHEMA_TYPES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'description', path, errors, validateString);
  validateOptionalField(record, 'required', path, errors, validateIdentifierArray);
  validateOptionalField(record, 'additionalProperties', path, errors, validateBoolean);
  validateOptionalField(record, 'enum', path, errors, validateIdentifierArray);
  validateOptionalField(record, 'oneOf', path, errors, (entry, entryPath, entryErrors) => {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 8) {
      addError(entryErrors, 'invalid_type', entryPath);
      return;
    }
    validateArray(entry, entryPath, entryErrors, (branch, branchPath, branchErrors) =>
      validateActionJsonSchemaShape(branch, branchPath, branchErrors, depth + 1),
    );
  });
  validateOptionalField(record, 'properties', path, errors, (entry, entryPath, entryErrors) => {
    const properties = validateRecord(entry, entryPath, entryErrors);
    if (!properties) return;
    for (const key of Reflect.ownKeys(properties)) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        addError(entryErrors, 'invalid_identifier', childPath(entryPath, String(key)));
        continue;
      }
      const property = inspectOwnField(properties, key);
      if (property.kind === 'data') {
        validateActionJsonSchemaShape(
          property.value,
          childPath(entryPath, key),
          entryErrors,
          depth + 1,
        );
      }
    }
  });
}

function validateActionSchemaSnapshotShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'id',
      'version',
      'title',
      'description',
      'inputSchema',
      'outputSchema',
      'requiredCapabilities',
      'requiredEntitlements',
      'risk',
      'approval',
      'expectedEffect',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'version', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'title', path, errors, validateIdentifier);
  validateRequiredField(record, 'description', path, errors, validateIdentifier);
  validateRequiredField(record, 'inputSchema', path, errors, validateActionJsonSchemaShape);
  validateRequiredField(record, 'outputSchema', path, errors, validateActionJsonSchemaShape);
  validateRequiredField(record, 'requiredCapabilities', path, errors, validateIdentifierArray);
  validateRequiredField(record, 'requiredEntitlements', path, errors, validateIdentifierArray);
  validateRequiredField(record, 'risk', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ACTION_RISKS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'approval', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ACTION_APPROVALS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'expectedEffect', path, errors, validateIdentifier);
}

function validateEntitlementShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['source', 'planId', 'capabilities', 'verifiedAt', 'expiresAt'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'source', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ENTITLEMENT_SOURCES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'planId', path, errors, validateIdentifier);
  validateRequiredField(record, 'capabilities', path, errors, validateIdentifierArray);
  validateOptionalField(record, 'verifiedAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'expiresAt', path, errors, validateFiniteNumber);
}

function validateCapabilitySnapshotShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'capturedAt',
      'tools',
      'plugins',
      'mcps',
      'terminals',
      'agents',
      'entitlements',
      'actionSchemas',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'capturedAt', path, errors, validateFiniteNumber);
  for (const key of ['tools', 'plugins', 'mcps', 'terminals', 'agents']) {
    validateRequiredField(record, key, path, errors, (entry, entryPath, entryErrors) =>
      validateArray(entry, entryPath, entryErrors, validateCapabilityRefShape),
    );
  }
  validateRequiredField(record, 'entitlements', path, errors, validateEntitlementShape);
  validateOptionalField(record, 'actionSchemas', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateActionSchemaSnapshotShape),
  );
  const actionSchemas = dataField(record, 'actionSchemas');
  if (Array.isArray(actionSchemas)) {
    const ids = actionSchemas
      .map((entry) => (isRecordValue(entry) ? dataField(entry, 'id') : undefined))
      .filter((id): id is string => typeof id === 'string');
    if (new Set(ids).size !== ids.length) {
      addError(errors, 'invalid_type', childPath(path, 'actionSchemas'));
    }
  }
}

function validateModelCapabilities(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') continue;
    const field = inspectOwnField(record, key);
    if (field.kind !== 'data') continue;
    validateIdentifier(key, childPath(path, key), errors);
    validateBoolean(field.value, childPath(path, key), errors);
  }
}

function validateModelSnapshotShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'connectionId',
      'providerId',
      'modelId',
      'connectionMode',
      'capabilities',
      'effectiveTemperature',
      'capturedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateOptionalField(record, 'connectionId', path, errors, validateIdentifier);
  validateRequiredField(record, 'providerId', path, errors, validateIdentifier);
  validateRequiredField(record, 'modelId', path, errors, validateIdentifier);
  validateRequiredField(record, 'connectionMode', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CONNECTION_MODES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'capabilities', path, errors, validateModelCapabilities);
  validateOptionalField(record, 'effectiveTemperature', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'capturedAt', path, errors, validateFiniteNumber);
}

function validateIdentityShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['identityVersion', 'coreHash', 'responseContractHash'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'identityVersion', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'coreHash', path, errors, validateIdentifier);
  validateRequiredField(record, 'responseContractHash', path, errors, validateIdentifier);
}

function validateProfileShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['profileId', 'revisionId', 'soulRevisionId', 'customInstructions', 'memoryScope'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'profileId', path, errors, validateIdentifier);
  validateRequiredField(record, 'revisionId', path, errors, validateIdentifier);
  validateOptionalField(record, 'soulRevisionId', path, errors, validateIdentifier);
  validateRequiredField(record, 'customInstructions', path, errors, validateString);
  validateRequiredField(record, 'memoryScope', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, PROFILE_MEMORY_SCOPES, entryPath, entryErrors),
  );
}

function validateLlmContentPart(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;

  const typePath = childPath(path, 'type');
  const typeField = inspectOwnField(record, 'type');
  if (typeField.kind === 'missing') {
    addError(errors, 'missing_field', typePath);
    validateUnknownKeys(record, ['type', 'text', 'data', 'mimeType', 'name'], path, errors);
    return;
  }
  if (typeField.kind === 'accessor') {
    validateUnknownKeys(record, ['type', 'text', 'data', 'mimeType', 'name'], path, errors);
    return;
  }

  validateEnum(typeField.value, LLM_CONTENT_PART_TYPES, typePath, errors);
  if (typeField.value === 'text') {
    validateUnknownKeys(record, ['type', 'text'], path, errors);
    validateRequiredField(record, 'text', path, errors, validateString);
    return;
  }

  if (typeField.value === 'image') {
    validateUnknownKeys(record, ['type', 'data', 'mimeType', 'name'], path, errors);
    validateRequiredField(record, 'data', path, errors, validateString);
    validateRequiredField(record, 'mimeType', path, errors, validateString);
    validateOptionalField(record, 'name', path, errors, validateString);
    return;
  }

  validateUnknownKeys(record, ['type', 'text', 'data', 'mimeType', 'name'], path, errors);
}

function validateLlmContent(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  if (typeof value === 'string') return;
  if (!Array.isArray(value)) {
    addError(errors, 'invalid_type', path);
    return;
  }
  validateArray(value, path, errors, validateLlmContentPart);
}

function validateLlmMessage(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  const record = validateClosedRecord(value, ['role', 'content'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'role', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, LLM_ROLES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'content', path, errors, validateLlmContent);
}

function validateOutputContractShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'preserveStructuredBlocks',
      'allowActionBlocks',
      'allowPlanBlocks',
      'allowQuestionBlocks',
      'allowPermissionBlocks',
      'voiceDelivery',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(
    record,
    'preserveStructuredBlocks',
    path,
    errors,
    (entry, entryPath, entryErrors) => validateLiteral(entry, true, entryPath, entryErrors),
  );
  validateRequiredField(record, 'allowActionBlocks', path, errors, validateBoolean);
  validateRequiredField(record, 'allowPlanBlocks', path, errors, validateBoolean);
  validateRequiredField(record, 'allowQuestionBlocks', path, errors, validateBoolean);
  validateRequiredField(record, 'allowPermissionBlocks', path, errors, validateBoolean);
  validateRequiredField(record, 'voiceDelivery', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, VOICE_DELIVERY_VALUES, entryPath, entryErrors),
  );
}

function validateRequestAgentShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['id', 'slug', 'builtin'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'slug', path, errors, validateIdentifier);
  validateRequiredField(record, 'builtin', path, errors, validateBoolean);
}

function validateRequestEnvelopeShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'requestId',
      'runId',
      'accountId',
      'workspaceId',
      'projectId',
      'chatId',
      'parentRunId',
      'agent',
      'surface',
      'interactionMode',
      'responseModeHint',
      'userText',
      'messageHistory',
      'identity',
      'profile',
      'capabilities',
      'model',
      'context',
      'outputContract',
      'createdAt',
    ],
    path,
    errors,
  );
  if (!record) return;

  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'accountId', path, errors, validateIdentifier);
  for (const key of ['workspaceId', 'projectId', 'chatId', 'parentRunId']) {
    validateOptionalField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'agent', path, errors, validateRequestAgentShape);
  validateRequiredField(record, 'surface', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, REQUEST_SURFACES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'interactionMode', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, INTERACTION_MODES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'responseModeHint', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, RESPONSE_MODES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'userText', path, errors, validateString);
  validateRequiredField(record, 'messageHistory', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateLlmMessage),
  );
  validateRequiredField(record, 'identity', path, errors, validateIdentityShape);
  validateRequiredField(record, 'profile', path, errors, validateProfileShape);
  validateRequiredField(record, 'capabilities', path, errors, validateCapabilitySnapshotShape);
  validateRequiredField(record, 'model', path, errors, validateModelSnapshotShape);
  validateRequiredField(record, 'context', path, errors, validateContextPackShape);
  validateRequiredField(record, 'outputContract', path, errors, validateOutputContractShape);
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
}

const SCHEDULE_SNAPSHOT_SECRET =
  /(?:authorization\s*:\s*bearer\s+\S+|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|cookie|client[_ -]?secret)\s*[:=]\s*\S+|\bjsecret_[A-Za-z0-9_-]+\b|BEGIN [A-Z ]*PRIVATE KEY)/i;

function containsScheduleSnapshotSecret(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return SCHEDULE_SNAPSHOT_SECRET.test(value);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsScheduleSnapshotSecret(entry, seen));
  }
  return Object.values(value).some((entry) => containsScheduleSnapshotSecret(entry, seen));
}

function validateScheduledRetrySnapshotShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['schemaVersion', 'accountId', 'eventId', 'occurrenceId', 'dueAt', 'logicalAttempt', 'request'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'accountId', path, errors, validateIdentifier);
  validateRequiredField(record, 'eventId', path, errors, validateIdentifier);
  validateRequiredField(record, 'occurrenceId', path, errors, (entry, entryPath, entryErrors) => {
    validateIdentifier(entry, entryPath, entryErrors);
    if (typeof entry === 'string' && !entry.startsWith('jocc_')) {
      addError(entryErrors, 'invalid_identifier', entryPath);
    }
  });
  validateRequiredField(record, 'dueAt', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'logicalAttempt', path, errors, validateNonNegativeInteger);
  const requestPath = childPath(path, 'request');
  const request = dataField(record, 'request');
  const requestRecord = validateClosedRecord(
    request,
    [
      'schemaVersion',
      'runId',
      'accountId',
      'workspaceId',
      'projectId',
      'chatId',
      'parentRunId',
      'agent',
      'surface',
      'interactionMode',
      'responseModeHint',
      'userText',
      'messageHistory',
      'identity',
      'profile',
      'capabilities',
      'model',
      'context',
      'outputContract',
    ],
    requestPath,
    errors,
  );
  if (!requestRecord) return;
  validateRequestEnvelopeShape(
    { ...requestRecord, requestId: 'snapshot-request', createdAt: 0 },
    requestPath,
    errors,
  );
  if (containsScheduleSnapshotSecret(requestRecord)) {
    addError(errors, 'invalid_type', requestPath);
  }
  if (dataField(requestRecord, 'surface') !== 'schedule') {
    addError(errors, 'invalid_type', childPath(requestPath, 'surface'));
  }
  requireEqualBinding(
    requestRecord,
    'accountId',
    dataField(record, 'accountId'),
    requestPath,
    errors,
  );
}

function validateHiveStackStepShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'stepId',
      'label',
      'workerId',
      'agent',
      'model',
      'messages',
      'workingDirectory',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  for (const key of ['stepId', 'label', 'workerId']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'agent', path, errors, (entry, entryPath, entryErrors) => {
    const agent = validateClosedRecord(
      entry,
      [
        'id',
        'slug',
        'builtin',
        'name',
        'description',
        'systemPrompt',
        'toolsAllowed',
        'memoryScope',
        'capabilities',
        'createdAt',
        'updatedAt',
      ],
      entryPath,
      entryErrors,
    );
    if (!agent) return;
    for (const key of ['id', 'slug', 'name', 'description']) {
      validateRequiredField(agent, key, entryPath, entryErrors, validateIdentifier);
    }
    validateRequiredField(agent, 'systemPrompt', entryPath, entryErrors, validateString);
    validateRequiredField(agent, 'builtin', entryPath, entryErrors, validateBoolean);
    validateRequiredField(agent, 'toolsAllowed', entryPath, entryErrors, validateStringArray);
    validateRequiredField(agent, 'capabilities', entryPath, entryErrors, validateStringArray);
    validateRequiredField(
      agent,
      'memoryScope',
      entryPath,
      entryErrors,
      (scope, scopePath, scopeErrors) =>
        validateEnum(scope, ['agent', 'project', 'workspace'] as const, scopePath, scopeErrors),
    );
    validateRequiredField(agent, 'createdAt', entryPath, entryErrors, validateFiniteNumber);
    validateRequiredField(agent, 'updatedAt', entryPath, entryErrors, validateFiniteNumber);
  });
  validateRequiredField(record, 'model', path, errors, validateModelSnapshotShape);
  validateRequiredField(record, 'messages', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateLlmMessage),
  );
  validateOptionalField(record, 'workingDirectory', path, errors, validateString);
  if (containsScheduleSnapshotSecret(record)) addError(errors, 'invalid_type', path);
}

function validateHiveStackPlanShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['schemaVersion', 'accountId', 'parentRunId', 'stackId', 'steps'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  for (const key of ['accountId', 'parentRunId', 'stackId']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'steps', path, errors, (entry, entryPath, entryErrors) => {
    validateArray(entry, entryPath, entryErrors, validateHiveStackStepShape);
    if (!Array.isArray(entry)) return;
    if (entry.length === 0 || entry.length > 16) addError(entryErrors, 'invalid_type', entryPath);
    const ids = new Set<string>();
    for (let index = 0; index < entry.length; index += 1) {
      const step = entry[index];
      if (!isRecordValue(step)) continue;
      const stepId = dataField(step, 'stepId');
      if (typeof stepId === 'string') {
        if (ids.has(stepId))
          addError(
            entryErrors,
            'invalid_identifier',
            childPath(childPath(entryPath, index), 'stepId'),
          );
        ids.add(stepId);
      }
    }
  });
  if (containsScheduleSnapshotSecret(record)) addError(errors, 'invalid_type', path);
}

function validateCompiledPromptLayerShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['id', 'authority', 'sourceRefs', 'content', 'contentHash', 'charCount', 'truncated'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'authority', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, PROMPT_AUTHORITIES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'sourceRefs', path, errors, validateSourceRefArray);
  validateRequiredField(record, 'content', path, errors, validateString);
  validateRequiredField(record, 'contentHash', path, errors, validateIdentifier);
  validateRequiredField(record, 'charCount', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'truncated', path, errors, validateBoolean);
}

function validatePromptDiagnosticsShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['totalChars', 'omittedSourceRefs', 'warnings'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'totalChars', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'omittedSourceRefs', path, errors, validateSourceRefArray);
  validateRequiredField(record, 'warnings', path, errors, validateStringArray);
}

function validateCompiledPromptShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'layers',
      'systemText',
      'providerPrompt',
      'promptHash',
      'identityVersion',
      'profileRevisionId',
      'diagnostics',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'layers', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateCompiledPromptLayerShape),
  );
  validateRequiredField(record, 'systemText', path, errors, validateString);
  validateOptionalField(record, 'providerPrompt', path, errors, validateString);
  validateRequiredField(record, 'promptHash', path, errors, validateIdentifier);
  validateRequiredField(record, 'identityVersion', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'profileRevisionId', path, errors, validateIdentifier);
  validateRequiredField(record, 'diagnostics', path, errors, validatePromptDiagnosticsShape);
}

function validateExecutionStateShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['status', 'verifiedBy', 'lastEventSeq'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'status', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, RUN_STATUSES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'verifiedBy', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, EXECUTION_VERIFIERS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'lastEventSeq', path, errors, validateSequence);
}

function validateResponsePart(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  validateRequiredField(record, 'kind', path, errors, validateString);
}

function validateEnforcementShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['linted', 'violations', 'repairAttempted', 'repairSucceeded', 'fallbackUsed'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'linted', path, errors, validateBoolean);
  validateRequiredField(record, 'violations', path, errors, validateStringArray);
  validateRequiredField(record, 'repairAttempted', path, errors, validateBoolean);
  validateRequiredField(record, 'repairSucceeded', path, errors, validateBoolean);
  validateRequiredField(record, 'fallbackUsed', path, errors, validateBoolean);
}

function validateResponseEnvelopeShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'requestId',
      'runId',
      'mode',
      'displayText',
      'spokenText',
      'parts',
      'artifactIds',
      'sourceRefs',
      'executionState',
      'provider',
      'enforcement',
      'completedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'mode', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, RESPONSE_MODES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'displayText', path, errors, validateString);
  validateOptionalField(record, 'spokenText', path, errors, validateString);
  validateRequiredField(record, 'parts', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateResponsePart),
  );
  validateRequiredField(record, 'artifactIds', path, errors, validateIdentifierArray);
  validateRequiredField(record, 'sourceRefs', path, errors, validateSourceRefArray);
  validateOptionalField(record, 'executionState', path, errors, validateExecutionStateShape);
  validateRequiredField(record, 'provider', path, errors, validateModelSnapshotShape);
  validateRequiredField(record, 'enforcement', path, errors, validateEnforcementShape);
  validateRequiredField(record, 'completedAt', path, errors, validateFiniteNumber);
}

function validatePreEffectTransportFailureShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'accountId',
      'runId',
      'requestId',
      'attemptNumber',
      'providerId',
      'modelId',
      'boundary',
      'responseStarted',
      'chunkCount',
      'actionDispatchCount',
      'failureCategory',
      'evidenceRef',
      'verifiedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  for (const key of [
    'accountId',
    'runId',
    'requestId',
    'providerId',
    'modelId',
    'failureCategory',
    'evidenceRef',
  ]) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'boundary', path, errors, (entry, entryPath, entryErrors) =>
    rejectUnlessEqual(entry, 'before_first_response_byte', entryPath, entryErrors),
  );
  validateRequiredField(record, 'responseStarted', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, false, entryPath, entryErrors),
  );
  for (const key of ['chunkCount', 'actionDispatchCount']) {
    validateRequiredField(record, key, path, errors, (entry, entryPath, entryErrors) =>
      validateLiteral(entry, 0, entryPath, entryErrors),
    );
  }
  validateRequiredField(record, 'verifiedAt', path, errors, validateFiniteNumber);
}

function validateZeroCountEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['count', 'evidenceRef'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'count', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 0, entryPath, entryErrors),
  );
  validateRequiredField(record, 'evidenceRef', path, errors, validateIdentifier);
}

function validateZeroEffectEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'accountId',
      'runId',
      'attemptNumber',
      'requestId',
      'assessedAt',
      'providerBoundary',
      'effectBarrier',
      'approvals',
      'artifacts',
      'executorClaims',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  for (const key of ['accountId', 'runId', 'requestId']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'assessedAt', path, errors, validateFiniteNumber);
  validateRequiredField(
    record,
    'providerBoundary',
    path,
    errors,
    validatePreEffectTransportFailureShape,
  );
  validateRequiredField(record, 'effectBarrier', path, errors, (entry, entryPath, entryErrors) => {
    const barrier = validateClosedRecord(entry, ['state', 'version'], entryPath, entryErrors);
    if (!barrier) return;
    validateRequiredField(
      barrier,
      'state',
      entryPath,
      entryErrors,
      (state, statePath, stateErrors) => rejectUnlessEqual(state, 'open', statePath, stateErrors),
    );
    validateRequiredField(
      barrier,
      'version',
      entryPath,
      entryErrors,
      (version, versionPath, versionErrors) =>
        validateLiteral(version, 0, versionPath, versionErrors),
    );
  });
  for (const key of ['approvals', 'artifacts']) {
    validateRequiredField(record, key, path, errors, validateZeroCountEvidenceShape);
  }
  validateRequiredField(record, 'executorClaims', path, errors, (entry, entryPath, entryErrors) => {
    const claims = validateClosedRecord(
      entry,
      ['count', 'throughSeq', 'evidenceRef'],
      entryPath,
      entryErrors,
    );
    if (!claims) return;
    validateRequiredField(
      claims,
      'count',
      entryPath,
      entryErrors,
      (count, countPath, countErrors) => validateLiteral(count, 0, countPath, countErrors),
    );
    validateRequiredField(claims, 'throughSeq', entryPath, entryErrors, validateSequence);
    validateRequiredField(claims, 'evidenceRef', entryPath, entryErrors, validateIdentifier);
  });
  const boundary = dataField(record, 'providerBoundary');
  if (isRecordValue(boundary)) {
    for (const key of ['accountId', 'runId', 'requestId', 'attemptNumber']) {
      requireEqualBinding(
        boundary,
        key,
        dataField(record, key),
        childPath(path, 'providerBoundary'),
        errors,
      );
    }
  }
}

function validateTransportBarrierShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['state', 'version', 'updatedAt'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, EFFECT_BARRIER_STATES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'version', path, errors, validateNonNegativeInteger);
  validateRequiredField(record, 'updatedAt', path, errors, validateFiniteNumber);
  const state = dataField(record, 'state');
  const version = dataField(record, 'version');
  if ((state === 'open' || state === 'sealed_for_retry') && version !== 0) {
    addError(errors, 'invalid_type', childPath(path, 'version'));
  }
  if (state === 'dirty' && (typeof version !== 'number' || version < 1)) {
    addError(errors, 'invalid_type', childPath(path, 'version'));
  }
}

function validateTransportAttemptShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'attemptNumber',
      'kind',
      'requestId',
      'state',
      'startedEventSeq',
      'effectBarrier',
      'createdAt',
      'updatedAt',
      'failureCategory',
      'zeroEffectEvidence',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, TRANSPORT_ATTEMPT_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, TRANSPORT_ATTEMPT_STATES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'startedEventSeq', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'effectBarrier', path, errors, validateTransportBarrierShape);
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'updatedAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'failureCategory', path, errors, validateIdentifier);
  validateOptionalField(
    record,
    'zeroEffectEvidence',
    path,
    errors,
    validateZeroEffectEvidenceShape,
  );

  const state = dataField(record, 'state');
  const failureCategory = dataField(record, 'failureCategory');
  const zeroEffectEvidence = dataField(record, 'zeroEffectEvidence');
  if (state === 'retryable_failed') {
    requireField(record, 'failureCategory', path, errors);
    requireField(record, 'zeroEffectEvidence', path, errors);
  } else if (state === 'effect_uncertain') {
    requireField(record, 'failureCategory', path, errors);
    if (hasOwn(record, 'zeroEffectEvidence')) {
      addError(errors, 'invalid_type', childPath(path, 'zeroEffectEvidence'));
    }
  } else {
    if (hasOwn(record, 'failureCategory')) {
      addError(errors, 'invalid_type', childPath(path, 'failureCategory'));
    }
    if (hasOwn(record, 'zeroEffectEvidence')) {
      addError(errors, 'invalid_type', childPath(path, 'zeroEffectEvidence'));
    }
  }
  if (isRecordValue(zeroEffectEvidence)) {
    for (const key of ['requestId', 'attemptNumber']) {
      requireEqualBinding(
        zeroEffectEvidence,
        key,
        dataField(record, key),
        childPath(path, 'zeroEffectEvidence'),
        errors,
      );
    }
    const boundary = dataField(zeroEffectEvidence, 'providerBoundary');
    if (isRecordValue(boundary)) {
      requireEqualBinding(
        boundary,
        'failureCategory',
        failureCategory,
        childPath(childPath(path, 'zeroEffectEvidence'), 'providerBoundary'),
        errors,
      );
    }
  }
}

function validateTransportAttemptArray(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  validateArray(value, path, errors, validateTransportAttemptShape);
  if (!Array.isArray(value)) return;
  if (value.length > 32) addError(errors, 'invalid_type', path);
  const requestIds = new Set<string>();
  value.forEach((attempt, index) => {
    if (!isRecordValue(attempt)) return;
    const attemptPath = childPath(path, index);
    if (dataField(attempt, 'attemptNumber') !== index + 1) {
      addError(errors, 'invalid_type', childPath(attemptPath, 'attemptNumber'));
    }
    const expectedKind = index === 0 ? 'initial' : 'transport_retry';
    if (dataField(attempt, 'kind') !== expectedKind) {
      addError(errors, 'invalid_type', childPath(attemptPath, 'kind'));
    }
    const requestId = dataField(attempt, 'requestId');
    if (typeof requestId === 'string') {
      if (requestIds.has(requestId)) {
        addError(errors, 'invalid_identifier', childPath(attemptPath, 'requestId'));
      }
      requestIds.add(requestId);
    }
    if (index < value.length - 1 && dataField(attempt, 'state') === 'retryable_failed') {
      const barrier = dataField(attempt, 'effectBarrier');
      if (!isRecordValue(barrier) || dataField(barrier, 'state') !== 'sealed_for_retry') {
        addError(errors, 'invalid_type', childPath(attemptPath, 'effectBarrier'));
      }
    }
  });
}

function validateExecutionEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'requestId',
      'attemptNumber',
      'kind',
      'ownerKind',
      'ownerId',
      'evidenceRef',
      'observedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, EXECUTION_EVIDENCE_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'ownerKind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, EXECUTION_OWNER_KINDS, entryPath, entryErrors),
  );
  for (const key of ['ownerId', 'evidenceRef']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'observedAt', path, errors, validateFiniteNumber);
}

function validateCanonicalResultEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'kind',
      'accountId',
      'runId',
      'requestId',
      'attemptNumber',
      'parentRunId',
      'stepId',
      'state',
      'resultRef',
      'observedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, CANONICAL_RESULT_KINDS, entryPath, entryErrors),
  );
  for (const key of ['accountId', 'runId', 'requestId']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateOptionalField(record, 'parentRunId', path, errors, validateIdentifier);
  validateOptionalField(record, 'stepId', path, errors, validateIdentifier);
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, TERMINAL_EVIDENCE_STATES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'resultRef', path, errors, (entry, entryPath, entryErrors) =>
    validatePrefixedIdentifier(entry, 'jresult_', entryPath, entryErrors),
  );
  validateRequiredField(record, 'observedAt', path, errors, validateFiniteNumber);
  if (dataField(record, 'kind') === 'hive_child_provider_result') {
    requireField(record, 'parentRunId', path, errors);
    requireField(record, 'stepId', path, errors);
  }
}

const PRODUCER_IDENTITY_KEYS: Record<(typeof LIVE_PRODUCER_KINDS)[number], readonly string[]> = {
  provider: ['producerKind', 'providerId', 'modelId', 'modelSnapshotRef'],
  action: ['producerKind', 'actionId', 'actionVersion', 'executionId'],
  file_action: ['producerKind', 'actionId', 'actionVersion', 'resultId'],
  terminal: ['producerKind', 'sessionId', 'executionId'],
  plugin: ['producerKind', 'pluginId', 'invocationId'],
  mcp: ['producerKind', 'serverId', 'toolName', 'invocationId'],
  schedule: ['producerKind', 'eventId', 'occurrenceId'],
  voice: ['producerKind', 'sessionId', 'engineKind', 'executionId'],
  hive: ['producerKind', 'stackId', 'stepId', 'workerId'],
};

function validateLiveProducerIdentityShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  const rawKind = dataField(record, 'producerKind');
  const kind =
    typeof rawKind === 'string' && LIVE_PRODUCER_KINDS.includes(rawKind as never)
      ? (rawKind as (typeof LIVE_PRODUCER_KINDS)[number])
      : undefined;
  validateUnknownKeys(
    record,
    kind ? PRODUCER_IDENTITY_KEYS[kind] : Object.values(PRODUCER_IDENTITY_KEYS).flat(),
    path,
    errors,
  );
  validateRequiredField(record, 'producerKind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, LIVE_PRODUCER_KINDS, entryPath, entryErrors),
  );
  if (!kind) return;
  for (const key of PRODUCER_IDENTITY_KEYS[kind].slice(1)) {
    const validator: ValueValidator =
      key === 'actionVersion'
        ? validatePositiveInteger
        : key === 'engineKind'
          ? (entry, entryPath, entryErrors) =>
              validateEnum(entry, ['tts', 'playback'], entryPath, entryErrors)
          : validateIdentifier;
    validateRequiredField(record, key, path, errors, validator);
  }
}

function validateResultAuthorityShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['runId', 'eventSeq', 'evidenceRef'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'eventSeq', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'evidenceRef', path, errors, (entry, entryPath, entryErrors) =>
    validatePrefixedIdentifier(entry, 'jresult_', entryPath, entryErrors),
  );
}

function validateProducerSourceEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  const phase = dataField(record, 'phase');
  validateUnknownKeys(
    record,
    [
      'schemaVersion',
      'accountId',
      'runId',
      'requestId',
      'attemptNumber',
      'producerKind',
      'producerIdentity',
      'resultRef',
      'observedAt',
      'phase',
      'state',
      ...(phase === 'result' ? ['resultAuthority'] : []),
    ],
    path,
    errors,
  );
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  for (const key of ['accountId', 'runId', 'requestId', 'resultRef']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'producerKind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, LIVE_PRODUCER_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(
    record,
    'producerIdentity',
    path,
    errors,
    validateLiveProducerIdentityShape,
  );
  validateRequiredField(record, 'observedAt', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'phase', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ['start', 'result'], entryPath, entryErrors),
  );
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(
      entry,
      phase === 'result' ? TERMINAL_EVIDENCE_STATES : ['started', 'ready', 'busy'],
      entryPath,
      entryErrors,
    ),
  );
  if (phase === 'result') {
    validateOptionalField(record, 'resultAuthority', path, errors, validateResultAuthorityShape);
  }
  const producerKind = dataField(record, 'producerKind');
  const identity = dataField(record, 'producerIdentity');
  if (isRecordValue(identity)) {
    requireEqualBinding(
      identity,
      'producerKind',
      producerKind,
      childPath(path, 'producerIdentity'),
      errors,
    );
  }
  if (phase === 'result' && (producerKind === 'schedule' || producerKind === 'hive')) {
    requireField(record, 'resultAuthority', path, errors);
  }
}

function validateDurableLiveEvidenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateRecord(value, path, errors);
  if (!record) return;
  const kind = dataField(record, 'kind');
  const commonKeys = [
    'schemaVersion',
    'kind',
    'accountId',
    'runId',
    'requestId',
    'attemptNumber',
    'registrationId',
    'producerKind',
    'producerIdentity',
    'transition',
    'operations',
    'resultRef',
    'resultEventSeq',
    'observedAt',
    'previousProofRef',
  ];
  validateUnknownKeys(
    record,
    [
      ...commonKeys,
      ...(kind === 'model'
        ? ['providerId', 'modelId', 'modelSnapshotRef']
        : kind === 'capability'
          ? ['category', 'capabilityId']
          : []),
    ],
    path,
    errors,
  );
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ['model', 'capability'], entryPath, entryErrors),
  );
  for (const key of ['accountId', 'runId', 'requestId', 'registrationId', 'resultRef']) {
    validateRequiredField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'producerKind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, LIVE_PRODUCER_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(
    record,
    'producerIdentity',
    path,
    errors,
    validateLiveProducerIdentityShape,
  );
  validateRequiredField(record, 'transition', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, LIVE_TRANSITIONS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'resultEventSeq', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'observedAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'previousProofRef', path, errors, (entry, entryPath, entryErrors) =>
    validatePrefixedIdentifier(entry, 'jlive_', entryPath, entryErrors),
  );
  const producerKind = dataField(record, 'producerKind');
  const identity = dataField(record, 'producerIdentity');
  if (isRecordValue(identity)) {
    requireEqualBinding(
      identity,
      'producerKind',
      producerKind,
      childPath(path, 'producerIdentity'),
      errors,
    );
  }
  if (kind === 'model') {
    validateRequiredField(record, 'operations', path, errors, (entry, entryPath, entryErrors) =>
      validateClosedOperationArray(entry, MODEL_LIVE_OPERATIONS, entryPath, entryErrors),
    );
    rejectUnlessEqual(producerKind, 'provider', childPath(path, 'producerKind'), errors);
    for (const key of ['providerId', 'modelId', 'modelSnapshotRef']) {
      validateRequiredField(record, key, path, errors, validateIdentifier);
      if (isRecordValue(identity)) {
        rejectUnlessEqual(
          dataField(record, key),
          dataField(identity, key),
          childPath(path, key),
          errors,
        );
      }
    }
  } else if (kind === 'capability') {
    validateRequiredField(record, 'operations', path, errors, (entry, entryPath, entryErrors) =>
      validateClosedOperationArray(entry, CAPABILITY_LIVE_OPERATIONS, entryPath, entryErrors),
    );
    validateRequiredField(record, 'category', path, errors, (entry, entryPath, entryErrors) =>
      validateEnum(entry, LIVE_CAPABILITY_CATEGORIES, entryPath, entryErrors),
    );
    validateRequiredField(record, 'capabilityId', path, errors, validateIdentifier);
    if (producerKind === 'provider')
      addError(errors, 'invalid_type', childPath(path, 'producerKind'));
  } else {
    validateRequiredField(record, 'operations', path, errors, validateStringArray);
  }
}

function validateRunShape(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  const record = validateClosedRecord(
    value,
    [
      'id',
      'accountId',
      'workspaceId',
      'projectId',
      'chatId',
      'parentRunId',
      'source',
      'status',
      'agentId',
      'identityVersion',
      'profileRevisionId',
      'model',
      'createdAt',
      'updatedAt',
      'completedAt',
      'scheduledRetrySnapshot',
      'hiveStackPlan',
      'transportAttempts',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'accountId', path, errors, validateIdentifier);
  for (const key of ['workspaceId', 'projectId', 'chatId', 'parentRunId']) {
    validateOptionalField(record, key, path, errors, validateIdentifier);
  }
  validateRequiredField(record, 'source', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, REQUEST_SURFACES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'status', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, RUN_STATUSES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'agentId', path, errors, validateIdentifier);
  validateRequiredField(record, 'identityVersion', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'profileRevisionId', path, errors, validateIdentifier);
  validateRequiredField(record, 'model', path, errors, validateModelSnapshotShape);
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
  validateRequiredField(record, 'updatedAt', path, errors, validateFiniteNumber);
  if (dataField(record, 'completedAt') !== undefined) {
    validateRequiredField(record, 'completedAt', path, errors, validateFiniteNumber);
  }
  validateOptionalField(
    record,
    'scheduledRetrySnapshot',
    path,
    errors,
    validateScheduledRetrySnapshotShape,
  );
  const snapshot = dataField(record, 'scheduledRetrySnapshot');
  if (isRecordValue(snapshot)) {
    if (dataField(record, 'source') !== 'schedule') {
      addError(errors, 'invalid_type', childPath(path, 'source'));
    }
    requireEqualBinding(
      snapshot,
      'accountId',
      dataField(record, 'accountId'),
      childPath(path, 'scheduledRetrySnapshot'),
      errors,
    );
    const request = dataField(snapshot, 'request');
    if (isRecordValue(request)) {
      requireEqualBinding(
        request,
        'runId',
        dataField(record, 'id'),
        childPath(childPath(path, 'scheduledRetrySnapshot'), 'request'),
        errors,
      );
    }
  }
  validateOptionalField(record, 'hiveStackPlan', path, errors, validateHiveStackPlanShape);
  const hivePlan = dataField(record, 'hiveStackPlan');
  if (isRecordValue(hivePlan)) {
    if (dataField(record, 'source') !== 'hive_final') {
      addError(errors, 'invalid_type', childPath(path, 'source'));
    }
    requireEqualBinding(
      hivePlan,
      'accountId',
      dataField(record, 'accountId'),
      childPath(path, 'hiveStackPlan'),
      errors,
    );
    requireEqualBinding(
      hivePlan,
      'parentRunId',
      dataField(record, 'id'),
      childPath(path, 'hiveStackPlan'),
      errors,
    );
  }
  validateOptionalField(record, 'transportAttempts', path, errors, validateTransportAttemptArray);
  const attempts = dataField(record, 'transportAttempts');
  if (Array.isArray(attempts) && attempts.length > 0) {
    if (dataField(record, 'source') !== 'schedule')
      addError(errors, 'invalid_type', childPath(path, 'source'));
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      if (!isRecordValue(attempt)) continue;
      const proof = dataField(attempt, 'zeroEffectEvidence');
      if (!isRecordValue(proof)) continue;
      const proofPath = childPath(childPath(path, 'transportAttempts'), index);
      requireEqualBinding(proof, 'accountId', dataField(record, 'accountId'), proofPath, errors);
      requireEqualBinding(proof, 'runId', dataField(record, 'id'), proofPath, errors);
      const boundary = dataField(proof, 'providerBoundary');
      const model = dataField(record, 'model');
      if (isRecordValue(boundary) && isRecordValue(model)) {
        requireEqualBinding(
          boundary,
          'providerId',
          dataField(model, 'providerId'),
          childPath(proofPath, 'zeroEffectEvidence'),
          errors,
        );
        requireEqualBinding(
          boundary,
          'modelId',
          dataField(model, 'modelId'),
          childPath(proofPath, 'zeroEffectEvidence'),
          errors,
        );
      }
    }
  }
}

function validateEventShape(value: unknown, path: ValidationPath, errors: ValidationErrors): void {
  const record = validateClosedRecord(
    value,
    [
      'runId',
      'seq',
      'idempotencyKey',
      'type',
      'status',
      'title',
      'safeSummary',
      'sourceRefs',
      'artifactIds',
      'createdAt',
      'executionEvidence',
      'canonicalResultEvidence',
      'producerSourceEvidence',
      'liveEvidence',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'seq', path, errors, validateSequence);
  validateRequiredField(record, 'idempotencyKey', path, errors, validateIdentifier);
  validateRequiredField(record, 'type', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, EVENT_TYPES, entryPath, entryErrors),
  );
  validateOptionalField(record, 'status', path, errors, validateString);
  validateRequiredField(record, 'title', path, errors, validateString);
  validateOptionalField(record, 'safeSummary', path, errors, validateString);
  validateRequiredField(record, 'sourceRefs', path, errors, validateSourceRefArray);
  validateRequiredField(record, 'artifactIds', path, errors, validateIdentifierArray);
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'executionEvidence', path, errors, validateExecutionEvidenceShape);
  validateOptionalField(
    record,
    'canonicalResultEvidence',
    path,
    errors,
    validateCanonicalResultEvidenceShape,
  );
  validateOptionalField(
    record,
    'producerSourceEvidence',
    path,
    errors,
    validateProducerSourceEvidenceShape,
  );
  validateOptionalField(record, 'liveEvidence', path, errors, validateDurableLiveEvidenceShape);
  const runId = dataField(record, 'runId');
  const seq = dataField(record, 'seq');
  for (const key of ['canonicalResultEvidence', 'producerSourceEvidence', 'liveEvidence']) {
    const evidence = dataField(record, key);
    if (isRecordValue(evidence))
      requireEqualBinding(evidence, 'runId', runId, childPath(path, key), errors);
  }
  const sourceEvidence = dataField(record, 'producerSourceEvidence');
  if (isRecordValue(sourceEvidence)) {
    const authority = dataField(sourceEvidence, 'resultAuthority');
    if (isRecordValue(authority)) {
      const authoritySeq = dataField(authority, 'eventSeq');
      if (typeof seq === 'number' && (typeof authoritySeq !== 'number' || authoritySeq >= seq)) {
        addError(
          errors,
          'invalid_type',
          childPath(childPath(path, 'producerSourceEvidence'), 'resultAuthority'),
        );
      }
    }
  }
  const liveEvidence = dataField(record, 'liveEvidence');
  if (isRecordValue(liveEvidence)) {
    const resultEventSeq = dataField(liveEvidence, 'resultEventSeq');
    if (typeof seq === 'number' && (typeof resultEventSeq !== 'number' || resultEventSeq >= seq)) {
      addError(
        errors,
        'invalid_type',
        childPath(childPath(path, 'liveEvidence'), 'resultEventSeq'),
      );
    }
  }
  if (hasOwn(record, 'producerSourceEvidence') && hasOwn(record, 'liveEvidence')) {
    addError(errors, 'invalid_type', childPath(path, 'liveEvidence'));
  }
  let firstAttemptBinding: RecordValue | undefined;
  for (const key of [
    'executionEvidence',
    'canonicalResultEvidence',
    'producerSourceEvidence',
    'liveEvidence',
  ]) {
    const evidence = dataField(record, key);
    if (!isRecordValue(evidence)) continue;
    if (!firstAttemptBinding) {
      firstAttemptBinding = evidence;
      continue;
    }
    for (const bindingKey of ['requestId', 'attemptNumber']) {
      if (dataField(evidence, bindingKey) !== dataField(firstAttemptBinding, bindingKey)) {
        addError(errors, 'invalid_type', childPath(childPath(path, key), bindingKey));
      }
    }
  }
}

function validateSecretHandleShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['field', 'handleId'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'field', path, errors, validateIdentifier);
  validateRequiredField(record, 'handleId', path, errors, validateIdentifier);
}

function validateApprovalShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'id',
      'runId',
      'requestId',
      'attemptNumber',
      'actionId',
      'actionVersion',
      'capabilityId',
      'capabilitySnapshotHash',
      'expectedEffect',
      'expiresAt',
      'params',
      'secretHandleRefs',
      'paramsHash',
      'targetSnapshot',
      'risk',
      'status',
      'createdAt',
      'decidedAt',
      'consumedAt',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'actionId', path, errors, validateIdentifier);
  validateRequiredField(record, 'actionVersion', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'capabilityId', path, errors, validateIdentifier);
  validateRequiredField(record, 'capabilitySnapshotHash', path, errors, validateIdentifier);
  validateRequiredField(record, 'expectedEffect', path, errors, validateIdentifier);
  validateRequiredField(record, 'expiresAt', path, errors, validateFiniteNumber);
  requireField(record, 'params', path, errors);
  validateOptionalField(record, 'secretHandleRefs', path, errors, (entry, entryPath, entryErrors) =>
    validateArray(entry, entryPath, entryErrors, validateSecretHandleShape),
  );
  validateRequiredField(record, 'paramsHash', path, errors, validateIdentifier);
  validateRequiredField(record, 'risk', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, APPROVAL_RISKS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'status', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, APPROVAL_STATUSES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'decidedAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'consumedAt', path, errors, validateFiniteNumber);
}

function validateArtifactPreviewShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    ['kind', 'text', 'truncated', 'sizeBytes'],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ARTIFACT_PREVIEW_KINDS, entryPath, entryErrors),
  );
  validateOptionalField(record, 'text', path, errors, validateString);
  validateRequiredField(record, 'truncated', path, errors, validateBoolean);
  validateRequiredField(record, 'sizeBytes', path, errors, validateNonNegativeInteger);
}

function validateArtifactLocalReferenceShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(value, ['kind', 'value'], path, errors);
  if (!record) return;
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ARTIFACT_LOCAL_REFERENCE_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'value', path, errors, validateIdentifier);
}

function validateArtifactShape(
  value: unknown,
  path: ValidationPath,
  errors: ValidationErrors,
): void {
  const record = validateClosedRecord(
    value,
    [
      'schemaVersion',
      'id',
      'runId',
      'requestId',
      'attemptNumber',
      'state',
      'kind',
      'title',
      'uri',
      'mimeType',
      'safeSummary',
      'sourceRefs',
      'createdAt',
      'contentHash',
      'sizeBytes',
      'preview',
      'localReference',
    ],
    path,
    errors,
  );
  if (!record) return;
  validateRequiredField(record, 'schemaVersion', path, errors, (entry, entryPath, entryErrors) =>
    validateLiteral(entry, 1, entryPath, entryErrors),
  );
  validateRequiredField(record, 'id', path, errors, validateIdentifier);
  validateRequiredField(record, 'runId', path, errors, validateIdentifier);
  validateRequiredField(record, 'requestId', path, errors, validateIdentifier);
  validateRequiredField(record, 'attemptNumber', path, errors, validatePositiveInteger);
  validateRequiredField(record, 'state', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ARTIFACT_STATES, entryPath, entryErrors),
  );
  validateRequiredField(record, 'kind', path, errors, (entry, entryPath, entryErrors) =>
    validateEnum(entry, ARTIFACT_KINDS, entryPath, entryErrors),
  );
  validateRequiredField(record, 'title', path, errors, validateString);
  validateOptionalField(record, 'uri', path, errors, validateString);
  validateOptionalField(record, 'mimeType', path, errors, validateString);
  validateOptionalField(record, 'safeSummary', path, errors, validateString);
  validateRequiredField(record, 'sourceRefs', path, errors, validateSourceRefArray);
  validateRequiredField(record, 'createdAt', path, errors, validateFiniteNumber);
  validateOptionalField(record, 'contentHash', path, errors, validateIdentifier);
  validateOptionalField(record, 'sizeBytes', path, errors, validateNonNegativeInteger);
  validateOptionalField(record, 'preview', path, errors, validateArtifactPreviewShape);
  validateOptionalField(
    record,
    'localReference',
    path,
    errors,
    validateArtifactLocalReferenceShape,
  );
}

function validateContract<T>(
  input: unknown,
  shapeValidator: ValueValidator,
): JarvisContractValidationResult<T> {
  const errors: ValidationErrors = [];
  try {
    shapeValidator(input, [], errors);
  } catch {
    addError(errors, 'non_json_safe', []);
  }

  try {
    validateJsonSafety(input, [], errors, new WeakSet<object>());
  } catch {
    addError(errors, 'non_json_safe', []);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as T };
}

export function validateJarvisRequestEnvelope(
  input: unknown,
): JarvisContractValidationResult<JarvisRequestEnvelope> {
  return validateContract(input, validateRequestEnvelopeShape);
}

export function validateCompiledJarvisPrompt(
  input: unknown,
): JarvisContractValidationResult<CompiledJarvisPrompt> {
  return validateContract(input, validateCompiledPromptShape);
}

export function validateJarvisSourceRef(
  input: unknown,
): JarvisContractValidationResult<JarvisSourceRef> {
  return validateContract(input, validateSourceRefShape);
}

export function validateJarvisContextPack(
  input: unknown,
): JarvisContractValidationResult<JarvisContextPack> {
  return validateContract(input, validateContextPackShape);
}

export function validateJarvisCapabilitySnapshot(
  input: unknown,
): JarvisContractValidationResult<JarvisCapabilitySnapshot> {
  return validateContract(input, validateCapabilitySnapshotShape);
}

export function validateJarvisModelSnapshot(
  input: unknown,
): JarvisContractValidationResult<JarvisModelSnapshot> {
  return validateContract(input, validateModelSnapshotShape);
}

export function validateJarvisResponseEnvelope(
  input: unknown,
): JarvisContractValidationResult<JarvisResponseEnvelope> {
  return validateContract(input, validateResponseEnvelopeShape);
}

export function validateJarvisRun(input: unknown): JarvisContractValidationResult<JarvisRun> {
  return validateContract(input, validateRunShape);
}

export function validateJarvisEvent(input: unknown): JarvisContractValidationResult<JarvisEvent> {
  return validateContract(input, validateEventShape);
}

export function validateJarvisPreEffectTransportFailureEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisPreEffectTransportFailureEvidence> {
  return validateContract(input, validatePreEffectTransportFailureShape);
}

export function validateJarvisZeroConsequentialEffectEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisZeroConsequentialEffectEvidenceV1> {
  return validateContract(input, validateZeroEffectEvidenceShape);
}

export function validateJarvisTransportAttempt(
  input: unknown,
): JarvisContractValidationResult<JarvisTransportAttemptV1> {
  return validateContract(input, validateTransportAttemptShape);
}

export function validateJarvisExecutionEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisExecutionEvidenceV1> {
  return validateContract(input, validateExecutionEvidenceShape);
}

export function validateJarvisCanonicalResultEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisCanonicalResultEvidenceV1> {
  return validateContract(input, validateCanonicalResultEvidenceShape);
}

export function validateJarvisProducerSourceEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisProducerSourceEvidenceV1> {
  return validateContract(input, validateProducerSourceEvidenceShape);
}

export function validateJarvisDurableLiveEvidence(
  input: unknown,
): JarvisContractValidationResult<JarvisDurableLiveEvidenceV1> {
  return validateContract(input, validateDurableLiveEvidenceShape);
}

export function validateJarvisApproval(
  input: unknown,
): JarvisContractValidationResult<JarvisApprovalV1> {
  return validateContract(input, validateApprovalShape);
}

export function validateJarvisArtifact(
  input: unknown,
): JarvisContractValidationResult<JarvisArtifactV1> {
  return validateContract(input, validateArtifactShape);
}
