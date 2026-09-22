import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import {
  getDiscoveredConnectionModels,
  subscribeDiscoveredConnectionModels,
  type DiscoveredConnectionModel,
} from '@/lib/ai/connectionCatalog';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { db, type JarvisDexie } from '@/lib/db';
import { contextSelectionSettingKey } from '@/features/context/migration';
import type { ContextMapRecordV2 } from '@/features/context/contracts';
import { createJevClient } from '@/lib/jev/client';
import type { JevClient } from '@/lib/jev/contracts';
import {
  loadJevSettings,
  testJevConnection,
  type JevConnectionTestResult,
  type JevSettings,
} from '@/lib/jev/settings';
import { createJevUsageEventWriter } from '@/lib/jev/usageEventWriter';
import { useAuthStore } from '@/stores/auth';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import type {
  CaoMission,
  CaoMissionScope,
  CaoMissionStore,
  CaoMissionWorker,
} from './mission/types';
import { createCaoMissionStoreFromDatabase } from './mission/missionStore';
import {
  selectCaoExecutionProfile,
  type CaoExecutionProfile,
  type CaoExecutionIdentity,
  type CaoLiveExecutionCatalog,
  type CaoExecutionBackend,
} from './executionProfile';
import {
  dispatchCaoAssignmentThroughAuthority,
  dispatchCaoWakeToMainBrain,
  type CaoAssignmentDispatchInput,
  type CaoWakeDispatchResult,
  type CaoWakeDispatchContext,
} from './mission/productionController';
import { createCaoChatSnapshotAdapter } from './sentinel/chatSnapshotAdapter';
import {
  createCaoTerminalSnapshotAdapter,
  type CaoTerminalSnapshotIdentityReader,
} from './sentinel/terminalSnapshotAdapter';
import { createCaoSentinelRuntime } from './sentinel/sentinelRuntime';
import { createCaoSentinelScheduler } from './sentinel/sentinelScheduler';
import type {
  CaoCandidateDispatchResult,
  CaoCandidateMessage,
  CaoSentinelObservation,
  CaoSentinelTrigger,
  CaoTargetSnapshot,
  CaoWakePacket,
} from './sentinel/types';

export type CaoProductionScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

type ActiveMission = CaoMission & Readonly<{ status: 'running' | 'verifying' }>;

type LifecycleTimerHandle = ReturnType<typeof setInterval>;

type TargetRequest = Readonly<{
  scope: CaoProductionScope;
  mission: CaoMission;
  worker: CaoMissionWorker;
  profile: CaoExecutionProfile;
  signal: AbortSignal;
}>;

export type CaoContextRevisionRequest = Readonly<{
  accountId: string;
  projectId: string | null;
  contextMapId: string | null;
}>;

type CreateJevRequest = TargetRequest &
  Readonly<{
    event: 'event' | 'sweep';
    jevModelId: string;
    getEvent?: () => 'event' | 'sweep';
  }>;

type CaoCandidateDispatchInput = CaoAssignmentDispatchInput &
  Readonly<{
    candidate: CaoCandidateMessage;
    observation: CaoSentinelObservation;
    trigger: CaoSentinelTrigger;
  }>;

export type CaoProductionLifecycleDependencies = Readonly<{
  database?: JarvisDexie;
  missionStore?: CaoMissionStore;
  readScope?: () => CaoProductionScope | null;
  isEnabled?: (scope: CaoProductionScope) => boolean;
  loadSettings?: (scope: CaoProductionScope) => Promise<JevSettings>;
  testConnection?: (scope: CaoProductionScope) => Promise<JevConnectionTestResult>;
  readLiveCatalog?: (scope: CaoProductionScope) => Promise<CaoLiveExecutionCatalog>;
  listMissions?: (scope: CaoProductionScope) => Promise<readonly CaoMission[]>;
  persistProfile?: (profile: CaoExecutionProfile) => Promise<void>;
  createJev?: (request: CreateJevRequest) => Promise<Pick<JevClient, 'evaluate'>>;
  readSnapshot?: (request: TargetRequest) => Promise<CaoTargetSnapshot>;
  onObservation?: (
    observation: CaoSentinelObservation,
    trigger: CaoSentinelTrigger,
  ) => Promise<void> | void;
  persistObservation?: (
    scope: CaoMissionScope,
    mission: CaoMission,
    observation: CaoSentinelObservation,
  ) => Promise<void> | void;
  dispatchCandidate?: (input: CaoCandidateDispatchInput) => Promise<CaoCandidateDispatchResult>;
  onWake?: (
    packet: CaoWakePacket,
    context?: CaoWakeDispatchContext,
  ) => Promise<CaoWakeDispatchResult | void> | CaoWakeDispatchResult | void;
  subscribeReceipts?: (scope: CaoProductionScope, listener: () => void) => () => void;
  subscribeMissions?: (scope: CaoProductionScope, listener: () => void) => () => void;
  subscribeCatalog?: (listener: () => void) => () => void;
  now?: () => number;
  setInterval?: (handler: () => void, timeoutMs: number) => LifecycleTimerHandle;
  clearInterval?: (handle: LifecycleTimerHandle) => void;
  debounceMs?: number;
  sweepMs?: number;
}>;

