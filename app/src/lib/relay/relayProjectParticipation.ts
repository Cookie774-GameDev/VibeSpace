/** Public native metadata only. These strings are validated as canonical u64 decimals. */
export type RelayNativeU64 = string;
export type RelayProjectScope = Readonly<{
  accountId: string;
  workspaceId: string | null;
  projectId: string;
}>;
export type RelayProcessIdentity = Readonly<{
  terminalSessionId: string;
  paneId: string;
  processInstanceId: string;
  runtimeGeneration: string;
  pid: number;
  processStartedAt: RelayNativeU64;
}>;
export type RelayRunIdentity = Readonly<{
  runId: string;
  providerSessionId: string;
  generation: RelayNativeU64;
}>;
export type RelayParticipationSubject =
  | Readonly<{ kind: 'Terminal'; process: RelayProcessIdentity }>
  | Readonly<{ kind: 'ChatRun' | 'AdeRun'; run: RelayRunIdentity }>;
export type RelayLeaseView = Readonly<{
  id: RelayNativeU64;
  scope: RelayProjectScope;
  subject: RelayParticipationSubject;
  access: 'ReadOnly' | 'ApprovedTools';
  accountEpoch: RelayNativeU64;
  bindingEpoch: RelayNativeU64;
  status: 'Pending' | 'Joining' | 'Joined';
}>;
export type RelayParticipationPolicy = Readonly<{
  scope: 'Off' | 'Project' | 'EntireApp';
  excludedProjects: readonly string[];
  excludedSessions: readonly string[];
  automaticMessages: boolean;
}>;
/**
 * Trusted host snapshot after native policy application, with no selected-view
 * state. revision orders complete snapshots within the native account epoch;
 * authorizationRevision advances on trusted project-access or existing-identity
 * readiness changes (including a native expiry observation). These observer
 * sequence numbers are metadata, not new native commands or permission grants.
 */
export type RelayParticipationInput = Readonly<{
  accountId: string | null;
  accountEpoch: RelayNativeU64;
  revision: RelayNativeU64;
  authorizationRevision: RelayNativeU64;
  policyRevision: RelayNativeU64;
  policy: RelayParticipationPolicy;
  leases: readonly RelayLeaseView[];
}>;
export type RelayParticipationError =
  | 'InvalidInput'
  | 'NoAccount'
  | 'StaleAccount'
  | 'StalePolicy'
  | 'ProjectDenied'
  | 'ProcessChanged'
  | 'RunRevoked'
  | 'Off'
  | 'Excluded'
  | 'SetupRequired'
  | 'CredentialsChanged'
  | 'ReadOnly'
  | 'PermissionDenied'
  | 'InvalidCapability'
  | 'Duplicate'
  | 'Capacity'
  | 'NotFound'
  | 'NotJoined'
  | 'Busy'
  | 'StaleTicket'
  | 'ClockInvalid'
  | 'CounterExhausted';
export type RelayLeaseReference = Readonly<{ id: RelayNativeU64; accountEpoch: RelayNativeU64 }>;
export type RelayEnrollmentReference = RelayLeaseReference &
  Readonly<{ observerId: string; enrollmentRequestId: string }>;
export type RelayEnrollmentRequest = RelayEnrollmentReference &
  Readonly<{
    bindingEpoch: RelayNativeU64;
    policyRevision: RelayNativeU64;
  }>;
/**
 * Injection contract, NOT a Tauri/wire API. Bind one port to one native Registry.
 * Native glue must validate current epoch/policy/lease under its lock, retain
 * private tickets/proof, use the original verified project, and unwind stale
 * remote joins. Correlation IDs grant no authority. Pending cancellation must
 * match the private attempt; after commit it is a no-op. Native subject lifecycle
 * alone retires admission/proof and committed membership. Missing credentials
 * cannot provision or write a keyring.
 */
