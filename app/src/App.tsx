/**
 * Jarvis - root App component.
 *
 * Composes:
 *   <AuthGate>            - generates local user, seeds DB, gates onboarding
 *     <AppShell>          - the three-pane chrome (TopBar, Nav, Inspector, etc.)
 *       <ActiveCanvas />  - dispatches chat / council / doc / code mode
 *     </AppShell>
 *     <CommandPalette />  - global Cmd+K
 *     <SettingsModal />   - Cmd+, target
 *     <VoiceModal />      - Cmd+Space target
 *     <GlowBorder />      - screen-edge glow during voice listening
 *     <AmbientHome />     - V2 idle takeover with breathing orb + clock
 *     <Toaster />         - in-app toast outlet
 *   </AuthGate>
 *
 * Plus boot effects:
 *   - openDb + seedIfEmpty (no-throw)
 *   - registerMany default agents into the agent runtime store
 *   - register the chat -> AI runtime listener (jarvis:send / jarvis:cancel)
 *   - useGlobalHotkeys() to wire every HOTKEY -> palette action
 *   - useIdleDetection() to flip ambient mode on inactivity (V2)
 */
import * as React from 'react';
import { liveQuery } from 'dexie';
import {
  applyAppBrightnessToDocument,
  applyThemeToDocument,
  resolveTheme,
  useUIStore,
  type Route,
} from '@/stores/ui';
import { handleVoiceModuleClosed, syncVoiceModuleOpenState } from '@/features/voice/voiceRouter';
import { useAgentStore } from '@/stores/agents';
import { AuthGate } from '@/features/auth';
import { SignInDialog, type RecoveryPasswordSession } from '@/features/auth/SignInDialog';
import {
  abandonRecoverySessionOwnership,
  consumeRecoveryCallbackOnce,
  type RecoveryCallbackResult,
} from '@/features/auth/recoveryCallback';
import { getSupabaseClient } from '@/lib/supabase/client';
import {
  AccessAppHost,
  InstalledAccessAppHost,
  type AccessAppRuntime,
} from '@/features/access/AccessAppHost';
import { AccessBanner } from '@/features/access/AccessBanner';
import { AccessPaywall } from '@/features/access/AccessPaywall';
import { evaluateAppAccess } from '@/features/access/accessPolicy';
import { createAccessViewModel } from '@/features/access/accessViewModel';
import { AppShell } from '@/components/layout';
import { JarvisContextMenu } from '@/components/layout/JarvisContextMenu';
import { PageRouter } from '@/components/layout/PageRouter';
import { NavigationHistoryBoundary } from '@/features/navigation/NavigationHistoryBoundary';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { startNotificationLoop } from '@/features/tasks';
import { startClockEngine } from '@/features/clock/clockEngine';
import { WellnessBreak } from '@/features/wellness';
import { useGlobalHotkeys } from '@/features/command-palette';
import { WakeWordHost } from '@/features/voice/WakeWordHost';
import {
  ApiKeySaveBurst,
  fireApiKeySaveBurstFromElement,
} from '@/features/settings/ApiKeySaveBurst';
import { CallModal, startOutboundTrigger } from '@/features/call';
import { useBridgeLifecycle } from '@/lib/bridge/useBridgeLifecycle';
import { VibeSpaceMcpRuntimeHost } from '@/lib/bridge/VibeSpaceMcpRuntimeHost';
import { useIdleDetection, AmbientAudioHost } from '@/features/ambient';
import { useLinkHotkeys } from '@/features/launcher';
import { startWorkspaceAnalyticsClock } from '@/features/inspector/workspaceAnalytics';
import { GlobalSttHost } from '@/features/composer-stt';
import { FileExplorerHost } from '@/features/files';
import { Toaster, toast } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  createJarvisCommandCenterHostPort,
  getInstalledJarvisCommandCenterHostDependencies,
  openJarvisLiveEvidenceAccount,
  openJarvisVoiceRecovery,
  startRuntimeListener,
} from '@/lib/ai/runtime';
import {
  JarvisCommandCenter,
  JarvisCommandCenterProvider,
  type JarvisCommandCenterBinding,
} from '@/features/jarvis-command-center/JarvisCommandCenter';
import type {
  JarvisCommandCenterDataPort,
  JarvisCommandCenterHandlers,
} from '@/features/jarvis-command-center/types';
import { createJarvisCommandCenterDataPort } from '@/features/jarvis-command-center/commandCenterDataPort';
import { selectCurrentRun } from '@/features/jarvis-command-center/selectors';
import { PromptForgeControl } from '@/features/prompt-forge/PromptForgeControl';
import { startJarvisLearningListener } from '@/features/jarvis-memory/learningListener';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { startJarvisOperatorListener } from '@/lib/jarvis/operatorListener';
import { startAllAboutMePersistence } from '@/features/all-about-me/persistence';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { startJarvisTaskRunNotifications } from '@/features/jarvis-runs/taskRunNotifications';
import {
  resumeRecoverableJarvisRuns,
  type JarvisRecoveryPresentation,
} from '@/features/jarvis-runs/recoveryExecutor';
import { readLegacyJarvisTaskRunsOnce } from '@/features/jarvis-runs/taskRunPersistence';
import { useJarvisTaskRunStore, type JarvisTaskRun } from '@/features/jarvis-runs/taskRunStore';
import { privateAccountDirectory } from '@/features/jarvis-memory/accountStorage';
import type { ChatActivityEvent } from '@/features/chat/activity/types';
import { messageRepo, agentRepo, chatRepo, openDb, db, memoryEvidenceRepo } from '@/lib/db';
import {
  jarvisApprovalRepo,
  jarvisArtifactRepo,
  jarvisEventRepo,
  jarvisRunRepo,
} from '@/lib/db/jarvisRepositories';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import {
  createJarvisPersistenceCoordinator,
  type JarvisPersistenceReadyReceipt,
} from '@/lib/jarvis/persistenceCoordinator';
import { findProtectedJarvisAgent } from '@/lib/jarvis/identity';
import type {
  JarvisEvent,
  JarvisLiveEvidencePrimaryHostAccountSession,
  JarvisLiveSystemNode,
} from '@/lib/jarvis/contracts/execution';
import {
  projectJarvisRunForLegacyUi,
  type JarvisTaskRunProjection,
} from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';
import { projectJarvisEventsForLegacyActivity } from '@/lib/jarvis/executionJournal/legacyActivityProjection';
import { createJarvisRecoveryScanner } from '@/lib/jarvis/executionJournal';
import { recoverVoiceResponses as recoverBoundVoiceResponses } from '@/features/voice/voiceResponseRecovery';
import {
  activateSyncQueueCloudAuthority,
  releaseSyncQueueCloudAuthority,
  type SyncQueueCloudAuthorityLease,
} from '@/lib/cloudSyncQueueOwner';
import { getDefaultAgents } from '@/features/agents';
import { ensureActiveChat, branchChatFromMessage } from '@/features/chat/chatLifecycle';
import { MONOCHROME_CHAT_FIXTURE } from '@/features/chat/monochromeFixture';
import type { ChatId, MessageId } from '@/types/common';
import { useBoundHotkey } from '@/lib/hotkeys';
import { FullscreenHost } from '@/features/fullscreen';
import { DevConsoleHost } from '@/features/dev-console';
import { initTerminalScheduler } from '@/features/terminals/terminalScheduler';
import { revokeTerminalExecutionsForAccount } from '@/features/terminals/terminalExecutionStore';
import { TerminalCliRuntimeHost } from '@/features/terminals';
import { ToolGatewayHost } from '@/lib/harness/ToolGatewayHost';
import { startJarvisScheduleRunner } from '@/features/schedule/jarvisScheduleRunner';
import { UpdateWarningHost } from '@/features/updates/UpdateWarningHost';
import { BenchmarkRefreshHost } from '@/features/benchmarks/BenchmarkRefreshHost';
import {
  flushWorkspacePersistence,
  flushWorkspacePersistenceAndAcknowledge,
} from '@/lib/persistence/workspaceFlush';
import { GlobalDictationOverlay } from '@/features/global-dictation/GlobalDictationOverlay';
import { PluginManagementCapabilityProvider } from '@/features/plugins/managementContext';
import type { PluginManagementCapability } from '@/features/plugins/runtime';
import type { Agent, AgentId, Message } from '@/types';
import { KernelSmokeBindingHost } from '@/lib/jarvis/smoke/KernelSmokeBindingHost';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import {
  MONOCHROME_BASELINE_REQUEST_AUTHORITY,
  MONOCHROME_DEVELOPMENT_AUTHORITY_ID,
  createTauriMonochromeEvidenceCommit,
  createTauriRuntimeProfileQuery,
  parseMonochromeFixtureRequest,
  resolveRuntimePlan,
  resolveRuntimeProfileHandshakeExpectation,
  verifyRuntimeProfileHandshake,
  type MonochromeEvidenceCommit,
  type MonochromeEvidenceCommitRequest,
  type RuntimePlan,
  type RuntimeProfileQuery,
  type RuntimeProfileEvidence,
  type RuntimeProfileHandshakeExpectation,
  type MonochromeFixtureRequest,
  type MonochromeHandshakeEvidence,
} from '@/lib/runtimeProfile';
import { boundedMap } from '@/lib/concurrency/boundedMap';
import {
  CANONICAL_PROJECTION_READ_CONCURRENCY,
  canonicalProjectionLimits,
} from '@/stability/canonicalProjectionBudget';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

type SupabaseSessionLike = {
  user?: {
    id?: string;
    email?: string;
  };
  expires_at?: number;
} | null;

let accountScopeTeardownBarrier: Promise<void> = Promise.resolve();
let cloudSyncTeardownBarrier: Promise<void> = Promise.resolve();
let invalidateActiveKernelAccount: (accountId: string) => void = () => {};

export async function runRuntimeAdmittedLocalHydration<T>(
  plan: RuntimePlan,
  adapters: {
    openDatabase(): Promise<void>;
    listAgents(): Promise<readonly T[]>;
    registerAgents(agents: readonly T[]): void;
  },
): Promise<void> {
  if (!plan.persistenceEnabled) {
    adapters.registerAgents([]);
    return;
  }
  await adapters.openDatabase();
  const agents = await adapters.listAgents();
  adapters.registerAgents(agents);
}

function cloudSessionUserId(session: SupabaseSessionLike): string {
  return session?.user?.id?.trim() ?? '';
}

type CanonicalProjectionSubscriptionInput = {
  accountId: string;
  accountScope: string;
  isCurrent: () => boolean;
  onTransition: (event: JarvisEvent) => void;
  onError?: (error: unknown) => void;
};

export interface JarvisLegacyLifecycleAccountServices {
  deriveAccountScope(accountId: string): Promise<string>;
  readLegacyRuns(input: { accountId: string }): Promise<readonly JarvisTaskRun[]>;
  setAccountScope(scope: string): void;
  replaceLegacyRuns(scope: string, runs: readonly JarvisTaskRun[]): void;
  startNotifications(input: {
    subscribe: (listener: (event: JarvisEvent) => void) => () => void;
    onError?: (error: unknown) => void;
  }): () => void;
  startCanonicalProjection(input: CanonicalProjectionSubscriptionInput): () => void;
  resumeRecovery(input: {
    accountId: string;
    readyReceipt: JarvisPersistenceReadyReceipt;
    signal?: AbortSignal;
    isCurrent: () => boolean;
  }): Promise<number>;
}

export interface JarvisVoiceResponseRecoveryAccountServices {
  openLiveEvidenceAccount(accountId: string): Promise<JarvisLiveEvidencePrimaryHostAccountSession>;
  recoverVoiceResponses(input: { accountId: string }): Promise<unknown>;
}

export type JarvisVoiceRecoveryAccountSession = Readonly<{
  session: JarvisLiveEvidencePrimaryHostAccountSession;
  recover(): Promise<unknown>;
}>;

function reportLifecycleError(error: unknown): void {
  console.warn(
    '[jarvis-task] canonical lifecycle projection unavailable',
    error instanceof Error ? error.message : String(error),
  );
}

async function readCanonicalProjectionSnapshot(accountId: string): Promise<{
  runs: JarvisTaskRunProjection[];
  activityByChat: Record<string, readonly ChatActivityEvent[]>;
  events: JarvisEvent[];
}> {
  const runs = await jarvisRunRepo.listByAccount(accountId, { limit: 500 });
  const rows = await boundedMap(runs, CANONICAL_PROJECTION_READ_CONCURRENCY, async (run) => {
    const limits = canonicalProjectionLimits(run.status);
    const [events, artifacts] = await Promise.all([
      jarvisEventRepo.listByRun(accountId, run.id, { limit: limits.events }),
      jarvisArtifactRepo.listByRun(accountId, run.id, limits.artifacts),
    ]);
    return { run, events, artifacts };
  });
  const activityByChat: Record<string, ChatActivityEvent[]> = {};
  const projections: JarvisTaskRunProjection[] = [];
  const allEvents: JarvisEvent[] = [];
  for (const row of rows) {
    projections.push(projectJarvisRunForLegacyUi(row));
    allEvents.push(...row.events);
    for (const activity of projectJarvisEventsForLegacyActivity({
      run: row.run,
      events: row.events,
      limit: 500,
    })) {
      const chatId = String(activity.chatId);
      const existing = activityByChat[chatId] ?? [];
      existing.push(activity);
      activityByChat[chatId] = existing;
    }
  }
  for (const [chatId, events] of Object.entries(activityByChat)) {
    activityByChat[chatId] = events.sort((left, right) => left.ts - right.ts).slice(-500);
  }
  return { runs: projections, activityByChat, events: allEvents };
}

function startCanonicalJarvisProjection(input: CanonicalProjectionSubscriptionInput): () => void {
  let initialized = false;
  let seenEvents = new Set<string>();
  const subscription = liveQuery(() => readCanonicalProjectionSnapshot(input.accountId)).subscribe({
    next(snapshot) {
      if (!input.isCurrent()) return;
      useJarvisTaskRunStore
        .getState()
        .replaceCanonicalForAccount(input.accountScope, snapshot.runs, snapshot.activityByChat);
      const currentKeys = new Set(snapshot.events.map((event) => `${event.runId}:${event.seq}`));
      if (initialized) {
        for (const event of snapshot.events) {
          if (!seenEvents.has(`${event.runId}:${event.seq}`)) input.onTransition(event);
        }
      }
      initialized = true;
      seenEvents = currentKeys;
    },
    error(error) {
      input.onError?.(error);
    },
  });
  return () => subscription.unsubscribe();
}