type TargetRuntime = Readonly<{
  key: string;
  mission: CaoMission;
  worker: CaoMissionWorker;
  profile: CaoExecutionProfile;
  readSnapshot: () => Promise<CaoTargetSnapshot>;
  observe: ReturnType<typeof createCaoSentinelRuntime>;
  setEvent: (event: 'event' | 'sweep') => void;
}>;

type TimerApi = Readonly<{
  setInterval: (handler: () => void, timeoutMs: number) => LifecycleTimerHandle;
  clearInterval: (handle: LifecycleTimerHandle) => void;
}>;

const DEFAULT_SWEEP_MS = 30_000;

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function scopedKey(scope: CaoProductionScope): string {
  return `${scope.accountId}\u0000${scope.workspaceId}`;
}

function targetKey(scope: CaoProductionScope, missionId: string, targetId: string): string {
  return `${scopedKey(scope)}\u0000${missionId}\u0000${targetId}`;
}

function activeMission(mission: CaoMission): mission is ActiveMission {
  return mission.status === 'running' || mission.status === 'verifying';
}

function activeWorker(worker: CaoMissionWorker): boolean {
  return worker.status === 'assigned' || worker.status === 'running' || worker.status === 'waiting';
}

function effectWorker(worker: CaoMissionWorker): boolean {
  return worker.status === 'assigned' || worker.status === 'running';
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readFreshEffectTarget(
  store: CaoMissionStore,
  scope: CaoProductionScope,
  mission: CaoMission,
  worker: CaoMissionWorker,
  signal: AbortSignal,
): Promise<{ mission: CaoMission; worker: CaoMissionWorker }> {
  signal.throwIfAborted();
  const current = await store.get({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    projectId: mission.projectId,
    missionId: mission.id,
  });
  const currentWorker = current?.workers.find(
    (candidate) => candidate.targetId === worker.targetId,
  );
  if (
    !current ||
    !activeMission(current) ||
    !currentWorker ||
    !effectWorker(currentWorker) ||
    currentWorker.kind !== worker.kind ||
    currentWorker.backend !== worker.backend ||
    currentWorker.connectionId !== worker.connectionId ||
    currentWorker.modelId !== worker.modelId ||
    currentWorker.reasoningEffort !== worker.reasoningEffort ||
    currentWorker.assignment !== worker.assignment ||
    !sameStringList(currentWorker.ownedPaths, worker.ownedPaths)
  ) {
    throw new Error('cao_mission_target_inactive');
  }
  signal.throwIfAborted();
  return { mission: current, worker: currentWorker };
}

async function persistMissionObservation(
  store: CaoMissionStore,
  scope: CaoProductionScope,
  mission: CaoMission,
  observation: CaoSentinelObservation,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await store.get({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: mission.projectId,
      missionId: mission.id,
    });
    if (!current || current.status === 'cancelled') return;
    const worker = current.workers.find((candidate) => candidate.targetId === observation.targetId);
    if (!worker) return;
    const revision = Math.max(worker.lastObservedRevision ?? -1, observation.targetRevision);
    if (worker.lastObservedRevision === revision) return;
    const next = Object.freeze({
      ...current,
      workers: Object.freeze(
        current.workers.map((candidate) =>
          candidate.targetId === observation.targetId
            ? Object.freeze({ ...candidate, lastObservedRevision: revision })
            : candidate,
        ),
      ),
      updatedAt: Math.max(current.updatedAt, observation.observedAt),
    });
    if (await store.compareAndSave({ expected: current, next })) return;
  }
}