export interface RelayProjectParticipationPort {
  ensureExistingParticipant(
    request: RelayEnrollmentRequest,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ ok: true; lease: RelayLeaseView }>
    | Readonly<{ ok: false; code: RelayParticipationError }>
  >;
  /** Cancel only this still-pending attempt; committed membership is native-subject-owned. */
  cancelPending(reference: RelayEnrollmentReference): Promise<void>;
}
export type RelayProjectAuthorization = (
  scope: RelayProjectScope,
  accountEpoch: RelayNativeU64,
  signal: AbortSignal,
) => Promise<boolean>;
export type RelayParticipationEntry = Readonly<{
  lease: RelayLeaseView;
  phase:
    | 'off'
    | 'excluded'
    | 'authorizing'
    | 'joining'
    | 'joined'
    | 'setup-required'
    | 'pending'
    | 'denied'
    | 'failed';
  automaticMessages: 'disabled' | 'requires-native-authorization';
  error?: RelayParticipationError;
}>;
export type RelayParticipationState = Readonly<{
  accountId: string | null;
  accountEpoch: RelayNativeU64;
  entries: readonly RelayParticipationEntry[];
  error?: 'InvalidInput' | 'CancelPendingFailed';
}>;
export interface RelayProjectParticipationCoordinator {
  update(input: RelayParticipationInput): boolean;
  getSnapshot(): RelayParticipationState;
  subscribe(listener: (state: RelayParticipationState) => void): () => void;
  whenIdle(): Promise<void>;
  dispose(): void;
}

