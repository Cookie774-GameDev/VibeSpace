import * as React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useMotionValue, type MotionStyle } from 'motion/react';
import { ChevronDown, ChevronUp, Shield } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { messageRepo } from '@/lib/db';
import { canRunLocalCommandWithoutModel, requiresLocalCommandPreflight } from '@/features/local-command-bridge/preModelBridge';
import { buildLocalTurnReceipt } from '@/features/local-command-bridge/localTurnReceipt';
import { createVoiceLocalCommandBoundary, type VoiceLocalCommandOutcome } from './voiceLocalCommandBoundary';
import { useChatMessages } from '@/features/chat/hooks';
import { ensureJarvisChatForProvider, focusVoiceChat } from './voiceChatRouting';
import type { ChatId } from '@/types';
import type { VoiceState } from './store';
import { useVoiceStore } from './store';
import { JarvisVoiceInputService as VoiceService } from './JarvisVoiceInputService';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';
import { PERSONAS } from './personas';
import { JarvisVoiceHeader } from './JarvisVoiceHeader';
import { JarvisVoiceTranscript } from './JarvisVoiceTranscript';
import { ContextGalaxy } from '@/features/context/ContextGalaxy';
import {
  contextTreeToGalaxyData,
  getContextGalaxySnapshot,
  subscribeContextGalaxySnapshots,
  type ContextGalaxySnapshot,
} from '@/features/context/contextGalaxyRegistry';
import { clampVoicePanelTranslation, shouldStartVoicePanelDrag } from './voicePanelDrag';
import {
  handleVoiceModuleClosed,
  speakWithSettings,
  stopCurrentVoiceResponse,
} from './voiceRouter';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';
import { modelSupportsVision } from '@/lib/ai/vision';
import {
  parseVoiceProviderOverrides,
  resolveVoiceProviderSelection,
  voiceProviderForConnectionId,
} from './voiceProviderSelection';
import { captureVoiceScreenAttachment } from './voiceScreenCapture';
import {
  formatPreviousVoiceTaskContext,
  listPreviousVoiceTasks,
  recordVoiceConversation,
  voiceTaskCoordinator,
} from './voiceTaskCoordinator';
import { syncVoiceConversationFolder } from './voiceConversationFolder';
import { createVoiceAgentFlow } from './voiceAgentFlow';
import { dispatchVoiceMainRequest } from './voiceNativeDelegation';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import {
  readChatReasoningPreference,
  writeChatReasoningEffort,
  writeChatReasoningMode,
} from '@/features/chat/reasoningSlashStore';
import { resolveVoiceListenTimeoutMs } from './voiceConversation';
import { createVoiceSessionBinding, newVoiceSessionId } from './voiceSessionBinding';
import {
  useThemeLayoutTransition,
  useThemeMotionLayout,
  useThemeMotionTransition,
} from '@/features/appearance/themeMotion';
import {
  formatChatModelSelectionLabel,
  modelSelectionContextFromAuth,
  validateSendModelAccess,
} from '@/lib/ai/modelSelection';
import {
  JarvisCommandCenter,
  useJarvisCommandCenterBinding,
} from '@/features/jarvis-command-center/JarvisCommandCenter';
import {
  isCurrentJarvisApprovalNavigationTarget,
  subscribeJarvisApprovalNavigation,
  type JarvisApprovalNavigationIntent,
} from '@/features/jarvis-command-center/approvalNavigation';
import type { JarvisCommandCenterHandlers } from '@/features/jarvis-command-center/types';
import {
  processVoiceFinalEvent,
  shouldAutoSendOnSilence,
  voiceListeningHint,
  VOICE_REPLY_COOLDOWN_MS,
} from './voiceTurnCommit';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_EVIDENCE } from '@/lib/jarvis/smoke/evidenceIds';
import { KERNEL_SMOKE_SCENARIOS } from '@/lib/jarvis/smoke/scenarios';
import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import { createVoiceSignalController, type VoiceSignalController } from './voiceSignal';
import { VoiceModelSelector } from './VoiceModelSelector';
import './voice.sakura.css';
import './voice-module.css';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});
function formatVoiceFailure(actionLabel: string, reason: string): string {
  return formatJarvisVerifiedNarration({
    kind: 'failure',
    actionLabel,
    reason,
  }).text;
}

const VOICE_SESSION_CLOSE_FAILURE = formatVoiceFailure(
  'Voice session closure',
  'The previous voice session could not be closed cleanly',
);
const VOICE_SESSION_START_FAILURE = formatVoiceFailure(
  'Voice session startup',
  'A Jarvis chat could not be prepared for the new voice session',
);
const VOICE_CHAT_TARGET_FAILURE = formatVoiceFailure(
  'Voice message routing',
  'No Jarvis chat target was available',
);
const VOICE_BOUND_CHAT_FAILURE = formatVoiceFailure(
  'Voice message routing',
  'The active voice session has no bound Jarvis chat',
);
const VOICE_MESSAGE_SAVE_FAILURE = formatVoiceFailure(
  'Voice message',
  'The local message could not be saved, so nothing was sent',
);
const KERNEL_SMOKE_VOICE_FIXTURE_SHA256 =
  'b3bab750a95495ae54c457b54cb9a066147e36acc6a711e1a09ea05265c272f7';

// React 18's HTML types omit inert; retain the native attribute on legacy chrome.
const LEGACY_VOICE_INERT_ATTRIBUTES = { inert: '' };

type SmokeSttState = 'idle' | 'transcribing' | 'submitted' | 'blocked_external';
type SmokeSttBlocker =
  | 'fixture_contract'
  | 'model_unavailable'
  | 'python_unavailable'
  | 'engine_failed'
  | 'transcript_mismatch';

function smokeSttBlocker(error: unknown): SmokeSttBlocker {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('fixture_contract')) return 'fixture_contract';
  if (message.includes('not downloaded')) return 'model_unavailable';
  if (message.includes('Python 3 is required')) return 'python_unavailable';
  if (message.includes('transcript_contract')) return 'transcript_mismatch';
  return 'engine_failed';
}

class VoiceSurfaceGuard extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Isolate voice-module render faults so they cannot blank the host app.
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Paused — click the orb to resume',
  error: 'Voice error',
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  React.useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

const LEGACY_VOICE_PANEL_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 360,
  damping: 30,
} as const);
const LEGACY_COMMAND_CENTER_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 340,
  damping: 32,
  mass: 0.8,
} as const);

export function VoiceModal() {
  return (
    <VoiceSurfaceGuard>
      <VoiceModalPanel />
    </VoiceSurfaceGuard>
  );
}