async function persistCandidateApproval(
  store: CaoMissionStore,
  scope: CaoProductionScope,
  mission: CaoMission,
  targetId: string,
  result: Readonly<{
    status: 'sent' | 'awaiting_approval';
    proposalId?: string;
  }>,
  now: () => number,
): Promise<void> {
  if (result.status !== 'awaiting_approval' || !result.proposalId) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await store.get({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: mission.projectId,
      missionId: mission.id,
    });
    if (!current || current.status === 'cancelled') return;
    const worker = current.workers.find((candidate) => candidate.targetId === targetId);
    if (!worker || (worker.status === 'waiting' && worker.proposalId === result.proposalId)) return;
    if (worker.status !== 'running' && worker.status !== 'assigned') return;
    const next = Object.freeze({
      ...current,
      workers: Object.freeze(
        current.workers.map((candidate) =>
          candidate.targetId === targetId
            ? Object.freeze({
                ...candidate,
                status: 'waiting' as const,
                proposalId: result.proposalId,
              })
            : candidate,
        ),
      ),
      updatedAt: now(),
    });
    if (await store.compareAndSave({ expected: current, next })) return;
  }
}

function normalizeVariants(model: DiscoveredConnectionModel): readonly string[] {
  if (!Array.isArray(model.variants)) return [];
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const value of model.variants) {
    if (!validText(value) || value.length > 64 || seen.has(value.trim())) continue;
    seen.add(value.trim());
    variants.push(value.trim());
  }
  return variants;
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('cao_execution_catalog_crypto_unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function liveModelEntries(
  connectionId: string,
  backend: CaoExecutionBackend,
  providerId: string,
  models: readonly DiscoveredConnectionModel[],
): readonly CaoExecutionIdentity[] {
  const entries: CaoExecutionIdentity[] = [];
  for (const model of models) {
    if (
      !validText(model.id) ||
      model.id.length > 256 ||
      model.source === 'stale_fallback' ||
      model.unverified === true ||
      !Number.isSafeInteger(model.lastVerifiedAt) ||
      model.lastVerifiedAt < 0
    ) {
      continue;
    }
    for (const reasoningEffort of normalizeVariants(model)) {
      entries.push({
        backend,
        providerId,
        connectionId,
        modelId: model.id.trim(),
        reasoningEffort,
      });
    }
  }
  return entries;
}

/** Build a receipt from the current verified connection catalog only. */
export async function readLiveCaoExecutionCatalog(
  scope: CaoProductionScope,
): Promise<CaoLiveExecutionCatalog> {
  const routes = [
    {
      connectionId: CODEX_CLI_CONNECTION.id,
      providerId: CODEX_CLI_CONNECTION.providerId,
      backend: 'codex' as const,
    },
    {
      connectionId: OPENCODE_CLI_CONNECTION.id,
      providerId: OPENCODE_CLI_CONNECTION.providerId,
      backend: 'opencode' as const,
    },
  ];
  const entries = routes
    .flatMap((route) =>
      liveModelEntries(
        route.connectionId,
        route.backend,
        route.providerId,
        getDiscoveredConnectionModels(route.connectionId),
      ),
    )
    .sort((left, right) =>
      [left.connectionId, left.modelId, left.reasoningEffort]
        .join('\u0000')
        .localeCompare([right.connectionId, right.modelId, right.reasoningEffort].join('\u0000')),
    );
  if (entries.length === 0) throw new Error('cao_execution_catalog_unavailable');
  const verifiedAt = Math.max(
    ...routes.flatMap((route) =>
      getDiscoveredConnectionModels(route.connectionId)
        .filter(
          (model) =>
            model.source !== 'stale_fallback' &&
            model.unverified !== true &&
            Number.isSafeInteger(model.lastVerifiedAt) &&
            model.lastVerifiedAt >= 0,
        )
        .map((model) => model.lastVerifiedAt),
    ),
  );
  const canonical = JSON.stringify(entries);
  const catalogHash = await sha256Hex(canonical);
  return Object.freeze({
    source: 'live',
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    catalogGeneration: `live-${verifiedAt}-${catalogHash.slice(0, 16)}`,
    catalogHash,
    verifiedAt,
    entries: Object.freeze(entries),
  });
}

function defaultScope(): CaoProductionScope | null {
  const account = getActiveAccountIdentity()?.accountId.trim();
  const workspace = useAuthStore.getState().workspaceId;
  return account && workspace?.trim()
    ? { accountId: account, workspaceId: workspace.trim() }
    : null;
}

function defaultEnabled(scope: CaoProductionScope): boolean {
  const state = useJarvisLearningStore.getState();
  return (
    state.activeAccountId === scope.accountId && state.profiles[scope.accountId]?.enabled === true
  );
}