const MAX_U64 = '18446744073709551615';
const nativeErrors = new Set<RelayParticipationError>([
  'InvalidInput',
  'NoAccount',
  'StaleAccount',
  'StalePolicy',
  'ProjectDenied',
  'ProcessChanged',
  'RunRevoked',
  'Off',
  'Excluded',
  'SetupRequired',
  'CredentialsChanged',
  'ReadOnly',
  'PermissionDenied',
  'InvalidCapability',
  'Duplicate',
  'Capacity',
  'NotFound',
  'NotJoined',
  'Busy',
  'StaleTicket',
  'ClockInvalid',
  'CounterExhausted',
]);
function u64(value: unknown, zero = false): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/u.test(value) &&
    (zero || value !== '0') &&
    (value.length < 20 || value <= MAX_U64)
  );
}
/** Compare validated decimal strings without converting native integers to Number. */
function compare(left: string, right: string): number {
  return left.length === right.length
    ? left === right
      ? 0
      : left < right
        ? -1
        : 1
    : left.length < right.length
      ? -1
      : 1;
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 256 &&
    !/[\p{Cc}\p{White_Space}\uD800-\uDFFF]/u.test(value)
  );
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every((key) => descriptors[key]?.enumerable && 'value' in descriptors[key]!)
  );
}
function scope(value: unknown): value is RelayProjectScope {
  return (
    record(value, ['accountId', 'workspaceId', 'projectId']) &&
    identifier(value.accountId) &&
    identifier(value.projectId) &&
    (value.workspaceId === null || identifier(value.workspaceId))
  );
}
function subject(value: unknown): value is RelayParticipationSubject {
  if (!value || typeof value !== 'object') return false;
  if (record(value, ['kind', 'process']) && value.kind === 'Terminal') {
    const p = value.process;
    return (
      record(p, [
        'terminalSessionId',
        'paneId',
        'processInstanceId',
        'runtimeGeneration',
        'pid',
        'processStartedAt',
      ]) &&
      identifier(p.terminalSessionId) &&
      identifier(p.paneId) &&
      identifier(p.processInstanceId) &&
      identifier(p.runtimeGeneration) &&
      typeof p.pid === 'number' &&
      Number.isInteger(p.pid) &&
      p.pid > 0 &&
      p.pid <= 4_294_967_295 &&
      u64(p.processStartedAt)
    );
  }
  if (!record(value, ['kind', 'run']) || (value.kind !== 'ChatRun' && value.kind !== 'AdeRun'))
    return false;
  const run = value.run;
  return (
    record(run, ['runId', 'providerSessionId', 'generation']) &&
    identifier(run.runId) &&
    identifier(run.providerSessionId) &&
    u64(run.generation)
  );
}
function copyLease(value: unknown): RelayLeaseView | null {
  if (
    !record(value, [
      'id',
      'scope',
      'subject',
      'access',
      'accountEpoch',
      'bindingEpoch',
      'status',
    ]) ||
    !u64(value.id) ||
    !u64(value.accountEpoch) ||
    !u64(value.bindingEpoch, true) ||
    !scope(value.scope) ||
    !subject(value.subject) ||
    (value.access !== 'ReadOnly' && value.access !== 'ApprovedTools') ||
    typeof value.status !== 'string' ||
    !['Pending', 'Joining', 'Joined'].includes(value.status) ||
    (value.status !== 'Pending' && value.bindingEpoch === '0') ||
    (value.subject.kind === 'AdeRun' && value.access !== 'ReadOnly')
  )
    return null;
  const s = value.subject;
  return Object.freeze({
    id: value.id,
    accountEpoch: value.accountEpoch,
    bindingEpoch: value.bindingEpoch,
    access: value.access,
    status: value.status as RelayLeaseView['status'],
    scope: Object.freeze({
      accountId: value.scope.accountId,
      workspaceId: value.scope.workspaceId,
      projectId: value.scope.projectId,
    }),
    subject:
      s.kind === 'Terminal'
        ? Object.freeze({
            kind: s.kind,
            process: Object.freeze({
              terminalSessionId: s.process.terminalSessionId,
              paneId: s.process.paneId,
              processInstanceId: s.process.processInstanceId,
              runtimeGeneration: s.process.runtimeGeneration,
              pid: s.process.pid,
              processStartedAt: s.process.processStartedAt,
            }),
          })
        : Object.freeze({
            kind: s.kind,
            run: Object.freeze({
              runId: s.run.runId,
              providerSessionId: s.run.providerSessionId,
              generation: s.run.generation,
            }),
          }),
  });
}
function session(value: RelayLeaseView): string {
  return value.subject.kind === 'Terminal'
    ? value.subject.process.terminalSessionId
    : value.subject.run.providerSessionId;
}
function admission(value: RelayLeaseView): string {
  return JSON.stringify([value.id, value.accountEpoch, value.scope, value.subject, value.access]);
}
function ref(value: RelayLeaseView): RelayLeaseReference {
  return Object.freeze({ id: value.id, accountEpoch: value.accountEpoch });
}
function copyInput(value: unknown): RelayParticipationInput | null {
  if (
    !record(value, [
      'accountId',
      'accountEpoch',
      'revision',
      'authorizationRevision',
      'policyRevision',
      'policy',
      'leases',
    ]) ||
    (value.accountId !== null && !identifier(value.accountId)) ||
    !u64(value.accountEpoch, value.accountId === null) ||
    !u64(value.revision) ||
    !u64(value.authorizationRevision, true) ||
    !u64(value.policyRevision, true) ||
    !Array.isArray(value.leases) ||
    value.leases.length > 256
  )
    return null;
  const p = value.policy;
  if (
    !record(p, ['scope', 'excludedProjects', 'excludedSessions', 'automaticMessages']) ||
    typeof p.scope !== 'string' ||
    !['Off', 'Project', 'EntireApp'].includes(p.scope) ||
    typeof p.automaticMessages !== 'boolean' ||
    (p.scope !== 'Off' && value.policyRevision === '0')
  )
    return null;
  const ids = (items: unknown): items is string[] =>
    Array.isArray(items) && items.length <= 4096 && items.every(identifier);
  if (!ids(p.excludedProjects) || !ids(p.excludedSessions)) return null;
  const leases = new Map<string, RelayLeaseView>();
  const subjects = new Set<string>();
  for (const raw of value.leases) {
    const lease = copyLease(raw);
    if (
      !lease ||
      value.accountId === null ||
      lease.scope.accountId !== value.accountId ||
      lease.accountEpoch !== value.accountEpoch
    )
      return null;
    const previous = leases.get(lease.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(lease)) return null;
      continue;
    }
    const identities =
      lease.subject.kind === 'Terminal'
        ? [`terminal:${session(lease)}`]
        : [`run:${lease.subject.run.runId}`, `provider:${session(lease)}`];
    if (identities.some((key) => subjects.has(key))) return null;
    identities.forEach((key) => subjects.add(key));
    leases.set(lease.id, lease);
  }
  return Object.freeze({
    accountId: value.accountId as string | null,
    accountEpoch: value.accountEpoch,
    revision: value.revision,
    authorizationRevision: value.authorizationRevision,
    policyRevision: value.policyRevision,
    policy: Object.freeze({
      scope: p.scope as RelayParticipationPolicy['scope'],
      automaticMessages: p.automaticMessages,
      excludedProjects: Object.freeze([...new Set(p.excludedProjects)].sort()),
      excludedSessions: Object.freeze([...new Set(p.excludedSessions)].sort()),
    }),
    leases: Object.freeze([...leases.values()]),
  });
}
type Entry = {
  source: RelayLeaseView;
  signature: string;
  abort: AbortController;
  nativeStarted: boolean;
  request?: RelayEnrollmentRequest;
  cancellationSent: boolean;
  state: RelayParticipationEntry;
};