async function resumeCanonicalJarvisRecovery(input: {
  accountId: string;
  readyReceipt: JarvisPersistenceReadyReceipt;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<number> {
  if (
    input.readyReceipt.state !== 'ready' ||
    input.readyReceipt.accountId !== input.accountId ||
    !input.isCurrent()
  ) {
    return 0;
  }
  const scanner = createJarvisRecoveryScanner({ runs: jarvisRunRepo, events: jarvisEventRepo });
  return resumeRecoverableJarvisRuns({
    accountId: input.accountId,
    scanner,
    approvals: jarvisApprovalRepo,
    signal: input.signal,
    isCurrent: input.isCurrent,
    onPresentation: (presentation: JarvisRecoveryPresentation) => {
      if (typeof window !== 'undefined' && input.isCurrent()) {
        window.dispatchEvent(
          new CustomEvent('jarvis:recovery-presentation', { detail: presentation }),
        );
      }
    },
  });
}

const DEFAULT_JARVIS_VOICE_RESPONSE_RECOVERY_SERVICES: JarvisVoiceResponseRecoveryAccountServices =
  Object.freeze({
    openLiveEvidenceAccount: openJarvisLiveEvidenceAccount,
    recoverVoiceResponses: ({ accountId }: { accountId: string }) =>
      recoverBoundVoiceResponses({
        accountId,
        scanner: createJarvisRecoveryScanner({ runs: jarvisRunRepo, events: jarvisEventRepo }),
        openVoiceRecovery: openJarvisVoiceRecovery,
      }),
  });

export async function startJarvisVoiceRecoveryAccountSession(input: {
  accountId: string;
  readyReceipt: JarvisPersistenceReadyReceipt;
  isCurrent: () => boolean;
  services?: JarvisVoiceResponseRecoveryAccountServices;
}): Promise<JarvisVoiceRecoveryAccountSession | undefined> {
  if (
    input.readyReceipt.state !== 'ready' ||
    input.readyReceipt.accountId !== input.accountId ||
    !input.isCurrent()
  ) {
    return undefined;
  }

  const services = input.services ?? DEFAULT_JARVIS_VOICE_RESPONSE_RECOVERY_SERVICES;
  const session = await services.openLiveEvidenceAccount(input.accountId);
  if (!input.isCurrent()) {
    session.dispose();
    return undefined;
  }
  if (session.accountId !== input.accountId) {
    session.dispose();
    throw new Error('jarvis_live_evidence_account_mismatch');
  }
  try {
    session.assertCurrent();
  } catch (error) {
    session.dispose();
    throw error;
  }

  let recoveryClaimed = false;
  return Object.freeze({
    session,
    async recover(): Promise<unknown> {
      if (recoveryClaimed) throw new Error('voice_response_recovery_already_started');
      recoveryClaimed = true;
      try {
        if (!input.isCurrent()) {
          session.dispose();
          return undefined;
        }
        session.assertCurrent();
        const summary = await services.recoverVoiceResponses({ accountId: input.accountId });
        if (!input.isCurrent()) {
          session.dispose();
          return summary;
        }
        session.assertCurrent();
        return summary;
      } catch (error) {
        session.dispose();
        throw error;
      }
    },
  });
}

const DEFAULT_JARVIS_LEGACY_LIFECYCLE_SERVICES: JarvisLegacyLifecycleAccountServices = {
  deriveAccountScope: privateAccountDirectory,
  readLegacyRuns: readLegacyJarvisTaskRunsOnce,
  setAccountScope: (scope) => useJarvisTaskRunStore.getState().setAccountScope(scope),
  replaceLegacyRuns: (scope, runs) =>
    useJarvisTaskRunStore.getState().replaceLegacyForAccount(scope, runs),
  startNotifications: (input) => startJarvisTaskRunNotifications(input),
  startCanonicalProjection: startCanonicalJarvisProjection,
  resumeRecovery: resumeCanonicalJarvisRecovery,
};

export async function startJarvisLegacyLifecycleAccountSession(input: {
  accountId: string;
  readyReceipt: JarvisPersistenceReadyReceipt;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  services?: JarvisLegacyLifecycleAccountServices;
  onError?: (error: unknown) => void;
}): Promise<() => void> {
  const services = input.services ?? DEFAULT_JARVIS_LEGACY_LIFECYCLE_SERVICES;
  const onError = input.onError ?? reportLifecycleError;
  let accountScope = '';
  let disposed = false;
  let stopNotifications: (() => void) | undefined;
  let stopCanonical: (() => void) | undefined;
  const transitionListeners = new Set<(event: JarvisEvent) => void>();
  services.setAccountScope('');

  const stop = () => {
    if (disposed) return;
    disposed = true;
    stopCanonical?.();
    stopNotifications?.();
    transitionListeners.clear();
    if (accountScope && input.isCurrent()) services.setAccountScope('');
  };

  try {
    if (
      input.readyReceipt.state !== 'ready' ||
      input.readyReceipt.accountId !== input.accountId ||
      !input.isCurrent()
    ) {
      return stop;
    }
    accountScope = await services.deriveAccountScope(input.accountId);
    if (!input.isCurrent()) return stop;
    services.setAccountScope(accountScope);
    const legacyRuns = await services.readLegacyRuns({ accountId: input.accountId });
    if (!input.isCurrent()) return stop;
    services.replaceLegacyRuns(accountScope, legacyRuns);
    stopNotifications = services.startNotifications({
      subscribe(listener) {
        transitionListeners.add(listener);
        return () => transitionListeners.delete(listener);
      },
      onError,
    });
    stopCanonical = services.startCanonicalProjection({
      accountId: input.accountId,
      accountScope,
      isCurrent: input.isCurrent,
      onTransition: (event) => {
        for (const listener of transitionListeners) listener(event);
      },
      onError,
    });
    if (!input.isCurrent()) {
      stop();
      return () => undefined;
    }
    void Promise.resolve()
      .then(() => {
        if (disposed || !input.isCurrent()) return 0;
        return services.resumeRecovery({
          accountId: input.accountId,
          readyReceipt: input.readyReceipt,
          signal: input.signal,
          isCurrent: input.isCurrent,
        });
      })
      .then(() => {
        if (!input.isCurrent()) stop();
      })
      .catch((error) => {
        if (!disposed && input.isCurrent()) onError(error);
        stop();
      });
    return stop;
  } catch (error) {
    onError(error);
    stop();
    return () => undefined;
  }
}

/**
 * Lazy-mounted modals + canvas surfaces.
 *
 * Two reasons each component is wrapped here instead of imported eagerly:
 *
 *   1. Code-splitting. The chat view, council grid, settings sections,
 *      schedule editor, launcher tile editor, what's-new modal, actions
 *      palette, ambient takeover, and wellness break all pull large
 *      dependency graphs (motion, dexie hooks, big component trees) that
 *      have no business landing in the boot chunk.
 *
 *   2. Runtime cost. Most of these are gated by an `open` boolean in the
 *      UI store; even when closed they pay rendering + tree-walk cost
 *      every time the store updates. Lazy-mounting means the React tree
 *      never sees them until the user actually summons them.
 *
 * Suspense fallbacks are deliberately `null` — these are overlays whose
 * own internal skeletons handle empty/loading states better than a
 * generic spinner would.
 */
const ChatView = React.lazy(() => import('@/features/chat').then((m) => ({ default: m.ChatView })));
const CouncilView = React.lazy(() =>
  import('@/features/council').then((m) => ({ default: m.CouncilView })),
);
import { getLastSettingsTab } from '@/features/settings/settingsTabMemory';

type SettingsTabMemoryValue = ReturnType<typeof getLastSettingsTab>;
let monochromeSettingsTabOverride: SettingsTabMemoryValue | undefined;

const SettingsModal = React.lazy(() =>
  import('@/features/settings').then((m) => ({ default: m.SettingsModal })),
);
const PetOverlayWindow = React.lazy(() =>
  import('@/features/pets/PetOverlayWindow').then((m) => ({ default: m.PetOverlayWindow })),
);
const PetMiniPanelWindow = React.lazy(() =>
  import('@/features/pets/PetMiniPanelWindow').then((m) => ({ default: m.PetMiniPanelWindow })),
);
const VoiceModal = React.lazy(() =>
  import('@/features/voice/VoiceModal').then((m) => ({ default: m.VoiceModal })),
);
const CommandPalette = React.lazy(() =>
  import('@/features/command-palette').then((m) => ({ default: m.CommandPalette })),
);
const LauncherDialog = React.lazy(() =>
  import('@/features/launcher').then((m) => ({ default: m.LauncherDialog })),
);
const AssistantBar = React.lazy(() =>
  import('@/features/assistant').then((m) => ({ default: m.AssistantBar })),
);
const WhatsNewHost = React.lazy(() =>
  import('@/features/whats-new').then((m) => ({ default: m.WhatsNewHost })),
);
const NewsHost = React.lazy(() => import('@/features/news').then((m) => ({ default: m.NewsHost })));
const ProductTutorialHost = React.lazy(() =>
  import('@/features/product-tutorial').then((m) => ({ default: m.ProductTutorialHost })),
);
const ActionsPalette = React.lazy(() =>
  import('@/features/actions').then((m) => ({ default: m.ActionsPalette })),
);
const AmbientHome = React.lazy(() =>
  import('@/features/ambient').then((m) => ({ default: m.AmbientHome })),
);
const PetHost = React.lazy(() => import('@/features/pets').then((m) => ({ default: m.PetHost })));
const CelebrationHost = React.lazy(() =>
  import('@/features/celebrate').then((m) => ({ default: m.CelebrationHost })),
);

let cloudPlanSyncGeneration = 0;

function applyCloudSession(session: SupabaseSessionLike): void {
  const requestGeneration = ++cloudPlanSyncGeneration;
  const store = useAuthStore.getState();
  if (session === null) {
    useAuthStore.setState({ cloudSession: null, plan: 'free' });
    return;
  }
  const userId = cloudSessionUserId(session);
  const previousUserId = store.cloudSession?.user_id.trim() ?? '';
  const resetPlan = !userId || previousUserId !== userId;
  useAuthStore.setState({
    cloudSession: {
      user_id: userId,
      email: session.user?.email ?? '',
      expires_at: session.expires_at ?? 0,
    },
    ...(resetPlan ? { plan: 'free' as const } : {}),
  });
  if (!userId) return;
  void syncPlanFromProfile(userId, requestGeneration);
}

/**
 * Pull the server-managed subscription tier into the local auth store so the
 * Plans/Account UI reflects Stripe state after sign-in and app restarts.
 * Fire-and-forget: a new authority starts at the fail-closed free tier, and
 * only the latest request for the still-active exact account may replace it.
 */
async function syncPlanFromProfile(userId: string, requestGeneration: number): Promise<void> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const supa = getSupabaseClient();
    if (!supa) return;
    const { data, error } = await supa
      .from('profiles')
      .select('tier')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data?.tier) return;
    const tier = data.tier === 'byok-only' ? 'free' : data.tier;
    const SYNCED_TIERS = new Set(['free', 'starter', 'pro', 'ultra', 'apex']);
    if (SYNCED_TIERS.has(tier)) {
      const store = useAuthStore.getState();
      if (
        requestGeneration !== cloudPlanSyncGeneration ||
        store.cloudSession?.user_id.trim() !== userId
      ) {
        return;
      }
      if (store.plan !== tier) store.setPlan(tier as import('@/lib/entitlements').PlanId);
    }
  } catch (err) {
    console.warn('[billing] plan sync skipped:', err);
  }
}

/**
 * Renders the right canvas based on `useUIStore.route` (V3) and
 * `chatMode` (V2). For non-`chat` routes (terminal / kanban / context /
 * benchmarks / history / agents) we delegate to `<PageRouter />`.
 *
 * For the `chat` route we keep the existing council bootstrap so
 * council mode still pulls per-chat agent ids and seeds messages.
 */
