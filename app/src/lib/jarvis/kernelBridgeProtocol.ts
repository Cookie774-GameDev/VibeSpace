export const KERNEL_BRIDGE_VERSION = 1 as const;
export const KERNEL_HOST_REQUEST_EVENT = 'jarvis:kernel-host-request-v1';
export const KERNEL_CLIENT_RESPONSE_EVENT = 'jarvis:kernel-client-response-v1';

export type KernelClientRequestV1 =
  | Readonly<{
      version: 1;
      kind: 'turn_dispatch';
      accountId: string;
      chatId: string;
      userMessageId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_create';
      accountId: string;
      runId: string;
      actionRequestId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_present';
      accountId: string;
      approvalId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_status';
      accountId: string;
      approvalId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_decide';
      accountId: string;
      approvalId: string;
      decision: 'approve' | 'deny';
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_execute';
      accountId: string;
      approvalId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'cancel';
      accountId: string;
      runId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'scheduled_retry';
      accountId: string;
      runId: string;
      attemptId: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'command_center_snapshot';
      accountId: string;
    }>;

export type KernelClientRequestKind = KernelClientRequestV1['kind'];

export type KernelUnavailableReason =
  | 'host_unavailable'
  | 'host_released'
  | 'request_timed_out'
  | 'client_disposed'
  | 'invalid_response'
  | 'kernel_not_activated';

export type KernelClientResponseV1 =
  | Readonly<{ version: 1; kind: 'turn_accepted'; runId: string }>
  | Readonly<{ version: 1; kind: 'approval_created'; approvalId: string }>
  | Readonly<{
      version: 1;
      kind: 'approval_presentation';
      approvalId: string;
      actionId: string;
      expectedEffect: string;
      risk: 'safe' | 'confirm' | 'dangerous';
      parameters: readonly Readonly<{ field: string; safeValue: string }>[];
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_decided';
      approvalId: string;
      status: 'approved' | 'denied';
      continuation?: 'tool_request';
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_state';
      accountId: string;
      approvalId: string;
      status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
    }>
  | Readonly<{
      version: 1;
      kind: 'approval_execution';
      approvalId: string;
      runId: string;
      status: 'queued' | 'running' | 'completed' | 'failed';
      continuation: 'ready' | 'waiting';
    }>
  | Readonly<{
      version: 1;
      kind: 'cancellation_state';
      runId: string;
      state: 'delivered' | 'handoff_pending' | 'not_found';
    }>
  | Readonly<{
      version: 1;
      kind: 'retry_state';
      runId: string;
      state: 'queued' | 'rejected';
    }>
  | Readonly<{
      version: 1;
      kind: 'command_center_snapshot';
      accountId: string;
      runs: readonly Readonly<{
        runId: string;
        status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
        hasActiveEvidence: boolean;
      }>[];
    }>
  | Readonly<{
      version: 1;
      kind: 'unavailable';
      requestKind: KernelClientRequestKind;
      reason: KernelUnavailableReason;
    }>;

export interface KernelHostRequestEvent {
  epoch: number;
  requestId: string;
  request: KernelClientRequestV1;
}

export interface KernelClientResponseEvent {
  epoch: number;
  requestId: string;
  response: KernelClientResponseV1;
}

export interface KernelClientRequestRegistration {
  epoch: number;
  requestId: string;
  deadlineMs: number;
}

type DataRecord = Readonly<Record<string, unknown>>;

function dataRecord(value: unknown): DataRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function exactKeys(record: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function epoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isKernelClientRequestV1(value: unknown): value is KernelClientRequestV1 {
  const record = dataRecord(value);
  if (!record || record.version !== KERNEL_BRIDGE_VERSION || typeof record.kind !== 'string') {
    return false;
  }
  switch (record.kind) {
    case 'turn_dispatch':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'chatId', 'userMessageId']) &&
        id(record.accountId) &&
        id(record.chatId) &&
        id(record.userMessageId)
      );
    case 'approval_create':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'runId', 'actionRequestId']) &&
        id(record.accountId) &&
        id(record.runId) &&
        id(record.actionRequestId)
      );
    case 'approval_present':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'approvalId']) &&
        id(record.accountId) &&
        id(record.approvalId)
      );
    case 'approval_status':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'approvalId']) &&
        id(record.accountId) &&
        id(record.approvalId)
      );
    case 'approval_decide':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'approvalId', 'decision']) &&
        id(record.accountId) &&
        id(record.approvalId) &&
        (record.decision === 'approve' || record.decision === 'deny')
      );
    case 'approval_execute':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'approvalId']) &&
        id(record.accountId) &&
        id(record.approvalId)
      );
    case 'cancel':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'runId']) &&
        id(record.accountId) &&
        id(record.runId)
      );
    case 'scheduled_retry':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'runId', 'attemptId']) &&
        id(record.accountId) &&
        id(record.runId) &&
        id(record.attemptId)
      );
    case 'command_center_snapshot':
      return exactKeys(record, ['version', 'kind', 'accountId']) && id(record.accountId);
    default:
      return false;
  }
}