/**
 * In-memory lifecycle coordinator only. Authorization is an injected trusted
 * repository observation; every join is independently revalidated natively.
 * Policy snapshots must follow native set_policy. This module never applies
 * native account/policy changes, admits subjects, or grants operation authority.
 */
export function createRelayProjectParticipationCoordinator(
  ports: Readonly<{
    native: RelayProjectParticipationPort;
    authorizeProject: RelayProjectAuthorization;
  }>,
): RelayProjectParticipationCoordinator {
  const observerId = crypto.randomUUID();
  let disposed = false;
  let current: RelayParticipationInput | undefined;
  let state: RelayParticipationState = Object.freeze({
    accountId: null,
    accountEpoch: '0',
    entries: Object.freeze([]),
  });
  let error: RelayParticipationState['error'];
  const entries = new Map<string, Entry>();
  const listeners = new Set<(state: RelayParticipationState) => void>();
  const tasks = new Set<Promise<void>>();
  const publish = () => {
    state = Object.freeze({
      accountId: current?.accountId ?? null,
      accountEpoch: current?.accountEpoch ?? '0',
      entries: Object.freeze([...entries.values()].map((entry) => entry.state)),
      ...(error ? { error } : {}),
    });
    if (!disposed)
      for (const listener of listeners) {
        try {
          listener(state);
        } catch {
          /* observers cannot grant authority */
        }
      }
  };
  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
  };
  const cancel = (entry: Entry) => {
    entry.abort.abort();
    if (!entry.request || entry.cancellationSent) return;
    entry.cancellationSent = true;
    const reference: RelayEnrollmentReference = Object.freeze({
      ...ref(entry.source),
      observerId: entry.request.observerId,
      enrollmentRequestId: entry.request.enrollmentRequestId,
    });
    track(
      Promise.resolve()
        .then(() => ports.native.cancelPending(reference))
        .catch(() => {
          error = 'CancelPendingFailed';
          publish();
        }),
    );
  };
  const isCurrent = (entry: Entry) =>
    !disposed && !entry.abort.signal.aborted && entries.get(entry.source.id) === entry;
  const setEntry = (
    entry: Entry,
    phase: RelayParticipationEntry['phase'],
    code?: RelayParticipationError,
    lease = entry.source,
  ) => {
    if (!isCurrent(entry)) return;
    entry.state = Object.freeze({
      lease,
      phase,
      automaticMessages:
        phase === 'joined' &&
        current?.policy.automaticMessages &&
        lease.access === 'ApprovedTools' &&
        lease.subject.kind !== 'AdeRun'
          ? 'requires-native-authorization'
          : 'disabled',
      ...(code ? { error: code } : {}),
    });
    publish();
  };
  const enroll = async (entry: Entry) => {
    try {
      const allowed = await ports.authorizeProject(
        entry.source.scope,
        entry.source.accountEpoch,
        entry.abort.signal,
      );
      if (!isCurrent(entry)) return;
      if (allowed !== true) {
        setEntry(entry, 'denied', 'ProjectDenied');
        cancel(entry);
        return;
      }
      setEntry(entry, 'joining');
      if (!isCurrent(entry)) return;
      entry.nativeStarted = true;
      entry.request = Object.freeze({
        ...ref(entry.source),
        observerId,
        enrollmentRequestId: crypto.randomUUID(),
        bindingEpoch: entry.source.bindingEpoch,
        // Identical policy updates keep this entry but advance the native revision.
        policyRevision: current!.policyRevision,
      });
      const result = await ports.native.ensureExistingParticipant(
        entry.request,
        entry.abort.signal,
      );
      // Teardown already cancelled this exact request. Never retire admission or
      // native-owned Joined membership in response to an old observer result.
      if (!isCurrent(entry)) return;
      if (
        record(result, ['ok', 'code']) &&
        result.ok === false &&
        nativeErrors.has(result.code as RelayParticipationError)
      ) {
        const code = result.code as RelayParticipationError;
        setEntry(
          entry,
          code === 'SetupRequired'
            ? 'setup-required'
            : code === 'Busy'
              ? 'pending'
              : code === 'Off'
                ? 'off'
                : code === 'Excluded'
                  ? 'excluded'
                  : 'denied',
          code,
        );
        return;
      }
      const observed =
        record(result, ['ok', 'lease']) && result.ok === true ? copyLease(result.lease) : null;
      if (
        !observed ||
        admission(observed) !== admission(entry.source) ||
        observed.status !== 'Joined' ||
        observed.bindingEpoch === '0' ||
        compare(observed.bindingEpoch, entry.source.bindingEpoch) < 0
      ) {
        setEntry(entry, 'failed', 'InvalidInput');
        cancel(entry);
        return;
      }
      const stillAllowed = await ports.authorizeProject(
        entry.source.scope,
        entry.source.accountEpoch,
        entry.abort.signal,
      );
      if (!isCurrent(entry)) return;
      if (stillAllowed !== true) {
        setEntry(entry, 'denied', 'ProjectDenied');
        cancel(entry);
        return;
      }
      setEntry(entry, 'joined', undefined, observed);
    } catch {
      // Only bounded enum codes enter UI state; do not retain transport errors.
      setEntry(entry, 'failed', 'PermissionDenied');
    }
  };
  const clear = () => {
    for (const entry of entries.values()) cancel(entry);
    entries.clear();
  };
  return {
    update(raw) {
      if (disposed) return false;
      let next: RelayParticipationInput | null;
      try {
        next = copyInput(raw);
      } catch {
        next = null;
      }
      if (!next) {
        clear();
        error = 'InvalidInput';
        publish();
        return false;
      }
      if (current) {
        const epochOrder = compare(next.accountEpoch, current.accountEpoch);
        if (epochOrder < 0) return false;
        if (epochOrder === 0) {
          if (next.accountId !== current.accountId) {
            clear();
            error = 'InvalidInput';
            publish();
            return false;
          }
          if (
            compare(next.revision, current.revision) < 0 ||
            compare(next.policyRevision, current.policyRevision) < 0 ||
            compare(next.authorizationRevision, current.authorizationRevision) < 0
          )
            return false;
          if (
            next.policyRevision === current.policyRevision &&
            JSON.stringify(next.policy) !== JSON.stringify(current.policy)
          ) {
            clear();
            error = 'InvalidInput';
            publish();
            return false;
          }
          if (next.revision === current.revision) {
            if (JSON.stringify(next) === JSON.stringify(current)) return !error;
            clear();
            error = 'InvalidInput';
            publish();
            return false;
          }
          for (const value of next.leases) {
            const old = entries.get(value.id)?.source;
            if (
              old &&
              (admission(old) !== admission(value) ||
                compare(value.bindingEpoch, old.bindingEpoch) < 0)
            ) {
              clear();
              error = 'InvalidInput';
              publish();
              return false;
            }
          }
        } else clear();
      }
      current = next;
      error = undefined;
      const desired = new Set(next.leases.map((value) => value.id));
      for (const [id, entry] of entries)
        if (!desired.has(id)) {
          cancel(entry);
          entries.delete(id);
        }
      const pending: Entry[] = [];
      for (const value of next.leases) {
        const signature = JSON.stringify([value, next.policy, next.authorizationRevision]);
        const old = entries.get(value.id);
        if (old?.signature === signature) continue;
        // Feedback from the same native enrollment is not a new subject. Keep
        // its pending completion/project recheck rather than aborting/rejoining.
        if (
          old &&
          old.signature === JSON.stringify([old.source, next.policy, next.authorizationRevision]) &&
          ((old.nativeStarted && old.state.phase === 'joining' && value.status !== 'Pending') ||
            (old.state.phase === 'joined' &&
              JSON.stringify(value) === JSON.stringify(old.state.lease)))
        ) {
          old.source = value;
          old.signature = signature;
          old.state = Object.freeze({ ...old.state, lease: value });
          continue;
        }
        if (old) cancel(old);
        const phase =
          next.policy.scope === 'Off'
            ? 'off'
            : next.policy.excludedProjects.includes(value.scope.projectId) ||
                next.policy.excludedSessions.includes(session(value))
              ? 'excluded'
              : 'authorizing';
        const entry: Entry = {
          source: value,
          signature,
          abort: new AbortController(),
          nativeStarted: false,
          cancellationSent: false,
          state: Object.freeze({ lease: value, phase, automaticMessages: 'disabled' }),
        };
        entries.set(value.id, entry);
        if (phase === 'authorizing') pending.push(entry);
      }
      publish();
      for (const entry of pending) if (isCurrent(entry)) track(enroll(entry));
      return true;
    },
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async whenIdle() {
      while (tasks.size) await Promise.all([...tasks]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      listeners.clear();
      publish();
    },
  };
}