function defaultListMissions(database: JarvisDexie) {
  const store = createCaoMissionStoreFromDatabase(database);
  return (scope: CaoProductionScope) => store.list(scope);
}

function contextMapRevision(
  accountId: string,
  projectId: string | null,
  map: ContextMapRecordV2 | undefined,
): string | null {
  if (
    !map ||
    map.accountId !== accountId ||
    (map.projectId ?? null) !== projectId ||
    map.status !== 'active' ||
    !Number.isSafeInteger(map.knowledgeRevision) ||
    map.knowledgeRevision < 0
  ) {
    return null;
  }
  // Keep the CAO revision in the same opaque form used by the Context
  // revision cache. It identifies the scoped map and its current knowledge
  // revision without copying map summaries, nodes, or transcript content.
  return `${accountId}\u001d${map.id}@${map.knowledgeRevision}`;
}

function selectedMapId(value: unknown, request: CaoContextRevisionRequest): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const selection = value as {
    version?: unknown;
    accountId?: unknown;
    projectId?: unknown;
    selectedMapId?: unknown;
  };
  if (
    selection.version !== 2 ||
    selection.accountId !== request.accountId ||
    selection.projectId !== request.projectId ||
    typeof selection.selectedMapId !== 'string' ||
    selection.selectedMapId.length === 0
  ) {
    return null;
  }
  return selection.selectedMapId;
}

