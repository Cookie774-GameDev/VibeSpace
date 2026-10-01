import { appDataDir } from '@tauri-apps/api/path';
import { createDirectory, readTextFile, writeTextFile } from '@/lib/fs';
import { isTauri } from '@/lib/utils';

export type VoiceNativeProvider = 'codex' | 'opencode';
export type VoiceNativeTaskStatus =
  'submitted' | 'launched' | 'running' | 'done' | 'blocked' | 'failed' | 'cancelled';

export interface VoiceNativeTaskScope {
  accountId: string;
  workspaceId: string;
  projectId: string | null;
}

export type VoiceNativeTaskStatusEvidence =
  | { source: 'voice_route_result'; observedAt?: string; code?: string }
  | {
      source: 'provider_native_task_tool' | 'provider_native_activity';
      observedAt?: string;
    };

export interface VoiceNativeMainIdentity {
  provider: VoiceNativeProvider;
  modelId?: string;
  evidence: 'main_runtime_usage';
}

export interface VoiceNativeWorkerIdentity {
  provider: VoiceNativeProvider;
  modelId?: string;
  nativeParentSessionId?: string;
  nativeTaskId: string;
  evidence: 'provider_native_task_tool';
}

/** Parent affinity is stored only when a runtime API independently proves it. */
export interface VoiceNativeWorkerParentSession {
  provider: VoiceNativeProvider;
  sessionId: string;
  evidence: 'verified_runtime_affinity';
}

export interface VoiceNativeTaskRecord {
  requestId: string;
  /** Original voice conversation. Its chat URL can be derived by the caller. */
  parentChatId: string;
  requestedMainProvider: VoiceNativeProvider;
  requestedWorkerProvider: VoiceNativeProvider;
  status: VoiceNativeTaskStatus;
  statusEvidence?: VoiceNativeTaskStatusEvidence;
  actualMain?: VoiceNativeMainIdentity;
  actualWorker?: VoiceNativeWorkerIdentity;
  workerParentSession?: VoiceNativeWorkerParentSession;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type VoiceNativeTaskUpdate = Pick<
  VoiceNativeTaskRecord,
  | 'requestId'
  | 'parentChatId'
  | 'requestedMainProvider'
  | 'requestedWorkerProvider'
  | 'status'
  | 'summary'
> &
  Partial<
    Pick<
      VoiceNativeTaskRecord,
      | 'statusEvidence'
      | 'actualMain'
      | 'actualWorker'
      | 'workerParentSession'
      | 'createdAt'
      | 'updatedAt'
    >
  >;

export type VoiceNativeTaskIndexErrorCode =
  | 'invalid_scope'
  | 'invalid_request'
  | 'invalid_evidence'
  | 'invalid_transition'
  | 'unavailable'
  | 'read_failed'
  | 'write_failed'
  | 'corrupt_index'
  | 'scope_mismatch'
  | 'capacity_reached';

export type VoiceNativeTaskIndexResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: VoiceNativeTaskIndexErrorCode; message: string } };

export type VoiceNativeTaskListResult =
  | { ok: true; records: VoiceNativeTaskRecord[] }
  | { ok: false; error: { code: VoiceNativeTaskIndexErrorCode; message: string } };

export type VoiceNativeTaskUpsertResult =
  | { ok: true; record: VoiceNativeTaskRecord }
  | { ok: false; error: { code: VoiceNativeTaskIndexErrorCode; message: string } };

export type VoiceNativeWorkerSessionResult =
  | { ok: true; session: (VoiceNativeWorkerParentSession & { requestId: string }) | null }
  | { ok: false; error: { code: VoiceNativeTaskIndexErrorCode; message: string } };

export const VOICE_NATIVE_TASK_INDEX_MAX_RECORDS = 100;
export const VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_CHARS = 1_800;
export const VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_RECORDS = 8;
export const VOICE_NATIVE_TASK_INDEX_MAX_SUMMARY_CHARS = 240;

const INDEX_DIRECTORY = 'jarvis-voice-native-task-index';
const MAX_INDEX_CHARS = 256_000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const PROVIDERS = new Set<VoiceNativeProvider>(['codex', 'opencode']);
const ACTIVE_STATUSES = new Set<VoiceNativeTaskStatus>(['submitted', 'launched', 'running']);
const TERMINAL_STATUSES = new Set<VoiceNativeTaskStatus>([
  'done',
  'blocked',
  'failed',
  'cancelled',
]);

interface PersistedIndex {
  version: 1;
  scope: VoiceNativeTaskScope;
  records: VoiceNativeTaskRecord[];
}