function ActiveCanvas() {
  const plan = resolveRuntimePlan();
  const route = useUIStore((s) => s.route);
  const chatMode = useUIStore((s) => s.chatMode);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const [councilAgentIds, setCouncilAgentIds] = React.useState<AgentId[]>([]);
  const [councilMessages, setCouncilMessages] = React.useState<Message[]>([]);
  const agentMap = useAgentStore((s) => s.agents);

  // When council mode is on, pull the chat's `active_agent_ids` and stream
  // messages from the same chat so each panel can filter on agent_id.
  React.useEffect(() => {
    if (!plan.persistenceEnabled || chatMode !== 'council' || !activeChatId) {
      setCouncilAgentIds([]);
      setCouncilMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const chat = await chatRepo.getById(activeChatId as never);
        if (cancelled || !chat) return;
        // Default to all built-in agents if the chat hasn't been wired yet.
        const ids =
          chat.active_agent_ids?.length > 0
            ? chat.active_agent_ids
            : (Object.values(agentMap) as Agent[]).slice(0, 4).map((a) => a.id);
        setCouncilAgentIds(ids);
        const msgs = await messageRepo.listByChat(activeChatId as never);
        if (!cancelled) setCouncilMessages(msgs);
      } catch (err) {
        console.error('Council bootstrap failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan.persistenceEnabled, chatMode, activeChatId, agentMap]);

  // V3 — non-chat routes go through the lazy PageRouter.
  if (route !== 'chat') {
    return <PageRouter />;
  }

  if (chatMode === 'council') {
    return (
      <React.Suspense fallback={null}>
        <CouncilView agentIds={councilAgentIds} messages={councilMessages} />
      </React.Suspense>
    );
  }
  // doc / code modes are placeholders in V1 - render the chat as a fallback.
  return (
    <React.Suspense fallback={null}>
      <ChatView />
    </React.Suspense>
  );
}

/**
 * Boot-time wiring: open DB, register default agents, start runtime + notification loops.
 * Mounted ONCE inside AuthGate (after seeding) via this effect.
 */
function useBoot() {
  const plan = resolveRuntimePlan();
  const registerMany = useAgentStore((s) => s.registerMany);
  const [commandCenterBinding, setCommandCenterBinding] =
    React.useState<JarvisCommandCenterBinding>();
  const [runtimeListenerReady, setRuntimeListenerReady] = React.useState(!plan.agentRuntimeEnabled);

  React.useEffect(() => {
    let stopRuntime: (() => void) | undefined;
    let stopLearning: (() => void | Promise<void>) | undefined;
    let stopOperator: (() => void) | undefined;
    let stopAllAboutMePersistence: (() => void | Promise<void>) | undefined;
    let stopTaskRunLifecycle: (() => void) | undefined;
    let liveEvidenceAccountSession: JarvisLiveEvidencePrimaryHostAccountSession | undefined;
    let stopNotifications: (() => void) | undefined;
    let stopTerminalScheduler: (() => void) | undefined;
    let stopJarvisScheduleRunner: (() => void) | undefined;
    let stopClockEngine: (() => void) | undefined;
    type CloudSyncAuthorityLifecycle = {
      userId: string;
      generation: number;
      controller: AbortController;
      startup: Promise<void>;
      stopLoop?: () => Promise<void>;
    };
    let activeCloudSyncAuthority: CloudSyncAuthorityLifecycle | undefined;
    let enqueueCloudAuthorityLease: SyncQueueCloudAuthorityLease | undefined;
    let stopCloudAuth: (() => void) | undefined;
    let stopAccountSubscription: (() => void) | undefined;
    let persistenceCoordinator: ReturnType<typeof createJarvisPersistenceCoordinator> | undefined;
    let stopPersistenceCoordinator: (() => void) | undefined;
    let stopPersistenceState: (() => void) | undefined;
    let persistenceReadyReceipt: JarvisPersistenceReadyReceipt | null = null;
    let activeAccountIdentity: ReturnType<typeof resolveAccountIdentity> = null;
    let activePersistenceGeneration: number | null = null;
    let desiredAccountIdentity: ReturnType<typeof resolveAccountIdentity> = null;
    let desiredPersistenceReceipt: JarvisPersistenceReadyReceipt | null = null;
    let accountIdentityReady = false;
    let accountListenersBootReady = false;
    let accountTransitionRequest = 0;
    let accountScopeGeneration = 0;
    let cloudAuthGeneration = 0;
    let accountRecoveryController: AbortController | undefined;
    let terminalAccountRevocationBlocked: string | null = null;
    let accountTransition = accountScopeTeardownBarrier;
    let cancelled = false;
    const errors: string[] = [];
    const publishRuntimeListenerReady = (ready: boolean): void => {
      if (ready) {
        document.documentElement.dataset.jarvisRuntimeListenerReady = 'true';
      } else {
        delete document.documentElement.dataset.jarvisRuntimeListenerReady;
      }
    };

    quarantineAccountScopedState();
    publishRuntimeListenerReady(!plan.agentRuntimeEnabled);

    function addError(label: string, err: unknown): void {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[boot] ${label}:`, msg);
      errors.push(`${label}: ${msg}`);
    }

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms),
        ),
      ]).catch((err) => {
        addError(label, err);
        throw err;
      });
    }

    function sameAccountIdentity(
      left: ReturnType<typeof resolveAccountIdentity>,
      right: ReturnType<typeof resolveAccountIdentity>,
    ): boolean {
      return left?.accountId === right?.accountId && left?.source === right?.source;
    }

    function sameReadyReceipt(
      left: JarvisPersistenceReadyReceipt | null,
      right: JarvisPersistenceReadyReceipt | null,
    ): boolean {
      return (
        left?.accountId === right?.accountId &&
        left?.generation === right?.generation &&
        left?.state === right?.state
      );
    }

    function releaseEnqueueCloudAuthority(expectedUserId?: string): void {
      const lease = enqueueCloudAuthorityLease;
      if (!lease || (expectedUserId && lease.userId !== expectedUserId)) return;
      enqueueCloudAuthorityLease = undefined;
      releaseSyncQueueCloudAuthority(lease);
    }

    function publishVerifiedEnqueueCloudAuthority(session: SupabaseSessionLike): void {
      const userId = cloudSessionUserId(session);
      if (enqueueCloudAuthorityLease?.userId === userId && userId) return;
      releaseEnqueueCloudAuthority();
      if (userId) {
        enqueueCloudAuthorityLease = activateSyncQueueCloudAuthority(userId);
      }
    }

    function revokeEnqueueAuthorityOnStoreDivergence(): void {
      const lease = enqueueCloudAuthorityLease;
      if (!lease) return;
      const storedUserId = useAuthStore.getState().cloudSession?.user_id.trim() ?? '';
      if (storedUserId !== lease.userId) {
        releaseEnqueueCloudAuthority(lease.userId);
      }
    }

    function stopActiveCloudSyncLoop(): Promise<void> {
      const authority = activeCloudSyncAuthority;
      activeCloudSyncAuthority = undefined;
      if (!authority) return cloudSyncTeardownBarrier;

      authority.controller.abort();
      const loopSettlement = authority.stopLoop?.() ?? Promise.resolve();
      const authoritySettlement = Promise.allSettled([authority.startup, loopSettlement]).then(
        () => undefined,
      );
      const priorSettlement = cloudSyncTeardownBarrier;
      cloudSyncTeardownBarrier = Promise.allSettled([priorSettlement, authoritySettlement]).then(
        () => undefined,
      );
      return cloudSyncTeardownBarrier;
    }

    function quarantineAccountScopedState(): void {
      useJarvisLearningStore.getState().clearAccountScope();
      useAllAboutMeStore.getState().clearAccountScope();
      useJarvisTaskRunStore.getState().setAccountScope('');
    }

    async function stopAccountScopedListeners(
      options: { revokeTerminalExecutions?: boolean } = {},
    ): Promise<void> {
      accountScopeGeneration += 1;
      accountRecoveryController?.abort();
      accountRecoveryController = undefined;
      const oldAccountId = activeAccountIdentity?.accountId;
      const oldLiveEvidenceSession = liveEvidenceAccountSession;
      let terminalAccountRevocationIncomplete = false;
      setCommandCenterBinding(undefined);
      liveEvidenceAccountSession = undefined;
      if (oldAccountId) invalidateActiveKernelAccount(oldAccountId);
      const stops = [stopLearning, stopAllAboutMePersistence, stopTaskRunLifecycle].filter(
        (stop): stop is () => void | Promise<void> => Boolean(stop),
      );
      stopLearning = undefined;
      stopAllAboutMePersistence = undefined;
      stopTaskRunLifecycle = undefined;
      activeAccountIdentity = null;
      activePersistenceGeneration = null;
      // Quarantine every account-scoped in-memory surface synchronously before
      // awaiting native terminal revocation or listener flushes. A malformed
      // live cloud session must not leave the previous account readable for
      // even one React/store turn while asynchronous teardown is in flight.
      const pendingStops = stops.map((stop) => {
        try {
          return Promise.resolve(stop());
        } catch (error) {
          return Promise.reject(error);
        }
      });
      oldLiveEvidenceSession?.dispose();
      quarantineAccountScopedState();
      const terminalRevocation =
        oldAccountId && options.revokeTerminalExecutions
          ? revokeTerminalExecutionsForAccount(oldAccountId)
              .then((outcome) => {
                terminalAccountRevocationIncomplete = outcome.rejected > 0;
              })
              .catch(() => {
                terminalAccountRevocationIncomplete = true;
              })
          : Promise.resolve();
      const results = await Promise.allSettled([...pendingStops, terminalRevocation]);
      for (const result of results) {
        if (result.status === 'rejected') addError('account scope teardown', result.reason);
      }
      if (terminalAccountRevocationIncomplete) {
        terminalAccountRevocationBlocked = oldAccountId ?? terminalAccountRevocationBlocked;
        throw new Error('terminal_account_revocation_incomplete');
      }
      if (oldAccountId === terminalAccountRevocationBlocked) {
        terminalAccountRevocationBlocked = null;
      }
    }

    async function transitionAccountScopedListeners(
      nextIdentity: ReturnType<typeof resolveAccountIdentity>,
      readyReceipt: JarvisPersistenceReadyReceipt,
      request: number,
    ): Promise<void> {
      if (
        sameAccountIdentity(nextIdentity, activeAccountIdentity) &&
        activePersistenceGeneration === readyReceipt.generation
      ) {
        return;
      }
      if (terminalAccountRevocationBlocked) {
        const blockedAccountId = terminalAccountRevocationBlocked;
        const retry = await revokeTerminalExecutionsForAccount(blockedAccountId);
        if (retry.rejected > 0) throw new Error('terminal_account_revocation_incomplete');
        if (terminalAccountRevocationBlocked === blockedAccountId) {
          terminalAccountRevocationBlocked = null;
        }
      }
      await stopAccountScopedListeners({
        revokeTerminalExecutions: !sameAccountIdentity(nextIdentity, activeAccountIdentity),
      });
      if (
        cancelled ||
        !accountListenersBootReady ||
        request !== accountTransitionRequest ||
        !nextIdentity ||
        !sameAccountIdentity(nextIdentity, resolveAccountIdentity(useAuthStore.getState())) ||
        !sameReadyReceipt(readyReceipt, persistenceReadyReceipt)
      ) {
        return;
      }

      const accountId = nextIdentity.accountId;
      const generation = ++accountScopeGeneration;
      const recoveryController = new AbortController();
      accountRecoveryController = recoveryController;
      activeAccountIdentity = nextIdentity;
      activePersistenceGeneration = readyReceipt.generation;
      const fixedAccountBindings = {
        getAccountId: () => accountId,
        subscribeAccount: (_listener: () => void) => () => {},
      };
      try {
        const isCurrent = () =>
          !cancelled &&
          accountListenersBootReady &&
          accountScopeGeneration === generation &&
          sameAccountIdentity(activeAccountIdentity, nextIdentity) &&
          activePersistenceGeneration === readyReceipt.generation &&
          sameReadyReceipt(persistenceReadyReceipt, readyReceipt);
        const voiceRecovery = await startJarvisVoiceRecoveryAccountSession({
          accountId,
          readyReceipt,
          isCurrent,
        });
        if (!voiceRecovery) return;
        if (!isCurrent()) {
          voiceRecovery.session.dispose();
          return;
        }
        liveEvidenceAccountSession = voiceRecovery.session;
        const commandCenterHostPort = createJarvisCommandCenterHostPort({
          accountSession: voiceRecovery.session,
          ...getInstalledJarvisCommandCenterHostDependencies(),
        });
        const commandCenterDataPort = createJarvisCommandCenterDataPort({
          repositories: {
            runs: jarvisRunRepo,
            events: jarvisEventRepo,
            artifacts: jarvisArtifactRepo,
          },
          liveEvidence: commandCenterHostPort.liveEvidence,
          subscribeJournal(subscriptionAccountId, chatId, listener) {
            const subscription = liveQuery(async () => {
              const runs = await jarvisRunRepo.listByAccount(subscriptionAccountId, { limit: 100 });
              const currentRun = selectCurrentRun(runs, subscriptionAccountId, chatId);
              if (!currentRun) return undefined;
              await Promise.all([
                jarvisEventRepo.listByRun(subscriptionAccountId, currentRun.id, { limit: 500 }),
                jarvisArtifactRepo.listByRun(subscriptionAccountId, currentRun.id, 500),
              ]);
              return currentRun.updatedAt;
            }).subscribe({
              next: listener,
              error: listener,
            });
            return () => subscription.unsubscribe();
          },
        });
        setCommandCenterBinding(
          Object.freeze({ hostPort: commandCenterHostPort, dataPort: commandCenterDataPort }),
        );
        await voiceRecovery.recover();
        if (!isCurrent()) return;
        stopLearning = startJarvisLearningListener({
          ...fixedAccountBindings,
          evidenceRepository: memoryEvidenceRepo,
        });
        stopAllAboutMePersistence = startAllAboutMePersistence(fixedAccountBindings);
        stopTaskRunLifecycle = await startJarvisLegacyLifecycleAccountSession({
          accountId,
          readyReceipt,
          signal: recoveryController.signal,
          isCurrent,
          onError: (error) => addError('canonical task projection', error),
        });
      } catch (error) {
        addError('account scope startup', error);
        await stopAccountScopedListeners();
      }
    }

    function syncAccountScopedListeners(): void {
      if (!accountListenersBootReady || !accountIdentityReady) {
        if (!activeAccountIdentity) quarantineAccountScopedState();
        return;
      }
      const nextIdentity = resolveAccountIdentity(useAuthStore.getState());
      const nextReadyReceipt =
        nextIdentity && persistenceReadyReceipt?.accountId === nextIdentity.accountId
          ? persistenceReadyReceipt
          : null;

      if (!nextIdentity || !nextReadyReceipt) {
        if (!desiredAccountIdentity && !desiredPersistenceReceipt && !activeAccountIdentity) {
          quarantineAccountScopedState();
          return;
        }
        desiredAccountIdentity = null;
        desiredPersistenceReceipt = null;
        accountTransitionRequest += 1;
        if (!activeAccountIdentity) {
          quarantineAccountScopedState();
          return;
        }
        const precedingTransition = accountTransition;
        const immediateTeardown = stopAccountScopedListeners({
          revokeTerminalExecutions: true,
        });
        accountTransition = Promise.allSettled([precedingTransition, immediateTeardown]).then(
          () => undefined,
        );
        return;
      }

      if (
        sameAccountIdentity(nextIdentity, desiredAccountIdentity) &&
        sameReadyReceipt(nextReadyReceipt, desiredPersistenceReceipt)
      ) {
        return;
      }

      desiredAccountIdentity = nextIdentity;
      desiredPersistenceReceipt = nextReadyReceipt;
      const request = ++accountTransitionRequest;
      if (
        sameAccountIdentity(nextIdentity, activeAccountIdentity) &&
        activePersistenceGeneration === nextReadyReceipt.generation
      ) {
        return;
      }
      accountTransition = accountTransition
        .then(async () => {
          if (cancelled || request !== accountTransitionRequest) return;
          await transitionAccountScopedListeners(nextIdentity, nextReadyReceipt, request);
        })
        .catch((error) => addError('account scope transition', error));
    }

    function ensurePersistenceCoordinatorStarted(): void {
      if (
        cancelled ||
        !accountIdentityReady ||
        !persistenceCoordinator ||
        stopPersistenceCoordinator
      ) {
        return;
      }
      stopPersistenceCoordinator = persistenceCoordinator.start();
      persistenceReadyReceipt = persistenceCoordinator.getReadyReceipt();
      syncAccountScopedListeners();
    }

    if (plan.cloudSyncEnabled) {
      stopAccountSubscription = useAuthStore.subscribe(() => {
        revokeEnqueueAuthorityOnStoreDivergence();
        syncAccountScopedListeners();
      });
    }

    (async () => {
      // Phase 1: storage & keys
      let databaseOpened = false;
      if (plan.persistenceEnabled) {
        try {
          await withTimeout(openDb(), 10_000, 'openDb');
          databaseOpened = true;
        } catch {
          /* degraded */
        }
      }

      if (cancelled) return;

      if (databaseOpened && plan.persistenceEnabled) {
        persistenceCoordinator = createJarvisPersistenceCoordinator({
          db,
          readIdentity: () =>
            accountIdentityReady ? resolveAccountIdentity(useAuthStore.getState()) : null,
          subscribeIdentity: (listener) => useAuthStore.subscribe(listener),
        });
        stopPersistenceState = persistenceCoordinator.subscribe(() => {
          persistenceReadyReceipt = persistenceCoordinator?.getReadyReceipt() ?? null;
          syncAccountScopedListeners();
        });
        persistenceReadyReceipt = persistenceCoordinator.getReadyReceipt();
        ensurePersistenceCoordinatorStarted();
      }

      if (plan.vaultKeychainHydrationEnabled) {
        try {
          await withTimeout(
            useAuthStore.getState().hydrateApiKeysFromVault(),
            5_000,
            'hydrateKeys',
          );
        } catch {
          useAuthStore.setState({
            credentialVaultState: 'degraded',
            credentialVaultFailedProviders: [],
          });
          console.warn('[credentials] credential-hydration-timeout');
        }
      }

      if (cancelled) return;

      if (plan.terminalLauncherInstallEnabled) {
        void import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('install_terminal_launcher'))
          .catch((err) => console.warn('[launcher] terminal command setup failed', err));
      }

      // Phase 2: Supabase (non-blocking, fire-and-forget)
      if (plan.cloudSyncEnabled) {
        try {
          const { isSupabaseConfigured } = await withTimeout(
            import('@/lib/supabase/env').then((m) => m),
            5_000,
            'supabaseCheck',
          );
          if (cancelled) return;
          if (!isSupabaseConfigured()) {
            publishVerifiedEnqueueCloudAuthority(null);
            applyCloudSession(null);
            accountIdentityReady = true;
            ensurePersistenceCoordinatorStarted();
          } else {
            const supabaseModules = await withTimeout(
              Promise.all([import('@/lib/supabase/client'), import('@/lib/sync')]),
              15_000,
              'supabaseImport',
            ).catch(() => null);
            if (supabaseModules && !cancelled) {
              const [{ getSupabaseClient }, { pruneSyncQueue, retrySyncErrors, startSyncLoop }] =
                supabaseModules;
              const supa = getSupabaseClient();
              const isCloudSyncAuthorityCurrent = (authority: CloudSyncAuthorityLifecycle) =>
                !cancelled &&
                activeCloudSyncAuthority === authority &&
                !authority.controller.signal.aborted &&
                authority.generation === cloudAuthGeneration &&
                useAuthStore.getState().cloudSession?.user_id.trim() === authority.userId;
              const startCloudSyncForAuthority = async (
                authority: CloudSyncAuthorityLifecycle,
                priorSettlement: Promise<void>,
              ): Promise<void> => {
                await priorSettlement;
                if (!isCloudSyncAuthorityCurrent(authority)) return;
                const syncAuthority = {
                  userId: authority.userId,
                  signal: authority.controller.signal,
                };
                await retrySyncErrors(syncAuthority).catch((err) =>
                  console.warn('[sync] retrySyncErrors failed:', err),
                );
                if (!isCloudSyncAuthorityCurrent(authority)) return;
                await pruneSyncQueue(syncAuthority).catch((err) =>
                  console.warn('[sync] prune failed:', err),
                );
                if (!isCloudSyncAuthorityCurrent(authority)) return;
                try {
                  authority.stopLoop = startSyncLoop(syncAuthority);
                } catch (err) {
                  console.warn('[sync] loop startup failed:', err);
                }
              };
              const reconcileCloudSyncAuthority = (
                session: SupabaseSessionLike,
                generation: number,
              ): void => {
                const userId = cloudSessionUserId(session);
                if (!userId) {
                  void stopActiveCloudSyncLoop();
                  return;
                }
                const current = activeCloudSyncAuthority;
                if (current && current.userId === userId && !current.controller.signal.aborted) {
                  current.generation = generation;
                  return;
                }

                const priorSettlement = stopActiveCloudSyncLoop();
                const authority: CloudSyncAuthorityLifecycle = {
                  userId,
                  generation,
                  controller: new AbortController(),
                  startup: Promise.resolve(),
                };
                activeCloudSyncAuthority = authority;
                authority.startup = startCloudSyncForAuthority(authority, priorSettlement).catch(
                  (err) => {
                    if (activeCloudSyncAuthority === authority) {
                      activeCloudSyncAuthority = undefined;
                      releaseEnqueueCloudAuthority(authority.userId);
                    }
                    console.warn('[sync] authority startup failed:', err);
                  },
                );
              };
              if (supa) {
                const sessionGeneration = ++cloudAuthGeneration;
                void supa.auth
                  .getSession()
                  .then(({ data }) => {
                    if (cancelled || sessionGeneration !== cloudAuthGeneration) return;
                    publishVerifiedEnqueueCloudAuthority(data.session as SupabaseSessionLike);
                    applyCloudSession(data.session as SupabaseSessionLike);
                    accountIdentityReady = true;
                    ensurePersistenceCoordinatorStarted();
                    syncAccountScopedListeners();
                    reconcileCloudSyncAuthority(
                      data.session as SupabaseSessionLike,
                      sessionGeneration,
                    );
                    const userId = cloudSessionUserId(data.session as SupabaseSessionLike);
                    // Startup routing: when cloud auth is configured but no one is
                    // signed in, open the Account page so the user can sign up /
                    // sign in. When signed in, the persisted last route is restored
                    // automatically (route is persisted in the UI store).
                    if (!data.session) {
                      useUIStore.getState().setRoute('account');
                    } else if (userId) {
                      void import('@/lib/launchPromo').then((m) => m.claimLaunchPromo(userId));
                    }
                  })
                  .catch((error) => {
                    if (cancelled || sessionGeneration !== cloudAuthGeneration) return;
                    releaseEnqueueCloudAuthority();
                    applyCloudSession(null);
                    console.warn('[auth] initial Supabase session unavailable:', error);
                    syncAccountScopedListeners();
                  });
                const sub = supa.auth.onAuthStateChange((_event, session) => {
                  if (cancelled) return;
                  cloudAuthGeneration += 1;
                  publishVerifiedEnqueueCloudAuthority(session as SupabaseSessionLike);
                  applyCloudSession(session as SupabaseSessionLike);
                  accountIdentityReady = true;
                  ensurePersistenceCoordinatorStarted();
                  syncAccountScopedListeners();
                  reconcileCloudSyncAuthority(session as SupabaseSessionLike, cloudAuthGeneration);
                  const userId = cloudSessionUserId(session as SupabaseSessionLike);
                  if (userId) {
                    void import('@/lib/launchPromo').then((m) => m.claimLaunchPromo(userId));
                  }
                });
                stopCloudAuth = () => sub.data.subscription.unsubscribe();
              } else {
                releaseEnqueueCloudAuthority();
                applyCloudSession(null);
              }
            } else if (!cancelled) {
              releaseEnqueueCloudAuthority();
              applyCloudSession(null);
            }
          }
        } catch {
          releaseEnqueueCloudAuthority();
          applyCloudSession(null);
          /* Supabase unavailable, app works offline */
        }
      } else {
        releaseEnqueueCloudAuthority();
        applyCloudSession(null);
        accountIdentityReady = true;
        ensurePersistenceCoordinatorStarted();
      }

      if (cancelled) return;

      // Phase 3: agent registration
      if (plan.persistenceEnabled) {
        try {
          const persistedAgents = await withTimeout(agentRepo.list(), 10_000, 'agentRepo');
          if (cancelled) return;
          registerMany(persistedAgents.length > 0 ? persistedAgents : getDefaultAgents());
        } catch {
          if (cancelled) return;
          registerMany(getDefaultAgents());
        }
      } else {
        registerMany(getDefaultAgents());
      }

      if (cancelled) return;

      // Phase 4: runtime listener
      if (plan.agentRuntimeEnabled) {
        accountListenersBootReady = true;
        if (cancelled) {
          accountListenersBootReady = false;
          return;
        }
        if (cancelled) {
          accountListenersBootReady = false;
          return;
        }
        syncAccountScopedListeners();
        stopOperator = startJarvisOperatorListener({
          appendMessage: async (msg) => messageRepo.create(msg as never),
        });
        stopRuntime = startRuntimeListener({
          getAgentById: (id) => useAgentStore.getState().agents[id] ?? null,
          getAgentBySlug: (slug) => {
            const agents = useAgentStore.getState().agents;
            const wanted = slug.trim().toLowerCase();
            return Object.values(agents).find((a) => a.slug.toLowerCase() === wanted) ?? null;
          },
          getAgentForChat: async (chatId) => {
            const agents = Object.values(useAgentStore.getState().agents) as Agent[];
            const chat = await chatRepo.getById(chatId as never);
            const chatAgentId = chat?.active_agent_ids?.[0];
            if (chatAgentId && useAgentStore.getState().agents[chatAgentId]) {
              return useAgentStore.getState().agents[chatAgentId];
            }
            return (
              findProtectedJarvisAgent(agents) ??
              agents.find((agent) => agent.slug !== 'jarvis') ??
              null
            );
          },
          getMessages: async (chatId) => {
            return messageRepo.listByChat(chatId as never);
          },
          appendMessage: async (msg) => {
            // messageRepo.create accepts the full message minus id+timestamps and
            // stamps them in for us.
            return messageRepo.create(msg as never);
          },
          updateMessage: async (id, patch) => {
            await messageRepo.update(id, patch);
          },
        });
        publishRuntimeListenerReady(true);
        setRuntimeListenerReady(true);
      }

      // Phase 5: background loops
      if (plan.nativeNotificationsEnabled) {
        try {
          stopNotifications = startNotificationLoop();
        } catch (err) {
          console.error('Failed to start notification loop:', err);
        }
      }
      if (plan.backgroundServicesEnabled) {
        try {
          stopTerminalScheduler = initTerminalScheduler();
        } catch (err) {
          console.error('Failed to start terminal scheduler:', err);
        }
        try {
          stopJarvisScheduleRunner = startJarvisScheduleRunner();
        } catch (err) {
          console.error('Failed to start Jarvis schedule runner:', err);
        }
        try {
          stopClockEngine = startClockEngine();
        } catch (err) {
          console.error('Failed to start clock engine:', err);
        }

        // Jarvis High Piper voice (background — verified one-time local model)
        void import('@/features/voice/voiceRouter')
          .then(({ bootstrapJarvisVoiceOnLaunch }) => bootstrapJarvisVoiceOnLaunch())
          .catch((err) => console.warn('[boot] Jarvis High voice bootstrap failed:', err));
      }

      // Report accumulated errors
      if (errors.length > 0 && !cancelled) {
        toast.warning(
          `${errors.length} startup issue${errors.length > 1 ? 's' : ''}`,
          errors.slice(0, 3).join('; ') +
            (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''),
        );
      }
    })();

    return () => {
      cancelled = true;
      publishRuntimeListenerReady(false);
      releaseEnqueueCloudAuthority();
      accountListenersBootReady = false;
      accountTransitionRequest += 1;
      cloudAuthGeneration += 1;
      cloudPlanSyncGeneration += 1;
      accountRecoveryController?.abort();
      stopRuntime?.();
      stopAccountSubscription?.();
      stopPersistenceState?.();
      persistenceReadyReceipt = null;
      stopPersistenceCoordinator?.();
      const accountTeardown = stopAccountScopedListeners();
      accountScopeTeardownBarrier = Promise.allSettled([accountTransition, accountTeardown]).then(
        () => undefined,
      );
      stopOperator?.();
      stopNotifications?.();
      stopTerminalScheduler?.();
      stopJarvisScheduleRunner?.();
      stopClockEngine?.();
      void stopActiveCloudSyncLoop();
      stopCloudAuth?.();
    };
    // Run once - boot is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { commandCenterBinding, runtimeListenerReady };
}

function KernelBridgeBootstrap() {
  const plan = resolveRuntimePlan();
  const [ready, setReady] = React.useState(false);
  const [pluginManagement, setPluginManagement] = React.useState<
    PluginManagementCapability | undefined
  >(undefined);

  React.useEffect(() => {
    // MonoChrome visual-test profile: skip the kernel host boot (side-effect
    // deny mode) but still mark ready so the workspace chrome renders for capture.
    if (!plan.kernelEnabled) {
      React.startTransition(() => setReady(true));
      return;
    }
    let disposed = false;
    let disposeBoundary: (() => void | Promise<void>) | undefined;
    let accountInvalidator: ((accountId: string) => void) | undefined;
    let disposeKernelRuntimeHost: (() => void) | undefined;
    let disposePluginReadPort: (() => void) | undefined;
    let securityRuntime:
      | {
          bindKernelActions: import('@/lib/jarvis/approvalEngine').JarvisApprovalActionBinder;
          pluginManagement: PluginManagementCapability;
          runReadOnlyPlugin: import('@/lib/jarvis/jarvisSecurityRuntime').JarvisSecurityRuntime['runReadOnlyPlugin'];
          invalidateAccount(accountId: string): void;
          invalidateAll(): void;
        }
      | undefined;
    const invalidateSecurityRuntime = () => {
      disposePluginReadPort?.();
      disposeKernelRuntimeHost?.();
      securityRuntime?.invalidateAll();
    };

    void import('@/lib/jarvis/kernelHost')
      .then(async ({ createUnavailableKernelHostRuntime, startJarvisKernelHost }) => {
        const session = await startJarvisKernelHost({
          createRuntime: async () => {
            // Browser preview may own its best-effort Web Lock, but it never
            // constructs credential or approval authority. Native registration
            // has already succeeded before this callback is invoked.
            if (!(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) {
              return createUnavailableKernelHostRuntime();
            }

            const [
              { createJarvisSecurityRuntime },
              {
                createJarvisExistingCredentialAuthorization,
                createPluginCredentialAccountGrantRepository,
                createStrictPluginCredentialGrantStorage,
              },
              { selectPluginConnectionsForAccount, usePluginStore },
              { PLUGIN_CATALOG },
              { createJarvisPluginCapabilityProjection },
              { createJarvisMcpCapabilityProjection },
              { jarvisMcpServerManager },
              { createJarvisRepositories },
              { createJarvisCapabilitySnapshotProvider },
              { createJarvisEntitlementSnapshotProvider, fetchCloudAdminEntitlementSnapshot },
              { createJarvisActionCatalog, DEFAULT_JARVIS_ACTION_REGISTRATIONS },
              { getBuiltinAction },
              { resolveLocalDevelopmentEntitlementSnapshot },
              { installToolGatewayPluginReadPort },
            ] = await Promise.all([
              import('@/lib/jarvis/jarvisSecurityRuntime'),
              import('@/features/plugins/credentialAuthorization'),
              import('@/features/plugins/store'),
              import('@/features/plugins/catalog'),
              import('@/lib/jarvis/pluginCapabilityProducer'),
              import('@/lib/jarvis/mcpCapabilityProducer'),
              import('@/lib/mcp/serverManager'),
              import('@/lib/db/jarvisRepositories'),
              import('@/lib/jarvis/capabilitySnapshot'),
              import('@/lib/admin'),
              import('@/lib/jarvis/actions/catalog'),
              import('@/lib/actions/registry'),
              import('@/lib/entitlements'),
              import('@/lib/harness/toolGatewayProduction'),
            ]);
            await openDb();
            if (disposed) return createUnavailableKernelHostRuntime();

            const randomUUID = () => crypto.randomUUID();
            const now = () => Date.now();
            const LOCAL_DEVELOPMENT_ENTITLEMENT_DECISION_FLOOR_MS = 2 * 60_000;
            const securityBootObservedAt = now();
            const bootId = `kernel-security-${randomUUID()}`;
            let localDevelopmentEntitlementCache:
              | Readonly<{
                  accountId: string;
                  email: string | null | undefined;
                  cloudEmail: string | null | undefined;
                  localUserId: string | null | undefined;
                  snapshot: ReturnType<typeof resolveLocalDevelopmentEntitlementSnapshot>;
                }>
              | undefined;
            const activeAccountId = () =>
              resolveAccountIdentity(useAuthStore.getState())?.accountId;
            const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
            const entitlementSnapshots = createJarvisEntitlementSnapshotProvider({
              getActiveAccountId: activeAccountId,
              async loadForActiveAccount(accountId) {
                const auth = useAuthStore.getState();
                if (auth.cloudSession?.user_id.trim() === accountId) {
                  return await fetchCloudAdminEntitlementSnapshot(accountId);
                }
                if (resolveAccountIdentity(auth)?.accountId !== accountId) {
                  return { source: 'unavailable' as const, capabilities: [] };
                }
                const localIdentity = {
                  email: auth.email,
                  cloudEmail: auth.cloudSession?.email,
                  localUserId: auth.localUserId,
                };
                const localEntitlementObservedAt = now();
                if (
                  localDevelopmentEntitlementCache?.accountId === accountId &&
                  localDevelopmentEntitlementCache.email === localIdentity.email &&
                  localDevelopmentEntitlementCache.cloudEmail === localIdentity.cloudEmail &&
                  localDevelopmentEntitlementCache.localUserId === localIdentity.localUserId &&
                  typeof localDevelopmentEntitlementCache.snapshot.expiresAt === 'number' &&
                  localDevelopmentEntitlementCache.snapshot.expiresAt - localEntitlementObservedAt >
                    LOCAL_DEVELOPMENT_ENTITLEMENT_DECISION_FLOOR_MS
                ) {
                  return localDevelopmentEntitlementCache.snapshot;
                }
                const snapshot = resolveLocalDevelopmentEntitlementSnapshot(localIdentity, {
                  context: {
                    now: localEntitlementObservedAt,
                    production: import.meta.env.PROD,
                  },
                });
                localDevelopmentEntitlementCache =
                  snapshot.source !== 'unavailable' &&
                  typeof snapshot.expiresAt === 'number' &&
                  snapshot.expiresAt > localEntitlementObservedAt
                    ? Object.freeze({ accountId, ...localIdentity, snapshot })
                    : undefined;
                return snapshot;
              },
              now,
            });
            const capabilitySnapshots = createJarvisCapabilitySnapshotProvider({
              getActiveAccountId: activeAccountId,
              async resolveInputForActiveAccount(accountId) {
                const capturedAt = now();
                const pluginCapabilities = createJarvisPluginCapabilityProjection({
                  accountId,
                  capturedAt,
                  manifests: PLUGIN_CATALOG,
                  connections: selectPluginConnectionsForAccount(
                    usePluginStore.getState(),
                    accountId,
                  ),
                });
                const mcpCapabilities = createJarvisMcpCapabilityProjection({
                  accountId,
                  capturedAt,
                  statuses: jarvisMcpServerManager.discover(),
                });
                const tools = catalog
                  .listExposed()
                  .filter(
                    (registration) =>
                      registration.executor.kind === 'builtin' &&
                      getBuiltinAction(registration.executor.registryActionId) !== undefined,
                  )
                  .map((registration) => ({
                    id: registration.requiredCapabilities[0],
                    state: 'available' as const,
                    operations: ['execute'],
                    evidenceRef: `registered:${registration.id}:${registration.version}:${bootId}`,
                    lastVerifiedAt: securityBootObservedAt,
                  }));
                return {
                  capturedAt,
                  tools,
                  plugins: pluginCapabilities.refs,
                  mcps: mcpCapabilities.refs,
                  terminals: [],
                  agents: [],
                  entitlements: await entitlementSnapshots.getForAccount(accountId),
                  actionSchemas: catalog.listExposed(),
                };
              },
            });
            const credentialGrants = createPluginCredentialAccountGrantRepository({
              storage: createStrictPluginCredentialGrantStorage(window.localStorage),
            });
            const credentialAuthorization = createJarvisExistingCredentialAuthorization({
              grants: credentialGrants,
              getActiveAccountId: activeAccountId,
            });

            let kernelPluginArtifacts:
              | import('@/features/plugins/runtime').CanonicalPluginArtifactCapability
              | undefined;
            securityRuntime = createJarvisSecurityRuntime({
              repositories: createJarvisRepositories(db),
              catalog,
              capabilitySnapshots,
              entitlementSnapshots,
              credentialGrants,
              credentialAuthorization,
              pluginConnections: {
                upsertConnection: (connection) =>
                  usePluginStore.getState().upsertConnection(connection),
                removeConnection: (accountId, pluginId) =>
                  usePluginStore.getState().removeConnection(accountId, pluginId),
              },
              bindKernelPluginArtifacts(capability) {
                if (kernelPluginArtifacts) {
                  throw new Error('jarvis_plugin_artifact_authority_already_bound');
                }
                kernelPluginArtifacts = capability;
              },
              activeAccountId,
              executeRegisteredAction: async (dispatchInput) => {
                const { executeInstalledJarvisRegisteredAction } = await import('@/lib/ai/runtime');
                return executeInstalledJarvisRegisteredAction(dispatchInput);
              },
              bootId,
              randomUUID,
              now,
            });
            disposePluginReadPort = installToolGatewayPluginReadPort({
              run: (request) => securityRuntime!.runReadOnlyPlugin(request),
            });
            if (!kernelPluginArtifacts) {
              throw new Error('jarvis_plugin_artifact_authority_unavailable');
            }
            const { handleInstalledJarvisKernelClientRequest, installJarvisKernelRuntimeHost } =
              await import('@/lib/ai/runtime');
            disposeKernelRuntimeHost = await installJarvisKernelRuntimeHost({
              db,
              bindKernelActions: securityRuntime.bindKernelActions,
              pluginArtifacts: kernelPluginArtifacts,
              actionCatalog: catalog,
              capabilitySnapshots,
              randomUUID,
              now,
            });
            if (disposed) {
              disposePluginReadPort();
              disposeKernelRuntimeHost();
              securityRuntime.invalidateAll();
              return createUnavailableKernelHostRuntime();
            }
            window.addEventListener('pagehide', invalidateSecurityRuntime);
            if (!disposed) {
              React.startTransition(() => setPluginManagement(securityRuntime?.pluginManagement));
            }
            return Object.freeze({
              handleRequest: handleInstalledJarvisKernelClientRequest,
              invalidateAccount(accountId: string) {
                if (localDevelopmentEntitlementCache?.accountId === accountId) {
                  localDevelopmentEntitlementCache = undefined;
                }
                securityRuntime?.invalidateAccount(accountId);
              },
              dispose() {
                window.removeEventListener('pagehide', invalidateSecurityRuntime);
                localDevelopmentEntitlementCache = undefined;
                disposePluginReadPort?.();
                disposeKernelRuntimeHost?.();
                securityRuntime?.invalidateAll();
              },
            });
          },
        });
        if (disposed) {
          if (session.role === 'host') await session.dispose();
          return;
        }
        if (session.role === 'host') {
          accountInvalidator = session.invalidateAccount;
          invalidateActiveKernelAccount = accountInvalidator;
          disposeBoundary = session.dispose;
          return;
        }
        const { createJarvisKernelClient } = await import('@/lib/jarvis/kernelClient');
        const client = createJarvisKernelClient();
        if (disposed) {
          client.dispose();
          return;
        }
        disposeBoundary = client.dispose;
      })
      .catch(() => {
        /* Native/browser ownership remains unavailable and fail-closed. */
      })
      .finally(() => {
        if (!disposed) React.startTransition(() => setReady(true));
      });

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', invalidateSecurityRuntime);
      disposePluginReadPort?.();
      disposeKernelRuntimeHost?.();
      securityRuntime?.invalidateAll();
      if (accountInvalidator && invalidateActiveKernelAccount === accountInvalidator) {
        invalidateActiveKernelAccount = () => {};
      }
      void Promise.resolve(disposeBoundary?.()).catch(() => undefined);
    };
  }, []);

  return (
    <RuntimeProfileAuthBoundary plan={plan}>
      <PluginManagementCapabilityProvider value={pluginManagement}>
        {ready ? (
          <InstalledAccessAppHost authenticatedBoundary={WorkspaceRuntimeBoundary}>
            <WorkspaceRoot />
          </InstalledAccessAppHost>
        ) : null}
      </PluginManagementCapabilityProvider>
    </RuntimeProfileAuthBoundary>
  );
}

export function RuntimeProfileAuthBoundary({
  plan,
  children,
}: {
  plan: RuntimePlan;
  children: React.ReactNode;
}) {
  return plan.isVisualTest ? <>{children}</> : <AuthGate>{children}</AuthGate>;
}

function useDesktopReopenLifecycle() {
  React.useEffect(() => {
    const refreshBranding = () => {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('refresh_app_branding'))
        .catch(() => {
          /* Web preview or test runtime without Tauri invoke. */
        });
    };

    const notifyVisible = (reason: string) => {
      refreshBranding();
      window.requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent('jarvis:terminals:visible', {
            detail: { reason },
          }),
        );
      });
    };

    const onFocus = () => notifyVisible('window-focus');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') notifyVisible('visibility');
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // When the app is closed (hidden to tray) or torn down, stop any in-flight
    // speech so Jarvis does not keep talking in the background.
    const stopAllSpeech = () => {
      void flushWorkspacePersistence('before-hide');
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      void import('@/features/voice/speechSynthesis').then((m) => m.stopSpeech()).catch(() => {});
      void import('@/features/voice/TtsService').then((m) => m.TtsService.stop()).catch(() => {});
      handleVoiceModuleClosed();
      useUIStore.getState().setVoiceModalOpen(false);
    };
    window.addEventListener('pagehide', stopAllSpeech);

    let disposed = false;
    let unlistenReopen: (() => void) | null = null;
    let unlistenHide: (() => void) | null = null;
    let unlistenPersistNow: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('jarvis:before-hide', () => stopAllSpeech()))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenHide = unlisten;
      })
      .catch(() => {});
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ reason?: string }>('jarvis:persist-now', async (event) => {
          try {
            await flushWorkspacePersistenceAndAcknowledge(
              event.payload?.reason ?? 'desktop-persist',
              async () => {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('persistence_flush_complete');
              },
            );
          } catch {
            /* Desktop exit retains its native hard deadline if IPC is unavailable. */
          }
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenPersistNow = unlisten;
      })
      .catch(() => {
        /* Web preview or test runtime without Tauri events. */
      });
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ reason?: string }>('jarvis:reopen', (event) => {
          notifyVisible(event.payload?.reason ?? 'desktop-reopen');
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenReopen = unlisten;
      })
      .catch(() => {
        /* Web preview or test runtime without Tauri events. */
      });

    return () => {
      disposed = true;
      unlistenReopen?.();
      unlistenHide?.();
      unlistenPersistNow?.();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', stopAllSpeech);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}

/**
 * Wires up the global Cmd+K palette + every other hotkey across features.
 */
function GlobalHotkeysHost() {
  useGlobalHotkeys();

  // V2 — manual ambient toggle.
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const ambientEnabled = useUIStore((s) => s.ambient);
  useBoundHotkey('AMBIENT_TOGGLE', (e) => {
    e.preventDefault();
    if (!ambientEnabled) return;
    setAmbientActive(!useUIStore.getState().ambientActive);
  });

  // V2 — Schedule.
  const setRoute = useUIStore((s) => s.setRoute);
  useBoundHotkey('SCHEDULE', (e) => {
    e.preventDefault();
    setRoute('schedule');
  });

  // V2 — Launcher.
  const setLauncherOpen = useUIStore((s) => s.setLauncherOpen);
  useBoundHotkey('LAUNCHER', (e) => {
    e.preventDefault();
    setLauncherOpen(!useUIStore.getState().launcherOpen);
  });

  // V2 — Assistant command bar.
  const setAssistantOpen = useUIStore((s) => s.setAssistantOpen);
  useBoundHotkey('ASSISTANT', (e) => {
    e.preventDefault();
    setAssistantOpen(!useUIStore.getState().assistantOpen);
  });
  useBoundHotkey(
    'JARVIS_BUBBLE',
    (e) => {
      e.preventDefault();
      if (useUIStore.getState().route === 'chat') {
        const next = !useAuthStore.getState().jarvisAutoApprove;
        useAuthStore.getState().setJarvisAutoApprove(next);
        toast.info(
          next ? 'Auto-approve on' : 'Auto-approve off',
          next
            ? 'Jarvis will run proposed actions without asking in this chat.'
            : 'Jarvis will show Approve cards before running actions.',
        );
        return;
      }
      setAssistantOpen(true);
    },
    { whenInputs: true },
  );

  // V3 — Actions palette. Sister to palette and launcher.
  const toggleActionsPalette = useUIStore((s) => s.toggleActionsPalette);
  useBoundHotkey('ACTIONS', (e) => {
    e.preventDefault();
    toggleActionsPalette();
  });

  // V2 — per-link launcher hotkeys (e.g. Mod+Shift+1 jumps straight to YouTube).
  useLinkHotkeys();

  return null;
}

function IdleDetectionHost() {
  useIdleDetection();
  return null;
}

/**
 * Launcher dialog mount, listens to ui.launcherOpen.
 */
function LauncherDialogHost() {
  const open = useUIStore((s) => s.launcherOpen);
  const setOpen = useUIStore((s) => s.setLauncherOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <LauncherDialog open={open} onOpenChange={setOpen} />
    </React.Suspense>
  );
}

/**
 * Jarvis Assistant mount, listens to ui.assistantOpen.
 *
 * The bar is the natural-language command surface (Mod+J). It runs a
 * deterministic local parser — no remote AI calls.
 */
function AssistantBarHost() {
  const open = useUIStore((s) => s.assistantOpen);
  const setOpen = useUIStore((s) => s.setAssistantOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <AssistantBar open={open} onOpenChange={setOpen} />
    </React.Suspense>
  );
}

function CommandPaletteHost() {
  const open = useUIStore((s) => s.paletteOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <CommandPalette />
    </React.Suspense>
  );
}

export function resolveSettingsModalInitialTab(plan: RuntimePlan): SettingsTabMemoryValue {
  // Settings → Account was removed; Account Center is the profile route.
  return plan.isVisualTest ? (monochromeSettingsTabOverride ?? 'plans') : getLastSettingsTab();
}

function SettingsModalHost({ plan }: { plan: RuntimePlan }) {
  const open = useUIStore((s) => s.settingsOpen);
  if (!open) return null;
  const initialTab = resolveSettingsModalInitialTab(plan);
  return (
    <React.Suspense fallback={null}>
      <SettingsModal
        initialTab={initialTab}
        visualAdminPreview={plan.isVisualTest && initialTab === 'admin'}
      />
    </React.Suspense>
  );
}

function VoiceModuleLifecycle() {
  const open = useUIStore((s) => s.voiceModalOpen);
  React.useEffect(() => {
    syncVoiceModuleOpenState(open);
  }, [open]);
  return null;
}

function VoiceModalHost() {
  const open = useUIStore((s) => s.voiceModalOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <VoiceModal />
    </React.Suspense>
  );
}

function ActionsPaletteHost() {
  const open = useUIStore((s) => s.actionsPaletteOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <ActionsPalette />
    </React.Suspense>
  );
}

function ThemeHost() {
  const theme = useUIStore((state) => state.theme);
  const appBrightness = useUIStore((state) => state.appBrightness);

  React.useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  React.useEffect(() => {
    applyAppBrightnessToDocument(appBrightness);
  }, [appBrightness]);

  return null;
}

function KernelSmokeReconstructedLiveEvidenceHost({
  binding,
}: {
  binding: JarvisCommandCenterBinding | undefined;
}) {
  const [nodes, setNodes] = React.useState<readonly JarvisLiveSystemNode[]>([]);

  React.useEffect(() => {
    if (!KERNEL_SMOKE_ENABLED || !binding) {
      setNodes([]);
      return;
    }
    let disposed = false;
    let refreshing = false;
    const accountId = binding.hostPort.accountId;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const runs = await jarvisRunRepo.listByAccount(accountId, { limit: 500 });
        const snapshots = await Promise.all(
          runs.map((run) => binding.dataPort.getLiveEvidenceSnapshot({ accountId, runId: run.id })),
        );
        if (disposed) return;
        setNodes(
          snapshots.flatMap((snapshot) =>
            snapshot?.accountId === accountId ? snapshot.nodes : [],
          ),
        );
      } catch {
        if (!disposed) setNodes([]);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 250);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [binding]);

  return (
    <>
      {nodes.map((node) => (
        <output
          hidden
          key={`${node.runId}:${node.id}:${node.evidenceRef}`}
          data-sik-evidence="live.reconstructed-node"
          data-live-node-state={node.state}
          data-live-proof-ref={node.evidenceRef}
        />
      ))}
    </>
  );
}

/**
 * Lifecycle effect hosts (bridge + desktop-reopen). Rendered only in ordinary
 * mode; the MonoChrome visual-test profile suppresses these lifecycle effects.
 * Extracted so a rules-of-hooks-compatible gate can skip them entirely while
 * ordinary behavior is preserved.
 */
function WorkspaceLifecycleHosts() {
  useBridgeLifecycle();
  useDesktopReopenLifecycle();
  return null;
}

function WorkspaceRuntimeBoundary({ children }: React.PropsWithChildren) {
  const { commandCenterBinding, runtimeListenerReady } = useBoot();
  const plan = resolveRuntimePlan();

  return (
    <JarvisCommandCenterProvider value={commandCenterBinding}>
      {plan.kernelEnabled && KERNEL_SMOKE_ENABLED ? (
        <KernelSmokeReconstructedLiveEvidenceHost binding={commandCenterBinding} />
      ) : null}
      {plan.lifecycleEnabled ? <VibeSpaceMcpRuntimeHost /> : null}
      {runtimeListenerReady ? children : null}
    </JarvisCommandCenterProvider>
  );
}

/**
 * Inner shell - rendered after AuthGate has confirmed local user + seeding.
 */
function WorkspaceRoot() {
  const plan = resolveRuntimePlan();

  React.useEffect(() => {
    if (!plan.analyticsEnabled) return;
    return startWorkspaceAnalyticsClock();
  }, []);

  // Wire outbound-call trigger so any feature can call `fireOutboundCall(...)`.
  // Default categories (manual + error) are toggled in Settings → Phone & Voice.
  React.useEffect(() => {
    if (!plan.backgroundServicesEnabled) return;
    const stop = startOutboundTrigger({
      onResult: (ok, info) => {
        if (ok) {
          toast.info('Outbound call queued', `Reason: ${info.reason}`);
        } else if (
          info.error &&
          info.error !== 'cooldown' &&
          info.error !== 'cloud_not_configured'
        ) {
          // Quiet failures we don't want to spam the user about
          // (cooldown is normal during a crash burst; cloud-not-configured
          // is the user's setup problem already surfaced in Settings).
          console.warn('[outbound]', info);
        }
      },
    });
    return stop;
  }, []);

  // Listen for the jarvis:new-chat event to spawn a new chat
  React.useEffect(() => {
    if (!plan.backgroundServicesEnabled) return;
    const handleNewChat = async () => {
      try {
        const chatId = await ensureActiveChat({ forceNew: true });
        if (!chatId) {
          toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
        }
      } catch (err) {
        toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
      }
    };

    const handleBranch = async (event: Event) => {
      const detail = (event as CustomEvent<{ messageId: string; chatId: string }>).detail;
      if (!detail?.messageId || !detail?.chatId) return;
      try {
        await branchChatFromMessage({
          chatId: detail.chatId as ChatId,
          messageId: detail.messageId as MessageId,
        });
        toast.success('Branched', 'Opened a new chat from that message — continue from here.');
      } catch (err) {
        toast.error(
          'Branch failed',
          err instanceof Error ? err.message : 'Could not branch from this message.',
        );
      }
    };

    window.addEventListener('jarvis:new-chat', handleNewChat);
    window.addEventListener('jarvis:branch', handleBranch);
    return () => {
      window.removeEventListener('jarvis:new-chat', handleNewChat);
      window.removeEventListener('jarvis:branch', handleBranch);
    };
  }, []);

  return (
    <>
      {plan.lifecycleEnabled ? <WorkspaceLifecycleHosts /> : null}
      {plan.globalHotkeyEnabled ? <GlobalHotkeysHost /> : null}
      {plan.isOrdinary ? <FullscreenHost /> : null}
      {plan.idleEnabled ? <IdleDetectionHost /> : null}
      <NavigationHistoryBoundary />
      <AppShell>
        <ActiveCanvas />
      </AppShell>

      {/* Modal layer — mount only while open to avoid idle store subscriptions */}
      <CommandPaletteHost />
      <SettingsModalHost plan={plan} />
      {plan.lifecycleEnabled ? <VoiceModuleLifecycle /> : null}
      <VoiceModalHost />
      {plan.wakeWordEnabled ? <WakeWordHost /> : null}
      {plan.backgroundServicesEnabled ? (
        <React.Suspense fallback={null}>
          <CallModal />
        </React.Suspense>
      ) : null}
      <LauncherDialogHost />
      <AssistantBarHost />
      {plan.backgroundServicesEnabled ? (
        <>
          <React.Suspense fallback={null}>
            <WhatsNewHost />
          </React.Suspense>
          <React.Suspense fallback={null}>
            <NewsHost />
          </React.Suspense>
          <React.Suspense fallback={null}>
            <ProductTutorialHost />
          </React.Suspense>
        </>
      ) : null}
      {plan.updateChecksEnabled ? <UpdateWarningHost /> : null}
      {plan.backgroundServicesEnabled ? <BenchmarkRefreshHost /> : null}

      {/* Visual ambient effects removed — clean UI */}

      {/* V3 — confetti + serif gradient toast on success milestones. */}
      {plan.backgroundServicesEnabled ? (
        <React.Suspense fallback={null}>
          <CelebrationHost />
        </React.Suspense>
      ) : null}

      {/* Provider key save success burst. */}
      {plan.backgroundServicesEnabled ? <ApiKeySaveBurst /> : null}

      {/* V2 — idle takeover. Self-renders only when ambientActive=true. */}
      <React.Suspense fallback={null}>
        <AmbientHome />
      </React.Suspense>
      {plan.backgroundServicesEnabled ? <AmbientAudioHost /> : null}

      {/* Pixel Pet — video-driven atlas animations + mini-panel on click. */}
      {plan.petEnabled ? (
        <React.Suspense fallback={null}>
          <PetHost />
        </React.Suspense>
      ) : null}

      {/* V3 — 20-20-20 eye-break overlay. Self-renders only while
          wellnessActive=true (wellness.eyeBreak action / assistant). */}
      {plan.backgroundServicesEnabled ? <WellnessBreak /> : null}

      {/* V3 — actions palette (Mod+Shift+A). Direct user invocation of
          built-in actions and saved custom tools. Sibling to the
          AI-proposed approval cards rendered inline in chat bubbles. */}
      <ActionsPaletteHost />

      {plan.sttEnabled ? <GlobalSttHost /> : null}

      {/* Themed desktop file / folder explorer (Context, Files, pickers). */}
      {plan.backgroundServicesEnabled ? <FileExplorerHost /> : null}

      {/* Toast outlet */}
      {plan.backgroundServicesEnabled ? <JarvisContextMenu /> : null}
      <Toaster />
    </>
  );
}

const defaultRuntimeProfileQuery = createTauriRuntimeProfileQuery();
const defaultMonochromeEvidenceCommit = createTauriMonochromeEvidenceCommit();
const sharedHandshakePromises = new WeakMap<
  RuntimeProfileQuery,
  Map<string, Promise<RuntimeProfileEvidence>>
>();
const sharedMonochromeEvidenceCommitPromises = new WeakMap<
  MonochromeEvidenceCommit,
  Map<string, Promise<Awaited<ReturnType<MonochromeEvidenceCommit>>>>
>();

interface VerifiedRuntimeProfileProof {
  readonly nativeRuntime: boolean;
  readonly nativeHandshake?: MonochromeHandshakeEvidence;
  readonly frontendHandshake?: MonochromeHandshakeEvidence;
}

const BROWSER_RUNTIME_PROFILE_PROOF: VerifiedRuntimeProfileProof = Object.freeze({
  nativeRuntime: false,
});
const RuntimeProfileHandshakeProofContext = React.createContext<VerifiedRuntimeProfileProof>(
  BROWSER_RUNTIME_PROFILE_PROOF,
);

function isNativeTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__')
  );
}

function sharedRuntimeProfileHandshake(
  query: RuntimeProfileQuery,
  plan: RuntimePlan,
  expectation: RuntimeProfileHandshakeExpectation | undefined,
  timeoutMs?: number,
): Promise<RuntimeProfileEvidence> {
  let promises = sharedHandshakePromises.get(query);
  if (!promises) {
    promises = new Map();
    sharedHandshakePromises.set(query, promises);
  }
  const key = JSON.stringify([plan.profile.kind, expectation, timeoutMs]);
  let promise = promises.get(key);
  if (!promise) {
    promise = verifyRuntimeProfileHandshake(query, plan, expectation, timeoutMs);
    promises.set(key, promise);
    const currentPromise = promise;
    void currentPromise.catch(() => {
      if (promises?.get(key) === currentPromise) {
        promises.delete(key);
      }
    });
  }
  return promise;
}

function sharedMonochromeEvidenceCommit(
  commit: MonochromeEvidenceCommit,
  request: MonochromeEvidenceCommitRequest,
): Promise<Awaited<ReturnType<MonochromeEvidenceCommit>>> {
  let promises = sharedMonochromeEvidenceCommitPromises.get(commit);
  if (!promises) {
    promises = new Map();
    sharedMonochromeEvidenceCommitPromises.set(commit, promises);
  }
  const key = JSON.stringify(request);
  let promise = promises.get(key);
  if (!promise) {
    promise = commit(request);
    promises.set(key, promise);
  }
  return promise;
}

export function RuntimeProfileHandshakeGate({
  plan,
  expectation,
  children,
  query = defaultRuntimeProfileQuery,
  nativeRuntime = isNativeTauriRuntime(),
  timeoutMs,
}: {
  plan: RuntimePlan;
  expectation: RuntimeProfileHandshakeExpectation | undefined;
  children: React.ReactNode;
  query?: RuntimeProfileQuery;
  nativeRuntime?: boolean;
  timeoutMs?: number;
}) {
  const handshakeKey = JSON.stringify([plan.profile.kind, expectation, timeoutMs]);
  const [nativeProofState, setNativeProofState] = React.useState<{
    readonly key: string;
    readonly proof: VerifiedRuntimeProfileProof;
  }>();
  const [failure, setFailure] = React.useState<Error>();

  React.useEffect(() => {
    if (!nativeRuntime) {
      if (plan.isVisualTest) {
        document.documentElement.dataset.runtimeProfileHandshake = 'ready';
        return () => {
          delete document.documentElement.dataset.runtimeProfileHandshake;
        };
      }
      return;
    }
    let disposed = false;
    void sharedRuntimeProfileHandshake(query, plan, expectation, timeoutMs)
      .then((evidence) => {
        if (disposed) return;
        const nativeHandshake = Object.freeze({
          profile: evidence.profile,
          appIdentifier: evidence.appIdentifier,
          capabilityIdentifier: evidence.capabilityIdentifier,
          sessionNonceHash: evidence.sessionNonceHash,
        });
        const frontendHandshake =
          plan.isVisualTest && expectation
            ? Object.freeze({
                profile: plan.profile.kind,
                appIdentifier: expectation.appIdentifier,
                capabilityIdentifier: expectation.capabilityIdentifier,
                sessionNonceHash: expectation.sessionNonceHash,
              })
            : undefined;
        const proof = Object.freeze({
          nativeRuntime: true,
          nativeHandshake,
          ...(frontendHandshake ? { frontendHandshake } : {}),
        });
        document.documentElement.dataset.runtimeProfileHandshake = 'ready';
        React.startTransition(() => setNativeProofState({ key: handshakeKey, proof }));
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setFailure(
          error instanceof Error
            ? error
            : new Error('Runtime profile handshake failed: unknown failure'),
        );
      });
    return () => {
      disposed = true;
      delete document.documentElement.dataset.runtimeProfileHandshake;
    };
  }, [expectation, handshakeKey, nativeRuntime, plan, query, timeoutMs]);

  if (failure) throw failure;
  const proof = nativeRuntime
    ? nativeProofState?.key === handshakeKey
      ? nativeProofState.proof
      : undefined
    : BROWSER_RUNTIME_PROFILE_PROOF;
  return proof ? (
    <RuntimeProfileHandshakeProofContext.Provider value={proof}>
      {children}
    </RuntimeProfileHandshakeProofContext.Provider>
  ) : (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 flex items-center justify-center bg-background p-6 text-sm text-muted-foreground"
    >
      Verifying VibeSpace runtime security…
    </div>
  );
}

const FIXTURE_READY_TIMEOUT_MS = 5_000;
const FIXTURE_READY_POLL_INTERVAL_MS = 50;
const MONOCHROME_FIXTURE_ROOT_SELECTORS = Object.freeze({
  chat: '[data-monochrome-surface="chat"]',
  'settings-appearance': '#settings-panel-appearance',
  'terminal-workbench': '[data-monochrome-route="terminal"]',
} as const);
const MONOCHROME_EXACT_STATELESS_SURFACE_SELECTORS: Readonly<Record<string, string>> =
  Object.freeze({
    'a11y:pointer-targets': '[data-monochrome-surface="chat"]',
    'a11y:forced-colors': '[data-monochrome-surface="chat"]',
    'a11y:production-navigation': '[data-monochrome-surface="chat"]',
    'theme:default': '[data-monochrome-surface="chat"]',
    'theme:jarvis': '[data-monochrome-surface="chat"]',
    'theme:monochrome': '[data-monochrome-surface="chat"]',
    'theme:origami': '[data-monochrome-surface="chat"]',
    'theme:vibespace': '[data-monochrome-surface="chat"]',
    'zoom:50%': '[data-monochrome-surface="chat"]',
    'zoom:80%': '[data-monochrome-surface="chat"]',
    'zoom:100%': '[data-monochrome-surface="chat"]',
    'zoom:125%': '[data-monochrome-surface="chat"]',
    'zoom:150%': '[data-monochrome-surface="chat"]',
    'zoom:200%': '[data-monochrome-surface="chat"]',
    'spatial:canvas': '[data-monochrome-route="canvas"]',
    'spatial:context': '[data-monochrome-route="context"]',
  });
const MONOCHROME_EXACT_ROUTE_SURFACE_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  account: '.mc7f-account-page',
  'agent-detail': '[data-monochrome-route="agent-detail"]',
  agents: '[data-monochrome-route="agents"]',
  benchmarks: '[data-monochrome-route="benchmarks"]',
  browser: '.browser-shell',
  canvas: '[data-monochrome-route="canvas"]',
  chat: '[data-monochrome-surface="chat"]',
  context: '[data-monochrome-route="context"]',
  files: '[data-monochrome-route="files"]',
  history: '[data-monochrome-route="history"]',
  kanban: '[data-monochrome-route="kanban"]',
  preview: '[data-monochrome-route="preview"]',
  'project-detail': '[data-monochrome-route="project-detail"]',
  schedule: '[data-monochrome-route="schedule"]',
  skills: '[data-monochrome-route="skills"]',
  terminal: '[data-monochrome-route="terminal"]',
  tools: '[data-monochrome-route="tools"]',
  workbench: '[data-monochrome-route="workbench"]',
});

function isExactMonochromeProductState(
  request: MonochromeFixtureRequest,
  surfaceId: string,
  requestedState: string,
  requestedRoute: string,
): boolean {
  return (
    request.surfaceId === surfaceId &&
    request.requestedState === requestedState &&
    request.requestedRoute === requestedRoute &&
    request.requestedTheme === 'monochrome' &&
    request.productTheme === 'monochrome' &&
    request.origamiGate === false
  );
}

function resolveMonochromeUsagePanel(): HTMLElement | null {
  const usageTab = Array.from(
    document.querySelectorAll<HTMLElement>('.mc7f-account-page [role="tab"]'),
  ).find((element) => element.textContent?.trim() === 'Usage');
  if (!usageTab || usageTab.dataset.state !== 'active') return null;
  const panelId = usageTab.getAttribute('aria-controls');
  if (!panelId) return null;
  const panel = document.getElementById(panelId);
  if (
    !(panel instanceof HTMLElement) ||
    panel.getAttribute('role') !== 'tabpanel' ||
    panel.dataset.state !== 'active' ||
    panel.closest('.mc7f-account-page') !== usageTab.closest('.mc7f-account-page')
  ) {
    return null;
  }
  return panel;
}

function resolveMonochromeNavigationTooltip(): HTMLElement | null {
  const trigger = document.querySelector<HTMLElement>('button[aria-label="Toggle navigation"]');
  if (!trigger) return null;
  const tooltipId = trigger.getAttribute('aria-describedby');
  if (!tooltipId) return null;
  const tooltip = document.getElementById(tooltipId);
  if (!(tooltip instanceof HTMLElement) || tooltip.getAttribute('role') !== 'tooltip') {
    return null;
  }
  const label = tooltip.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return label.startsWith('Show sidebar') || label.startsWith('Hide sidebar') ? tooltip : null;
}

export function activateMonochromeFixtureProductState(request: MonochromeFixtureRequest): boolean {
  if (isExactMonochromeProductState(request, 'state:usage', 'usage', 'account')) {
    return resolveMonochromeUsagePanel() !== null;
  }
  if (isExactMonochromeProductState(request, 'state:dropdown-open', 'dropdown-open', 'chat')) {
    if (document.querySelector('.jarvis-slash-dropdown')) return true;
    const trigger = document.querySelector<HTMLElement>('button[aria-label="Choose model"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  }
  if (
    isExactMonochromeProductState(request, 'state:tooltip-visible', 'tooltip-visible', 'chat') ||
    isExactMonochromeProductState(request, 'a11y:text-contrast', 'tooltip-visible', 'chat') ||
    isExactMonochromeProductState(request, 'a11y:non-text-contrast', 'tooltip-visible', 'chat')
  ) {
    if (resolveMonochromeNavigationTooltip()) return true;
    const trigger = document.querySelector<HTMLElement>('button[aria-label="Toggle navigation"]');
    if (!trigger) return false;
    trigger.focus({ preventScroll: true });
    return true;
  }
  return true;
}

export function resolveMonochromeFixtureSurface(
  request: MonochromeFixtureRequest,
): HTMLElement | null {
  const exposed = (element: HTMLElement | null): HTMLElement | null =>
    element?.closest('[hidden], [aria-hidden="true"], .hidden') ? null : element;
  const state = useUIStore.getState();
  const authoritySelector: Readonly<Record<string, string>> = {
    'access:app-host': '.mc7f-access-app-host',
    'access:banner': '.mc7f-access-banner',
    'access:locked': '.mc7f-access-paywall',
    'detached:dictation': '[data-monochrome-surface="global-dictation"]',
    'detached:pet-mini-panel': '[data-monochrome-surface="pet-mini-panel-window"]',
    'detached:pet-overlay': '[data-monochrome-surface="pet-overlay-window"]',
    'detached:workbench-main': '[data-monochrome-route="workbench"]',
    'embedded:command-center': '[data-monochrome-surface="jarvis-command-center"]',
    'embedded:browser-operator': '.browser-shell',
    'embedded:prompt-forge': '[data-monochrome-surface="prompt-forge"]',
    'overlay:actions-palette-host': '[data-monochrome-surface="actions-palette"]',
    'overlay:activity-strip': '[role="status"][aria-label="Active agents"]',
    'overlay:ambient-home': '[data-monochrome-surface="ambient-home"]',
    'overlay:api-key-save-burst': '.mc7f-api-key-save-burst',
    'overlay:app-dispatch': 'main[aria-label="Workspace"]',
    'overlay:app-shell': '[data-monochrome-surface="app-shell"]',
    'overlay:assistant-bar-host': '[data-monochrome-surface="assistant"]',
    'overlay:call-modal': '[data-monochrome-surface="call"]',
    'overlay:celebration-host': '[data-monochrome-surface="celebration-host"]',
    'overlay:command-palette-host': '[data-monochrome-surface="command-palette"]',
    'overlay:file-explorer-host': '[data-monochrome-surface="file-explorer-dialog"]',
    'overlay:global-dictation-overlay': '[data-monochrome-surface="global-dictation"]',
    'overlay:inspector': '[data-monochrome-surface="inspector"]',
    'overlay:jarvis-context-menu': '[data-monochrome-surface="context-menu"]',
    'overlay:launcher-dialog-host': '[data-monochrome-surface="launcher-dialog"]',
    'overlay:nav-pane': '[data-monochrome-surface="navigation"]',
    'overlay:news-host': '[data-monochrome-surface="news-host"]',
    'overlay:page-router': '[data-monochrome-surface="page-router"]',
    'overlay:pet-host': '[data-monochrome-surface="pet-host"]',
    'overlay:pet-mini-panel-window': '[data-monochrome-surface="pet-mini-panel-window"]',
    'overlay:pet-overlay-window': '[data-monochrome-surface="pet-overlay-window"]',
    'overlay:product-tutorial-host': '[data-monochrome-surface="product-tutorial-host"]',
    'overlay:tab-strip': '[data-monochrome-surface="tab-strip"]',
    'overlay:top-bar': '[data-monochrome-surface="top-bar"]',
    'overlay:update-warning-host': '[data-monochrome-surface="update-warning-host"]',
    'overlay:voice-modal-host': '[data-monochrome-surface="voice"]',
    'overlay:wellness-break': '[data-monochrome-surface="wellness-break"]',
    'overlay:whats-new-host': '[data-monochrome-surface="whats-new-modal"]',
    'overlay:workbench-window-dispatch': '[data-monochrome-route="workbench"]',
  };
  const baselineAuthority = request.authorityId
    ? MONOCHROME_BASELINE_REQUEST_AUTHORITY.find((entry) => entry.surfaceId === request.authorityId)
    : undefined;
  if (baselineAuthority) {
    if (state.route !== request.requestedRoute) return null;
    if (request.fixtureId === 'settings-appearance' && !state.settingsOpen) return null;
    return exposed(
      document.querySelector<HTMLElement>(
        MONOCHROME_FIXTURE_ROOT_SELECTORS[baselineAuthority.fixtureId],
      ),
    );
  }
  if (request.authorityId?.startsWith('detached:')) {
    const selector = authoritySelector[request.authorityId];
    return selector ? exposed(document.querySelector<HTMLElement>(selector)) : null;
  }
  if (request.authorityId === MONOCHROME_DEVELOPMENT_AUTHORITY_ID) {
    return exposed(
      document.querySelector<HTMLElement>('[data-monochrome-development-surface="true"]'),
    );
  }
  if (request.authorityId === 'overlay:workbench-window-dispatch') {
    return state.route === 'workbench'
      ? exposed(
          document.querySelector<HTMLElement>(
            authoritySelector['overlay:workbench-window-dispatch'],
          ),
        )
      : null;
  }
  const settingsTab =
    request.settingsTab ??
    (request.authorityId === 'overlay:settings-modal-host' ||
    request.requestedState === 'settings-appearance'
      ? 'appearance'
      : undefined);
  if (settingsTab) {
    if (state.route !== request.requestedRoute || !state.settingsOpen) {
      return null;
    }
    return exposed(document.querySelector<HTMLElement>(`#settings-panel-${settingsTab}`));
  }
  if (state.route !== request.requestedRoute) return null;
  if (request.authorityId === 'overlay:api-key-save-burst') {
    // The real burst is intentionally aria-hidden because it is a decorative
    // visual effect; its mounted animation node is still the captured surface.
    return document.querySelector<HTMLElement>('.mc7f-api-key-save-burst');
  }
  if (request.authorityId === 'overlay:toaster') {
    const dismissButton = document.querySelector<HTMLElement>('button[aria-label="Dismiss"]');
    return exposed(dismissButton?.closest<HTMLElement>('.pointer-events-auto') ?? null);
  }
  if (request.authorityId && authoritySelector[request.authorityId]) {
    return exposed(document.querySelector<HTMLElement>(authoritySelector[request.authorityId]));
  }
  if (isExactMonochromeProductState(request, 'state:usage', 'usage', 'account')) {
    return exposed(resolveMonochromeUsagePanel());
  }
  if (isExactMonochromeProductState(request, 'state:dropdown-open', 'dropdown-open', 'chat')) {
    return exposed(document.querySelector<HTMLElement>('.jarvis-slash-dropdown'));
  }
  if (
    isExactMonochromeProductState(request, 'state:tooltip-visible', 'tooltip-visible', 'chat') ||
    isExactMonochromeProductState(request, 'a11y:text-contrast', 'tooltip-visible', 'chat') ||
    isExactMonochromeProductState(request, 'a11y:non-text-contrast', 'tooltip-visible', 'chat')
  ) {
    return exposed(resolveMonochromeNavigationTooltip());
  }
  if (isExactMonochromeProductState(request, 'state:empty-state', 'empty', 'chat')) {
    return exposed(document.querySelector<HTMLElement>('[data-vibespace-empty-chat]'));
  }
  if (isExactMonochromeProductState(request, 'state:modal-open', 'modal-open', 'chat')) {
    return exposed(document.querySelector<HTMLElement>('.mc7f-settings-modal[role="dialog"]'));
  }
  if (isExactMonochromeProductState(request, 'state:toast-visible', 'toast-visible', 'chat')) {
    const dismissButton = document.querySelector<HTMLElement>('button[aria-label="Dismiss"]');
    return exposed(dismissButton?.closest<HTMLElement>('.pointer-events-auto') ?? null);
  }
  if (isExactMonochromeProductState(request, 'state:locked-access', 'locked', 'account')) {
    return exposed(document.querySelector<HTMLElement>('.mc7f-access-paywall'));
  }
  const statelessSelector = MONOCHROME_EXACT_STATELESS_SURFACE_SELECTORS[request.surfaceId];
  if (statelessSelector) {
    return exposed(document.querySelector<HTMLElement>(statelessSelector));
  }
  const overlaySelectorByState: Readonly<Record<string, string>> = {
    'actions-palette': '[data-monochrome-surface="actions-palette"]',
    'command-palette': '[data-monochrome-surface="command-palette"]',
    launcher: '[data-monochrome-surface="launcher-dialog"]',
    assistant: '[data-monochrome-surface="assistant"]',
    voice: '[data-monochrome-surface="voice"]',
  };
  if (request.requestedState) {
    const selector = overlaySelectorByState[request.requestedState];
    return selector ? exposed(document.querySelector<HTMLElement>(selector)) : null;
  }
  if (
    request.surfaceId === `route:${request.requestedRoute}` ||
    request.surfaceId === `a11y:route:${request.requestedRoute}`
  ) {
    const selector = MONOCHROME_EXACT_ROUTE_SURFACE_SELECTORS[request.requestedRoute];
    return selector ? exposed(document.querySelector<HTMLElement>(selector)) : null;
  }
  return null;
}

let monochromeAccessAppRuntime: AccessAppRuntime | undefined;

function getMonochromeAccessAppRuntime(): AccessAppRuntime {
  if (monochromeAccessAppRuntime) return monochromeAccessAppRuntime;
  const capturedAt = 1_750_000_000_000;
  const viewModel = createAccessViewModel(
    evaluateAppAccess({
      config: {
        enabled: true,
        minVersion: null,
        rollbackEnabled: false,
        trial: { enabled: true, days: 30 },
        payment: {
          graceDays: 3,
          checkoutUrl: 'https://checkout.example',
          portalUrl: 'https://portal.example',
        },
      },
      status: {
        serverTime: new Date(capturedAt).toISOString(),
        state: 'locked',
      },
      appVersion: '1.2.3',
    }),
    { capturedAt, featureTier: 'free' },
  );
  monochromeAccessAppRuntime = Object.freeze({
    loadViewModel(signal: AbortSignal) {
      if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return Promise.resolve(viewModel);
    },
    createCheckoutUrl() {
      return Promise.resolve('https://checkout.example/');
    },
    createPortalUrl() {
      return Promise.resolve('https://portal.example/');
    },
    openExternalUrl() {
      return Promise.resolve();
    },
    signOut() {
      return Promise.resolve();
    },
    backupLocalData() {
      return Promise.resolve();
    },
  });
  return monochromeAccessAppRuntime;
}

const MONOCHROME_COMMAND_CENTER_DATA_PORT: JarvisCommandCenterDataPort = Object.freeze({
  getRunsForChat: async () => [],
  getEventsForRun: async () => [],
  getArtifactsForRun: async () => [],
  getLiveEvidenceSnapshot: async () => undefined,
  subscribe: () => () => undefined,
});
const MONOCHROME_COMMAND_CENTER_HANDLERS: JarvisCommandCenterHandlers = Object.freeze({});

export function MonochromeFixtureController({
  plan,
  request,
  children,
  commit = defaultMonochromeEvidenceCommit,
}: {
  plan: RuntimePlan;
  request: MonochromeFixtureRequest | undefined;
  children: React.ReactNode;
  commit?: MonochromeEvidenceCommit;
}) {
  const runtimeProof = React.useContext(RuntimeProfileHandshakeProofContext);
  const [configured, setConfigured] = React.useState(!request);
  const [ready, setReady] = React.useState(false);
  const [failure, setFailure] = React.useState<Error>();
  const evidencedSurface = React.useRef<HTMLElement>();
  const activatedProductState = React.useRef<MonochromeFixtureRequest>();

  React.useLayoutEffect(() => {
    if (!request) return;
    const previousActiveChatId = useUIStore.getState().activeChatId;
    const settingsTab =
      request.settingsTab ??
      (request.authorityId === 'overlay:settings-modal-host' ||
      request.requestedState === 'settings-appearance'
        ? 'appearance'
        : undefined);
    if (settingsTab) {
      monochromeSettingsTabOverride = settingsTab as SettingsTabMemoryValue;
    }
    const overlayState =
      request.authorityId === 'overlay:actions-palette-host' ||
      request.requestedState === 'actions-palette'
        ? { actionsPaletteOpen: true }
        : request.authorityId === 'overlay:command-palette-host' ||
            request.requestedState === 'command-palette'
          ? { paletteOpen: true }
          : request.authorityId === 'overlay:launcher-dialog-host' ||
              request.requestedState === 'launcher'
            ? { launcherOpen: true }
            : request.authorityId === 'overlay:assistant-bar-host' ||
                request.requestedState === 'assistant'
              ? { assistantOpen: true }
              : request.authorityId === 'overlay:voice-modal-host' ||
                  request.requestedState === 'voice'
                ? { voiceModalOpen: true }
                : request.authorityId === 'overlay:call-modal'
                  ? { callModalOpen: true }
                  : request.authorityId === 'overlay:ambient-home'
                    ? { ambientActive: true }
                    : request.authorityId === 'overlay:news-host'
                      ? { newsPanelOpen: true }
                      : request.authorityId === 'overlay:whats-new-host'
                        ? { whatsNewOpen: true }
                        : request.authorityId === 'overlay:activity-strip'
                          ? { chatMode: 'council' as const }
                          : request.authorityId === 'overlay:inspector'
                            ? { inspectorOpen: true }
                            : request.authorityId === 'overlay:workbench-window-dispatch'
                              ? { route: 'workbench' as Route }
                              : {};
    if (request.fixtureId === 'chat') {
      document.documentElement.dataset.monochromeChatFixture = 'chat';
    }
    if (isExactMonochromeProductState(request, 'state:empty-state', 'empty', 'chat')) {
      document.documentElement.dataset.monochromeChatState = 'empty-state';
    }
    useUIStore.setState({
      route: request.requestedRoute as Route,
      settingsOpen:
        settingsTab !== undefined ||
        isExactMonochromeProductState(request, 'state:modal-open', 'modal-open', 'chat'),
      theme: request.productTheme,
      activeChatId:
        request.fixtureId === 'chat'
          ? MONOCHROME_CHAT_FIXTURE.activeConversationId
          : previousActiveChatId,
      ...overlayState,
    });
    applyThemeToDocument(request.productTheme);
    document.documentElement.dataset.monochromeOrigamiGate = String(request.origamiGate);
    React.startTransition(() => setConfigured(true));
    return () => {
      evidencedSurface.current?.removeAttribute('data-monochrome-surface-id');
      if (settingsTab && monochromeSettingsTabOverride === settingsTab) {
        monochromeSettingsTabOverride = undefined;
      }
      delete document.documentElement.dataset.monochromeOrigamiGate;
      if (document.documentElement.dataset.monochromeChatFixture === 'chat') {
        delete document.documentElement.dataset.monochromeChatFixture;
      }
      if (document.documentElement.dataset.monochromeChatState === 'empty-state') {
        delete document.documentElement.dataset.monochromeChatState;
      }
      if (
        request.fixtureId === 'chat' &&
        useUIStore.getState().activeChatId === MONOCHROME_CHAT_FIXTURE.activeConversationId
      ) {
        useUIStore.setState({ activeChatId: previousActiveChatId });
      }
      activatedProductState.current = undefined;
    };
  }, [request]);

  React.useEffect(() => {
    if (!request || !configured) return;
    if (request.authorityId === 'overlay:api-key-save-burst') {
      fireApiKeySaveBurstFromElement(null);
      return;
    }
    if (
      request.authorityId === 'overlay:toaster' ||
      isExactMonochromeProductState(request, 'state:toast-visible', 'toast-visible', 'chat')
    ) {
      const toastId = toast.info(
        'MonoChrome fixture notification',
        'Product-owned toast presentation',
        0,
      );
      return () => toast.dismiss(toastId);
    }
  }, [configured, request]);

  React.useEffect(() => {
    if (!request || !configured) return;
    let disposed = false;
    let readinessTimer: number | undefined;
    const deadline = performance.now() + FIXTURE_READY_TIMEOUT_MS;
    const fontsReady =
      'fonts' in document ? document.fonts.ready.then(() => true) : Promise.resolve(true);
    void fontsReady
      .then(() => {
        const inspect = () => {
          if (disposed) return;
          const themeReady =
            document.documentElement.dataset.theme === resolveTheme(request.productTheme);
          const fallback = document.querySelector('[data-monochrome-fallback="true"]') !== null;
          if (activatedProductState.current !== request) {
            if (activateMonochromeFixtureProductState(request)) {
              activatedProductState.current = request;
            }
          }
          const surface = resolveMonochromeFixtureSurface(request);
          if (themeReady && !fallback && surface) {
            surface.dataset.monochromeSurfaceId = request.surfaceId;
            evidencedSurface.current = surface;
            const requiresNativeCommit =
              runtimeProof.nativeRuntime &&
              request.authorityId === 'route:chat' &&
              request.fixtureId === 'chat' &&
              request.fixtureHash ===
                'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9' &&
              request.surfaceId === 'route:chat' &&
              request.requestedRoute === 'chat' &&
              request.requestedState === undefined &&
              request.requestedTheme === 'monochrome' &&
              request.productTheme === 'monochrome' &&
              request.origamiGate === false &&
              request.settingsTab === undefined;
            if (!requiresNativeCommit) {
              React.startTransition(() => setReady(true));
              return;
            }
            if (!runtimeProof.nativeHandshake || !runtimeProof.frontendHandshake) {
              setFailure(new Error('MonoChrome native evidence commit failed.'));
              return;
            }
            const commitRequest: MonochromeEvidenceCommitRequest = Object.freeze({
              nativeHandshake: runtimeProof.nativeHandshake,
              frontendHandshake: runtimeProof.frontendHandshake,
              readiness: Object.freeze({
                status: 'PASS',
                application: 'READY',
                fixtureSmoke: 'PASS',
                surface: 'route:chat',
                theme: 'monochrome',
                font: 'READY',
                fallback: 'NOT_USED',
              }),
              errors: Object.freeze({
                page: Object.freeze([] as []),
                native: Object.freeze([] as []),
              }),
            });
            void sharedMonochromeEvidenceCommit(commit, commitRequest)
              .then(() => {
                if (!disposed) React.startTransition(() => setReady(true));
              })
              .catch(() => {
                if (!disposed) setFailure(new Error('MonoChrome native evidence commit failed.'));
              });
            return;
          }
          if (performance.now() >= deadline) {
            setFailure(new Error('MonoChrome fixture readiness failed.'));
            return;
          }
          readinessTimer = window.setTimeout(inspect, FIXTURE_READY_POLL_INTERVAL_MS);
        };
        inspect();
      })
      .catch(() => {
        if (!disposed) setFailure(new Error('MonoChrome fixture readiness failed.'));
      });
    return () => {
      disposed = true;
      if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
    };
  }, [commit, configured, request, runtimeProof]);

  if (failure) throw failure;
  if (!configured) return null;
  const fixtureChildren =
    request?.authorityId === 'overlay:celebration-host' ? (
      <React.Suspense fallback={null}>
        <CelebrationHost runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:call-modal' ? (
      <CallModal runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'overlay:jarvis-context-menu' ? (
      <JarvisContextMenu runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'overlay:news-host' ? (
      <React.Suspense fallback={null}>
        <NewsHost runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:page-router' ? (
      <PageRouter />
    ) : request?.authorityId === 'overlay:pet-host' ? (
      <React.Suspense fallback={null}>
        <PetHost runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:product-tutorial-host' ? (
      <React.Suspense fallback={null}>
        <ProductTutorialHost runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:update-warning-host' ? (
      <UpdateWarningHost runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'overlay:wellness-break' ? (
      <WellnessBreak runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'overlay:whats-new-host' ? (
      <React.Suspense fallback={null}>
        <WhatsNewHost runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:file-explorer-host' ? (
      <FileExplorerHost runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'embedded:command-center' ? (
      <JarvisCommandCenter
        accountId="monochrome-fixture-account"
        chatId="monochrome-fixture-chat"
        dataPort={MONOCHROME_COMMAND_CENTER_DATA_PORT}
        handlers={MONOCHROME_COMMAND_CENTER_HANDLERS}
        embedded
      />
    ) : request?.authorityId === 'embedded:prompt-forge' ? (
      <TooltipProvider>
        <PromptForgeControl
          status="idle"
          statusMessage="Ready to upgrade prompt"
          isRunning={false}
          disabledReason={null}
          error={null}
          compact={false}
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={[]}
          onModelSelectionChange={() => undefined}
          privacyMode="local_only"
          onPrivacyModeChange={() => undefined}
          allowPublicResearch={false}
          onAllowPublicResearchChange={() => undefined}
          publicResearchAvailable={false}
          offlineMode
          autoUpgradeOnSend={false}
          onAutoUpgradeOnSendChange={() => undefined}
          onStart={() => undefined}
          onCancel={() => undefined}
        />
      </TooltipProvider>
    ) : request?.authorityId === 'access:app-host' ? (
      <AccessAppHost enabled runtime={getMonochromeAccessAppRuntime()}>
        {children}
      </AccessAppHost>
    ) : request?.authorityId === 'access:banner' ? (
      <AccessBanner
        displayState="trialing"
        trialDaysRemaining={3}
        trialEndsAt="2026-08-02"
        onManageBilling={() => undefined}
        onSubscribe={() => undefined}
      />
    ) : request?.authorityId === 'overlay:global-dictation-overlay' ? (
      <GlobalDictationOverlay runtimeEffectsEnabled={false} />
    ) : request?.authorityId === 'overlay:pet-mini-panel-window' ? (
      <React.Suspense fallback={null}>
        <PetMiniPanelWindow runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'overlay:pet-overlay-window' ? (
      <React.Suspense fallback={null}>
        <PetOverlayWindow runtimeEffectsEnabled={false} />
      </React.Suspense>
    ) : request?.authorityId === 'access:locked' ||
      (request &&
        isExactMonochromeProductState(request, 'state:locked-access', 'locked', 'account')) ? (
      <AccessPaywall
        displayState="locked"
        featureTier="free"
        onContinue={() => undefined}
        onSubscribe={() => undefined}
        onManageBilling={() => undefined}
        onRestoreAccess={() => undefined}
        onSignOut={() => undefined}
        onExportData={() => undefined}
        onPrivacy={() => undefined}
        onTerms={() => undefined}
      />
    ) : (
      children
    );
  return (
    <>
      {fixtureChildren}
      {request?.authorityId === 'overlay:api-key-save-burst' ? <ApiKeySaveBurst /> : null}
      {request && ready ? (
        <output
          hidden
          data-monochrome-fixture-ready="true"
          data-runtime-profile={plan.profile.kind}
          data-fixture-hash={request.fixtureHash}
          data-resolved-theme={request.requestedTheme}
          data-document-theme={resolveTheme(request.productTheme)}
          data-font-ready="true"
          data-fallback="false"
          data-origami-gate={String(request.origamiGate)}
        />
      ) : null}
    </>
  );
}

/**
 * App root: AuthGate decides whether to show Onboarding or the workspace.
 * Onboarding flow is its own component owned by A8.
 *
 * Two safety wrappers sit around AuthGate:
 *
 *   - <ErrorBoundary>: catches any uncaught render error and shows a
 *     recoverable error card instead of the React tree blanking out.
 *     Without it, a crash inside any lazy chunk or boot effect would
 *     leave the user staring at a dark window.
 *
 *   - <DevConsoleHost>: installs the patchers (console / fetch /
 *     invoke / dispatch / window-error) that pump events into the
 *     in-app DevConsole panel, plus the Mod+Shift+D and F12 hotkeys
 *     to summon it. Mounted at the root so it captures onboarding-
 *     stage logs too.
 */
function AppContent({ plan }: { plan: RuntimePlan }) {
  const view = new URLSearchParams(window.location.search).get('view');
  const auxiliaryView = view === 'dictation' || view === 'pet-overlay' || view === 'pet-mini-panel';
  const cloudBootQuarantineStarted = React.useRef(false);
  const [cloudBootQuarantined, setCloudBootQuarantined] = React.useState(false);

  React.useLayoutEffect(() => {
    if (auxiliaryView || cloudBootQuarantineStarted.current) return;
    cloudBootQuarantineStarted.current = true;
    // Persisted cloud identity and billing state are recovery hints, not
    // authority. Hide them before AuthGate or any boot listener can observe
    // the first main-window render; Supabase may restore them after verification.
    applyCloudSession(null);
    React.startTransition(() => setCloudBootQuarantined(true));
  }, [auxiliaryView]);

  // Commit the fail-closed store state before mounting any child that can
  // subscribe to account identity or plan entitlements.
  if (!auxiliaryView && !cloudBootQuarantined) return null;

  if (view === 'dictation') {
    return (
      <ErrorBoundary>
        <ThemeHost />
        <GlobalDictationOverlay runtimeEffectsEnabled={plan.sttEnabled} />
      </ErrorBoundary>
    );
  }

  if (view === 'pet-overlay') {
    return (
      <ErrorBoundary>
        <ThemeHost />
        <React.Suspense fallback={null}>
          <PetOverlayWindow runtimeEffectsEnabled={plan.petEnabled} />
        </React.Suspense>
      </ErrorBoundary>
    );
  }

  if (view === 'pet-mini-panel') {
    return (
      <ErrorBoundary>
        <ThemeHost />
        <React.Suspense fallback={null}>
          <PetMiniPanelWindow runtimeEffectsEnabled={plan.petEnabled} />
        </React.Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeHost />
      {plan.kernelEnabled && KERNEL_SMOKE_ENABLED ? <KernelSmokeBindingHost /> : null}
      <KernelBridgeBootstrap />
      <ToolGatewayHost />
      {plan.terminalCliEnabled ? <TerminalCliRuntimeHost /> : null}
      {plan.devConsoleEnabled ? <DevConsoleHost /> : null}
    </ErrorBoundary>
  );
}

function RecoveryCallbackHost({ callback }: { callback: Promise<RecoveryCallbackResult> }) {
  const [recoverySession, setRecoverySession] = React.useState<RecoveryPasswordSession | null>(
    null,
  );

  React.useEffect(() => {
    let current = true;
    void callback.then((result) => {
      if (!current) {
        if (result.status === 'ready') {
          const client = getSupabaseClient();
          if (client) void abandonRecoverySessionOwnership(client.auth, result.ownership);
          else result.ownership.release();
        }
        return;
      }
      if (result.status === 'ready') {
        setRecoverySession(result);
      } else if (result.status === 'error') {
        toast.error('Recovery link unavailable', result.message);
      }
    });
    return () => {
      current = false;
    };
  }, [callback]);

  return recoverySession ? (
    <SignInDialog
      open
      onOpenChange={(open) => {
        if (!open) setRecoverySession(null);
      }}
      recoverySession={recoverySession}
    />
  ) : null;
}

export function App() {
  // Callback material must leave the address before any gate or ordinary app
  // surface renders. The singleton consumer also coalesces StrictMode renders.
  const supabase = getSupabaseClient();
  const recoveryCallback = consumeRecoveryCallbackOnce(window, supabase?.auth ?? null);

  // Resolve all compile-time inputs synchronously before React mounts any
  // product effect host. Invalid profile or isolation identity values throw.
  const plan = resolveRuntimePlan();
  const expectation = resolveRuntimeProfileHandshakeExpectation(plan);
  const request = parseMonochromeFixtureRequest(
    plan,
    new URLSearchParams(window.location.search),
    window.location.pathname,
  );
  return (
    <RuntimeProfileHandshakeGate plan={plan} expectation={expectation}>
      <MonochromeFixtureController plan={plan} request={request}>
        <RecoveryCallbackHost callback={recoveryCallback} />
        <AppContent plan={plan} />
      </MonochromeFixtureController>
    </RuntimeProfileHandshakeGate>
  );
}

export default App;