const REQUEST_KINDS = new Set<KernelClientRequestKind>([
  'turn_dispatch',
  'approval_create',
  'approval_present',
  'approval_status',
  'approval_decide',
  'approval_execute',
  'cancel',
  'scheduled_retry',
  'command_center_snapshot',
]);

const UNAVAILABLE_REASONS = new Set<KernelUnavailableReason>([
  'host_unavailable',
  'host_released',
  'request_timed_out',
  'client_disposed',
  'invalid_response',
  'kernel_not_activated',
]);

function isRunSummary(value: unknown): boolean {
  const record = dataRecord(value);
  return Boolean(
    record &&
    exactKeys(record, ['runId', 'status', 'hasActiveEvidence']) &&
    id(record.runId) &&
    typeof record.status === 'string' &&
    ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'].includes(record.status) &&
    typeof record.hasActiveEvidence === 'boolean',
  );
}

function isApprovalPresentationParameter(value: unknown): boolean {
  const record = dataRecord(value);
  return Boolean(
    record &&
    exactKeys(record, ['field', 'safeValue']) &&
    typeof record.field === 'string' &&
    record.field.length > 0 &&
    record.field.length <= 128 &&
    typeof record.safeValue === 'string' &&
    record.safeValue.length <= 160,
  );
}

export function isKernelClientResponseV1(value: unknown): value is KernelClientResponseV1 {
  const record = dataRecord(value);
  if (!record || record.version !== KERNEL_BRIDGE_VERSION || typeof record.kind !== 'string') {
    return false;
  }
  switch (record.kind) {
    case 'turn_accepted':
      return exactKeys(record, ['version', 'kind', 'runId']) && id(record.runId);
    case 'approval_created':
      return exactKeys(record, ['version', 'kind', 'approvalId']) && id(record.approvalId);
    case 'approval_presentation':
      return (
        exactKeys(record, [
          'version',
          'kind',
          'approvalId',
          'actionId',
          'expectedEffect',
          'risk',
          'parameters',
        ]) &&
        id(record.approvalId) &&
        typeof record.actionId === 'string' &&
        record.actionId.length > 0 &&
        record.actionId.length <= 128 &&
        typeof record.expectedEffect === 'string' &&
        record.expectedEffect.length > 0 &&
        record.expectedEffect.length <= 512 &&
        (record.risk === 'safe' || record.risk === 'confirm' || record.risk === 'dangerous') &&
        Array.isArray(record.parameters) &&
        record.parameters.length <= 32 &&
        record.parameters.every(isApprovalPresentationParameter)
      );
    case 'approval_decided':
      return (
        exactKeys(record, ['version', 'kind', 'approvalId', 'status', ...(record.continuation === undefined ? [] : ['continuation'])]) &&
        id(record.approvalId) &&
        (record.continuation === undefined || record.continuation === 'tool_request') &&
        (record.status === 'approved' || record.status === 'denied')
      );
    case 'approval_state':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'approvalId', 'status']) &&
        id(record.accountId) &&
        id(record.approvalId) &&
        typeof record.status === 'string' &&
        ['pending', 'approved', 'denied', 'expired', 'consumed'].includes(record.status)
      );
    case 'approval_execution':
      return (
        exactKeys(record, [
          'version',
          'kind',
          'approvalId',
          'runId',
          'status',
          'continuation',
        ]) &&
        id(record.approvalId) &&
        id(record.runId) &&
        typeof record.status === 'string' &&
        ['queued', 'running', 'completed', 'failed'].includes(record.status) &&
        (record.continuation === 'ready' || record.continuation === 'waiting')
      );
    case 'cancellation_state':
      return (
        exactKeys(record, ['version', 'kind', 'runId', 'state']) &&
        id(record.runId) &&
        typeof record.state === 'string' &&
        ['delivered', 'handoff_pending', 'not_found'].includes(record.state)
      );
    case 'retry_state':
      return (
        exactKeys(record, ['version', 'kind', 'runId', 'state']) &&
        id(record.runId) &&
        (record.state === 'queued' || record.state === 'rejected')
      );
    case 'command_center_snapshot':
      return (
        exactKeys(record, ['version', 'kind', 'accountId', 'runs']) &&
        id(record.accountId) &&
        Array.isArray(record.runs) &&
        record.runs.length <= 1_000 &&
        record.runs.every(isRunSummary)
      );
    case 'unavailable':
      return (
        exactKeys(record, ['version', 'kind', 'requestKind', 'reason']) &&
        REQUEST_KINDS.has(record.requestKind as KernelClientRequestKind) &&
        UNAVAILABLE_REASONS.has(record.reason as KernelUnavailableReason)
      );
    default:
      return false;
  }
}

