import * as React from 'react';
import { AnimatePresence, motion, useMotionValue } from 'motion/react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { messageRepo } from '@/lib/db';
import { useChatMessages } from '@/features/chat/hooks';
import {
  ensureJarvisChatForVoice,
  focusVoiceChat,
  resolveVoiceChatTarget,
} from './voiceChatRouting';
import type { ChatId } from '@/types';
import type { VoiceState } from './store';
import { useVoiceStore } from './store';
import { VoiceService } from './VoiceService';
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
import { handleVoiceModuleClosed, stopCurrentVoiceResponse } from './voiceRouter';
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
import './voice.sakura.css';

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
  const open = useUIStore((state) => state.voiceModalOpen);
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
  const commandCenterBinding = useJarvisCommandCenterBinding();
  const [showCommandCenter, setShowCommandCenter] = React.useState(false);
  const commandCenterDisclosureRef = React.useRef<HTMLButtonElement>(null);
  const [expandedTranscriptIds, setExpandedTranscriptIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const session = useVoiceStore((voice) => voice.session);
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
  const pendingUtteranceRef = React.useRef('');
  const utteranceTimerRef = React.useRef<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const cooldownTimerRef = React.useRef<number | null>(null);
  const speakingRef = React.useRef(false);
  const streamingReplyRef = React.useRef(false);
  const manuallyStoppedReplyRef = React.useRef(false);
  const flushUtteranceRef = React.useRef<(text: string) => void>(() => undefined);
  const listeningArmedRef = React.useRef(false);
  const turnBusyRef = React.useRef(false);
  const [smokeSttState, setSmokeSttState] = React.useState<SmokeSttState>('idle');
  const [smokeSttBlockerCode, setSmokeSttBlockerCode] = React.useState<SmokeSttBlocker>();
  const [smokeSttRunBound, setSmokeSttRunBound] = React.useState(false);
  // True when the mic was actively listening as external speech (e.g. a
  // Settings voice preview) started - so we can hand the mic back afterwards
  // instead of leaving push-to-talk silently disarmed.
  const resumeListeningAfterSpeechRef = React.useRef(false);
  const personaCfg = PERSONAS[persona];
  const modelLabel = React.useMemo(
    () =>
      formatChatModelSelectionLabel(
        chatModelSelection,
        modelSelectionContextFromAuth(useAuthStore.getState()),
      ),
    [chatModelSelection],
  );
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
    listeningArmedRef.current = false;
    VoiceService.stopListening();
    useUIStore.getState().setVoiceListening(false);
    useVoiceStore.getState().setPartialTranscript('');
    useVoiceStore.getState().setState(nextState);
  }, []);

  const startListening = React.useCallback(() => {
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
    useUIStore.getState().setVoiceListening(started);
    if (started) {
      useVoiceStore.getState().setState('listening');
    } else {
      listeningArmedRef.current = false;
    }
    return started;
  }, []);

  /** Stop the current spoken reply and hand control straight back to the user. */
  const stopSpeaking = React.useCallback(() => {
    manuallyStoppedReplyRef.current = true;
    stopCurrentVoiceResponse();
    speakingRef.current = false;
    streamingReplyRef.current = false;
    turnBusyRef.current = false;
    resumeListeningAfterSpeechRef.current = false;
    if (useAuthStore.getState().voiceAutoListenOnOpen) {
      listeningArmedRef.current = true;
      startListening();
    } else {
      useVoiceStore.getState().setState('idle');
    }
  }, [startListening]);

  const toggleListening = React.useCallback(() => {
    if (state === 'thinking' || state === 'speaking' || speakingRef.current) {
      stopSpeaking();
      return;
    }
    if (state === 'listening' || useUIStore.getState().voiceListening) {
      stopListening('idle');
      return;
    }
    if (!voiceAutoListenOnOpen) {
      listeningArmedRef.current = true;
    }
    startListening();
  }, [startListening, state, stopListening, stopSpeaking, voiceAutoListenOnOpen]);

  React.useEffect(() => {
    if (!open) return;
    let disposed = false;

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
      if (disposed) return;

      const currentIdentity = resolveAccountIdentity(useAuthStore.getState());
      if (currentIdentity?.accountId !== requestedIdentity.accountId) return;

      const currentSession = useVoiceStore.getState().session;
      if (currentSession) return;

      const chatId = await ensureJarvisChatForVoice();
      if (disposed || !chatId) return;

      const confirmedIdentity = resolveAccountIdentity(useAuthStore.getState());
      if (confirmedIdentity?.accountId !== requestedIdentity.accountId) return;

      const binding = createVoiceSessionBinding({
        sessionId: newVoiceSessionId(),
        accountId: requestedIdentity.accountId,
        chatId,
        startedAt: Date.now(),
      });
      if (useVoiceStore.getState().beginSession(binding)) focusVoiceChat(binding.chatId);
    })().catch(() => {
      if (disposed) return;
      useVoiceStore.getState().setState('error', VOICE_SESSION_START_FAILURE);
    });

    return () => void (disposed = true);
  }, [agentRoster, cloudAccountId, localUserId, open, workspaceId]);

  React.useEffect(() => {
    if (!open) return;
    listeningArmedRef.current = voiceAutoListenOnOpen;
    if (voiceAutoListenOnOpen) startListening();
    else useVoiceStore.getState().setState('idle');

    const handsFree = () => useAuthStore.getState().voiceAutoListenOnOpen;

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
      if (turnBusyRef.current) return;
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
        if (turnBusyRef.current) return;
        if (
          !useUIStore.getState().voiceModalOpen ||
          speakingRef.current ||
          !listeningArmedRef.current
        )
          return;
        if (VoiceService.isListening() || VoiceService.wantsListening()) return;
        startListening();
      }, 180);
    };

    const scheduleRestartAfterReply = () => {
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = window.setTimeout(() => {
        cooldownTimerRef.current = null;
        turnBusyRef.current = false;
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

    const flushUtterance = (textOverride?: string) => {
      clearUtteranceTimers();
      if (turnBusyRef.current) return;

      const text = (textOverride ?? pendingUtteranceRef.current).trim();
      pendingUtteranceRef.current = '';
      if (!text) return;

      turnBusyRef.current = true;
      disarmPushToTalk();
      stopMicForTurn();
      useVoiceStore.getState().setState('thinking');
      void (async () => {
        const target = await resolveVoiceChatTarget(text);
        if (!target) {
          useVoiceStore.getState().setState('error', VOICE_CHAT_TARGET_FAILURE);
          releaseTurnAndRestart();
          return;
        }

        const boundSession = useVoiceStore.getState().session;
        const chatId = target.agentId ? target.chatId : boundSession?.chatId;
        const accountId = target.agentId ? undefined : boundSession?.accountId;
        const voiceSessionId = target.agentId ? undefined : boundSession?.sessionId;
        if (!chatId) {
          useVoiceStore.getState().setState('error', VOICE_BOUND_CHAT_FAILURE);
          releaseTurnAndRestart();
          return;
        }
        focusVoiceChat(chatId);
        const messageText = target.messageText.trim();
        if (!messageText) {
          useVoiceStore.getState().setState('error', 'Say something for Jarvis to send.');
          releaseTurnAndRestart();
          return;
        }

        const auth = useAuthStore.getState();
        const modelCheck = validateSendModelAccess(
          messageText,
          auth.chatModelSelection,
          modelSelectionContextFromAuth(auth),
          auth.stackCustomSteps,
          { voice: true },
        );
        if (!modelCheck.ok) {
          useVoiceStore.getState().setState('error', modelCheck.message);
          releaseTurnAndRestart();
          return;
        }

        try {
          await messageRepo.create({
            chat_id: chatId as ChatId,
            role: 'user',
            parts: [{ kind: 'text', text: messageText }],
          });
          window.dispatchEvent(
            new CustomEvent('jarvis:send', {
              detail: {
                chatId,
                ...(accountId && voiceSessionId ? { accountId, voiceSessionId } : {}),
                text: messageText,
                agentId: target.agentId,
                mentionedAgentIds: target.mentionedAgentIds,
                speakReply: true,
                autoApproveActions: auth.voiceAutoApproveActions,
              },
            }),
          );
        } catch {
          toast.error('Voice message failed', VOICE_MESSAGE_SAVE_FAILURE);
          useVoiceStore.getState().setState('error', VOICE_MESSAGE_SAVE_FAILURE);
          releaseTurnAndRestart();
        }
      })();
    };
    flushUtteranceRef.current = (text: string) => flushUtterance(text);

    let partialTimer: number | null = null;
    let pendingPartial = '';

    const schedulePartial = (text: string) => {
      pendingPartial = text;
      levelRef.current = Math.min(1, 0.25 + text.length / 48);
      if (partialTimer !== null) return;
      partialTimer = window.setTimeout(() => {
        partialTimer = null;
        useVoiceStore.getState().setPartialTranscript(pendingPartial);
      }, 100);
    };

    const offs = [
      VoiceService.on('voice:start', () => {
        useUIStore.getState().setVoiceListening(true);
        useVoiceStore.getState().setState('listening');
      }),
      VoiceService.on('voice:partial', ({ text }) => {
        schedulePartial(text);
      }),
      VoiceService.on('voice:final', ({ text }) => {
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
      VoiceService.on('voice:error', ({ kind, message }) => {
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
      manuallyStoppedReplyRef.current = false;
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
      if (manuallyStoppedReplyRef.current) return;
      scheduleRestartAfterReply();
    };
    const onSpeechStart = () => {
      manuallyStoppedReplyRef.current = false;
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
      if (partialTimer !== null) window.clearTimeout(partialTimer);
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
      clearUtteranceTimers();
      pendingUtteranceRef.current = '';
      useVoiceStore.getState().clearTranscripts();
      listeningArmedRef.current = false;
      turnBusyRef.current = false;
      streamingReplyRef.current = false;
      manuallyStoppedReplyRef.current = false;
      window.removeEventListener(STREAMING_VOICE_START_EVENT, onStreamingStart);
      window.removeEventListener(STREAMING_VOICE_END_EVENT, onStreamingEnd);
      window.removeEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
      window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);
      handleVoiceModuleClosed();
    };
  }, [open, startListening, voiceAutoListenOnOpen, stopListening]);

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
    state === 'listening'
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
        style={{ x: dragX, y: dragY }}
        className={cn(
          'jarvis-voice-panel fixed right-3 top-3 z-[90] max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[0.5625rem] border border-border bg-elevated/95 text-foreground backdrop-blur-sm',
          '[[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border-mid [[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none [[data-theme=monochrome]_&]:backdrop-blur-none',
          '[[data-theme=monochrome]_&]:before:!hidden [[data-theme=monochrome]_&]:after:!hidden',
          '[[data-theme=monochrome]_&]:[&_.jarvis-voice-drag-row::after]:!hidden',
          '[[data-theme=monochrome]_&]:[&_.jarvis-voice-mic]:!bg-none [[data-theme=monochrome]_&]:[&_.jarvis-voice-mic]:!shadow-none',
          '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button]:!bg-none [[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button]:!shadow-none',
          '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![background-image:none] [[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![filter:none] [[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:!shadow-none [[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![transform:none]',
          '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-shell::before]:!hidden',
          showCommandCenter ? 'w-[26.25rem]' : 'w-[17.875rem]',
        )}
        aria-label="Jarvis voice session"
        data-monochrome-surface="voice"
        data-vibespace-owned-chrome="voice"
        data-voice-appearance-state={state}
        data-reduced-motion={reducedMotion ? 'true' : 'false'}
        data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_EVIDENCE.voiceState : undefined}
        data-voice-state={KERNEL_SMOKE_ENABLED ? state : undefined}
      >
        {/* Primary-button drag handle — single compact row */}
        <JarvisVoiceHeader
          state={state}
          personaName={personaCfg.name}
          listeningHint={listeningHint}
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

        {KERNEL_SMOKE_ENABLED ? (
          <div className="relative z-[1] flex gap-1 border-t border-white/[0.06] px-2 py-1 [[data-theme=monochrome]_&]:border-border">
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
          </div>
        ) : null}

        {/* Command Center disclosure */}
        <button
          ref={commandCenterDisclosureRef}
          type="button"
          onClick={() => setShowCommandCenter((visible) => !visible)}
          aria-expanded={showCommandCenter}
          aria-controls={commandCenterRegionId}
          className="relative z-[1] flex min-h-8 w-full items-center gap-1 border-t border-border/70 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent-copper/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:hover:bg-muted"
        >
          <span className="shrink-0 font-medium text-foreground">Command Center</span>
          {showCommandCenter ? (
            <span
              className="ml-auto min-w-0 break-words text-right text-xs leading-tight"
              title={modelLabel}
            >
              {modelLabel}
            </span>
          ) : null}
          {showCommandCenter ? (
            <ChevronUp className="h-2.5 w-2.5 shrink-0" />
          ) : (
            <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0" />
          )}
        </button>

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
                <p className="border-t border-border/70 px-2 py-3 text-center text-xs text-muted-foreground">
                  Command Center is unavailable for this voice session.
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.aside>
    </AnimatePresence>
  );
}