export async function readCaoContextRevision(
  database: Pick<JarvisDexie, 'context_maps' | 'settings'>,
  request: CaoContextRevisionRequest,
): Promise<string | null> {
  if (request.contextMapId) {
    return contextMapRevision(
      request.accountId,
      request.projectId,
      await database.context_maps.get(request.contextMapId),
    );
  }

  const selection = await database.settings.get(
    contextSelectionSettingKey(request.accountId, request.projectId),
  );
  const preferredId = selectedMapId(selection?.value, request);
  if (preferredId) {
    const preferred = contextMapRevision(
      request.accountId,
      request.projectId,
      await database.context_maps.get(preferredId),
    );
    if (preferred) return preferred;
  }

  const maps = await database.context_maps.where('accountId').equals(request.accountId).toArray();
  const fallback = maps
    .filter(
      (map) =>
        map.status === 'active' &&
        map.accountId === request.accountId &&
        (map.projectId ?? null) === request.projectId,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
  return contextMapRevision(request.accountId, request.projectId, fallback);
}

export function defaultReadSnapshot(database: JarvisDexie) {
  return async (request: TargetRequest): Promise<CaoTargetSnapshot> => {
    const identity = request.profile;
    let readExecutionIdentity: CaoTerminalSnapshotIdentityReader | undefined;
    if (request.worker.kind === 'terminal') {
      const [{ listCaoTerminals }, { readCaoTerminalExecutionIdentity }] = await Promise.all([
        import('./terminalControlProduction'),
        import('./terminalExecutionIdentity'),
      ]);
      const target = (
        await listCaoTerminals(request.scope.accountId, request.mission.projectId)
      ).find(
        (candidate) =>
          candidate.sessionId === request.worker.targetId &&
          candidate.projectId === request.mission.projectId,
      );
      if (!target?.projectId) throw new Error('cao_terminal_snapshot_identity_unavailable');
      const binding = {
        accountId: request.scope.accountId,
        projectId: target.projectId,
        paneId: target.paneId,
        sessionId: target.sessionId,
        process: target.processIdentity,
      };
      readExecutionIdentity = () => readCaoTerminalExecutionIdentity(binding);
    }
    const adapter =
      request.worker.kind === 'chat'
        ? createCaoChatSnapshotAdapter({ database, identity })
        : createCaoTerminalSnapshotAdapter({ database, identity, readExecutionIdentity });
    const contextRevision = await readCaoContextRevision(database, {
      accountId: request.scope.accountId,
      projectId: request.mission.projectId,
      contextMapId: request.mission.contextMapId,
    });
    return adapter({
      missionId: request.mission.id,
      accountId: request.scope.accountId,
      workspaceId: request.scope.workspaceId,
      projectId: request.mission.projectId,
      targetId: request.worker.targetId,
      assignment: request.worker.assignment,
      ownedPaths: request.worker.ownedPaths,
      contextRevision,
    });
  };
}

function defaultReceiptSubscription(database: JarvisDexie) {
  return (_scope: CaoProductionScope, listener: () => void): (() => void) => {
    const onMessageCreating = () => listener();
    const onMessageUpdating = () => listener();
    const onTerminalCreating = () => listener();
    const onTerminalUpdating = () => listener();
    const onScrollbackCreating = () => listener();
    database.messages.hook('creating', onMessageCreating);
    database.messages.hook('updating', onMessageUpdating);
    database.terminal_sessions.hook('creating', onTerminalCreating);
    database.terminal_sessions.hook('updating', onTerminalUpdating);
    database.terminal_scrollback.hook('creating', onScrollbackCreating);
    return () => {
      database.messages.hook('creating').unsubscribe(onMessageCreating);
      database.messages.hook('updating').unsubscribe(onMessageUpdating);
      database.terminal_sessions.hook('creating').unsubscribe(onTerminalCreating);
      database.terminal_sessions.hook('updating').unsubscribe(onTerminalUpdating);
      database.terminal_scrollback.hook('creating').unsubscribe(onScrollbackCreating);
    };
  };
}

function defaultMissionSubscription(database: JarvisDexie) {
  return (_scope: CaoProductionScope, listener: () => void): (() => void) => {
    const onCreating = () => listener();
    const onUpdating = () => listener();
    const onDeleting = () => listener();
    database.cao_missions.hook('creating', onCreating);
    database.cao_missions.hook('updating', onUpdating);
    database.cao_missions.hook('deleting', onDeleting);
    return () => {
      database.cao_missions.hook('creating').unsubscribe(onCreating);
      database.cao_missions.hook('updating').unsubscribe(onUpdating);
      database.cao_missions.hook('deleting').unsubscribe(onDeleting);
    };
  };
}

function defaultCreateJev(database: JarvisDexie) {
  return async (request: CreateJevRequest): Promise<Pick<JevClient, 'evaluate'>> => {
    const { requestJevSystemOne } = await import('@/lib/security/jevCredentialStore');
    const usageWriter = createJevUsageEventWriter({
      database,
      accountId: request.scope.accountId,
      workspaceId: request.scope.workspaceId,
      projectId: request.mission.projectId,
      missionId: request.mission.id,
      targetId: request.worker.targetId,
      event: request.getEvent ?? request.event,
    });
    return createJevClient({
      model: request.jevModelId,
      transport: async ({ body }) => {
        const result = await requestJevSystemOne(body);
        if (result.kind !== 'ok') throw new Error('jev_native_transport_unavailable');
        return result.body;
      },
      onUsage: usageWriter,
    });
  };
}

function missionSignature(missions: readonly CaoMission[]): string {
  return JSON.stringify(
    missions.map((mission) => ({
      id: mission.id,
      projectId: mission.projectId,
      objective: mission.objective,
      status: mission.status,
      contextMapId: mission.contextMapId,
      latestPlanRevision: mission.latestPlanRevision,
      milestones: mission.milestones.map((milestone) => ({
        id: milestone.id,
        label: milestone.label,
        status: milestone.status,
      })),
      workers: mission.workers.map((worker) => ({
        targetId: worker.targetId,
        kind: worker.kind,
        backend: worker.backend,
        connectionId: worker.connectionId,
        modelId: worker.modelId,
        reasoningEffort: worker.reasoningEffort,
        assignment: worker.assignment,
        ownedPaths: worker.ownedPaths,
        status: worker.status,
        proposalId: worker.proposalId,
        approvalClaimId: worker.approvalClaimId,
        approvalOutcome: worker.approvalOutcome,
      })),
    })),
  );
}

function profileMatchesWorker(
  catalog: CaoLiveExecutionCatalog,
  scope: CaoProductionScope,
  worker: CaoMissionWorker,
): CaoExecutionProfile | undefined {
  const modelId = worker.modelId;
  const reasoningEffort = worker.reasoningEffort;
  const connectionId = worker.connectionId;
  if (!validText(modelId) || !validText(reasoningEffort) || !validText(connectionId))
    return undefined;
  const matches = catalog.entries.filter(
    (entry) =>
      entry.modelId === modelId.trim() &&
      entry.reasoningEffort === reasoningEffort.trim() &&
      entry.connectionId === connectionId.trim() &&
      (worker.backend === undefined || entry.backend === worker.backend),
  );
  if (matches.length !== 1) return undefined;
  return selectCaoExecutionProfile({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    catalog,
    modelId,
    reasoningEffort,
    backend: worker.backend,
    connectionId,
  });
}

function exactSnapshot(snapshot: CaoTargetSnapshot, request: TargetRequest): boolean {
  return (
    snapshot.accountId === request.scope.accountId &&
    snapshot.workspaceId === request.scope.workspaceId &&
    snapshot.projectId === request.mission.projectId &&
    snapshot.missionId === request.mission.id &&
    snapshot.targetId === request.worker.targetId &&
    snapshot.backend === request.profile.backend &&
    snapshot.providerId === request.profile.providerId &&
    snapshot.modelId === request.profile.modelId &&
    snapshot.reasoningEffort === request.profile.reasoningEffort
  );
}

function timerApi(input: CaoProductionLifecycleDependencies): TimerApi {
  return {
    setInterval: input.setInterval ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs)),
    clearInterval: input.clearInterval ?? ((handle) => clearInterval(handle)),
  };
}