export function unavailableKernelResponse(
  request: Pick<KernelClientRequestV1, 'kind'>,
  reason: KernelUnavailableReason,
): Extract<KernelClientResponseV1, { kind: 'unavailable' }> {
  return Object.freeze({
    version: KERNEL_BRIDGE_VERSION,
    kind: 'unavailable',
    requestKind: request.kind,
    reason,
  });
}

const RESPONSE_FOR_REQUEST: Readonly<
  Record<KernelClientRequestKind, KernelClientResponseV1['kind']>
> = Object.freeze({
  turn_dispatch: 'turn_accepted',
  approval_create: 'approval_created',
  approval_present: 'approval_presentation',
  approval_status: 'approval_state',
  approval_decide: 'approval_decided',
  approval_execute: 'approval_execution',
  cancel: 'cancellation_state',
  scheduled_retry: 'retry_state',
  command_center_snapshot: 'command_center_snapshot',
});

export function responseMatchesKernelRequest(
  request: KernelClientRequestV1,
  response: KernelClientResponseV1,
): boolean {
  if (response.kind === 'unavailable') return response.requestKind === request.kind;
  if (RESPONSE_FOR_REQUEST[request.kind] !== response.kind) return false;
  switch (request.kind) {
    case 'approval_present':
      return (
        response.kind === 'approval_presentation' && response.approvalId === request.approvalId
      );
    case 'approval_status':
      return (
        response.kind === 'approval_state' &&
        response.accountId === request.accountId &&
        response.approvalId === request.approvalId
      );
    case 'approval_decide':
      return response.kind === 'approval_decided' && response.approvalId === request.approvalId;
    case 'approval_execute':
      return response.kind === 'approval_execution' && response.approvalId === request.approvalId;
    case 'cancel':
      return response.kind === 'cancellation_state' && response.runId === request.runId;
    case 'scheduled_retry':
      return response.kind === 'retry_state' && response.runId === request.runId;
    case 'command_center_snapshot':
      return (
        response.kind === 'command_center_snapshot' && response.accountId === request.accountId
      );
    case 'turn_dispatch':
    case 'approval_create':
      return true;
  }
}

export function isKernelHostRequestEvent(value: unknown): value is KernelHostRequestEvent {
  const record = dataRecord(value);
  return Boolean(
    record &&
    exactKeys(record, ['epoch', 'requestId', 'request']) &&
    epoch(record.epoch) &&
    id(record.requestId) &&
    isKernelClientRequestV1(record.request),
  );
}

export function isKernelClientResponseEvent(value: unknown): value is KernelClientResponseEvent {
  const record = dataRecord(value);
  return Boolean(
    record &&
    exactKeys(record, ['epoch', 'requestId', 'response']) &&
    epoch(record.epoch) &&
    id(record.requestId) &&
    isKernelClientResponseV1(record.response),
  );
}

export function isKernelClientRequestRegistration(
  value: unknown,
): value is KernelClientRequestRegistration {
  const record = dataRecord(value);
  return Boolean(
    record &&
    exactKeys(record, ['epoch', 'requestId', 'deadlineMs']) &&
    epoch(record.epoch) &&
    id(record.requestId) &&
    Number.isSafeInteger(record.deadlineMs) &&
    Number(record.deadlineMs) >= 0,
  );
}