function VoiceModalPanel() {
  const open = useUIStore((state) => state.voiceModalOpen);
  const textInputMode = useUIStore((state) => state.voiceInputMode === 'text');
  const theme = useUIStore((state) => state.theme);
  const setOpen = useUIStore((state) => state.setVoiceModalOpen);
  const localUserId = useAuthStore((state) => state.localUserId);
  const cloudAccountId = useAuthStore((state) => state.cloudSession?.user_id ?? null);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const agentRoster = useAgentStore((state) => state.agents);
  const voiceAutoListenOnOpen = useAuthStore((state) => state.voiceAutoListenOnOpen);
  const voiceEndTrigger = useAuthStore((state) => state.voiceEndTrigger);
  const voiceCommitPhrase = useAuthStore((state) => state.voiceCommitPhrase);
  const fasterWhisperModel = useAuthStore((state) => state.fasterWhisperModel);
  const chatModelSelection = useAuthStore((state) => state.chatModelSelection);
  const voiceMainAgentProvider = useAuthStore((state) => state.voiceMainAgentProvider);
  const selectedMainProvider = (chatModelSelection.mode === 'single'
    ? voiceProviderForConnectionId(chatModelSelection.connectionId)
    : null) ?? voiceMainAgentProvider;
  const [activeMainProvider, setActiveMainProvider] = React.useState(selectedMainProvider);
  const voiceAccentIntensity = useAuthStore((state) => state.voiceAccentIntensity);
  const voiceStartFreshChat = useAuthStore((state) => state.voiceStartFreshChat);
  const voiceMiniBarEnabled = useAuthStore((state) => state.voiceMiniBarEnabled);
  const [miniBarText, setMiniBarTextValue] = React.useState('');
  const miniBarDraftRevisionRef = React.useRef(0);
  const setMiniBarText = React.useCallback((value: string) => {
    miniBarDraftRevisionRef.current += 1;
    setMiniBarTextValue(value);
  }, []);
  const { flatOptions: accessibleModels } = useAccessibleChatModels();
  const accessibleModelsRef = React.useRef(accessibleModels);
  accessibleModelsRef.current = accessibleModels;
  const commandCenterBinding = useJarvisCommandCenterBinding();
  const [showCommandCenter, setShowCommandCenter] = React.useState(false);
  const [capturePending, setCapturePending] = React.useState(false);
  const commandCenterDisclosureRef = React.useRef<HTMLButtonElement>(null);
  const [expandedTranscriptIds, setExpandedTranscriptIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const session = useVoiceStore((voice) => voice.session);
  const agentsByChat = useJarvisInteractionStore((state) => state.agentsByChat);
  const priorVoiceTasks = React.useMemo(
    () =>
      session && workspaceId
        ? listPreviousVoiceTasks(
            {
              accountId: session.accountId,
              workspaceId: String(workspaceId),
              projectId: projectId ? String(projectId) : null,
            },
            String(session.chatId),
            agentsByChat,
          )
        : [],
    [agentsByChat, projectId, session, workspaceId],
  );
  const liveGalaxySnapshot = React.useSyncExternalStore(
    subscribeContextGalaxySnapshots,
    () => getContextGalaxySnapshot(session?.accountId ?? null, projectId),
    () => null,
  );
  const [persistedGalaxySnapshot, setPersistedGalaxySnapshot] =
    React.useState<ContextGalaxySnapshot | null>(null);
  const galaxySnapshot = liveGalaxySnapshot ?? persistedGalaxySnapshot;
  const [galaxySelectedId, setGalaxySelectedId] = React.useState<string | null>(null);
  const messages = useChatMessages(open && showCommandCenter ? (session?.chatId ?? null) : null);
  const state = useVoiceStore((voice) => voice.state);
  const partial = useVoiceStore((voice) => voice.partialTranscript);
  const persona = useVoiceStore((voice) => voice.persona);
  const errorMessage = useVoiceStore((voice) => voice.errorMessage);
  const reducedMotion = usePrefersReducedMotion();
  const panelTransition = useThemeMotionTransition(LEGACY_VOICE_PANEL_TRANSITION);
  const panelLayout = useThemeMotionLayout('size');
  const commandCenterTransition = useThemeLayoutTransition(LEGACY_COMMAND_CENTER_TRANSITION);
  const levelRef = React.useRef(0);
  const signalControllerRef = React.useRef<VoiceSignalController | null>(null);
  if (!signalControllerRef.current) {
    signalControllerRef.current = createVoiceSignalController(levelRef);
  }
  const pendingUtteranceRef = React.useRef('');
  const utteranceTimerRef = React.useRef<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const cooldownTimerRef = React.useRef<number | null>(null);
  const partialTimerRef = React.useRef<number | null>(null);
  const pendingPartialRef = React.useRef('');
  const speakingRef = React.useRef(false);
  const streamingReplyRef = React.useRef(false);
  const manuallyStoppedReplyRef = React.useRef(false);
  const flushUtteranceRef = React.useRef<(text: string, onCommitted?: () => void) => void>(() => undefined);
  const voiceFlowActiveRef = React.useRef(false);
  const voiceFlowGenerationRef = React.useRef(0);
  const scopeRevisionRef = React.useRef(0);
  const pendingRequestSessionRef = React.useRef<{
    sessionId: string; accountId: string; chatId: string;
  } | null>(null);
  const openingIdRef = React.useRef<string | null>(null);
  const openingScopeRef = React.useRef('');
  const providerChatsRef = React.useRef<Record<string, Promise<ChatId | null>>>({});
  const [voiceFlowStatus, setVoiceFlowStatus] = React.useState('');
  const listeningArmedRef = React.useRef(false);
  const turnBusyRef = React.useRef(false);
  const [smokeSttState, setSmokeSttState] = React.useState<SmokeSttState>('idle');
  const [smokeSttBlockerCode, setSmokeSttBlockerCode] = React.useState<SmokeSttBlocker>();
  const [smokeSttRunBound, setSmokeSttRunBound] = React.useState(false);
  // True when the mic was actively listening as external speech (e.g. a
  // Settings voice preview) started - so we can hand the mic back afterwards
  // instead of leaving push-to-talk silently disarmed.
  const resumeListeningAfterSpeechRef = React.useRef(false);
  React.useEffect(() => {
    const revokePending = () => {
      scopeRevisionRef.current += 1;
      voiceFlowGenerationRef.current += 1;
      voiceFlowActiveRef.current = false;
      pendingRequestSessionRef.current = null;
      turnBusyRef.current = false;
      setMiniBarText('');
    };
    // Observe transitions synchronously. React can coalesce A -> B -> A into
    // unchanged visible values; a revoked pending turn must not revive with them.
    const offAuth = useAuthStore.subscribe((next, previous) => {
      if (resolveAccountIdentity(next)?.accountId !== resolveAccountIdentity(previous)?.accountId ||
          next.workspaceId !== previous.workspaceId || next.projectId !== previous.projectId) {
        revokePending();
      }
    });
    const offUi = useUIStore.subscribe((next, previous) => {
      if ((previous.voiceModalOpen && !next.voiceModalOpen) ||
          next.voiceInputMode !== previous.voiceInputMode) revokePending();
    });
    const offSession = useVoiceStore.subscribe((next) => {
      const bound = pendingRequestSessionRef.current;
      const session = next.session;
      if (bound && (!session || session.sessionId !== bound.sessionId ||
          session.accountId !== bound.accountId || String(session.chatId) !== bound.chatId)) {
        revokePending();
      }
    });
    return () => {
      offAuth(); offUi(); offSession();
      scopeRevisionRef.current += 1;
      voiceFlowGenerationRef.current += 1;
      pendingRequestSessionRef.current = null;
    };
  }, []);
  const personaCfg = PERSONAS[persona];
  const modelLabel = React.useMemo(
    () =>
      formatChatModelSelectionLabel(
        chatModelSelection,
        modelSelectionContextFromAuth(useAuthStore.getState()),
      ),
    [chatModelSelection],
  );
  React.useEffect(() => {
    const signal = signalControllerRef.current;
    if (!signal || !open) {
      signal?.stop();
      return;
    }
    if (state === 'listening' && !textInputMode) void signal.startListening();
    else if (state === 'speaking') signal.startSpeaking();
    else if (state !== 'thinking') signal.stop();
    return () => {
      if (!useUIStore.getState().voiceModalOpen) signal.stop();
    };
  }, [open, state, textInputMode]);
  const commandCenterHandlers = React.useMemo<JarvisCommandCenterHandlers>(() => {
    const hostPort = commandCenterBinding?.hostPort;
    if (!hostPort) return {};
    const requireBoundAccount = (accountId: string) => {
      if (accountId !== hostPort.accountId) {
        throw new Error('jarvis_command_center_account_mismatch');
      }
    };
    return {
      cancelRun(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.requestCancellation(runId);
      },
      retryScheduledTransport(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.retryScheduledTransport(runId);
      },
      retryLogicalRun(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.retryLogicalRun(runId);
      },
    };
  }, [commandCenterBinding]);
  const eligibleCommandCenterBinding =
    session && commandCenterBinding?.hostPort.accountId === session.accountId
      ? commandCenterBinding
      : undefined;
  React.useEffect(() => {
    setGalaxySelectedId(galaxySnapshot?.selectedId ?? galaxySnapshot?.nodes[0]?.id ?? null);
  }, [galaxySnapshot?.mapId, galaxySnapshot?.selectedId, galaxySnapshot?.nodes]);
  React.useEffect(() => {
    if (!open || !showCommandCenter || !session || liveGalaxySnapshot) {
      if (liveGalaxySnapshot) setPersistedGalaxySnapshot(null);
      return;
    }
    let active = true;
    void import('@/features/context/contextPersistence')
      .then(({ ensureContextPersistence }) => ensureContextPersistence(projectId))
      .then((state) => {
        if (!active || state.accountId !== session.accountId || state.projectId !== projectId)
          return;
        const map =
          state.maps.find(
            (candidate) => candidate.id === state.selectedMapId && candidate.status === 'active',
          ) ?? state.maps.find((candidate) => candidate.status === 'active');
        if (!map) {
          setPersistedGalaxySnapshot(null);
          return;
        }
        const data = contextTreeToGalaxyData(map.tree);
        setPersistedGalaxySnapshot({
          accountId: state.accountId,
          projectId: state.projectId,
          mapId: map.id,
          nodes: data.nodes,
          edges: data.edges,
          selectedId: data.nodes[0]?.id ?? null,
          activityNodeIds: [],
          updatedAt: Date.now(),
        });
      })
      .catch(() => {
        if (active) setPersistedGalaxySnapshot(null);
      });
    return () => {
      active = false;
    };
  }, [liveGalaxySnapshot, open, projectId, session, showCommandCenter]);
  const commandCenterRegionId = React.useId();
  const handleCommandCenterEscape = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !showCommandCenter) return;
      event.preventDefault();
      event.stopPropagation();
      setShowCommandCenter(false);
      commandCenterDisclosureRef.current?.focus();
    },
    [showCommandCenter],
  );

  React.useEffect(() => {
    let disposed = false;
    let generation = 0;
    const returnToChatApproval = (requested: JarvisApprovalNavigationIntent | undefined) => {
      // The undefined notification emitted after the chat acknowledges this
      // exact target must not cancel the matching voice-to-chat handoff.
      if (!requested) return;
      const requestGeneration = ++generation;
      if (
        !session ||
        !eligibleCommandCenterBinding ||
        requested.accountId !== session.accountId ||
        requested.chatId !== session.chatId
      ) {
        return;
      }
      void isCurrentJarvisApprovalNavigationTarget(eligibleCommandCenterBinding.dataPort, requested)
        .then((isCurrent) => {
          if (disposed || requestGeneration !== generation) return;
          if (!isCurrent) return;
          setOpen(false);
          focusVoiceChat(session.chatId);
        })
        .catch(() => undefined);
    };
    const unsubscribe = subscribeJarvisApprovalNavigation(returnToChatApproval);
    return () => {
      disposed = true;
      generation += 1;
      unsubscribe();
    };
  }, [eligibleCommandCenterBinding, session, setOpen]);

  // Drag state — primary-button drag on the panel chrome, clamped to viewport
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const isDragging = React.useRef(false);
  const dragStart = React.useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const panelRef = React.useRef<HTMLElement>(null);

  const clampPanelToViewport = React.useCallback(
    (requested = { x: dragX.get(), y: dragY.get() }) => {
      const panel = panelRef.current;
      if (!panel) return;
      const next = clampVoicePanelTranslation({
        rect: panel.getBoundingClientRect(),
        current: { x: dragX.get(), y: dragY.get() },
        requested,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      if (Math.abs(next.x - dragX.get()) > 0.5) dragX.set(next.x);
      if (Math.abs(next.y - dragY.get()) > 0.5) dragY.set(next.y);
    },
    [dragX, dragY],
  );

  const handleDragStart = React.useCallback(
    (e: React.PointerEvent) => {
      if (!shouldStartVoicePanelDrag(e.button, e.target)) return;
      e.preventDefault();
      isDragging.current = true;
      dragStart.current = { x: dragX.get(), y: dragY.get(), mx: e.clientX, my: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [dragX, dragY],
  );

  const handleDragMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rawX = dragStart.current.x + (e.clientX - dragStart.current.mx);
      const rawY = dragStart.current.y + (e.clientY - dragStart.current.my);
      clampPanelToViewport({ x: rawX, y: rawY });
    },
    [clampPanelToViewport],
  );

  const handleDragEnd = React.useCallback(() => {
    isDragging.current = false;
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const reclamp = () => clampPanelToViewport();
    reclamp();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reclamp);
    observer?.observe(panel);
    panel.addEventListener('transitionend', reclamp);
    window.addEventListener('resize', reclamp);
    return () => {
      observer?.disconnect();
      panel.removeEventListener('transitionend', reclamp);
      window.removeEventListener('resize', reclamp);
    };
  }, [clampPanelToViewport, open, showCommandCenter]);

  const stopListening = React.useCallback((nextState: VoiceState = 'idle') => {
    setCapturePending(false);
    listeningArmedRef.current = false;
    if (utteranceTimerRef.current !== null) window.clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = null;
    if (partialTimerRef.current !== null) window.clearTimeout(partialTimerRef.current);
    partialTimerRef.current = null;
    pendingPartialRef.current = '';
    pendingUtteranceRef.current = '';
    resumeListeningAfterSpeechRef.current = false;
    VoiceService.cancelListening();
    useUIStore.getState().setVoiceListening(false);
    useVoiceStore.getState().setPartialTranscript('');
    useVoiceStore.getState().setState(nextState);
  }, []);

  const startListening = React.useCallback(() => {
    if (useUIStore.getState().voiceInputMode === 'text') return false;
    const supported = VoiceService.isSupported();
    if (!supported) {
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore
        .getState()
        .setState('error', 'Speech recognition is unavailable in this runtime.');
      return false;
    }
    listeningArmedRef.current = true;
    const auth = useAuthStore.getState();
    VoiceService.setInactivityTimeoutMs(
      resolveVoiceListenTimeoutMs(
        auth.voiceAutoListenOnOpen,
        auth.voiceEndTrigger,
        auth.voiceSilenceDelayMs,
      ),
    );
    const started = VoiceService.startListening();
    const capturing = started && VoiceService.isListening();
    setCapturePending(started && !capturing);
    useUIStore.getState().setVoiceListening(capturing);
    if (started) {
      useVoiceStore.getState().setState(capturing ? 'listening' : 'idle');
      return true;
    }
    // Failed startup already reports its actionable error. A request acceptance
    // or a retry timer is never evidence that the microphone is capturing.
    listeningArmedRef.current = false;
    return false;
  }, []);

  /** Stop the current spoken reply and hand control straight back to the user. */
  const stopSpeaking = React.useCallback(() => {
    voiceFlowGenerationRef.current += 1;
    voiceFlowActiveRef.current = false;
    pendingRequestSessionRef.current = null;
    manuallyStoppedReplyRef.current = true;
    stopCurrentVoiceResponse();
    speakingRef.current = false;
    streamingReplyRef.current = false;
    turnBusyRef.current = false;
    resumeListeningAfterSpeechRef.current = false;
    if (useAuthStore.getState().voiceAutoListenOnOpen && !textInputMode) {
      listeningArmedRef.current = true;
      startListening();
    } else {
      useVoiceStore.getState().setState('idle');
    }
  }, [startListening, textInputMode]);

  const toggleListening = React.useCallback(() => {
    if (state === 'thinking' || state === 'speaking' || speakingRef.current) {
      stopSpeaking();
      return;
    }
    if (capturePending || state === 'listening' || useUIStore.getState().voiceListening) {
      stopListening(voiceAutoListenOnOpen ? 'paused' : 'idle');
      return;
    }
    if (!voiceAutoListenOnOpen) {
      listeningArmedRef.current = true;
    }
    startListening();
  }, [capturePending, startListening, state, stopListening, stopSpeaking, voiceAutoListenOnOpen]);

  React.useEffect(() => {
    if (open) return;
    // The panel component stays mounted between openings. A fresh-chat choice
    // must receive a new opening ID instead of reusing the prior promise.
    // Invalidate the old Main acceptance wait so a new conversation can take
    // another distinct turn immediately. Its late completion cannot clear the
    // new turn's active flag or paint a stale status into the reopened panel.
    voiceFlowGenerationRef.current += 1;
    voiceFlowActiveRef.current = false;
    // A hidden panel can outlive its session during a renderer remount. Keep
    // its dedicated microphone service and visible state in sync without
    // cancelling the Main Agent's already accepted background task.
    const staleVoice = useVoiceStore.getState();
    if (staleVoice.session || staleVoice.state === 'listening' || VoiceService.wantsListening()) {
      VoiceService.cancelListening();
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore.getState().setState('idle');
      if (staleVoice.session) useVoiceStore.getState().endSession(staleVoice.session.sessionId);
    }
    openingScopeRef.current = '';
    openingIdRef.current = null;
    providerChatsRef.current = {};
    setMiniBarText('');
    const auth = useAuthStore.getState();
    setActiveMainProvider((auth.chatModelSelection.mode === 'single'
      ? voiceProviderForConnectionId(auth.chatModelSelection.connectionId)
      : null) ?? auth.voiceMainAgentProvider);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let disposed = false;
    const openingRevision = scopeRevisionRef.current;

    const requestedIdentity = resolveAccountIdentity(useAuthStore.getState());
    if (!requestedIdentity) {
      void (async () => {
        const oldSession = useVoiceStore.getState().session;
        if (!oldSession) return;
        await stopCurrentVoiceResponse();
        useVoiceStore.getState().endSession(oldSession.sessionId);
      })().catch(() => {
        if (disposed) return;
        useVoiceStore.getState().setState('error', VOICE_SESSION_CLOSE_FAILURE);
      });
      return () => void (disposed = true);
    }

    void (async () => {
      const oldSession = useVoiceStore.getState().session;
      if (oldSession && oldSession.accountId !== requestedIdentity.accountId) {
        try {
          await stopCurrentVoiceResponse();
          useVoiceStore.getState().endSession(oldSession.sessionId);
        } catch {
          if (!disposed) {
            useVoiceStore.getState().setState('error', VOICE_SESSION_CLOSE_FAILURE);
          }
          return;
        }
      }
      if (disposed || scopeRevisionRef.current !== openingRevision) return;

      const currentIdentity = resolveAccountIdentity(useAuthStore.getState());
      if (currentIdentity?.accountId !== requestedIdentity.accountId) return;
      const provider = selectedMainProvider;
      const openingScope = JSON.stringify([requestedIdentity.accountId, workspaceId, projectId]);
      const inheritVisiblePreference = !openingScopeRef.current || openingScopeRef.current === openingScope;
      const sourceChatId = inheritVisiblePreference ? useUIStore.getState().activeChatId : null;
      const sourcePreference = sourceChatId ? readChatReasoningPreference(sourceChatId) : null;
      if (openingScopeRef.current !== openingScope) {
        if (openingScopeRef.current) {
          setMiniBarText('');
          voiceFlowGenerationRef.current += 1;
          voiceFlowActiveRef.current = false;
        }
        openingScopeRef.current = openingScope;
        openingIdRef.current = newVoiceSessionId();
        providerChatsRef.current = {};
      }
      const openingId = openingIdRef.current!;
      const chatId = await (providerChatsRef.current[provider] ??= ensureJarvisChatForProvider(
        provider,
        undefined,
        {
          freshVoiceConversation: voiceStartFreshChat,
          openingId,
        },
      ));
      if (!chatId) delete providerChatsRef.current[provider];
      if (disposed || !chatId || scopeRevisionRef.current !== openingRevision) return;

      const confirmedAuth = useAuthStore.getState();
      const confirmedIdentity = resolveAccountIdentity(confirmedAuth);
      if (confirmedIdentity?.accountId !== requestedIdentity.accountId ||
          confirmedAuth.workspaceId !== workspaceId || confirmedAuth.projectId !== projectId ||
          !useUIStore.getState().voiceModalOpen) return;
      if (openingScopeRef.current !== openingScope || openingIdRef.current !== openingId) return;
      if (sourcePreference && sourceChatId !== chatId) {
        writeChatReasoningMode(String(chatId), sourcePreference.mode);
        writeChatReasoningEffort(String(chatId), sourcePreference.effortOverride);
      }
      setActiveMainProvider(provider);
      const currentSession = useVoiceStore.getState().session;
      if (
        currentSession?.chatId === chatId &&
        currentSession.accountId === requestedIdentity.accountId
      )
        return;
      if (currentSession) useVoiceStore.getState().endSession(currentSession.sessionId);

      const binding = createVoiceSessionBinding({
        sessionId: newVoiceSessionId(),
        accountId: requestedIdentity.accountId,
        chatId,
        startedAt: Date.now(),
      });
      if (useVoiceStore.getState().beginSession(binding)) {
        recordVoiceConversation(
          {
            accountId: binding.accountId,
            workspaceId: String(workspaceId),
            projectId: projectId ? String(projectId) : null,
          },
          String(binding.chatId),
        );
        // Opening typed Voice is an overlay, not a request to leave the
        // current chat. An explicit Send or navigation action focuses it.
        if (useUIStore.getState().voiceInputMode !== 'text') {
          focusVoiceChat(binding.chatId);
        }
        void syncVoiceConversationFolder(String(binding.chatId), {
          accountId: binding.accountId,
          workspaceId: String(workspaceId),
          projectId: projectId ? String(projectId) : null,
        }).then((result) => {
          if (!disposed && !result.ok) setVoiceFlowStatus(result.error);
        });
      }
    })().catch(() => {
      if (disposed) return;
      useVoiceStore.getState().setState('error', VOICE_SESSION_START_FAILURE);
    });

    return () => void (disposed = true);
  }, [
    agentRoster,
    cloudAccountId,
    localUserId,
    open,
    workspaceId,
    projectId,
    selectedMainProvider,
    voiceStartFreshChat,
  ]);

  React.useEffect(() => {
    if (!open || !session || chatModelSelection.mode !== 'none' || !accessibleModels.length) return;
    const auth = useAuthStore.getState();
    if (resolveAccountIdentity(auth)?.accountId !== session.accountId) return;
    try {
      const route = resolveVoiceProviderSelection({
        provider: selectedMainProvider,
        options: accessibleModels,
        preferredSelection: auth.chatModelSelection,
      });
      // The ordinary chat controls persist this exact connected route. Opening
      // voice may choose a default only when there is no explicit selection.
      if (useAuthStore.getState().chatModelSelection.mode === 'none') {
        auth.setChatModelSelection(route.selection);
      }
    } catch {
      // Discovery can still be loading; a send reports the actionable route error.
    }
  }, [open, session, chatModelSelection, accessibleModels, selectedMainProvider]);

  React.useEffect(() => {
    if (!open) return;
    listeningArmedRef.current = voiceAutoListenOnOpen && !textInputMode;
    if (voiceAutoListenOnOpen && !textInputMode) startListening();
    else useVoiceStore.getState().setState('idle');

    const handsFree = () => useAuthStore.getState().voiceAutoListenOnOpen &&
      useUIStore.getState().voiceInputMode !== 'text';

    const clearUtteranceTimers = () => {
      if (utteranceTimerRef.current !== null) window.clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
    };

    const releaseTurnAndRestart = () => {
      turnBusyRef.current = false;
      if (handsFree()) {
        listeningArmedRef.current = true;
        restartListening();
      } else {
        useVoiceStore.getState().setState('idle');
      }
    };

    const restartListening = () => {
      if (turnBusyRef.current || voiceFlowActiveRef.current) return;
      if (
        !useUIStore.getState().voiceModalOpen ||
        speakingRef.current ||
        !listeningArmedRef.current
      )
        return;
      if (!handsFree() && !listeningArmedRef.current) return;
      if (VoiceService.isListening() || VoiceService.wantsListening()) return;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (turnBusyRef.current || voiceFlowActiveRef.current) return;
        if (
          !useUIStore.getState().voiceModalOpen ||
          speakingRef.current ||
          !listeningArmedRef.current
        )
          return;
        if (VoiceService.isListening() || VoiceService.wantsListening()) return;
        startListening();
      }, 50);
    };

    const scheduleRestartAfterReply = () => {
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = window.setTimeout(() => {
        cooldownTimerRef.current = null;
        turnBusyRef.current = false;
        if (!listeningArmedRef.current && useVoiceStore.getState().state === 'paused') return;
        if (handsFree()) {
          listeningArmedRef.current = true;
          pendingUtteranceRef.current = '';
          useVoiceStore.getState().setPartialTranscript('');
          restartListening();
        } else if (resumeListeningAfterSpeechRef.current) {
          // External speech (e.g. a Settings voice preview) interrupted an
          // armed push-to-talk mic - hand it back instead of going silent.
          resumeListeningAfterSpeechRef.current = false;
          listeningArmedRef.current = true;
          restartListening();
        } else {
          useVoiceStore.getState().setState('idle');
        }
      }, VOICE_REPLY_COOLDOWN_MS);
    };

    const disarmPushToTalk = () => {
      if (handsFree()) return;
      listeningArmedRef.current = false;
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
    };

    const stopMicForTurn = () => {
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
      clearUtteranceTimers();
    };

    const flushUtterance = (textOverride?: string, onCommitted?: () => void) => {
      clearUtteranceTimers();
      if (turnBusyRef.current || voiceFlowActiveRef.current) return;

      const text = (textOverride ?? pendingUtteranceRef.current).trim();
      pendingUtteranceRef.current = '';
      if (!text) return;

      manuallyStoppedReplyRef.current = false;
      turnBusyRef.current = true;
      disarmPushToTalk();
      stopMicForTurn();
      useVoiceStore.getState().setState('thinking');
      // Speak before DB/chat preparation so the acknowledgment is not held
      // behind provider routing or a display-permission prompt.
      // Acknowledgment belongs to this submitted turn even if the panel's
      // lifecycle synchronization has not finished on a fresh open.
      void speakWithSettings('On it.', { allowBackground: true }).catch(() => undefined);
      voiceFlowActiveRef.current = true;
      pendingRequestSessionRef.current = null;
      const flowGeneration = ++voiceFlowGenerationRef.current;
      const auth = useAuthStore.getState();
      const requestAccountId = resolveAccountIdentity(auth)?.accountId;
      const visibleChatId = useUIStore.getState().activeChatId;
      const visibleReasoningPreference = visibleChatId
        ? readChatReasoningPreference(visibleChatId) : null;
      let requestSessionId: string | null = null;
      let localCommandStarted = false;
      const requestIsCurrent = () => {
        const live = useAuthStore.getState();
        return (
          voiceFlowGenerationRef.current === flowGeneration &&
          useUIStore.getState().voiceModalOpen &&
          (requestSessionId === null || useVoiceStore.getState().session?.sessionId === requestSessionId) &&
          resolveAccountIdentity(live)?.accountId === requestAccountId &&
          live.workspaceId === auth.workspaceId &&
          live.projectId === auth.projectId
        );
      };
      void (async () => {
        const parsed = parseVoiceProviderOverrides(text);
        const messageText = (parsed ? parsed.taskText : text).trim();
        if (!messageText) throw new Error('Say a task after the provider instruction.');
        const localPreflight = useUIStore.getState().voiceInputMode === 'text' &&
          requiresLocalCommandPreflight(messageText);
        let localOutcome: VoiceLocalCommandOutcome | undefined;
        const runLocalPreflight = async () => {
          localCommandStarted = true;
          const interactionId = `voice-local-${crypto.randomUUID()}`;
          const outcome = await createVoiceLocalCommandBoundary({
            text: messageText,
            interactionId,
            context: {
              correlationId: interactionId,
              accountId: requestAccountId ?? '',
              workspaceId: String(auth.workspaceId ?? ''),
              projectId: String(auth.projectId ?? ''),
            },
            isCurrent: requestIsCurrent,
          })();
          const settled = outcome.completedCount + outcome.queuedCount;
          const partial = settled
            ? `${outcome.completedCount} local action(s) completed and ${outcome.queuedCount} queued. `
            : '';
          if (outcome.status === 'revoked') {
            // The old action's receipt remains in scoped diagnostics. Never
            // paint its outcome into a new account or imply it was undone.
            if (settled && resolveAccountIdentity(useAuthStore.getState())?.accountId === requestAccountId) {
              toast.error('Voice action stopped', `${partial}The remaining request was stopped; no model request was sent.`);
            }
            return null;
          }
          if (outcome.status === 'held') {
            const confirmation = outcome.result.receipts.some((receipt) => receipt.status === 'needs_confirmation');
            throw new Error(`${partial}${confirmation ? 'Confirm the exact local action before continuing.' : 'The local request needs attention before continuing.'} No model request was sent.`);
          }
          return outcome;
        };
        const persistLocalTurn = async (chatId: ChatId) => {
          if (!localOutcome || localOutcome.status !== 'command_only' || !requestIsCurrent()) return;
          const parts = buildLocalTurnReceipt(localOutcome.result.receipts);
          if (!parts.length) throw new Error('The completed local action receipt is unavailable.');
          const saved = await messageRepo.create({
            chat_id: chatId, role: 'user', parts: [{ kind: 'text', text: messageText }, ...parts],
          });
          if (!saved?.id) throw new Error('The local action completed, but its receipt could not be saved. Do not repeat the action automatically.');
          if (!requestIsCurrent()) return;
          onCommitted?.();
          setVoiceFlowStatus(localOutcome.queuedCount ? 'Local action queued' : 'Local action completed');
          void syncVoiceConversationFolder(String(chatId), {
            accountId: requestAccountId!, workspaceId: String(auth.workspaceId),
            projectId: auth.projectId ? String(auth.projectId) : null,
          });
          releaseTurnAndRestart();
        };

        // A pure typed local action needs its bound receipt scope, not a
        // model route. Provider directives still follow normal validation.
        if (localPreflight && !parsed && canRunLocalCommandWithoutModel(messageText)) {
          await providerChatsRef.current[selectedMainProvider];
          if (!requestIsCurrent()) return;
          const binding = useVoiceStore.getState().session;
          if (!binding || binding.accountId !== requestAccountId) throw new Error(VOICE_BOUND_CHAT_FAILURE);
          requestSessionId = binding.sessionId;
          pendingRequestSessionRef.current = {
            sessionId: binding.sessionId, accountId: binding.accountId, chatId: String(binding.chatId),
          };
          localOutcome = (await runLocalPreflight()) ?? undefined;
          if (!localOutcome) return;
          if (localOutcome?.status !== 'command_only') throw new Error('The local request was held without sending it to a model.');
          await persistLocalTurn(binding.chatId);
          return;
        }
        const requestedMainProvider = parsed?.providers.main ?? auth.voiceMainAgentProvider;
        const workerProvider = parsed?.providers.worker ?? auth.voiceWorkerProvider;
        // Only Main must be available before this turn is sent. Main may answer
        // directly without a worker; native delegation checks its own route.
        const mainRoute = resolveVoiceProviderSelection({
          provider: requestedMainProvider,
          options: accessibleModelsRef.current,
          preferredSelection: auth.chatModelSelection,
          preservePreferredRoute: !parsed?.providers.main,
        });
        const mainProvider = mainRoute.provider;
        if (parsed?.saveAsDefault) {
          if (parsed.providers.main) auth.setVoiceMainAgentProvider(parsed.providers.main);
          if (parsed.providers.worker) auth.setVoiceWorkerProvider(parsed.providers.worker);
        }

        const openingId = (openingIdRef.current ??= newVoiceSessionId());
        const cachedChatId = await providerChatsRef.current[mainProvider];
        if (!requestIsCurrent()) return;
        const chatPromise = ensureJarvisChatForProvider(mainProvider, messageText, {
          freshVoiceConversation: auth.voiceStartFreshChat,
          openingId: `${openingId}:${mainProvider}`,
          ...(cachedChatId ? { cachedChatId } : {}),
        });
        providerChatsRef.current[mainProvider] = chatPromise;
        const chatId = await chatPromise;
        if (!requestIsCurrent()) return;
        if (!chatId) delete providerChatsRef.current[mainProvider];
        if (!chatId) throw new Error(VOICE_CHAT_TARGET_FAILURE);
        const identity = resolveAccountIdentity(useAuthStore.getState());
        if (!identity) throw new Error(VOICE_BOUND_CHAT_FAILURE);
        const currentSession = useVoiceStore.getState().session;
        if (currentSession?.chatId !== chatId || currentSession.accountId !== identity.accountId) {
          if (currentSession) useVoiceStore.getState().endSession(currentSession.sessionId);
          const binding = createVoiceSessionBinding({
            sessionId: newVoiceSessionId(),
            accountId: identity.accountId,
            chatId,
            startedAt: Date.now(),
          });
          if (!useVoiceStore.getState().beginSession(binding))
            throw new Error(VOICE_BOUND_CHAT_FAILURE);
        }
        recordVoiceConversation(
          {
            accountId: identity.accountId,
            workspaceId: String(auth.workspaceId),
            projectId: auth.projectId ? String(auth.projectId) : null,
          },
          String(chatId),
        );
        if (visibleReasoningPreference && visibleChatId !== chatId && requestIsCurrent()) {
          writeChatReasoningMode(String(chatId), visibleReasoningPreference.mode);
          writeChatReasoningEffort(String(chatId), visibleReasoningPreference.effortOverride);
        }
        focusVoiceChat(chatId);

        const modelCheck = validateSendModelAccess(
          messageText,
          mainRoute.selection,
          modelSelectionContextFromAuth(auth),
          auth.stackCustomSteps,
          { voice: true },
        );
        if (!modelCheck.ok) throw new Error(modelCheck.message);

        const binding = useVoiceStore.getState().session;
        if (binding?.chatId !== chatId || binding.accountId !== identity.accountId)
          throw new Error(VOICE_BOUND_CHAT_FAILURE);
        requestSessionId = binding.sessionId;
        pendingRequestSessionRef.current = {
          sessionId: binding.sessionId, accountId: binding.accountId, chatId: String(binding.chatId),
        };
        const scope = {
          accountId: identity.accountId,
          workspaceId: String(auth.workspaceId),
          projectId: auth.projectId ? String(auth.projectId) : null,
        };
        if (localPreflight) {
          localOutcome = (await runLocalPreflight()) ?? undefined;
          if (!localOutcome) return;
          if (localOutcome?.status === 'command_only') {
            await persistLocalTurn(chatId);
            return;
          }
        }
        const request = {
          chatId: String(chatId),
          text: messageText,
          mainProvider,
          workerProvider,
          selection: mainRoute.selection,
          reasoningPreference: readChatReasoningPreference(String(chatId)),
          voiceSession: binding,
          priorTaskContext: formatPreviousVoiceTaskContext(
            listPreviousVoiceTasks(
              scope,
              String(chatId),
              useJarvisInteractionStore.getState().agentsByChat,
            ),
          ),
          dedupeScope: JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId]),
        };
        const receipt = await voiceTaskCoordinator.start(request, (report) => {
          const flow = createVoiceAgentFlow({
            now: Date.now,
            // The prompt acknowledgment already started before chat preparation.
            acknowledge: () => undefined,
            persistUser: async (input) => {
              if (!requestIsCurrent()) throw new Error('voice_scope_changed');
              const saved = await messageRepo.create({
                chat_id: input.chatId as ChatId,
                role: 'user',
                parts: [{ kind: 'text', text: input.text }],
              });
              if (!saved?.id) throw new Error(VOICE_MESSAGE_SAVE_FAILURE);
              if (requestIsCurrent()) onCommitted?.();
              void syncVoiceConversationFolder(input.chatId, scope);
              return String(saved.id);
            },
            captureScreen: async (requestText) => {
              if (
                mainRoute.selection.mode !== 'single' ||
                !modelSupportsVision(mainRoute.selection.providerId, mainRoute.selection.modelId)
              ) {
                return {
                  ok: false as const,
                  code: 'main_model_no_vision',
                  message:
                    'The selected Main Agent model cannot receive a screenshot; sending text.',
                };
              }
              return captureVoiceScreenAttachment(requestText);
            },
            dispatchMain: (detail) => {
              if (!requestIsCurrent()) return Promise.resolve({
                status: 'failed' as const, code: 'runtime_cancelled' as const,
                message: 'The voice request scope changed.',
              });
              const actionContext = localOutcome?.result.localActionContext;
              const priorPayload = detail.structuredContext?.payload;
              if (actionContext && (!detail.structuredContext || !priorPayload || typeof priorPayload !== 'object' || Array.isArray(priorPayload))) return Promise.resolve({
                status: 'failed' as const, code: 'dispatch_failed' as const,
                message: 'The local action context could not be attached safely.',
              });
              return dispatchVoiceMainRequest({
                ...detail,
                ...(localOutcome ? { modelText: localOutcome.result.modelText } : {}),
                // The flat localCommandContext has an existing 800-character
                // runtime cap. Preserve Voice guidance there; add real action
                // receipts to the existing untruncated structured UI context.
                ...(actionContext && detail.structuredContext ? {
                  structuredContext: {
                    ...detail.structuredContext,
                    payload: {
                      ...(priorPayload as Record<string, unknown>),
                      voiceLocalActionResult: {
                        version: 1,
                        source: 'vibespace-local-command-bridge',
                        scope: { chatId: detail.chatId, voiceSessionId: detail.voiceSessionId },
                        receipts: localOutcome!.result.receipts.map(({ commandId, status }) => ({ commandId, status })),
                        context: actionContext,
                      },
                    },
                  },
                } : {}),
              });
            },
            reportStatus: (status) => {
              report(status);
              if (useVoiceStore.getState().session?.chatId !== status.chatId) return;
              if (status.phase === 'capture_failed') {
                setVoiceFlowStatus(status.message ?? 'Screen unavailable; sending text');
                void speakWithSettings('Screen unavailable. Sending the text.').catch(
                  () => undefined,
                );
              }
            },
          });
          return flow.run(request);
        });
        if (voiceFlowGenerationRef.current === flowGeneration) voiceFlowActiveRef.current = false;
        // The old Main turn may accept after a fresh voice chat has opened.
        // Its outcome belongs to the old binding, never the new panel.
        if (
          voiceFlowGenerationRef.current !== flowGeneration ||
          useVoiceStore.getState().session?.sessionId !== binding.sessionId
        )
          return;
        if (receipt.status === 'accepted') {
          // A duplicate accepted request can reuse an already durable message.
          if (requestIsCurrent()) onCommitted?.();
          if (!receipt.duplicate) setActiveMainProvider(mainProvider);
          setVoiceFlowStatus(
            receipt.duplicate
              ? 'Already sent; continuing the existing request'
              : 'Sent to ' + (mainProvider === 'codex' ? 'Codex' : 'OpenCode') + ' Main Agent',
          );
        } else if (receipt.status === 'persist_failed') {
          toast.error('Voice message failed', VOICE_MESSAGE_SAVE_FAILURE);
          setVoiceFlowStatus(VOICE_MESSAGE_SAVE_FAILURE);
          useVoiceStore.getState().setState('error', VOICE_MESSAGE_SAVE_FAILURE);
          void speakWithSettings(VOICE_MESSAGE_SAVE_FAILURE).catch(() => undefined);
        } else if (receipt.status === 'dispatch_failed') {
          const failure = 'The Main Agent did not accept the voice request.';
          setVoiceFlowStatus(failure);
          useVoiceStore.getState().setState('error', failure);
          void speakWithSettings(failure).catch(() => undefined);
        }
        releaseTurnAndRestart();
      })()
        .catch((error) => {
          if (!requestIsCurrent()) return;
          const message = error instanceof Error ? error.message : VOICE_MESSAGE_SAVE_FAILURE;
          toast.error('Voice message failed', message);
          setVoiceFlowStatus(message);
          useVoiceStore.getState().setState('error', message);
          void speakWithSettings(localCommandStarted
            ? 'The local request needs attention. Check its receipt before retrying.'
            : 'I could not start the task.').catch(() => undefined);
          releaseTurnAndRestart();
        })
        .finally(() => {
          if (voiceFlowGenerationRef.current === flowGeneration) {
            voiceFlowActiveRef.current = false;
            pendingRequestSessionRef.current = null;
            if (!requestIsCurrent()) turnBusyRef.current = false;
          }
        });
    };
    flushUtteranceRef.current = (text, onCommitted) => flushUtterance(text, onCommitted);

    const schedulePartial = (text: string) => {
      pendingPartialRef.current = text;
      if (partialTimerRef.current !== null) return;
      partialTimerRef.current = window.setTimeout(() => {
        partialTimerRef.current = null;
        if (!listeningArmedRef.current) return;
        useVoiceStore.getState().setPartialTranscript(pendingPartialRef.current);
      }, 100);
    };

    const offs = [
      VoiceService.on('voice:start', () => {
        setCapturePending(false);
        if (!listeningArmedRef.current) {
          VoiceService.stopListening();
          return;
        }
        useUIStore.getState().setVoiceListening(true);
        useVoiceStore.getState().setState('listening');
      }),
      VoiceService.on('voice:partial', ({ text }) => {
        if (!listeningArmedRef.current || turnBusyRef.current) return;
        // A previous segment's pause is no longer silence once speech resumes.
        // Wait for the new final segment to start the configured interval again.
        if (text.trim()) clearUtteranceTimers();
        schedulePartial(text);
      }),
      VoiceService.on('voice:final', ({ text }) => {
        if (!listeningArmedRef.current) return;
        if (turnBusyRef.current) return;

        useVoiceStore.getState().pushFinalTranscript(text);
        const auth = useAuthStore.getState();
        const action = processVoiceFinalEvent({
          finalText: text,
          currentDraft: pendingUtteranceRef.current,
          turnBusy: turnBusyRef.current,
          handsFree: auth.voiceAutoListenOnOpen,
          endTrigger: auth.voiceEndTrigger,
          commitPhrase: auth.voiceCommitPhrase,
          cancelPhrase: auth.voiceCancelPhrase,
        });

        if (action.type === 'ignore') return;

        if (action.type === 'cancel') {
          pendingUtteranceRef.current = '';
          clearUtteranceTimers();
          useVoiceStore.getState().setPartialTranscript('');
          return;
        }

        if (action.type === 'accumulate') {
          pendingUtteranceRef.current = action.draft;
          useVoiceStore.getState().setPartialTranscript(action.draft);
          return;
        }

        if (action.type === 'commit') {
          pendingUtteranceRef.current = '';
          flushUtterance(action.messageText);
          return;
        }

        pendingUtteranceRef.current = action.draft;
        if (!shouldAutoSendOnSilence(auth.voiceAutoListenOnOpen, auth.voiceEndTrigger)) return;

        clearUtteranceTimers();
        utteranceTimerRef.current = window.setTimeout(
          () => flushUtterance(),
          auth.voiceSilenceDelayMs,
        );
      }),
      VoiceService.on('voice:turn-end', (signal) => {
        if (!listeningArmedRef.current || turnBusyRef.current) return;
        // Click-to-talk can trust a confirmed provider endpoint. Hands-free
        // retains the user's explicit phrase gate or configured pause duration.
        // A local batch fallback has already ended recording after silence, so
        // its completed transcript cannot wait for a later spoken commit phrase.
        if (signal?.forceCommit || !useAuthStore.getState().voiceAutoListenOnOpen) flushUtterance();
      }),
      VoiceService.on('voice:error', ({ kind, message }) => {
        setCapturePending(false);
        if (!listeningArmedRef.current && useVoiceStore.getState().state === 'paused') return;
        if (kind === 'no_speech' || kind === 'aborted') {
          restartListening();
          return;
        }
        if (
          kind === 'permission_denied' ||
          kind === 'service_not_allowed' ||
          kind === 'audio_capture'
        ) {
          useUIStore.getState().setVoiceListening(false);
          useVoiceStore.getState().setState('error', message);
          return;
        }
        useVoiceStore.getState().setState('error', message);
      }),
      VoiceService.on('voice:timeout', () => {
        if (!handsFree()) return;
        const auth = useAuthStore.getState();
        if (shouldAutoSendOnSilence(auth.voiceAutoListenOnOpen, auth.voiceEndTrigger)) {
          if (pendingUtteranceRef.current.trim()) {
            flushUtterance();
            return;
          }
        } else {
          pendingUtteranceRef.current = '';
          useVoiceStore.getState().setPartialTranscript('');
        }
        // Visible pause instead of a silent shutoff - the label tells the
        // user the mic stopped and how to resume.
        stopListening('paused');
      }),
    ];

    const onStreamingStart = () => {
      if (manuallyStoppedReplyRef.current) return;
      setCapturePending(false);
      flushUtteranceRef.current = () => undefined;
      streamingReplyRef.current = true;
      turnBusyRef.current = true;
      if (speakingRef.current) return;
      speakingRef.current = true;
      stopMicForTurn();
      useVoiceStore.getState().setState('speaking');
    };
    const onStreamingEnd = () => {
      streamingReplyRef.current = false;
      speakingRef.current = false;
      flushUtteranceRef.current = (text, onCommitted) => flushUtterance(text, onCommitted);
      if (manuallyStoppedReplyRef.current) return;
      scheduleRestartAfterReply();
    };
    const onSpeechStart = () => {
      if (manuallyStoppedReplyRef.current) return;
      setCapturePending(false);
      if (streamingReplyRef.current) return;
      // Capture BEFORE flipping turnBusy: a mid-listen preview (turn not
      // busy, mic live) must resume the mic after the speech ends.
      resumeListeningAfterSpeechRef.current =
        !turnBusyRef.current && !handsFree() && VoiceService.isListening();
      turnBusyRef.current = true;
      speakingRef.current = true;
      stopMicForTurn();
      useVoiceStore.getState().setState('speaking');
    };
    const onSpeechEnd = () => {
      if (streamingReplyRef.current) return;
      speakingRef.current = false;
      if (manuallyStoppedReplyRef.current) return;
      scheduleRestartAfterReply();
    };
    window.addEventListener(STREAMING_VOICE_START_EVENT, onStreamingStart);
    window.addEventListener(STREAMING_VOICE_END_EVENT, onStreamingEnd);
    window.addEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);

    return () => {
      offs.forEach((off) => off());
      if (partialTimerRef.current !== null) window.clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
      pendingPartialRef.current = '';
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
      clearUtteranceTimers();
      pendingUtteranceRef.current = '';
      useVoiceStore.getState().clearTranscripts();
      VoiceService.cancelListening();
      listeningArmedRef.current = false;
      turnBusyRef.current = false;
      streamingReplyRef.current = false;
      manuallyStoppedReplyRef.current = false;
      window.removeEventListener(STREAMING_VOICE_START_EVENT, onStreamingStart);
      window.removeEventListener(STREAMING_VOICE_END_EVENT, onStreamingEnd);
      window.removeEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
      window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);
      if (!useUIStore.getState().voiceModalOpen) handleVoiceModuleClosed();
    };
  }, [open, startListening, voiceAutoListenOnOpen, stopListening, textInputMode]);

  const runSmokeSttFixture = React.useCallback(async () => {
    if (!KERNEL_SMOKE_ENABLED || smokeSttState === 'transcribing') return;
    setSmokeSttState('transcribing');
    setSmokeSttBlockerCode(undefined);
    setSmokeSttRunBound(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const transcript = await (async () => {
        const fixture = await invoke<unknown>('sik_smoke_voice_fixture');
        if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
          throw new Error('fixture_contract');
        }
        const record = fixture as Record<string, unknown>;
        if (
          Object.keys(record).sort().join('|') !== 'audioBase64|mimeType|sha256' ||
          record.mimeType !== 'audio/wav' ||
          record.sha256 !== KERNEL_SMOKE_VOICE_FIXTURE_SHA256 ||
          typeof record.audioBase64 !== 'string' ||
          record.audioBase64.length === 0
        ) {
          throw new Error('fixture_contract');
        }
        return invoke<string>('faster_whisper_transcribe', {
          model: fasterWhisperModel ?? 'small',
          audioBase64: record.audioBase64,
        });
      })();
      const expectedTranscript = KERNEL_SMOKE_SCENARIOS.native_stt_voice_turn.safeTextFixture;
      if (typeof transcript !== 'string' || transcript.trim() !== expectedTranscript) {
        throw new Error('transcript_contract');
      }
      setSmokeSttState('submitted');
      flushUtteranceRef.current(expectedTranscript);
    } catch (error) {
      setSmokeSttBlockerCode(smokeSttBlocker(error));
      setSmokeSttState('blocked_external');
    }
  }, [fasterWhisperModel, smokeSttState]);

  React.useEffect(() => {
    if (smokeSttState === 'submitted' && session?.activeRunId) setSmokeSttRunBound(true);
  }, [session?.activeRunId, smokeSttState]);

  const listeningHint =
    capturePending && state === 'idle'
      ? 'Waiting for microphone'
      : state === 'listening'
        ? voiceListeningHint(voiceCommitPhrase, voiceAutoListenOnOpen, voiceEndTrigger)
        : STATE_LABEL[state];

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.aside
        ref={panelRef}
        layout={panelLayout}
        initial={reducedMotion ? false : { opacity: 0, x: 16, y: -6, scale: 0.96 }}
        animate={reducedMotion ? undefined : { opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={reducedMotion ? undefined : { opacity: 0, x: 12, scale: 0.97 }}
        transition={panelTransition}
        style={
          {
            x: dragX,
            y: dragY,
            '--jarvis-accent-intensity': `${voiceAccentIntensity}%`,
          } as MotionStyle & { '--jarvis-accent-intensity': string }
        }
        className={cn(
          'jarvis-voice-panel fixed right-3 top-3 z-[90] max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden text-foreground',
          showCommandCenter && 'is-expanded',
        )}
        id="jarvis-panel"
        aria-label="Jarvis voice session"
        hidden
        aria-hidden="true"
        {...LEGACY_VOICE_INERT_ATTRIBUTES}
        data-monochrome-surface="voice"
        data-vibespace-owned-chrome="voice"
        data-voice-appearance-state={state}
        data-voice-provider={activeMainProvider}
        data-reduced-motion={reducedMotion ? 'true' : 'false'}
        data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_EVIDENCE.voiceState : undefined}
        data-voice-state={KERNEL_SMOKE_ENABLED ? state : undefined}
      >
        {/* Primary-button drag handle — single compact row */}
        <JarvisVoiceHeader
          state={state}
          activeProvider={activeMainProvider}
          personaName={personaCfg.name}
          listeningHint={listeningHint}
          capturePending={capturePending && state === 'idle'}
          errorMessage={errorMessage}
          voiceAutoListenOnOpen={voiceAutoListenOnOpen}
          voiceCommitPhrase={voiceCommitPhrase}
          levelRef={levelRef}
          voiceControlEvidence={KERNEL_SMOKE_ENABLED ? SIK_EVIDENCE.voiceStop : undefined}
          onClose={() => {
            handleVoiceModuleClosed();
            setOpen(false);
          }}
          onToggleListening={toggleListening}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        />

        {/* Command Center disclosure */}
        {voiceFlowStatus ? (
          <output
            className="block border-t border-border/70 px-3 py-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {voiceFlowStatus}
          </output>
        ) : null}
        <div className="jarvis-command-disclosure relative z-[1] flex min-h-8 items-center justify-between gap-2 border-t border-border/70 px-2 [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:hover:bg-muted">
          <button
            ref={commandCenterDisclosureRef}
            type="button"
            onClick={() => setShowCommandCenter((visible) => !visible)}
            aria-expanded={showCommandCenter}
            aria-controls={commandCenterRegionId}
            aria-label={showCommandCenter ? 'Collapse Command Center' : 'Expand Command Center'}
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="shrink-0 font-semibold text-foreground">Command Center</span>
            {showCommandCenter ? (
              <span
                className="sr-only min-w-0 break-words text-right text-xs leading-tight"
                title={modelLabel}
              >
                {modelLabel}
              </span>
            ) : null}
            {showCommandCenter ? (
              <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
          </button>
          {showCommandCenter ? <VoiceModelSelector selection={chatModelSelection} /> : null}
        </div>

        <AnimatePresence>
          {showCommandCenter && (
            <motion.div
              id={commandCenterRegionId}
              initial={reducedMotion ? false : { height: 0, opacity: 0 }}
              animate={reducedMotion ? undefined : { height: 'auto', opacity: 1 }}
              exit={reducedMotion ? undefined : { height: 0, opacity: 0 }}
              transition={commandCenterTransition}
              className="overflow-hidden"
              onKeyDown={handleCommandCenterEscape}
              data-motion-kind={
                reducedMotion ? 'none' : theme === 'sakura' ? 'instant-layout' : 'spring'
              }
            >
              <JarvisVoiceTranscript
                messages={messages}
                partial={partial}
                hasBoundChat={Boolean(session?.chatId)}
                expandedIds={expandedTranscriptIds}
                onToggleExpanded={(messageId) =>
                  setExpandedTranscriptIds((current) => {
                    const next = new Set(current);
                    if (next.has(messageId)) next.delete(messageId);
                    else next.add(messageId);
                    return next;
                  })
                }
              />
              {priorVoiceTasks.length > 0 ? (
                <section
                  aria-label="Earlier voice workers"
                  className="border-t border-border/50 px-3 py-2"
                >
                  <h3 className="mb-1 text-xs font-semibold">Earlier voice workers</h3>
                  <ul className="space-y-1">
                    {priorVoiceTasks.map((task) => (
                      <li key={task.agentId} className="text-xs text-muted-foreground">
                        <button
                          type="button"
                          className="text-left underline underline-offset-2 hover:text-foreground"
                          onClick={() => focusVoiceChat(task.childChatId as ChatId)}
                        >
                          {task.provider} · {task.status} · {task.agentId.slice(0, 12)} ·{' '}
                          {task.task}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {galaxySnapshot ? (
                <section aria-label="Voice Context Map">
                  <h3 className="sr-only">Context Map</h3>
                  <ContextGalaxy
                    nodes={galaxySnapshot.nodes}
                    edges={galaxySnapshot.edges}
                    selectedId={galaxySelectedId}
                    activityNodeIds={galaxySnapshot.activityNodeIds}
                    onSelect={setGalaxySelectedId}
                    compact
                    reducedMotion={reducedMotion}
                  />
                </section>
              ) : (
                <p className="border-t border-border/50 px-2 py-2 text-center text-xs text-muted-foreground">
                  Context Map is not available for this project yet.
                </p>
              )}
              {eligibleCommandCenterBinding && session ? (
                <JarvisCommandCenter
                  accountId={session.accountId}
                  chatId={session.chatId}
                  dataPort={eligibleCommandCenterBinding.dataPort}
                  handlers={commandCenterHandlers}
                  compact
                  embedded
                />
              ) : (
                <p className="flex items-center gap-2 border-t border-border/70 px-2 py-2 text-xs text-muted-foreground">
                  <Shield className="h-3.5 w-3.5 shrink-0 text-accent-copper" aria-hidden="true" />
                  Command Center is unavailable for this voice session.
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {(voiceMiniBarEnabled || textInputMode) &&
          createPortal(
            <form
              aria-label="Jarvis voice mini bar"
              hidden={!textInputMode}
              aria-hidden={!textInputMode}
              {...(!textInputMode ? LEGACY_VOICE_INERT_ATTRIBUTES : {})}
              onSubmit={(event) => {
                event.preventDefault();
                const text = miniBarText.trim();
                if (!text || turnBusyRef.current || voiceFlowActiveRef.current) return;
                const submittedRevision = miniBarDraftRevisionRef.current;
                flushUtteranceRef.current(text, () => {
                  if (miniBarDraftRevisionRef.current === submittedRevision) setMiniBarText('');
                });
              }}
              className="fixed bottom-5 left-1/2 z-[120] flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-2xl border border-white/20 bg-background/75 p-2 text-foreground shadow-2xl shadow-black/20 backdrop-blur-xl"
            >
              <input
                aria-label="Type to Jarvis voice"
                value={miniBarText}
                onChange={(event) => setMiniBarText(event.target.value)}
                placeholder="Ask Jarvis…"
                autoComplete="off"
                autoFocus={textInputMode}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={!miniBarText.trim() || state === 'thinking' || state === 'speaking'}
                className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-40"
              >
                Send
              </button>
              {textInputMode && (state === 'thinking' || state === 'speaking') && (
                <button type="button" onClick={stopSpeaking} className="rounded-xl px-3 py-2 text-sm">
                  Stop reply
                </button>
              )}
              {textInputMode && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close typed Jarvis voice"
                  className="rounded-xl px-3 py-2 text-sm"
                >
                  Close
                </button>
              )}
            </form>,
            document.body,
          )}
      </motion.aside>
      {KERNEL_SMOKE_ENABLED ? (
        <section
          key="voice-smoke-controls"
          aria-label="Jarvis voice smoke controls"
          className="fixed bottom-3 right-3 z-[91] flex gap-1 rounded border border-border bg-background p-2"
        >
          <button
            type="button"
            data-sik-evidence={SIK_EVIDENCE.voiceTranscript}
            onClick={() =>
              flushUtteranceRef.current(KERNEL_SMOKE_SCENARIOS.voice_turn_stop.safeTextFixture)
            }
            className="min-h-7 rounded border border-border px-2 py-1 text-xs text-muted-foreground"
          >
            Submit fixed transcript
          </button>
          <button
            type="button"
            data-sik-evidence={SIK_EVIDENCE.voiceSttFixture}
            onClick={() => void runSmokeSttFixture()}
            disabled={smokeSttState === 'transcribing'}
            className="min-h-7 rounded border border-border px-2 py-1 text-xs text-muted-foreground disabled:opacity-50"
          >
            Transcribe fixed audio
          </button>
          <output
            hidden
            data-sik-evidence={SIK_EVIDENCE.voiceSttState}
            data-stt-state={smokeSttState}
            data-engine-id="faster-whisper"
            data-model-id={fasterWhisperModel ?? 'small'}
            data-fixture-sha256={KERNEL_SMOKE_VOICE_FIXTURE_SHA256}
            data-session-bound={session ? 'true' : 'false'}
            data-run-bound={smokeSttRunBound ? 'true' : 'false'}
            data-blocker-code={smokeSttBlockerCode}
          />
        </section>
      ) : null}
    </AnimatePresence>
  );
}