interface LoadedIndex {
  path: string;
  root: string;
  index: PersistedIndex;
}

const pendingWrites = new Map<string, Promise<unknown>>();

function failure(
  code: VoiceNativeTaskIndexErrorCode,
  message: string,
): Extract<VoiceNativeTaskIndexResult<never>, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function listFailure(
  code: VoiceNativeTaskIndexErrorCode,
  message: string,
): VoiceNativeTaskListResult {
  return { ok: false, error: { code, message } };
}

function validBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validProvider(value: unknown): value is VoiceNativeProvider {
  return typeof value === 'string' && PROVIDERS.has(value as VoiceNativeProvider);
}

function validScope(scope: VoiceNativeTaskScope): boolean {
  if (!asRecord(scope)) return false;
  return (
    validBoundedText(scope.accountId, 128) &&
    validBoundedText(scope.workspaceId, 128) &&
    (scope.projectId === null || validBoundedText(scope.projectId, 128))
  );
}

function sameScope(left: VoiceNativeTaskScope, right: VoiceNativeTaskScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function timestampOrNow(value: string | undefined): string {
  return validTimestamp(value) ? value : new Date().toISOString();
}

function safeSummary(summary: string): string {
  return summary
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{16,}\b/giu, '[redacted]')
    .replace(/\bgithub_pat_[a-z0-9_]{20,}\b/giu, '[redacted]')
    .replace(/\bgh[pousr]_[a-z0-9_]{20,}\b/giu, '[redacted]')
    .replace(/\b(bearer|token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, VOICE_NATIVE_TASK_INDEX_MAX_SUMMARY_CHARS);
}

function validStatus(value: unknown): value is VoiceNativeTaskStatus {
  return (
    value === 'submitted' ||
    value === 'launched' ||
    value === 'running' ||
    value === 'done' ||
    value === 'blocked' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function validIdentityPart(value: unknown): value is string {
  return validBoundedText(value, 180) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validMainIdentity(value: VoiceNativeMainIdentity | undefined): boolean {
  return (
    value === undefined ||
    (validProvider(value.provider) &&
      value.evidence === 'main_runtime_usage' &&
      (value.modelId === undefined || validIdentityPart(value.modelId)))
  );
}

function validWorkerIdentity(value: VoiceNativeWorkerIdentity | undefined): boolean {
  return (
    value === undefined ||
    (validProvider(value.provider) &&
      value.evidence === 'provider_native_task_tool' &&
      validIdentityPart(value.nativeTaskId) &&
      (value.modelId === undefined || validIdentityPart(value.modelId)) &&
      (value.nativeParentSessionId === undefined || validIdentityPart(value.nativeParentSessionId)))
  );
}

function validParentSession(value: VoiceNativeWorkerParentSession | undefined): boolean {
  return (
    value === undefined ||
    (validProvider(value.provider) &&
      value.evidence === 'verified_runtime_affinity' &&
      validIdentityPart(value.sessionId))
  );
}

function validStatusEvidence(value: VoiceNativeTaskStatusEvidence | undefined): boolean {
  if (value === undefined) return true;
  if (value.source === 'voice_route_result') {
    return (
      (value.observedAt === undefined || validTimestamp(value.observedAt)) &&
      (value.code === undefined || /^[a-zA-Z0-9_.:-]{1,120}$/u.test(value.code))
    );
  }
  return (
    (value.source === 'provider_native_task_tool' || value.source === 'provider_native_activity') &&
    (value.observedAt === undefined || validTimestamp(value.observedAt))
  );
}

function validateEvidence(update: VoiceNativeTaskUpdate): boolean {
  if (
    !validStatusEvidence(update.statusEvidence) ||
    !validMainIdentity(update.actualMain) ||
    !validWorkerIdentity(update.actualWorker) ||
    !validParentSession(update.workerParentSession)
  ) {
    return false;
  }

  if (update.status === 'submitted') {
    return (
      update.actualWorker === undefined &&
      update.workerParentSession === undefined &&
      update.statusEvidence?.source !== 'provider_native_task_tool' &&
      update.statusEvidence?.source !== 'provider_native_activity'
    );
  }
  if (update.status === 'launched' || update.status === 'running') {
    return (
      update.actualWorker !== undefined &&
      update.statusEvidence !== undefined &&
      (update.statusEvidence.source === 'provider_native_task_tool' ||
        update.statusEvidence.source === 'provider_native_activity')
    );
  }
  if (update.status === 'done') {
    return (
      update.actualWorker !== undefined &&
      update.statusEvidence?.source === 'provider_native_activity'
    );
  }
  return (
    update.statusEvidence !== undefined &&
    (update.statusEvidence.source === 'voice_route_result' ||
      update.statusEvidence.source === 'provider_native_activity')
  );
}

function transitionAllowed(from: VoiceNativeTaskStatus, to: VoiceNativeTaskStatus): boolean {
  if (from === to) return true;
  if (from === 'submitted') return to !== 'submitted';
  if (from === 'launched') return to === 'running' || TERMINAL_STATUSES.has(to);
  if (from === 'running') return TERMINAL_STATUSES.has(to);
  return false;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validStoredRecord(value: unknown): value is VoiceNativeTaskRecord {
  if (!asRecord(value)) return false;
  const validBase =
    typeof value.requestId === 'string' &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    typeof value.parentChatId === 'string' &&
    ID_PATTERN.test(value.parentChatId) &&
    validProvider(value.requestedMainProvider) &&
    validProvider(value.requestedWorkerProvider) &&
    validStatus(value.status) &&
    typeof value.summary === 'string' &&
    value.summary.length <= VOICE_NATIVE_TASK_INDEX_MAX_SUMMARY_CHARS &&
    validTimestamp(value.createdAt) &&
    validTimestamp(value.updatedAt) &&
    validStatusEvidence(value.statusEvidence as VoiceNativeTaskStatusEvidence | undefined) &&
    validMainIdentity(value.actualMain as VoiceNativeMainIdentity | undefined) &&
    validWorkerIdentity(value.actualWorker as VoiceNativeWorkerIdentity | undefined) &&
    validParentSession(value.workerParentSession as VoiceNativeWorkerParentSession | undefined);
  if (!validBase) return false;
  const record = value as unknown as VoiceNativeTaskRecord;
  return (
    validateEvidence(record) &&
    (!record.workerParentSession ||
      record.workerParentSession.provider === record.actualWorker?.provider)
  );
}

async function indexPath(scope: VoiceNativeTaskScope): Promise<LoadedIndex | null> {
  if (!validScope(scope)) return null;
  const scopeJson = JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scopeJson));
  const scopeKey = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const root = (await appDataDir()).replace(/[\\/]+$/u, '');
  const folder = `${root}/${INDEX_DIRECTORY}`;
  return {
    path: `${folder}/${scopeKey}.json`,
    root,
    index: { version: 1, scope: { ...scope }, records: [] },
  };
}

async function loadIndex(
  scope: VoiceNativeTaskScope,
): Promise<
  | { ok: true; loaded: LoadedIndex }
  | { ok: false; error: { code: VoiceNativeTaskIndexErrorCode; message: string } }
> {
  if (!validScope(scope)) {
    return {
      ok: false,
      error: { code: 'invalid_scope', message: 'The voice task scope is invalid.' },
    };
  }
  if (!isTauri) {
    return {
      ok: false,
      error: { code: 'unavailable', message: 'Native task storage is unavailable.' },
    };
  }
  try {
    const loaded = await indexPath(scope);
    if (!loaded) {
      return {
        ok: false,
        error: { code: 'invalid_scope', message: 'The voice task scope is invalid.' },
      };
    }
    const read = await readTextFile(loaded.path, { root: loaded.root });
    if (!read.ok) {
      if (read.error.code === 'not_found') return { ok: true, loaded };
      return {
        ok: false,
        error: { code: 'read_failed', message: 'Could not read native task references.' },
      };
    }
    if (read.content.length > MAX_INDEX_CHARS) {
      return {
        ok: false,
        error: { code: 'corrupt_index', message: 'The native task index is too large.' },
      };
    }
    const parsed: unknown = JSON.parse(read.content);
    if (!asRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      return {
        ok: false,
        error: { code: 'corrupt_index', message: 'The native task index is invalid.' },
      };
    }
    if (!asRecord(parsed.scope)) {
      return {
        ok: false,
        error: { code: 'corrupt_index', message: 'The native task scope is invalid.' },
      };
    }
    const storedScope = parsed.scope as unknown as VoiceNativeTaskScope;
    if (!validScope(storedScope)) {
      return {
        ok: false,
        error: { code: 'corrupt_index', message: 'The native task scope is invalid.' },
      };
    }
    if (!sameScope(storedScope, scope)) {
      return {
        ok: false,
        error: { code: 'scope_mismatch', message: 'The native task scope did not match.' },
      };
    }
    if (
      parsed.records.length > VOICE_NATIVE_TASK_INDEX_MAX_RECORDS ||
      !parsed.records.every(validStoredRecord)
    ) {
      return {
        ok: false,
        error: { code: 'corrupt_index', message: 'The native task records are invalid.' },
      };
    }
    loaded.index = { version: 1, scope: { ...scope }, records: parsed.records };
    return { ok: true, loaded };
  } catch {
    return {
      ok: false,
      error: { code: 'read_failed', message: 'Could not read native task references.' },
    };
  }
}

async function saveIndex(loaded: LoadedIndex): Promise<boolean> {
  const content = JSON.stringify(loaded.index);
  if (content.length > MAX_INDEX_CHARS) return false;
  try {
    const directory = loaded.path.slice(0, loaded.path.lastIndexOf('/'));
    const created = await createDirectory(directory, { root: loaded.root });
    if (!created.ok) return false;
    const written = await writeTextFile(loaded.path, content, { root: loaded.root });
    return written.ok;
  } catch {
    return false;
  }
}

function scopeQueueKey(scope: VoiceNativeTaskScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId]);
}

async function serializeScope<T>(
  scope: VoiceNativeTaskScope,
  action: () => Promise<T>,
): Promise<T> {
  const key = scopeQueueKey(scope);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous.then(action, action);
  pendingWrites.set(key, next);
  try {
    return await next;
  } finally {
    if (pendingWrites.get(key) === next) pendingWrites.delete(key);
  }
}

function mergeUpdate(
  previous: VoiceNativeTaskRecord | undefined,
  update: VoiceNativeTaskUpdate,
): VoiceNativeTaskRecord | null {
  if (
    !REQUEST_ID_PATTERN.test(update.requestId) ||
    !ID_PATTERN.test(update.parentChatId) ||
    !validProvider(update.requestedMainProvider) ||
    !validProvider(update.requestedWorkerProvider) ||
    !validStatus(update.status) ||
    typeof update.summary !== 'string'
  ) {
    return null;
  }
  if (previous) {
    if (
      previous.parentChatId !== update.parentChatId ||
      previous.requestedMainProvider !== update.requestedMainProvider ||
      previous.requestedWorkerProvider !== update.requestedWorkerProvider ||
      !transitionAllowed(previous.status, update.status)
    ) {
      return null;
    }
    if (
      update.actualWorker &&
      previous.actualWorker &&
      (update.actualWorker.provider !== previous.actualWorker.provider ||
        update.actualWorker.nativeTaskId !== previous.actualWorker.nativeTaskId)
    ) {
      return null;
    }
    if (
      update.actualMain &&
      previous.actualMain &&
      (update.actualMain.provider !== previous.actualMain.provider ||
        (update.actualMain.modelId &&
          previous.actualMain.modelId &&
          update.actualMain.modelId !== previous.actualMain.modelId))
    ) {
      return null;
    }
    if (
      update.workerParentSession &&
      previous.workerParentSession &&
      (update.workerParentSession.provider !== previous.workerParentSession.provider ||
        update.workerParentSession.sessionId !== previous.workerParentSession.sessionId)
    ) {
      return null;
    }
  }
  const actualWorker = update.actualWorker ?? previous?.actualWorker;
  const workerParentSession = update.workerParentSession ?? previous?.workerParentSession;
  const evidenceCandidate = {
    ...update,
    actualMain: update.actualMain ?? previous?.actualMain,
    actualWorker,
    workerParentSession,
  };
  if (
    !validateEvidence(evidenceCandidate) ||
    (workerParentSession &&
      (!actualWorker || workerParentSession.provider !== actualWorker.provider))
  ) {
    return null;
  }
  if (update.status === 'submitted' && (actualWorker || workerParentSession)) return null;

  return {
    requestId: update.requestId,
    parentChatId: update.parentChatId,
    requestedMainProvider: update.requestedMainProvider,
    requestedWorkerProvider: update.requestedWorkerProvider,
    status: update.status,
    ...(update.statusEvidence
      ? {
          statusEvidence: {
            ...update.statusEvidence,
            observedAt: timestampOrNow(update.statusEvidence.observedAt),
          },
        }
      : previous?.statusEvidence
        ? { statusEvidence: previous.statusEvidence }
        : {}),
    ...((update.actualMain ?? previous?.actualMain)
      ? { actualMain: update.actualMain ?? previous?.actualMain }
      : {}),
    ...(actualWorker ? { actualWorker } : {}),
    ...(workerParentSession ? { workerParentSession } : {}),
    summary: safeSummary(update.summary),
    createdAt: previous?.createdAt ?? timestampOrNow(update.createdAt),
    updatedAt: timestampOrNow(update.updatedAt),
  };
}

function compactRecords(records: VoiceNativeTaskRecord[]): VoiceNativeTaskRecord[] {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createVoiceNativeTaskRequestId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  return `voice-${uuid}`;
}

/** Persist one bounded task summary; full user/task prompts and transcripts are never indexed. */
export async function upsertVoiceNativeTask(
  scope: VoiceNativeTaskScope,
  update: VoiceNativeTaskUpdate,
): Promise<VoiceNativeTaskUpsertResult> {
  if (!validScope(scope)) {
    return {
      ok: false,
      error: { code: 'invalid_scope', message: 'The voice task scope is invalid.' },
    };
  }
  return serializeScope(scope, async () => {
    const result = await loadIndex(scope);
    if (!result.ok) return failure(result.error.code, result.error.message);
    const { loaded } = result;
    const position = loaded.index.records.findIndex(
      (record) => record.requestId === update.requestId,
    );
    const previous = position >= 0 ? loaded.index.records[position] : undefined;
    const record = mergeUpdate(previous, update);
    if (!record) {
      return failure(
        previous ? 'invalid_transition' : 'invalid_evidence',
        'The native task update did not include valid, matching request evidence.',
      );
    }
    if (position >= 0) loaded.index.records[position] = record;
    else loaded.index.records.push(record);

    if (loaded.index.records.length > VOICE_NATIVE_TASK_INDEX_MAX_RECORDS) {
      const removable = compactRecords(loaded.index.records)
        .filter((entry) => TERMINAL_STATUSES.has(entry.status))
        .slice(VOICE_NATIVE_TASK_INDEX_MAX_RECORDS - loaded.index.records.length);
      for (const stale of removable) {
        loaded.index.records = loaded.index.records.filter(
          (entry) => entry.requestId !== stale.requestId,
        );
      }
    }
    if (loaded.index.records.length > VOICE_NATIVE_TASK_INDEX_MAX_RECORDS) {
      return failure('capacity_reached', 'The native task index is full of active tasks.');
    }
    loaded.index.records = compactRecords(loaded.index.records);
    if (!(await saveIndex(loaded))) {
      return failure('write_failed', 'Could not save native task references.');
    }
    return { ok: true, record };
  });
}

export async function listVoiceNativeTasks(
  scope: VoiceNativeTaskScope,
): Promise<VoiceNativeTaskListResult> {
  if (!validScope(scope)) {
    return listFailure('invalid_scope', 'The voice task scope is invalid.');
  }
  return serializeScope(scope, async () => {
    const result = await loadIndex(scope);
    if (!result.ok) return listFailure(result.error.code, result.error.message);
    return { ok: true, records: compactRecords(result.loaded.index.records) };
  });
}

export async function getLastVoiceWorkerParentSession(
  scope: VoiceNativeTaskScope,
  provider: VoiceNativeProvider,
): Promise<VoiceNativeWorkerSessionResult> {
  const listed = await listVoiceNativeTasks(scope);
  if (!listed.ok) return { ok: false, error: listed.error };
  const record = listed.records.find(
    (candidate) =>
      candidate.actualWorker?.provider === provider &&
      candidate.workerParentSession?.provider === provider &&
      candidate.workerParentSession.evidence === 'verified_runtime_affinity',
  );
  return {
    ok: true,
    session: record?.workerParentSession
      ? { ...record.workerParentSession, requestId: record.requestId }
      : null,
  };
}

/** Bounded reference only; callers derive the actual chat link from parentChatId. */
export function formatVoiceNativeTaskContext(records: readonly VoiceNativeTaskRecord[]): string {
  if (records.length === 0) return '';
  const selected = compactRecords([...records]).slice(
    0,
    VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_RECORDS,
  );
  const lines = [
    'Prior native voice tasks (references only; do not relaunch these tasks):',
    ...selected.map((record) => {
      const actual = record.actualWorker
        ? `; actual ${record.actualWorker.provider}${record.actualWorker.modelId ? `/${record.actualWorker.modelId}` : ''} task ${record.actualWorker.nativeTaskId}`
        : '';
      return `- ${record.requestId} [${record.status}] requested ${record.requestedWorkerProvider}${actual}; original chat ${record.parentChatId}: ${record.summary}`;
    }),
  ];
  return lines.join('\n').slice(0, VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_CHARS);
}