export function createCaoProductionLifecycle(
  input: CaoProductionLifecycleDependencies = {},
): Readonly<{
  reconcile(): Promise<void>;
  refresh(trigger?: 'event' | 'sweep'): Promise<void>;
  stop(): void;
}> {
  const database = input.database ?? db;
  const readScope = input.readScope ?? defaultScope;
  const isEnabled = input.isEnabled ?? defaultEnabled;
  const loadSettingsForScope = input.loadSettings ?? loadJevSettings;
  const testConnectionForScope = input.testConnection ?? testJevConnection;
  const readCatalog = input.readLiveCatalog ?? readLiveCaoExecutionCatalog;
  const missionStore = input.missionStore ?? createCaoMissionStoreFromDatabase(database);
  const listMissions =
    input.listMissions ?? ((scope: CaoProductionScope) => missionStore.list(scope));
  const persistObservation =
    input.persistObservation ??
    ((scope: CaoMissionScope, mission: CaoMission, observation: CaoSentinelObservation) =>
      persistMissionObservation(missionStore, scope, mission, observation));
  const dispatchCandidate =
    input.dispatchCandidate ??
    ((candidate: CaoCandidateDispatchInput) => dispatchCaoAssignmentThroughAuthority(candidate));
  const createJev = input.createJev ?? defaultCreateJev(database);
  const readSnapshot = input.readSnapshot ?? defaultReadSnapshot(database);
  const subscribeReceipts = input.subscribeReceipts ?? defaultReceiptSubscription(database);
  const subscribeMissions = input.subscribeMissions ?? defaultMissionSubscription(database);
  const subscribeCatalog = input.subscribeCatalog ?? subscribeDiscoveredConnectionModels;
  const now = input.now ?? Date.now;
  const timers = timerApi(input);

  let stopped = false;
  let generation = 0;
  let activeKey: string | null = null;
  let activeScope: CaoProductionScope | null = null;
  let controller: AbortController | null = null;
  let scheduler: ReturnType<typeof createCaoSentinelScheduler> | null = null;
  let sweepTimer: LifecycleTimerHandle | null = null;
  let unsubscribeReceipts: (() => void) | null = null;
  let unsubscribeMissions: (() => void) | null = null;
  let unsubscribeCatalog: (() => void) | null = null;
  let missionStateSignature = '';
  let targets = new Map<string, TargetRuntime>();
  let reconcilePromise: Promise<void> | null = null;
  let reconcileQueued = false;
  let reconcileQueuedForce = false;

  const reset = (): void => {
    generation += 1;
    controller?.abort();
    controller = null;
    scheduler?.dispose();
    scheduler = null;
    if (sweepTimer !== null) timers.clearInterval(sweepTimer);
    sweepTimer = null;
    unsubscribeReceipts?.();
    unsubscribeReceipts = null;
    unsubscribeMissions?.();
    unsubscribeMissions = null;
    unsubscribeCatalog?.();
    unsubscribeCatalog = null;
    targets = new Map();
    missionStateSignature = '';
    activeKey = null;
    activeScope = null;
  };

  const refresh = async (trigger: 'event' | 'sweep' = 'event'): Promise<void> => {
    const localScheduler = scheduler;
    const scope = activeScope;
    const localController = controller;
    const localGeneration = generation;
    if (!localScheduler || !scope || !localController || localController.signal.aborted || stopped)
      return;
    const snapshots: CaoTargetSnapshot[] = [];
    for (const target of targets.values()) {
      if (stopped || localGeneration !== generation || localController.signal.aborted) return;
      try {
        const request: TargetRequest = {
          scope,
          mission: target.mission,
          worker: target.worker,
          profile: target.profile,
          signal: localController.signal,
        };
        const snapshot = await target.readSnapshot();
        if (!exactSnapshot(snapshot, request) || snapshot.runStatus === 'idle') continue;
        target.setEvent(trigger);
        snapshots.push(snapshot);
      } catch {
        // A deleted or scope-mismatched target is omitted from this cycle. The
        // next receipt/sweep re-reads durable truth before any Jev call.
      }
    }
    if (stopped || localGeneration !== generation || localController.signal.aborted) return;
    if (trigger === 'sweep') {
      await localScheduler.sweep(snapshots);
    } else {
      for (const snapshot of snapshots) localScheduler.notify(snapshot, trigger);
    }
  };

  const buildRuntime = async (
    scope: CaoProductionScope,
    mission: CaoMission,
    worker: CaoMissionWorker,
    profile: CaoExecutionProfile,
    signal: AbortSignal,
    localGeneration: number,
    jevModelId: string,
  ): Promise<TargetRuntime | undefined> => {
    const key = targetKey(scope, mission.id, worker.targetId);
    let currentEvent: 'event' | 'sweep' = 'sweep';
    const jev = await createJev({
      scope,
      mission,
      worker,
      profile,
      signal,
      event: 'sweep',
      jevModelId,
      getEvent: () => currentEvent,
    });
    if (stopped || localGeneration !== generation || signal.aborted) return undefined;
    const read = async () => {
      const snapshot = await readSnapshot({ scope, mission, worker, profile, signal });
      if (!exactSnapshot(snapshot, { scope, mission, worker, profile, signal })) {
        throw new Error('cao_snapshot_scope_mismatch');
      }
      return snapshot;
    };
    const runtime = createCaoSentinelRuntime({
      jev,
      now,
      onObservation: async (observation, trigger) => {
        try {
          await persistObservation(
            { ...scope, projectId: mission.projectId },
            mission,
            observation,
          );
        } catch {
          // Observation persistence is durable evidence, but must not turn a
          // valid Sentinel decision into an effects failure.
        }
        await input.onObservation?.(observation, trigger);
      },
      onCandidate: async (candidate, candidateInput) => {
        if (
          candidate.targetId !== worker.targetId ||
          candidateInput.snapshot.missionId !== mission.id ||
          candidateInput.snapshot.targetId !== worker.targetId ||
          candidateInput.decision.action !== 'use_candidate_message' ||
          !exactSnapshot(candidateInput.snapshot, { scope, mission, worker, profile, signal })
        ) {
          throw new Error('cao_candidate_scope_mismatch');
        }
        const fresh = await readFreshEffectTarget(missionStore, scope, mission, worker, signal);
        const result = await dispatchCandidate({
          scope: { ...scope, projectId: fresh.mission.projectId },
          mission: fresh.mission,
          worker: Object.freeze({ ...fresh.worker, assignment: candidate.body }),
          signal,
          candidate,
          observation: candidateInput.observation,
          trigger: candidateInput.trigger,
        });
        if (result.status === 'awaiting_approval' && result.proposalId) {
          try {
            await persistCandidateApproval(
              missionStore,
              scope,
              fresh.mission,
              worker.targetId,
              result,
              now,
            );
          } catch {
            // The authority result remains truthful even when the local
            // mission projection is temporarily unavailable.
          }
        }
        return result;
      },
      onWake: async (packet) => {
        if (stopped || localGeneration !== generation || signal.aborted) return;
        await readFreshEffectTarget(missionStore, scope, mission, worker, signal);
        const snapshot = await read();
        const fresh = await readFreshEffectTarget(missionStore, scope, mission, worker, signal);
        const context: CaoWakeDispatchContext = {
          scope: { ...scope, projectId: fresh.mission.projectId },
          mission: fresh.mission,
          worker: fresh.worker,
          profile,
          snapshot,
          packet,
          signal,
        };
        const result = input.onWake
          ? await input.onWake(packet, context)
          : await dispatchCaoWakeToMainBrain(context, {
              revalidateWake: async (current) => {
                const currentFresh = await readFreshEffectTarget(
                  missionStore,
                  scope,
                  current.mission,
                  current.worker,
                  signal,
                );
                return {
                  ...current,
                  scope: { ...scope, projectId: currentFresh.mission.projectId },
                  mission: currentFresh.mission,
                  worker: currentFresh.worker,
                };
              },
            });
        if (result?.status === 'awaiting_approval' && result.proposalId) {
          try {
            await persistCandidateApproval(
              missionStore,
              scope,
              context.mission,
              context.worker.targetId,
              result,
              now,
            );
          } catch {
            // The authority result remains truthful even when the local
            // mission projection is temporarily unavailable.
          }
        }
      },
    });
    return {
      key,
      mission,
      worker,
      profile,
      readSnapshot: read,
      observe: runtime,
      setEvent: (event) => {
        currentEvent = event;
      },
    };
  };

  const rebuild = async (
    scope: CaoProductionScope,
    localGeneration: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const settings = await loadSettingsForScope(scope);
    if (stopped || localGeneration !== generation || signal.aborted) return;
    if (!settings.hasKey) return;
    let connected = settings.connected;
    if (!connected) {
      const connection = await testConnectionForScope(scope);
      connected = connection.kind === 'connected';
    }
    if (!connected) return;
    const catalog = await readCatalog(scope);
    const missions = (await listMissions(scope)).filter(activeMission);
    const nextTargets = new Map<string, TargetRuntime>();
    for (const mission of missions) {
      for (const worker of mission.workers) {
        if (!activeWorker(worker)) continue;
        let profile: CaoExecutionProfile;
        try {
          const selected = profileMatchesWorker(catalog, scope, worker);
          if (!selected) continue;
          profile = selected;
        } catch {
          continue;
        }
        const target = await buildRuntime(
          scope,
          mission,
          worker,
          profile,
          signal,
          localGeneration,
          settings.modelId,
        );
        if (target) nextTargets.set(target.key, target);
      }
    }
    if (stopped || localGeneration !== generation || signal.aborted) return;
    targets = nextTargets;
    missionStateSignature = missionSignature(missions);
    scheduler = createCaoSentinelScheduler({
      debounceMs: input.debounceMs,
      sweepMs: input.sweepMs ?? DEFAULT_SWEEP_MS,
      now,
      observe: async (snapshot, trigger) => {
        if (stopped || localGeneration !== generation || signal.aborted) return;
        const target = targets.get(targetKey(scope, snapshot.missionId, snapshot.targetId));
        if (!target) return;
        target.setEvent(trigger === 'sweep' ? 'sweep' : 'event');
        await target.observe.observe(snapshot, trigger);
      },
    });
    unsubscribeReceipts = subscribeReceipts(scope, () => {
      queueReconcile();
      void refresh('event');
    });
    unsubscribeMissions = subscribeMissions(scope, () => {
      queueReconcile();
    });
    unsubscribeCatalog = subscribeCatalog(() => {
      queueReconcile(true);
    });
    sweepTimer = timers.setInterval(() => {
      void refresh('sweep');
    }, input.sweepMs ?? DEFAULT_SWEEP_MS);
    await refresh('sweep');
  };

  const reconcile = async (force = false): Promise<void> => {
    if (stopped) return;
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      const scope = readScope();
      const enabled = scope !== null && isEnabled(scope);
      if (!scope || !enabled) {
        if (activeKey !== null) reset();
        return;
      }
      const key = scopedKey(scope);
      let missionStateChanged = false;
      if (!force && activeKey === key && scheduler !== null) {
        const missions = (await listMissions(scope)).filter(activeMission);
        missionStateChanged = missionSignature(missions) !== missionStateSignature;
        if (!missionStateChanged) return;
      }
      if (activeKey !== key || force || missionStateChanged) reset();
      activeKey = key;
      activeScope = scope;
      const localGeneration = generation;
      const localController = new AbortController();
      controller = localController;
      try {
        await rebuild(scope, localGeneration, localController.signal);
      } catch {
        if (activeKey === key && localGeneration === generation) reset();
      }
    })().finally(() => {
      const rerun = reconcileQueued;
      const rerunForce = reconcileQueuedForce;
      reconcileQueued = false;
      reconcileQueuedForce = false;
      reconcilePromise = null;
      if (rerun && !stopped) queueReconcile(rerunForce);
    });
    return reconcilePromise;
  };

  function queueReconcile(force = false): void {
    if (stopped) return;
    if (reconcilePromise) {
      reconcileQueued = true;
      reconcileQueuedForce ||= force;
      return;
    }
    void reconcile(force);
  }

  const unsubscribeAuth = useAuthStore.subscribe(() => {
    queueReconcile();
  });
  const unsubscribeLearning = useJarvisLearningStore.subscribe(() => {
    queueReconcile();
  });
  queueReconcile();

  return Object.freeze({
    reconcile: () => reconcile(),
    refresh,
    stop(): void {
      if (stopped) return;
      stopped = true;
      reset();
      unsubscribeAuth();
      unsubscribeLearning();
    },
  });
}

export function startCaoProductionLifecycle(
  input?: CaoProductionLifecycleDependencies,
): () => void {
  const lifecycle = createCaoProductionLifecycle(input);
  return lifecycle.stop;
}
