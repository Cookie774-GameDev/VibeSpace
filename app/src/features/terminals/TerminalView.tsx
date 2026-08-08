/**
 * Terminal view — wraps xterm.js and binds to the slice 1 PTY backend.
 *
 * Lifecycle (see WAVE4_CONTRACTS.md for the Tauri command surface):
 *   1. On mount we build a fresh `Terminal`, load FitAddon + WebLinksAddon,
 *      and open it into the inner div ref.
 *   2. We subscribe to `terminal://output` and `terminal://exit` events,
 *      filtered by the active sessionId so two TerminalView instances
 *      never cross-talk.
 *   3. We spawn a fresh PTY (or skip if a `sessionId` prop is supplied
 *      to attach), then route xterm.onData -> `terminal_write`.
 *   4. ResizeObserver + window resize call FitAddon.fit() then
 *      `terminal_resize` so the PTY honours the visible viewport.
 *   5. On unmount we dispose xterm and unsubscribe listeners, but never
 *      call `terminal_kill` -- sessions are owned by the user. Closing
 *      happens explicitly via the chrome `×` button.
 *
 * Font-load race fix (the "mushed words" bug at 2x2+):
 *   xterm measures cell width during `term.open()` and caches it. We load
 *   JetBrains Mono via an async @import in globals.css. If we open() and
 *   fit() before the font arrives, xterm bakes in the fallback monospace
 *   metrics; once the real font swaps in, glyphs render at a different
 *   advance and the canvas grid no longer matches -> overlapping text at
 *   smaller tile sizes. Fix:
 *     a) briefly await `document.fonts.ready` before `term.open()`, without
 *        allowing an unavailable font to block terminal startup forever,
 *     b) re-assign `fontFamily` after open() to bust xterm's metric cache,
 *     c) one belt-and-braces re-fit when fonts settle later.
 *
 * If the Tauri backend isn't reachable (e.g. running the web dev server
 * before slice 1 lands) we render a calm `bg-paper-soft` placeholder
 * instead of crashing the React tree.
 */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Mic, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Terminal, type ITheme } from 'xterm';
import { isTauri } from '@/lib/utils';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
import 'xterm/css/xterm.css';

import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import type { TerminalViewProps } from './types';
import {
  HOLD_TO_CONFIRM_MS,
  createHoldToConfirmController,
  type HoldConfirmPhase,
} from './holdToConfirm';
import { useTerminalTranscriptStore } from './transcriptStore';
import { TerminalWarmIdleScene } from './terminalWarmIdleScene';
import { resolveTerminalRestoreSession, type BackendTerminalInfo } from './restoreSession';
import {
  buildAgentSpawnEnv,
  deliverAgentTerminalContext,
  detectInteractiveAgentCli,
  resolveAgentForSlug,
} from './agentPromptDelivery';
import {
  getOrCreateTerminalContextSession,
  getTerminalContextSession,
  subscribeTerminalContextSessions,
  updateTerminalContextSession,
} from './terminalContextSessionStore';
import {
  createTerminalOutputBuffer,
  filterStartupTerminalOutput,
  findAltScreenEnter,
  stripOrphanEscapeFragments,
} from './terminalEscape';
import {
  clearTerminalPaneSessionId,
  registerTerminalPaneClearHandler,
  setTerminalPaneSessionId,
} from './terminalClearRegistry';
import { TERMINAL_CLEAR_SUPPRESS_MS } from './terminalClear';
import { createWebglDisposeTracker } from './terminalDispose';
import { subscribeTerminalOutput, type TerminalOutputSubscription } from './terminalOutputRouter';
import { createTerminalRenderQueue } from './terminalRenderQueue';
import { terminalWebglBudget, type TerminalWebglLease } from './terminalWebglBudget';
import { RESOURCE_PRESSURE_EVENT } from '@/stability/resourcePressure';
import { stabilityDiagnostics } from '@/stability/stabilityDiagnostics';
import { shouldSendTerminalResize, type TerminalGridSize } from './terminalGeometry';
import { applyTerminalFollowScroll, terminalUserHasScrolled } from './terminalViewport';
import { COMPOSER_STT_STOP_EVENT, COMPOSER_STT_TOGGLE_EVENT } from '@/features/composer-stt';
import { startSttVolumeMeter, stopSttVolumeMeter } from '@/features/composer-stt/sttVolume';
import { VoiceService } from '@/features/voice/VoiceService';
import { useUIStore } from '@/stores/ui';
import {
  CONTEXT_MIME,
  formatContextAttachmentForTerminal,
  parseContextAttachment,
} from '@/features/context/tree';
import {
  heartbeatCoordinatedTerminal,
  inferAgentProvider,
  loadCoordinationSummary,
  registerCoordinatedTerminal,
} from './agentCoordinationClient';
import type { AgentCoordinationMode } from './agentCoordination';
import { createPersistedInputTracker } from './terminalInputPersistence';
import {
  createTerminalSnapshot,
  terminalSnapshotFingerprint,
  type TerminalSnapshotPayload,
} from './terminalSnapshot';
import { registerTerminalSnapshotFlush } from './terminalSnapshotRegistry';
import { terminalRestartDecision } from './terminalRestartPolicy';
import {
  attachTerminalExecution,
  ensureTerminalExecutionExitListener,
  failTerminalExecutionBeforeNativeExit,
  hasCanonicalTerminalExecution,
  markTerminalExecution,
  observeTerminalExecutionNativeExit,
  requestTerminalExecutionCancellation,
  terminalCancellationDisposition,
  terminalExecutionCancellationToken,
  type NativeTerminalExitPayload,
  useTerminalExecutionStore,
} from './terminalExecutionStore';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_EVIDENCE } from '@/lib/jarvis/smoke/evidenceIds';
import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import { TerminalCommandPalette } from './TerminalCommandPalette';
import {
  installTerminalCli,
  installTerminalShellIntegration,
  uninstallTerminalCli,
  uninstallTerminalShellIntegration,
} from './terminalCliInstall';
import {
  createTerminalSlashIntegration,
  isSshSessionCommand,
  isSupportedLocalShellCommand,
  terminalPaletteRequestTargetsPane,
  TERMINAL_VIBESPACE_PALETTE_EVENT,
} from './terminalSlashIntegration';
import type { TerminalPromptEvidence } from './terminalCommandFoundation';
import { prepareUpgradedPromptInsert } from './terminalPromptUpgrade';
import {
  applyTerminalTheme,
  resolveTerminalDocumentTheme,
  resolveTerminalTheme,
} from './terminalTheme';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

const TERMINAL_FONT_READINESS_TIMEOUT_MS = 2_000;
const TERMINAL_OUTPUT_READINESS_TIMEOUT_MS = 2_000;

type TerminalVoiceFailureKind = 'unsupported' | 'startup';

export function formatTerminalVoiceFailure(kind: TerminalVoiceFailureKind): string {
  const details =
    kind === 'unsupported'
      ? {
          actionLabel: 'Terminal speech recognition availability',
          reason: 'Speech-to-text is not available in this runtime',
        }
      : {
          actionLabel: 'Terminal dictation startup',
          reason:
            'Speech-to-text could not start in the terminal. Check microphone access, then try again',
        };
  return formatJarvisVerifiedNarration({
    kind: 'failure',
    actionLabel: details.actionLabel,
    reason: details.reason,
  }).text;
}

export function awaitTerminalFontReadiness(
  readiness: Promise<unknown> | undefined,
  timeoutMs = TERMINAL_FONT_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  if (!readiness) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));

    void readiness.then(
      () => settle(true),
      () => settle(false),
    );
  });
}

export function awaitTerminalOutputReadiness(
  readiness: Promise<boolean>,
  timeoutMs = TERMINAL_OUTPUT_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  return awaitTerminalFontReadiness(readiness, timeoutMs);
}

export function terminalSmokeFailureCode(error: string | null): string | undefined {
  if (!error) return undefined;
  if (error.includes('canonical_terminal_handle_unavailable_after_restart')) {
    return 'kernel_terminal_authority_unavailable';
  }
  if (error.includes('canonical_terminal_native_attach_failed')) {
    return 'kernel_terminal_native_attach_failed';
  }
  if (error.includes('Canonical terminal ownership handoff failed')) {
    return 'kernel_terminal_authority_handoff_failed';
  }
  if (error.includes('terminal: invalid cancellation token')) {
    return 'kernel_terminal_cancellation_token_rejected';
  }
  if (error.includes('terminal: open pty failed')) return 'kernel_terminal_native_open_failed';
  if (error.includes('terminal: spawn failed')) return 'kernel_terminal_native_spawn_failed';
  if (error.includes('terminal: reader clone failed'))
    return 'kernel_terminal_native_reader_failed';
  if (error.includes('terminal: writer take failed')) return 'kernel_terminal_native_writer_failed';
  return 'kernel_terminal_initialization_failed';
}

/**
 * When the parent owns its own chrome (`<TileGrid>`'s pane-tile or the
 * splits renderer's leaf header) we suppress this component's internal
 * border + status row so the user doesn't see two stacked chrome strips.
 * Default `false` keeps existing call sites unchanged.
 */

interface SpawnResult {
  sessionId: string;
  /** Resolved working directory reported by the backend. */
  cwd?: string;
  /** True when the backend launched the shell with the startup command. */
  startupCommandConsumed: boolean;
}
export interface OutputPayload {
  sessionId: string;
  data: string;
}

const MAX_EARLY_TERMINAL_OUTPUT_CHUNKS = 32;
const MAX_EARLY_TERMINAL_OUTPUT_CHARACTERS = 65_536;

export function createTerminalOutputLatch(onExactOutput: (payload: OutputPayload) => void): {
  observe(payload: OutputPayload): void;
  bind(sessionId: string): boolean;
  readiness: Promise<boolean>;
} {
  let boundSessionId: string | undefined;
  let pending: OutputPayload[] = [];
  let pendingCharacters = 0;
  let readinessResolved = false;
  let resolveReadiness!: (ready: boolean) => void;
  const readiness = new Promise<boolean>((resolve) => {
    resolveReadiness = resolve;
  });

  const deliver = (payload: OutputPayload): boolean => {
    if (payload.sessionId !== boundSessionId) return false;
    if (!readinessResolved) {
      readinessResolved = true;
      resolveReadiness(true);
    }
    onExactOutput(payload);
    return true;
  };

  return {
    observe(payload) {
      if (boundSessionId !== undefined) {
        deliver(payload);
        return;
      }
      if (payload.data.length > MAX_EARLY_TERMINAL_OUTPUT_CHARACTERS) {
        return;
      }
      while (
        pending.length > 0 &&
        (pending.length >= MAX_EARLY_TERMINAL_OUTPUT_CHUNKS ||
          pendingCharacters + payload.data.length > MAX_EARLY_TERMINAL_OUTPUT_CHARACTERS)
      ) {
        pendingCharacters -= pending.shift()!.data.length;
      }
      pending.push(payload);
      pendingCharacters += payload.data.length;
    },
    bind(sessionId) {
      if (boundSessionId !== undefined && boundSessionId !== sessionId) return false;
      boundSessionId = sessionId;
      const exact = pending.filter((payload) => payload.sessionId === sessionId);
      pending = [];
      pendingCharacters = 0;
      for (const payload of exact) deliver(payload);
      return exact.length > 0;
    },
    readiness,
  };
}

export function createTerminalExitLatch(
  onExactExit: (payload: NativeTerminalExitPayload) => void,
): {
  observe(payload: NativeTerminalExitPayload): void;
  bind(sessionId: string): boolean;
} {
  const pending = new Map<string, NativeTerminalExitPayload>();
  let boundSessionId: string | undefined;
  let delivered = false;

  const deliver = (payload: NativeTerminalExitPayload): boolean => {
    if (delivered || payload.sessionId !== boundSessionId) return false;
    delivered = true;
    onExactExit(payload);
    return true;
  };

  return {
    observe(payload) {
      if (boundSessionId === undefined) {
        if (!pending.has(payload.sessionId)) pending.set(payload.sessionId, payload);
        return;
      }
      deliver(payload);
    },
    bind(sessionId) {
      if (boundSessionId !== undefined && boundSessionId !== sessionId) return false;
      boundSessionId = sessionId;
      const early = pending.get(sessionId);
      pending.clear();
      return early ? deliver(early) : false;
    },
  };
}

export async function attachTerminalViewExecution(
  executionId: string | undefined,
  sessionId: string,
  dependencies: {
    isCanonical?: typeof hasCanonicalTerminalExecution;
    attach?: typeof attachTerminalExecution;
  } = {},
): Promise<boolean> {
  if (!executionId) return true;
  const isCanonical = dependencies.isCanonical ?? hasCanonicalTerminalExecution;
  if (!isCanonical(executionId)) return true;
  return (dependencies.attach ?? attachTerminalExecution)(executionId, sessionId);
}

export function canonicalTerminalSpawnToken(
  executionId: string | undefined,
  dependencies: {
    isCanonical?: typeof hasCanonicalTerminalExecution;
    readToken?: typeof terminalExecutionCancellationToken;
  } = {},
): string | undefined {
  if (!executionId) return undefined;
  const isCanonical = dependencies.isCanonical ?? hasCanonicalTerminalExecution;
  if (!isCanonical(executionId)) return undefined;
  const token = (dependencies.readToken ?? terminalExecutionCancellationToken)(executionId);
  if (!token) {
    throw new TypeError('canonical_terminal_handle_unavailable_after_restart');
  }
  return token;
}

export async function settleTerminalInitializationFailure(
  input: Readonly<{
    executionId?: string;
    sessionId: string;
    nativeSessionStarted: boolean;
    executionAttached: boolean;
  }>,
  dependencies: {
    isCanonical?: typeof hasCanonicalTerminalExecution;
    failBeforeNativeExit?: typeof failTerminalExecutionBeforeNativeExit;
    requestCancellation?: typeof requestTerminalExecutionCancellation;
    killManual?: (sessionId: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const isCanonical = dependencies.isCanonical ?? hasCanonicalTerminalExecution;
  if (input.executionId && isCanonical(input.executionId)) {
    if (input.executionAttached) {
      await (dependencies.requestCancellation ?? requestTerminalExecutionCancellation)(
        input.executionId,
      );
    } else {
      await (dependencies.failBeforeNativeExit ?? failTerminalExecutionBeforeNativeExit)(
        input.executionId,
        input.nativeSessionStarted ? 'native_attach_failed' : 'native_spawn_failed',
      );
    }
  }
  if (input.nativeSessionStarted && input.sessionId && !input.executionAttached) {
    await (
      dependencies.killManual ??
      ((sessionId) => invoke('terminal_kill', { sessionId }).catch(() => undefined))
    )(input.sessionId).catch(() => undefined);
  }
}

const CURRENT_INPUT_FLUSH_MS = 160;

function currentTerminalTheme() {
  const documentTheme =
    typeof document === 'undefined'
      ? 'dark'
      : resolveTerminalDocumentTheme(document.documentElement.getAttribute('data-theme'));
  return resolveTerminalTheme({ documentTheme, explicitUserTheme: null });
}

function terminalCursorBlinkEnabled(): boolean {
  const documentTheme =
    typeof document === 'undefined'
      ? 'dark'
      : resolveTerminalDocumentTheme(document.documentElement.getAttribute('data-theme'));
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return documentTheme !== 'monochrome' && !reducedMotion;
}

export function observeTerminalDocumentTheme(
  target: Parameters<typeof applyTerminalTheme>[0] & {
    options: { cursorBlink?: boolean };
  },
  container: Pick<HTMLElement, 'style'>,
  explicitUserTheme: Readonly<ITheme> | null,
): MutationObserver {
  const applyDocumentTheme = () => {
    target.options.cursorBlink = terminalCursorBlinkEnabled();
    const theme = applyTerminalTheme(target, {
      documentTheme: resolveTerminalDocumentTheme(
        document.documentElement.getAttribute('data-theme'),
      ),
      explicitUserTheme,
    });
    if (theme.background) {
      container.style.backgroundColor = theme.background;
    }
  };

  applyDocumentTheme();
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.attributeName === 'data-theme')) {
      applyDocumentTheme();
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return observer;
}

function commandToInput(command: string): string {
  return command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`;
}

function sameTerminalPromptEvidence(
  left: TerminalPromptEvidence,
  right: TerminalPromptEvidence,
): boolean {
  return (
    left.promptProtocol === right.promptProtocol &&
    left.atPrompt === right.atPrompt &&
    left.alternateScreen === right.alternateScreen &&
    left.interactiveProgram === right.interactiveProgram &&
    left.localShell === right.localShell &&
    left.passwordPrompt === right.passwordPrompt &&
    left.sshSession === right.sshSession
  );
}

export function TerminalView({
  sessionId: existingSessionId,
  paneId,
  command,
  startupCommand,
  startupCommands,
  preserveExisting = false,
  executionId,
  pendingCommand,
  pendingCommandId,
  cwd,
  rows = 30,
  cols = 100,
  className,
  hideChrome = false,
  fontSize = 9,
  agentSlug,
  agentMode,
  onReady,
  onPendingCommandSent,
  onExit,
  onFocus,
  onBlur,
  projectId,
  projectName,
}: TerminalViewProps): JSX.Element {
  const resolvedAgentMode = agentMode ?? (agentSlug ? 'default' : undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(existingSessionId ?? null);
  // Resolved working directory of the live session — needed to re-deliver
  // the agent briefing (AGENTS.md + coordination doc) on agent switches.
  const cwdRef = useRef<string | null>(cwd ?? null);
  // Last agent slug whose briefing was written for this session's cwd.
  const deliveredSlugRef = useRef<string | null>(null);
  const deliveredModeRef = useRef(resolvedAgentMode);
  const exitFiredRef = useRef(false);
  const focusedRef = useRef(false);
  const dictatingRef = useRef(false);
  const ignoreClearsUntilRef = useRef<number>(0);
  const suppressOutputUntilRef = useRef<number>(0);
  const lastResizeSentRef = useRef<TerminalGridSize | null>(null);
  const userHasScrolledRef = useRef(false);
  const currentInputRef = useRef('');
  const currentInputFlushTimerRef = useRef<number | null>(null);
  const contextDeliveryQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [activeSessionId, setActiveSessionId] = useState<string | null>(existingSessionId ?? null);
  const [isFocused, setIsFocused] = useState(false);
  const [warmIdleInteractionAt, setWarmIdleInteractionAt] = useState(() => Date.now());
  const [warmIdlePointerEnteredAt, setWarmIdlePointerEnteredAt] = useState<number | null>(null);
  const [warmIdlePointerInside, setWarmIdlePointerInside] = useState(false);
  const warmTheme = useUIStore((state) => state.theme);
  const markWarmIdleInteraction = () => setWarmIdleInteractionAt(Date.now());
  const markWarmIdlePointerEntered = () => {
    setWarmIdlePointerInside(true);
    setWarmIdlePointerEnteredAt(Date.now());
  };
  const markWarmIdlePointerLeft = () => {
    setWarmIdlePointerInside(false);
    setWarmIdlePointerEnteredAt(null);
    markWarmIdleInteraction();
  };
  const warmIdleLastActivityAt = warmIdleInteractionAt;
  const [dictating, setDictating] = useState(false);
  const [terminalPaletteOpen, setTerminalPaletteOpen] = useState(false);
  const [terminalPromptEvidence, setTerminalPromptEvidence] = useState<TerminalPromptEvidence>(() =>
    Object.freeze({
      promptProtocol: 'none',
      atPrompt: false,
      alternateScreen: false,
      interactiveProgram: false,
      localShell: isSupportedLocalShellCommand(command),
      passwordPrompt: false,
      sshSession: isSshSessionCommand(startupCommand),
    }),
  );
  const setComposerSttListening = useUIStore((s) => s.setComposerSttListening);
  const [dropKind, setDropKind] = useState<'file' | 'context' | null>(null);
  const [powerUpTitle, setPowerUpTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializationPhase, setInitializationPhase] = useState('kernel_terminal_phase_mounted');
  const terminalExecutionStatus = useTerminalExecutionStore((state) =>
    executionId ? state.executions[executionId]?.status : undefined,
  );
  const powerUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const coordinationSummaryFor = async (
    mode: AgentCoordinationMode | undefined,
    sessionCwd: string | null | undefined,
  ): Promise<string> => (mode === 'coordinated' ? loadCoordinationSummary(sessionCwd) : '');

  // Capture latest callbacks via refs so the mount effect doesn't re-run
  // on every prop change (which would re-spawn the PTY).
  const onReadyRef = useRef(onReady);
  const onPendingCommandSentRef = useRef(onPendingCommandSent);
  const onExitRef = useRef(onExit);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  // Mirror agentSlug so the registerSession call inside the spawn-await
  // path reads the *current* slug, not the one captured at first mount.
  // The audit flagged a narrow race: if the parent flips agentSlug
  // between this component mounting and `terminal_spawn` returning
  // (typically 50-200 ms), the closure-captured value is stale and the
  // first transcript record gets tagged with the old role. The retag
  // effect below catches up on the next prop change, but any early
  // output that arrived before that window had the wrong tag. Reading
  // through the ref eliminates the window.
  const agentSlugRef = useRef(agentSlug ?? null);
  const agentModeRef = useRef(resolvedAgentMode);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    onPendingCommandSentRef.current = onPendingCommandSent;
  }, [onPendingCommandSent]);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);
  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  useEffect(() => {
    const openPalette = () => setTerminalPaletteOpen(true);
    const onPaletteRequest = (event: Event) => {
      if (!terminalPaletteRequestTargetsPane(event, paneId)) return;
      openPalette();
    };
    const onPaletteHotkey = (event: KeyboardEvent) => {
      if (
        !focusedRef.current ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.key.toLowerCase() !== 'p'
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      openPalette();
    };
    window.addEventListener(TERMINAL_VIBESPACE_PALETTE_EVENT, onPaletteRequest);
    window.addEventListener('keydown', onPaletteHotkey, true);
    return () => {
      window.removeEventListener(TERMINAL_VIBESPACE_PALETTE_EVENT, onPaletteRequest);
      window.removeEventListener('keydown', onPaletteHotkey, true);
    };
  }, [paneId]);
  useEffect(() => {
    const slug = agentSlug ?? null;
    agentSlugRef.current = slug;
  }, [agentSlug]);
  useEffect(() => {
    agentModeRef.current = resolvedAgentMode;
  }, [resolvedAgentMode]);

  useEffect(() => {
    return () => {
      if (powerUpTimerRef.current) clearTimeout(powerUpTimerRef.current);
    };
  }, []);

  const flashPowerUp = (title: string) => {
    setPowerUpTitle(title);
    if (powerUpTimerRef.current) clearTimeout(powerUpTimerRef.current);
    powerUpTimerRef.current = setTimeout(() => setPowerUpTitle(null), 1500);
  };

  const flushCurrentInput = () => {
    const sid = sessionRef.current;
    if (!sid) return;
    useTerminalTranscriptStore.getState().setCurrentInput(sid, currentInputRef.current);
  };

  const scheduleCurrentInputFlush = () => {
    if (currentInputFlushTimerRef.current != null) {
      window.clearTimeout(currentInputFlushTimerRef.current);
    }
    currentInputFlushTimerRef.current = window.setTimeout(() => {
      currentInputFlushTimerRef.current = null;
      flushCurrentInput();
    }, CURRENT_INPUT_FLUSH_MS);
  };

  // Re-tag the live transcript whenever the parent flips agentSlug. This
  // keeps the by-agent index correct without re-spawning the PTY: the
  // user can pick a different role from the chrome dropdown and the
  // existing buffer flows under the new slug going forward.
  //
  // Re-delivery: switching agents also rewrites the managed briefing
  // block in the session cwd's AGENTS.md (and clears it when the role is
  // removed), so the next CLI started in this pane receives the new
  // agent's prompt. A CLI already mid-session reads its instructions at
  // session start — the user restarts it to pick up the switch.
  useEffect(() => {
    const sid = sessionRef.current;
    if (!sid) return;
    useTerminalTranscriptStore.getState().retagSession(sid, agentSlug ?? null);

    const slug = agentSlug ?? null;
    const mode = resolvedAgentMode;
    if (deliveredSlugRef.current === slug && deliveredModeRef.current === mode) return;
    deliveredSlugRef.current = slug;
    deliveredModeRef.current = mode;
    const sessionCwd = cwdRef.current;
    if (!sessionCwd) return;
    const terminalContextSession = getTerminalContextSession(sid);
    if (terminalContextSession && terminalContextSession.agentSlug !== slug) {
      updateTerminalContextSession(
        {
          terminalSessionId: sid,
          paneId: terminalContextSession.paneId,
          projectId: terminalContextSession.projectId,
        },
        { agentSlug: slug },
      );
      return;
    }
    void (async () => {
      const coordinationSummary = await coordinationSummaryFor(mode, sessionCwd);
      const result = await deliverAgentTerminalContext({
        cwd: sessionCwd,
        agentSlug: slug,
        agentMode: mode,
        terminalId: sid,
        projectId: projectId ?? null,
        projectName: projectName ?? null,
        excludeSessionId: sid,
        coordinationSummary,
        terminalContextSession,
      });
      if (!result.ok && result.error) {
        console.warn('[Jarvis] agent briefing re-delivery failed:', result.error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug, resolvedAgentMode]);

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;

    const regenerate = (session: ReturnType<typeof getOrCreateTerminalContextSession>): void => {
      if (session.terminalSessionId !== activeSessionId) return;
      const sessionCwd = cwdRef.current;
      if (!sessionCwd) return;

      const slug = session.agentSlug;
      const mode = agentModeRef.current;
      contextDeliveryQueueRef.current = contextDeliveryQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (cancelled) return;
          const result = await deliverAgentTerminalContext({
            cwd: sessionCwd,
            agentSlug: slug,
            agentMode: mode,
            terminalId: activeSessionId,
            projectId: session.projectId,
            projectName: projectName ?? null,
            excludeSessionId: activeSessionId,
            coordinationSummary: await coordinationSummaryFor(mode, sessionCwd),
            terminalContextSession: session,
          });
          if (cancelled) return;
          if (result.ok) {
            deliveredSlugRef.current = slug;
            deliveredModeRef.current = mode;
          } else if (result.error) {
            console.warn('[Jarvis] Context briefing regeneration failed:', result.error);
          }
        });
    };

    let initialSession =
      getTerminalContextSession(activeSessionId) ??
      getOrCreateTerminalContextSession({
        terminalSessionId: activeSessionId,
        paneId: paneId ?? null,
        projectId: projectId ?? null,
      });
    if (
      initialSession.contextRevision === 0 &&
      initialSession.agentSlug === null &&
      agentSlugRef.current !== null
    ) {
      initialSession = updateTerminalContextSession(
        {
          terminalSessionId: activeSessionId,
          paneId: initialSession.paneId,
          projectId: initialSession.projectId,
        },
        { agentSlug: agentSlugRef.current },
      );
    }

    const unsubscribe = subscribeTerminalContextSessions(regenerate);
    regenerate(initialSession);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, paneId, projectId, projectName]);

  useEffect(() => {
    const sid = activeSessionId;
    const sessionCwd = cwdRef.current;
    const slug = agentSlug ?? null;
    if (!sid || !sessionCwd || resolvedAgentMode !== 'coordinated' || !slug) return;

    const agentName = resolveAgentForSlug(slug).name;
    const provider = inferAgentProvider(startupCommand ?? command);
    let cancelled = false;
    const base = {
      cwd: sessionCwd,
      mode: resolvedAgentMode,
      terminalId: sid,
      paneId: paneId ?? null,
      agentSlug: slug,
      agentName,
      provider,
    };

    void registerCoordinatedTerminal({
      ...base,
      summary: `${agentName} registered from terminal ${sid}.`,
    }).then((result) => {
      if (!cancelled && !result.ok && result.error) {
        console.warn('[Jarvis] coordinated terminal registration failed:', result.error);
      }
    });

    const heartbeatTimer = window.setInterval(() => {
      void heartbeatCoordinatedTerminal(base).then((result) => {
        if (!cancelled && !result.ok && result.error) {
          console.warn('[Jarvis] coordinated terminal heartbeat failed:', result.error);
        }
      });
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatTimer);
    };
  }, [activeSessionId, resolvedAgentMode, agentSlug, command, paneId, startupCommand]);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    let cancelled = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let outputSubscription: TerminalOutputSubscription | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let scrollListenerDispose: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let rafToken: number | null = null;
    let outputRafToken: number | null = null;
    const renderQueue = createTerminalRenderQueue();
    let terminalWriteInFlight = false;
    const outputBuffer = createTerminalOutputBuffer();
    let handleVisible: (() => void) | null = null;
    let onClear: ((e: Event) => void) | null = null;
    let onPersistNow: (() => void) | null = null;
    let unregisterPaneClear: (() => void) | null = null;
    let unregisterSnapshotFlush: (() => void) | null = null;
    let snapshotSaveTimer: number | null = null;
    let snapshotSaveInFlight: Promise<void> | null = null;
    let latestTerminalWrite: Promise<void> = Promise.resolve();
    let lastSnapshotFingerprint = '';
    let deferredRestartCommand: string | null = null;
    let restartConfirmationHandled = false;
    let startupRestoreMode = false;
    let sshSession = isSshSessionCommand(startupCommand);
    const webglDispose = createWebglDisposeTracker();
    let webglLease: TerminalWebglLease | null = null;
    let onResourcePressure: (() => void) | null = null;
    const inputTracker = createPersistedInputTracker(currentInputRef.current);
    const slashIntegration = createTerminalSlashIntegration({ command });
    const publishPromptEvidence = (next: TerminalPromptEvidence) => {
      setTerminalPromptEvidence((current) =>
        sameTerminalPromptEvidence(current, next) ? current : next,
      );
    };
    const outputLatch = createTerminalOutputLatch((payload) => {
      publishPromptEvidence(slashIntegration.observeOutput(payload.data));
      if (Date.now() < suppressOutputUntilRef.current) return;
      enqueueTerminalChunks(payload.data);
    });
    const exitLatch = createTerminalExitLatch((payload) => {
      if (exitFiredRef.current) return;
      exitFiredRef.current = true;
      const notifyParent = () => onExitRef.current?.(payload.code);
      if (executionId && hasCanonicalTerminalExecution(executionId)) {
        void observeTerminalExecutionNativeExit(payload).finally(notifyParent);
      } else {
        notifyParent();
      }
    });

    const isInteractiveAgentSession = (sid: string): boolean => {
      const currentSession = useTerminalTranscriptStore.getState().sessions[sid];
      return detectInteractiveAgentCli({
        command: currentSession?.command ?? startupCommand ?? command,
        startupCommand,
        transcript: currentSession?.text ?? '',
      });
    };

    const ensureAgentBriefingForSession = (sid: string): void => {
      const slug = agentSlugRef.current;
      const mode = agentModeRef.current;
      const sessionCwd = cwdRef.current;
      if (!sessionCwd || !isInteractiveAgentSession(sid)) return;
      if (!slug && mode !== 'no-context') return;
      void (async () => {
        const result = await deliverAgentTerminalContext({
          cwd: sessionCwd,
          agentSlug: slug,
          agentMode: mode,
          terminalId: sid,
          projectId: projectId ?? null,
          projectName: projectName ?? null,
          excludeSessionId: sid,
          coordinationSummary: await coordinationSummaryFor(mode, sessionCwd),
          terminalContextSession: getTerminalContextSession(sid),
        });
        if (result.ok) {
          deliveredSlugRef.current = slug;
          deliveredModeRef.current = mode;
        } else if (result.error) {
          console.warn('[Jarvis] agent briefing refresh failed:', result.error);
        }
      })();
    };

    const confirmDeferredRestart = (): void => {
      if (!deferredRestartCommand || restartConfirmationHandled) return;
      const sid = sessionRef.current;
      if (!sid) return;
      restartConfirmationHandled = true;
      const deferred = deferredRestartCommand;
      deferredRestartCommand = null;
      if (!window.confirm(`Restart the previous terminal command?\n\n${deferred}`)) return;
      invoke('terminal_write', {
        sessionId: sid,
        data: commandToInput(deferred),
      }).catch(() => {
        /* backend probably gone */
      });
    };

    const resetTerminalSurface = () => {
      outputBuffer.flush();
      renderQueue.clear();
      if (outputRafToken != null) {
        cancelAnimationFrame(outputRafToken);
        outputRafToken = null;
      }
      suppressOutputUntilRef.current = Date.now() + TERMINAL_CLEAR_SUPPRESS_MS;
      ignoreClearsUntilRef.current = 0;
      const t = termRef.current;
      if (!t) return;
      try {
        t.reset();
        t.clear();
        t.scrollToTop();
      } catch {
        /* xterm may already be disposed */
      }
    };

    const prepareTerminalChunk = (chunk: string): string => {
      if (!chunk) return '';
      if (Date.now() < ignoreClearsUntilRef.current) {
        const filterOpts = { stripCursorPositioning: startupRestoreMode };
        // A fullscreen TUI entering the alternate screen buffer ends the
        // startup window immediately: from that point on, clears and
        // absolute cursor positioning are intentional (the TUI owns the
        // viewport) and must not be filtered, or its UI renders mangled.
        const altIdx = findAltScreenEnter(chunk);
        if (altIdx >= 0) {
          ignoreClearsUntilRef.current = 0;
          return (
            filterStartupTerminalOutput(chunk.slice(0, altIdx), filterOpts) + chunk.slice(altIdx)
          );
        }
        return filterStartupTerminalOutput(chunk, filterOpts);
      }
      return stripOrphanEscapeFragments(chunk);
    };

    // RAF-coalesced resize. Multiple ResizeObserver fires inside the same
    // animation frame collapse to a single fit() + IPC. Without this,
    // dragging a split or reflowing the tile grid can fire dozens of
    // `terminal_resize` calls per second for no benefit.
    const dispatchResize = () => {
      if (rafToken != null) return;
      rafToken = requestAnimationFrame(() => {
        rafToken = null;
        const t = termRef.current;
        const f = fitRef.current;
        const sid = sessionRef.current;
        if (!t || !f || !sid) return;

        // Skip fitting if the container is currently hidden or collapsed
        const width = containerEl.clientWidth;
        const height = containerEl.clientHeight;
        if (width <= 40 || height <= 40) return;

        try {
          f.fit();
        } catch {
          return;
        }
        const nextSize = { rows: t.rows, cols: t.cols };
        if (!shouldSendTerminalResize(lastResizeSentRef.current, nextSize)) return;
        lastResizeSentRef.current = nextSize;
        invoke('terminal_resize', {
          sessionId: sid,
          rows: t.rows,
          cols: t.cols,
        }).catch(() => {
          /* backend may have torn down -- ignore */
        });
      });
    };

    const flushTerminalSnapshot = async (): Promise<void> => {
      if (snapshotSaveInFlight) await snapshotSaveInFlight;
      const currentTerm = termRef.current;
      if (!currentTerm || !paneId) return;
      if (snapshotSaveTimer != null) {
        window.clearTimeout(snapshotSaveTimer);
        snapshotSaveTimer = null;
      }
      const snapshot = createTerminalSnapshot(currentTerm, {
        projectId: projectId ?? null,
        paneId,
        rows: currentTerm.rows,
        cols: currentTerm.cols,
        updatedAt: Date.now(),
        command: startupCommand ?? command ?? null,
        interactive: isInteractiveAgentSession(sessionRef.current ?? ''),
      });
      const fingerprint = terminalSnapshotFingerprint(snapshot);
      if (fingerprint === lastSnapshotFingerprint) return;
      snapshotSaveInFlight = invoke('terminal_snapshot_save', { snapshot });
      try {
        await snapshotSaveInFlight;
        lastSnapshotFingerprint = fingerprint;
      } finally {
        snapshotSaveInFlight = null;
      }
    };

    const scheduleTerminalSnapshot = (): void => {
      if (!paneId || snapshotSaveTimer != null) return;
      snapshotSaveTimer = window.setTimeout(() => {
        snapshotSaveTimer = null;
        void flushTerminalSnapshot().catch((err) => {
          console.warn('[Jarvis] terminal snapshot save failed:', err);
        });
      }, 1_000);
    };

    const flushTerminalOutput = () => {
      outputRafToken = null;
      if (terminalWriteInFlight) return;
      const pending = renderQueue.drain();
      if (!pending) return;
      const { displayData, transcriptData, droppedCharacters } = pending;
      if (droppedCharacters > 0) {
        stabilityDiagnostics.record({
          type: 'terminal-output-trimmed',
          at: Date.now(),
          droppedCharacters,
        });
      }
      const sid = sessionRef.current;
      if (!sid) return;

      try {
        const currentTerm = termRef.current;
        const followUserScrolled = userHasScrolledRef.current;
        if (currentTerm) {
          terminalWriteInFlight = true;
          latestTerminalWrite = new Promise<void>((resolve) => {
            currentTerm.write(displayData, () => {
              if (!cancelled) {
                const live = termRef.current;
                if (live) {
                  // Short buffers pin to top (PS prompt at top of pane); long
                  // scrollback follows the bottom only while the user hasn't
                  // scrolled away. Never thrash between top and bottom.
                  applyTerminalFollowScroll(live, { userHasScrolled: followUserScrolled });
                }
                if (!followUserScrolled) {
                  userHasScrolledRef.current = false;
                }
                scheduleTerminalSnapshot();
              }
              terminalWriteInFlight = false;
              resolve();
              if (!renderQueue.isEmpty() && outputRafToken == null) {
                outputRafToken = requestAnimationFrame(flushTerminalOutput);
              }
            });
          });
        }
      } catch (err) {
        console.warn('[Jarvis] terminal render write failed:', err);
      }

      try {
        useTerminalTranscriptStore.getState().appendOutput(sid, transcriptData);
      } catch (err) {
        console.warn('[Jarvis] terminal transcript append failed:', err);
      }
    };

    const queueTerminalOutput = (displayData: string, transcriptData: string) => {
      if (!displayData) return;
      renderQueue.enqueue(displayData, transcriptData);
      if (outputRafToken != null) return;
      outputRafToken = requestAnimationFrame(flushTerminalOutput);
    };

    const enqueueTerminalChunks = (raw: string) => {
      for (const chunk of outputBuffer.push(raw)) {
        if (!chunk) continue;
        const displayData = prepareTerminalChunk(chunk);
        if (!displayData) continue;
        queueTerminalOutput(displayData, chunk);
      }
    };

    const flushTerminalPersistenceNow = async (): Promise<void> => {
      if (outputRafToken != null) {
        cancelAnimationFrame(outputRafToken);
        flushTerminalOutput();
      }
      while (terminalWriteInFlight || !renderQueue.isEmpty()) {
        await latestTerminalWrite;
        flushTerminalOutput();
      }
      flushCurrentInput();
      await latestTerminalWrite;
      await flushTerminalSnapshot();
    };

    const init = async () => {
      term = new Terminal({
        rows,
        cols,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize,
        lineHeight: fontSize <= 10 ? 1.0 : 1.08,
        cursorBlink: terminalCursorBlinkEnabled(),
        allowProposedApi: true,
        scrollback: 5000,
        theme: currentTerminalTheme(),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      if (cancelled) return;

      // Prefer waiting for JetBrains Mono before xterm measures cell width
      // inside `open()`, but fail open after a short bound: browser font
      // readiness may remain pending indefinitely in an offline WebView.
      // Without this gate, xterm bakes in fallback monospace metrics and
      // the canvas grid stops matching rendered glyphs once the real font
      // swaps in -> visible text overlap at smaller tile sizes (the
      // "mushed words" bug at 2x2+).
      setInitializationPhase('kernel_terminal_phase_font_wait');
      await awaitTerminalFontReadiness(document.fonts?.ready);
      if (cancelled) return;

      setInitializationPhase('kernel_terminal_phase_xterm_open');
      term.open(containerEl);

      // GPU renderer. xterm's default DOM renderer re-lays-out HTML rows on
      // every write, which is the dominant frame cost with a 10-pane grid of
      // live CLIs. The WebGL addon renders glyphs on the GPU at the device
      // pixel ratio (crisper at fractional Windows display scaling, too).
      // If WebGL isn't available — or the browser reclaims the context
      // because too many are alive — we dispose the addon and xterm falls
      // back to the DOM renderer transparently.
      webglLease = terminalWebglBudget.acquire();
      try {
        if (!webglLease) {
          throw new Error('terminal WebGL context budget reached');
        }
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webglDispose.disposeAddon();
          webglLease?.release();
          webglLease = null;
          requestAnimationFrame(() => {
            if (cancelled) return;
            const currentTerm = termRef.current;
            if (!currentTerm) return;
            try {
              currentTerm.refresh(0, Math.max(0, currentTerm.rows - 1));
            } catch {
              /* renderer may already be switching; the refit below is best-effort */
            }
            dispatchResize();
          });
        });
        webglDispose.setAddon(webgl);
        term.loadAddon(webgl);
      } catch (err) {
        webglDispose.setAddon(null);
        webglLease?.release();
        webglLease = null;
        console.warn('[Jarvis] WebGL renderer unavailable, using DOM renderer:', err);
      }

      onResourcePressure = () => {
        webglDispose.disposeAddon();
        webglLease?.release();
        webglLease = null;
      };
      window.addEventListener(RESOURCE_PRESSURE_EVENT, onResourcePressure);

      // Belt-and-braces: re-assigning fontFamily forces xterm's option
      // proxy to re-run its cell measurement, in case fonts.ready
      // resolved before the browser had finished building metric tables.
      term.options.fontFamily = term.options.fontFamily;

      termRef.current = term;
      fitRef.current = fit;
      scrollListenerDispose = term.onScroll(() => {
        const currentTerm = termRef.current;
        if (!currentTerm) return;
        userHasScrolledRef.current = terminalUserHasScrolled(currentTerm);
      });

      if (paneId) {
        unregisterPaneClear = registerTerminalPaneClearHandler(paneId, () => {
          if (!cancelled) resetTerminalSurface();
        });
      }

      const textarea = (term as any).textarea as HTMLTextAreaElement | undefined;
      if (textarea) {
        textarea.addEventListener('focus', () => {
          focusedRef.current = true;
          setIsFocused(true);
          const sid = sessionRef.current;
          if (sid) ensureAgentBriefingForSession(sid);
          confirmDeferredRestart();
          onFocusRef.current?.();
        });
        textarea.addEventListener('blur', () => {
          focusedRef.current = false;
          setIsFocused(false);
          onBlurRef.current?.();
        });
      }

      term.onData((data: string) => {
        markWarmIdleInteraction();
        const sid = sessionRef.current;
        if (!sid) return;

        const store = useTerminalTranscriptStore.getState();
        const currentSession = store.sessions[sid];
        const interactiveProgram = detectInteractiveAgentCli({
          command: currentSession?.command ?? startupCommand ?? command,
          startupCommand,
          transcript: currentSession?.text ?? '',
        });
        const capture = slashIntegration.pushInput(data, {
          draftEmpty: inputTracker.currentDraft().length === 0,
          interactiveProgram,
          passwordPrompt: false,
          sshSession,
        });
        publishPromptEvidence(slashIntegration.snapshot());
        if (capture.openPalette) {
          setTerminalPaletteOpen(true);
          return;
        }
        const forwardData = capture.forwardData;
        if (!forwardData) return;

        // Track only printable forwarded input; captured palette bytes,
        // terminal protocol, and control sequences never enter persisted state.
        const inputUpdate = inputTracker.push(forwardData);
        currentInputRef.current = inputUpdate.draft;
        if (inputUpdate.flushNow) {
          if (currentInputFlushTimerRef.current != null) {
            window.clearTimeout(currentInputFlushTimerRef.current);
            currentInputFlushTimerRef.current = null;
          }
          flushCurrentInput();
        } else {
          scheduleCurrentInputFlush();
        }

        if (inputUpdate.submittedText && agentSlugRef.current && interactiveProgram) {
          ensureAgentBriefingForSession(sid);
        }
        if (inputUpdate.submittedText && isSshSessionCommand(inputUpdate.submittedText)) {
          sshSession = true;
          publishPromptEvidence(
            slashIntegration.updateRuntime({
              draftEmpty: true,
              interactiveProgram,
              passwordPrompt: false,
              sshSession,
            }),
          );
        }

        invoke('terminal_write', { sessionId: sid, data: forwardData }).catch(() => {
          /* ignore: backend probably gone */
        });
      });

      // Subscribe BEFORE spawning so we don't lose any first-prompt bytes.
      // Each await is paired with a cancelled re-check so we never leak a
      // listener when the component unmounts mid-init (StrictMode dev).
      try {
        if (executionId && hasCanonicalTerminalExecution(executionId)) {
          setInitializationPhase('kernel_terminal_phase_execution_exit_listener');
          await ensureTerminalExecutionExitListener();
        }
        setInitializationPhase('kernel_terminal_phase_output_listener');
        const u1 = await subscribeTerminalOutput((payload) => outputLatch.observe(payload));
        if (cancelled) {
          u1.unsubscribe();
          return;
        }
        outputSubscription = u1;

        setInitializationPhase('kernel_terminal_phase_native_exit_listener');
        const u2 = await listen<NativeTerminalExitPayload>('terminal://exit', (e) => {
          exitLatch.observe(e.payload);
        });
        if (cancelled) {
          u2();
          return;
        }
        unlistenExit = u2;
      } catch (err) {
        if (executionId && hasCanonicalTerminalExecution(executionId)) {
          await failTerminalExecutionBeforeNativeExit(
            executionId,
            'pre_session_initialization_failed',
          );
        }
        if (cancelled) return;
        setError(String(err));
        return;
      }

      // First fit AFTER listeners are subscribed but BEFORE spawn, so the
      // PTY's initial size already reflects the visible viewport. This
      // avoids the brief "shell renders at the 30x100 default" flicker
      // when the surrounding tile is much smaller than that.
      try {
        fit.fit();
      } catch {
        /* container not laid out yet; post-spawn fit covers it */
      }

      // Spawn or attach.
      let sid = '';
      let spawnedFresh = false;
      let nativeSessionStarted = false;
      let executionAttached = false;
      let viewSessionBound = false;
      let nativeStartupCommandConsumed = false;
      let restoredInput = '';
      let sessionCwd: string | null = cwd ?? null;
      let briefingDelivered = false;
      const slugAtSpawn = agentSlugRef.current;
      const modeAtSpawn = agentModeRef.current;
      try {
        setInitializationPhase('kernel_terminal_phase_restore_state');
        let activeSessions: BackendTerminalInfo[] = [];
        if (existingSessionId != null || paneId) {
          try {
            activeSessions = await invoke<BackendTerminalInfo[]>('terminal_list');
          } catch (listErr) {
            console.warn('[Jarvis] Failed to list terminal sessions for restore:', listErr);
          }
        }

        let renderedSnapshot: TerminalSnapshotPayload | null = null;
        if (paneId) {
          try {
            renderedSnapshot = await invoke<TerminalSnapshotPayload | null>(
              'terminal_snapshot_load',
              { projectId: projectId ?? null, paneId },
            );
          } catch (snapshotErr) {
            console.warn('[Jarvis] Failed to load terminal snapshot:', snapshotErr);
          }
        }

        const restoreDecision = resolveTerminalRestoreSession({
          existingSessionId,
          paneId,
          projectId,
          activeSessions,
          transcripts: useTerminalTranscriptStore.getState().sessions,
          renderedSnapshot,
        });
        startupRestoreMode = Boolean(restoreDecision.restoredText);

        if (restoreDecision.kind === 'spawn') {
          spawnedFresh = true;
          restoredInput = restoreDecision.restoredInput;
          let spawnCommand = command;
          const isRecoveredSession = restoreDecision.source !== 'new-pane';
          const nativeStartupCommand =
            isRecoveredSession || startupCommands?.length ? undefined : startupCommand;
          if (isRecoveredSession) {
            const restart = terminalRestartDecision(command, startupCommand);
            spawnCommand = restart.spawnCommand;
            if (restart.kind === 'confirm') {
              deferredRestartCommand = restart.deferredCommand;
            }
          }

          if (restoreDecision.restoredText) {
            term.write(restoreDecision.restoredText);
            term.write('\r\n\x1b[33m[Session restored - process restarted]\x1b[0m\r\n', () => {
              // Long restores follow bottom; short ones stay top-aligned.
              if (!cancelled && termRef.current) {
                applyTerminalFollowScroll(termRef.current, { userHasScrolled: false });
              }
            });
            // Set active window of 3s to bypass ConPTY initialization screen-clear signals only when restoring transcript
            ignoreClearsUntilRef.current = Date.now() + 3000;
          }

          // Deliver the agent briefing (AGENTS.md managed block +
          // coordination doc) BEFORE the process starts whenever the
          // working directory is known, so a CLI spawned directly (e.g.
          // `opencode` as the pane command) reads it on session start.
          if (cwd) {
            setInitializationPhase('kernel_terminal_phase_agent_briefing');
            const delivery = await deliverAgentTerminalContext({
              cwd,
              agentSlug: slugAtSpawn,
              agentMode: modeAtSpawn,
              terminalId: paneId ?? null,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
              coordinationSummary: await coordinationSummaryFor(modeAtSpawn, cwd),
            });
            briefingDelivered = delivery.ok;
            if (!delivery.ok && delivery.error) {
              console.warn('[Jarvis] agent briefing delivery failed:', delivery.error);
            }
          }

          setInitializationPhase('kernel_terminal_phase_native_spawn');
          const spawnEnv = {
            ...(slugAtSpawn
              ? buildAgentSpawnEnv({
                  agentSlug: slugAtSpawn,
                  agentName: resolveAgentForSlug(slugAtSpawn).name,
                  agentMode: modeAtSpawn,
                  cwd: cwd ?? null,
                  projectName: projectName ?? null,
                })
              : {}),
            ...(paneId ? { VIBESPACE_PANE_ID: paneId } : {}),
          };
          const result = await invoke<SpawnResult>('terminal_spawn', {
            command: spawnCommand,
            startupCommand: nativeStartupCommand,
            cwd,
            rows: term.rows,
            cols: term.cols,
            projectId: projectId,
            projectName: projectName,
            cancellationToken: canonicalTerminalSpawnToken(executionId),
            preserveExisting: preserveExisting || undefined,
            // Make the assignment discoverable by any process in the pane,
            // not just AGENTS.md readers (env is inherited by child CLIs).
            env: Object.keys(spawnEnv).length > 0 ? spawnEnv : undefined,
          });
          sid = result.sessionId;
          nativeStartupCommandConsumed = result.startupCommandConsumed;
          nativeSessionStarted = true;
          if (executionId && hasCanonicalTerminalExecution(executionId)) {
            setInitializationPhase('kernel_terminal_phase_execution_attach');
            const attached = await attachTerminalExecution(executionId, sid);
            if (!attached) throw new TypeError('canonical_terminal_native_attach_failed');
            executionAttached = true;
          }
          sessionRef.current = sid;
          viewSessionBound = true;
          if (!cancelled) setActiveSessionId(sid);
          setInitializationPhase('kernel_terminal_phase_session_bound');
          if (nativeStartupCommandConsumed && executionId) {
            markTerminalExecution(executionId, 'running', { sessionId: sid });
          }
          outputLatch.bind(sid);
          outputSubscription?.bind(sid);
          if (exitLatch.bind(sid)) return;
          sessionCwd = result.cwd || cwd || null;
          console.log(`[Jarvis] Spawned new PTY session: ${sid}`);

          // The backend resolved a cwd we did not know up front — deliver
          // there now, before any startup command launches a CLI.
          if (!briefingDelivered && sessionCwd) {
            const delivery = await deliverAgentTerminalContext({
              cwd: sessionCwd,
              agentSlug: slugAtSpawn,
              agentMode: modeAtSpawn,
              terminalId: sid,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
              excludeSessionId: sid,
              coordinationSummary: await coordinationSummaryFor(modeAtSpawn, sessionCwd),
              terminalContextSession: getTerminalContextSession(sid),
            });
            briefingDelivered = delivery.ok;
            if (!delivery.ok && delivery.error) {
              console.warn('[Jarvis] agent briefing delivery failed:', delivery.error);
            }
          }

          if (restoreDecision.oldSessionId) {
            useTerminalTranscriptStore
              .getState()
              .transferSession(restoreDecision.oldSessionId, sid);
          }

          // Register the new session!
          useTerminalTranscriptStore.getState().registerSession(sid, {
            paneId: paneId,
            agentSlug: agentSlug ?? null,
            command: command ?? null,
            projectId: projectId ?? null,
          });
        } else {
          sid = restoreDecision.sessionId;
          const backendInfo = activeSessions.find((s) => s.sessionId === sid);
          sessionCwd = backendInfo?.cwd || cwd || null;
          console.log(
            `[Jarvis] Re-attaching to existing active session: ${sid} (${restoreDecision.source})`,
          );
          // Keep the briefing fresh on re-attach: the assignment (or the
          // agent's editable prompt) may have changed while unmounted.
          if (sessionCwd) {
            const delivery = await deliverAgentTerminalContext({
              cwd: sessionCwd,
              agentSlug: slugAtSpawn,
              agentMode: modeAtSpawn,
              terminalId: sid,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
              excludeSessionId: sid,
              coordinationSummary: await coordinationSummaryFor(modeAtSpawn, sessionCwd),
              terminalContextSession: getTerminalContextSession(sid),
            });
            briefingDelivered = delivery.ok;
          }
          // Restore visual transcript for active session re-attach
          if (restoreDecision.restoredText) {
            term.write(restoreDecision.restoredText, () => {
              if (!cancelled && termRef.current) {
                applyTerminalFollowScroll(termRef.current, { userHasScrolled: false });
              }
            });
            ignoreClearsUntilRef.current = Date.now() + 3000;
          } else if (!cancelled && termRef.current) {
            // Fresh / empty re-attach: keep prompt at the top of the pane.
            applyTerminalFollowScroll(termRef.current, { userHasScrolled: false });
          }
        }
      } catch (err) {
        await settleTerminalInitializationFailure({
          executionId,
          sessionId: sid,
          nativeSessionStarted,
          executionAttached,
        });
        if (cancelled) return;
        setError(String(err));
        return;
      }

      if (!cancelled && !viewSessionBound) {
        setInitializationPhase('kernel_terminal_phase_view_attach');
        const attached = await attachTerminalViewExecution(executionId, sid);
        if (!attached) {
          setError('Canonical terminal ownership handoff failed.');
          return;
        }
        sessionRef.current = sid;
        viewSessionBound = true;
        if (!cancelled) setActiveSessionId(sid);
        setInitializationPhase('kernel_terminal_phase_session_bound');
        outputLatch.bind(sid);
        outputSubscription?.bind(sid);
        if (exitLatch.bind(sid)) return;
      }

      // Race fix: if the effect was torn down between awaiting the
      // spawn and reaching here, the PTY is already running on the
      // backend but we have no UI handle to it. Without this kill we
      // leak a PTY per cancelled mount (StrictMode dev does this on
      // every render; production does it on fast route changes
      // during the spawn window). We kill the orphan and bail.
      if (cancelled) {
        if (existingSessionId == null) {
          if (executionId && hasCanonicalTerminalExecution(executionId)) {
            await requestTerminalExecutionCancellation(executionId);
          } else
            invoke('terminal_kill', { sessionId: sid }).catch(() => {
              /* nothing to do — PTY may have already exited */
            });
        }
        return;
      }
      if (paneId) {
        setTerminalPaneSessionId(paneId, sid);
      }
      cwdRef.current = sessionCwd;
      if (briefingDelivered || slugAtSpawn == null) {
        // Record what's on disk so the agent-switch effect only rewrites
        // the briefing when the slug actually changes.
        deliveredSlugRef.current = slugAtSpawn;
        deliveredModeRef.current = modeAtSpawn;
      }
      // Register the session in the transcript store so the by-agent
      // index has somewhere to land subsequent appendOutput calls.
      // Doing this *after* sessionRef.current is set ensures the
      // already-subscribed `terminal://output` listener targets the
      // right id when the first bytes flow back. We read the agent
      // slug through `agentSlugRef.current` rather than the closure
      // so a fast role-change between mount and spawn-completion
      // gets the current slug, not the one at mount time.
      useTerminalTranscriptStore.getState().registerSession(sid, {
        paneId,
        agentSlug: agentSlugRef.current,
        command: startupCommand ?? command ?? null,
        projectId: projectId ?? null,
      });
      onReadyRef.current?.(sid);
      if (restoredInput) {
        inputTracker.replaceDraft(restoredInput);
        currentInputRef.current = inputTracker.currentDraft();
      }
      if (spawnedFresh) {
        ignoreClearsUntilRef.current = Math.max(ignoreClearsUntilRef.current, Date.now() + 1500);
        // Fresh PTY: keep the first prompt top-aligned in the pane.
        requestAnimationFrame(() => {
          if (cancelled || !termRef.current) return;
          applyTerminalFollowScroll(termRef.current, { userHasScrolled: false });
        });
      }
      const executionWasCancelled = executionId
        ? useTerminalExecutionStore.getState().executions[executionId]?.status === 'cancelled'
        : false;
      const orderedStartupCommands = startupCommands?.length
        ? startupCommands
        : startupCommand
          ? [startupCommand]
          : [];
      if (
        spawnedFresh &&
        orderedStartupCommands.length > 0 &&
        !nativeStartupCommandConsumed &&
        !deferredRestartCommand &&
        !executionWasCancelled
      ) {
        setInitializationPhase('kernel_terminal_phase_startup_command_readiness');
        await awaitTerminalOutputReadiness(outputLatch.readiness);
        if (cancelled) return;
        const cancelledBeforeStartupWrite = executionId
          ? useTerminalExecutionStore.getState().executions[executionId]?.status === 'cancelled'
          : false;
        if (cancelledBeforeStartupWrite) return;
        try {
          setInitializationPhase('kernel_terminal_phase_startup_command_write');
          for (const startupWrite of orderedStartupCommands) {
            if (cancelled) return;
            const cancelledDuringStartup = executionId
              ? useTerminalExecutionStore.getState().executions[executionId]?.status === 'cancelled'
              : false;
            if (cancelledDuringStartup) return;
            await invoke('terminal_write', {
              sessionId: sid,
              data: commandToInput(startupWrite),
            });
          }
          markTerminalExecution(executionId, 'running', { sessionId: sid });
          setInitializationPhase('kernel_terminal_phase_startup_command_sent');
        } catch {
          markTerminalExecution(executionId, 'failed', {
            sessionId: sid,
            exitCode: null,
          });
          setInitializationPhase('kernel_terminal_phase_startup_command_failed');
        }
      } else if (executionId && !nativeStartupCommandConsumed && !executionWasCancelled) {
        markTerminalExecution(executionId, 'running', { sessionId: sid });
      }
      if (spawnedFresh && restoredInput && !deferredRestartCommand) {
        window.setTimeout(
          () => {
            invoke('terminal_write', {
              sessionId: sid,
              data: restoredInput,
            }).catch(() => {
              /* backend probably gone */
            });
          },
          startupCommand ? 900 : 250,
        );
      }

      if (paneId) {
        unregisterSnapshotFlush = registerTerminalSnapshotFlush(
          `${projectId ?? '__no_project__'}:${paneId}`,
          flushTerminalPersistenceNow,
        );
        scheduleTerminalSnapshot();
      }

      handleVisible = () => {
        window.setTimeout(() => {
          if (!cancelled) dispatchResize();
        }, 50);
      };

      // Geometry observers.
      resizeObserver = new ResizeObserver(() => dispatchResize());
      resizeObserver.observe(containerEl);
      window.addEventListener('resize', dispatchResize);
      window.addEventListener('jarvis:terminals:visible', handleVisible);

      onClear = (e: Event) => {
        if (cancelled) return;
        const detail = (e as CustomEvent<{ sessionId: string; paneId?: string }>).detail;
        if (!detail?.sessionId) return;
        const sid = sessionRef.current;
        const matchesPane = detail.paneId != null && detail.paneId === paneId;
        const matchesSession = detail.sessionId === sid;
        if (!matchesPane && !matchesSession) return;
        resetTerminalSurface();
      };
      window.addEventListener('jarvis:terminal:clear', onClear);
      onPersistNow = () => {
        if (!cancelled) void flushTerminalPersistenceNow();
      };
      window.addEventListener('jarvis:terminal:persist-now', onPersistNow);

      // Theme follower -- re-skin xterm whenever the active document theme changes.
      const currentTerm = termRef.current;
      if (currentTerm) {
        mutationObserver = observeTerminalDocumentTheme(currentTerm, containerEl, null);
      }

      // Final fit now that we have the real session dims.
      dispatchResize();

      // Late insurance: some browsers fire fonts.ready before the metric
      // tables are fully built. Bust xterm's metric cache one more time
      // and re-fit on the next paint so any residual mismatch resolves.
      const fontsReady = document.fonts?.ready;
      if (fontsReady) {
        void fontsReady.then(() => {
          if (cancelled) return;
          const t = termRef.current;
          if (t) t.options.fontFamily = t.options.fontFamily;
          requestAnimationFrame(() => {
            if (!cancelled) dispatchResize();
          });
        });
      }
    };

    void init().catch((err) => {
      if (!cancelled) setError(String(err));
    });

    return () => {
      cancelled = true;
      if (rafToken != null) cancelAnimationFrame(rafToken);
      if (currentInputFlushTimerRef.current != null) {
        window.clearTimeout(currentInputFlushTimerRef.current);
        currentInputFlushTimerRef.current = null;
      }
      flushCurrentInput();
      if (snapshotSaveTimer != null) {
        window.clearTimeout(snapshotSaveTimer);
        snapshotSaveTimer = null;
      }
      void flushTerminalSnapshot().catch(() => {
        /* app or route may already be tearing down */
      });
      if (outputRafToken != null) {
        cancelAnimationFrame(outputRafToken);
        flushTerminalOutput();
      }
      const tailRaw = outputBuffer.flush();
      const tailDisplay = prepareTerminalChunk(tailRaw);
      if (tailDisplay) {
        try {
          termRef.current?.write(tailDisplay);
        } catch {
          /* xterm may already be disposed */
        }
        const sid = sessionRef.current;
        if (sid && tailRaw) {
          try {
            useTerminalTranscriptStore.getState().appendOutput(sid, tailRaw);
          } catch {
            /* store may be tearing down */
          }
        }
      }
      window.removeEventListener('resize', dispatchResize);
      if (handleVisible) {
        window.removeEventListener('jarvis:terminals:visible', handleVisible);
      }
      if (onClear) window.removeEventListener('jarvis:terminal:clear', onClear);
      if (onPersistNow) window.removeEventListener('jarvis:terminal:persist-now', onPersistNow);
      unregisterSnapshotFlush?.();
      unregisterPaneClear?.();
      if (paneId) clearTerminalPaneSessionId(paneId);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      outputSubscription?.unsubscribe();
      unlistenExit?.();
      scrollListenerDispose?.dispose();
      try {
        webglDispose.disposeTerminal(termRef.current);
      } catch {
        /* best-effort teardown */
      }
      webglLease?.release();
      webglLease = null;
      if (onResourcePressure) {
        window.removeEventListener(RESOURCE_PRESSURE_EVENT, onResourcePressure);
      }
      termRef.current = null;
      fitRef.current = null;
      // NOTE: deliberately no `terminal_kill` here. Sessions persist past
      // unmount; the user closes them via the chrome `×` button.
    };
    // Mount-only: prop changes after mount don't re-spawn the PTY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastPendingCommandIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pendingCommand || pendingCommandId == null) return;
    if (lastPendingCommandIdRef.current === pendingCommandId) return;
    const sid = sessionRef.current;
    if (!sid) return;
    lastPendingCommandIdRef.current = pendingCommandId;
    invoke('terminal_write', {
      sessionId: sid,
      data: commandToInput(pendingCommand),
    })
      .then(() => onPendingCommandSentRef.current?.())
      .catch(() => {
        /* backend probably gone */
      });
  }, [activeSessionId, pendingCommand, pendingCommandId]);

  // Reactive font-size: when the pane toolbar cycles size, update xterm's
  // option, bust the metric cache, then re-fit + IPC so the PTY learns
  // the new cols/rows that fit in the same viewport.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    if (t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    t.options.fontFamily = t.options.fontFamily;
    const id = requestAnimationFrame(() => {
      const term2 = termRef.current;
      const f = fitRef.current;
      const sid = sessionRef.current;
      if (!term2 || !f || !sid) return;
      try {
        f.fit();
      } catch {
        return;
      }
      const nextSize = { rows: term2.rows, cols: term2.cols };
      if (!shouldSendTerminalResize(lastResizeSentRef.current, nextSize)) return;
      lastResizeSentRef.current = nextSize;
      invoke('terminal_resize', {
        sessionId: sid,
        rows: term2.rows,
        cols: term2.cols,
      }).catch(() => {
        /* backend torn down */
      });
    });
    return () => cancelAnimationFrame(id);
  }, [fontSize]);

  useEffect(() => {
    const onWriteText = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId: string; text: string }>).detail;
      if (detail?.paneId === paneId) {
        const sid = sessionRef.current;
        if (!sid) return;
        void invoke('terminal_write', {
          sessionId: sid,
          data: detail.text,
        });
      }
    };
    window.addEventListener('jarvis:terminal:write-text', onWriteText as EventListener);
    return () =>
      window.removeEventListener('jarvis:terminal:write-text', onWriteText as EventListener);
  }, [paneId]);

  useEffect(() => {
    dictatingRef.current = dictating;
    if (dictating) {
      setComposerSttListening(true);
    } else if (!VoiceService.isListening()) {
      setComposerSttListening(false);
    }
  }, [dictating, setComposerSttListening]);

  useEffect(() => {
    return () => {
      if (dictatingRef.current) VoiceService.stopListening();
    };
  }, []);

  useEffect(() => {
    const onStop = () => {
      if (dictatingRef.current) {
        VoiceService.stopListening();
        setDictating(false);
      }
    };
    window.addEventListener(COMPOSER_STT_STOP_EVENT, onStop);
    return () => window.removeEventListener(COMPOSER_STT_STOP_EVENT, onStop);
  }, []);

  useEffect(() => {
    const onGlobalSttToggle = (event: Event) => {
      if (!focusedRef.current) return;
      event.preventDefault?.();
      if (dictatingRef.current) {
        VoiceService.stopListening();
        setDictating(false);
        return;
      }
      if (!VoiceService.isSupported()) {
        toast.warning('Voice unsupported', formatTerminalVoiceFailure('unsupported'));
        return;
      }
      try {
        if (VoiceService.isListening() || VoiceService.wantsListening()) {
          VoiceService.interruptListening();
        }
        VoiceService.startListening();
        setDictating(true);
      } catch {
        toast.error('Voice error', formatTerminalVoiceFailure('startup'));
        setDictating(false);
      }
    };
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, onGlobalSttToggle);
    return () => window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, onGlobalSttToggle);
  }, []);

  useEffect(() => {
    if (!dictating) {
      stopSttVolumeMeter();
      return;
    }
    void startSttVolumeMeter();
    return () => stopSttVolumeMeter();
  }, [dictating]);

  useEffect(() => {
    if (!dictating) return;
    const offFinal = VoiceService.on('voice:final', ({ text }) => {
      const sid = sessionRef.current;
      const spoken = text.trim();
      if (!sid || !spoken) return;
      void invoke('terminal_write', {
        sessionId: sid,
        data: `${spoken} `,
      });
    });
    const offError = VoiceService.on('voice:error', ({ kind, message }) => {
      setDictating(false);
      if (kind !== 'no_speech' && kind !== 'aborted') {
        toast.error('Voice error', message);
      }
    });
    const offEnd = VoiceService.on('voice:end', () => {
      if (!VoiceService.isListening()) setDictating(false);
    });
    const offTimeout = VoiceService.on('voice:timeout', ({ reason }) => {
      setDictating(false);
      toast.info('Speech-to-text stopped', reason);
    });
    return () => {
      offFinal();
      offError();
      offEnd();
      offTimeout();
    };
  }, [dictating]);

  const handleKill = async () => {
    const sid = sessionRef.current;
    if (executionId && hasCanonicalTerminalExecution(executionId)) {
      const result = await requestTerminalExecutionCancellation(executionId);
      const disposition = terminalCancellationDisposition(result);
      if (disposition === 'terminal') {
        if (!exitFiredRef.current) {
          exitFiredRef.current = true;
          onExitRef.current?.(
            useTerminalExecutionStore.getState().executions[executionId]?.exitCode ?? null,
          );
        }
      } else if (disposition === 'rejected') {
        toast.error(
          'Cancellation unavailable',
          'The canonical terminal could not commit cancellation intent and remains open.',
        );
      }
      return;
    }
    if (sid) {
      try {
        await invoke('terminal_kill', { sessionId: sid });
      } catch {
        /* still fall through and fire onExit so the parent can react */
      }
      // Drop the session from the transcript store so by-agent lookups
      // don't surface a dead pane's output any more. Done after the
      // kill IPC so a failure to kill still cleans up the in-memory
      // buffer (the pane is going away from the user's POV either way).
      useTerminalTranscriptStore.getState().forgetSession(sid);
    }
    if (paneId) {
      try {
        await invoke('terminal_snapshot_delete', {
          projectId: projectId ?? null,
          paneId,
        });
      } catch {
        /* explicit pane close still succeeds if snapshot cleanup fails */
      }
    }
    if (!exitFiredRef.current) {
      exitFiredRef.current = true;
      onExitRef.current?.(null);
    }
  };

  if (error) {
    // Render the *actual* error from the Tauri bridge so the user can
    // see what went wrong. Earlier this was a hardcoded "Run the desktop
    // build" message even when the user *was* on the desktop build —
    // that masked real failures (e.g. `opencode` not on PATH, PTY
    // exhaustion, sandbox denial). The honest error text is what the
    // user reported in the bug; keep it visible.
    //
    // We only fall back to the "desktop build" hint when `isTauri` is
    // genuinely false (running in a browser preview), because then we
    // know the failure is environmental rather than a runtime issue.
    const headline = isTauri ? 'Terminal failed to start' : 'Terminal backend not available';
    const body = isTauri
      ? error
      : `Run the desktop build (\`npm run tauri:dev\`) to use real terminals.\n\nDetail: ${error}`;
    return (
      <div
        data-sakura-terminal-chrome={hideChrome ? undefined : 'true'}
        className={cn(
          'rounded-lg border border-border bg-paper-soft shadow-soft p-4 space-y-1 [html[data-theme=monochrome]_&]:shadow-none',
          className,
        )}
        role="status"
        data-sik-evidence={
          KERNEL_SMOKE_ENABLED && executionId ? SIK_EVIDENCE.terminalExecution : undefined
        }
        data-error-code={
          KERNEL_SMOKE_ENABLED && executionId ? terminalSmokeFailureCode(error) : undefined
        }
        data-initialization-phase={
          KERNEL_SMOKE_ENABLED && executionId ? initializationPhase : undefined
        }
        data-terminal-status={
          KERNEL_SMOKE_ENABLED && executionId ? terminalExecutionStatus : undefined
        }
      >
        <p className="text-foreground text-ui-strong">{headline}</p>
        <p className="text-secondary text-muted-foreground whitespace-pre-wrap font-mono">{body}</p>
        {command && (
          <p className="text-metadata text-muted-foreground">
            Tried to run: <code>{command}</code>
            {cwd ? (
              <>
                {' '}
                in <code>{cwd}</code>
              </>
            ) : null}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      data-sakura-terminal-chrome={hideChrome ? undefined : 'true'}
      data-session-id={activeSessionId ?? undefined}
      data-sik-evidence={
        KERNEL_SMOKE_ENABLED && executionId ? SIK_EVIDENCE.terminalExecution : undefined
      }
      data-initialization-phase={
        KERNEL_SMOKE_ENABLED && executionId ? initializationPhase : undefined
      }
      data-terminal-status={
        KERNEL_SMOKE_ENABLED && executionId ? terminalExecutionStatus : undefined
      }
      onPointerEnter={markWarmIdlePointerEntered}
      onPointerLeave={markWarmIdlePointerLeft}
      onPointerDownCapture={markWarmIdleInteraction}
      onKeyDownCapture={markWarmIdleInteraction}
      onDragOver={(e) => {
        const nextKind =
          e.dataTransfer.types.includes('application/x-jarvis-file') ||
          e.dataTransfer.types.includes('text/plain')
            ? 'file'
            : e.dataTransfer.types.includes(CONTEXT_MIME)
              ? 'context'
              : null;
        if (!nextKind) return;
        e.preventDefault();
        setDropKind(nextKind);
      }}
      onDragLeave={() => setDropKind(null)}
      onDrop={(e) => {
        const filePath = e.dataTransfer.getData('application/x-jarvis-file');
        const contextRaw = e.dataTransfer.getData(CONTEXT_MIME);
        const path = filePath || (!contextRaw ? e.dataTransfer.getData('text/plain') : '');
        if (!contextRaw && !path) return;
        e.preventDefault();
        setDropKind(null);
        const sid = sessionRef.current;
        if (!sid) return;
        if (contextRaw) {
          const context = parseContextAttachment(contextRaw);
          if (!context) return;
          flashPowerUp(context.title);
          void invoke('terminal_write', {
            sessionId: sid,
            data: commandToInput(formatContextAttachmentForTerminal(context)),
          });
          return;
        }
        void invoke('terminal_write', { sessionId: sid, data: path.trim() });
      }}
      className={cn(
        'jarvis-terminal-surface relative flex w-full flex-col overflow-hidden bg-paper transition-shadow duration-300',
        // Only apply the standalone chrome (border, rounding, soft shadow)
        // when the parent isn't drawing its own pane frame.
        !hideChrome && 'rounded-lg border border-border shadow-soft',
        isFocused && 'animate-terminal-focus border-accent-copper/80 ring-2 ring-accent-copper/30',
        dropKind &&
          'border-accent-copper ring-2 ring-accent-copper/50 shadow-[0_0_28px_hsl(var(--accent-copper)/0.35)]',
        className,
      )}
    >
      <TerminalWarmIdleScene
        identity={activeSessionId ?? paneId ?? command ?? 'terminal'}
        lastActivityAt={warmIdleLastActivityAt}
        pointerEnteredAt={warmIdlePointerEnteredAt}
        pointerInside={warmIdlePointerInside}
        theme={warmTheme}
      />
      {dropKind && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-md border border-accent-copper/60 bg-background/90 px-3 py-1 text-metadata text-accent-copper shadow-soft">
          Drop {dropKind === 'context' ? 'Context' : 'file'} here to paste into this terminal
        </div>
      )}
      {powerUpTitle && (
        <div className="pointer-events-none absolute inset-x-4 top-1/2 z-20 -translate-y-1/2 rounded-2xl border border-accent-copper/60 bg-background/95 px-4 py-3 text-center text-accent-copper shadow-[0_0_42px_hsl(var(--accent-copper)/0.32)] animate-breathe">
          <div className="text-ui-strong">Context powered up</div>
          <div className="truncate text-metadata text-muted-foreground">{powerUpTitle}</div>
        </div>
      )}
      {dictating && (
        <div className="pointer-events-none absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-full border border-accent-copper/60 bg-background/90 px-2 py-1 text-metadata text-accent-copper shadow-soft">
          <Mic className="h-3 w-3" /> Dictating
        </div>
      )}
      {!hideChrome && (
        <StandaloneCloseChrome label={command || 'terminal'} onClose={() => void handleKill()} />
      )}
      <TerminalCommandPalette
        open={terminalPaletteOpen}
        paneId={paneId}
        sessionId={activeSessionId}
        projectId={projectId ?? null}
        evidence={terminalPromptEvidence}
        cwd={cwdRef.current ?? cwd ?? null}
        agentSlug={agentSlug ?? null}
        projectName={projectName ?? null}
        projectRoot={cwd ?? null}
        onClose={() => {
          setTerminalPaletteOpen(false);
          requestAnimationFrame(() => termRef.current?.focus());
        }}
        onNavigate={(route) => useUIStore.getState().setRoute(route)}
        onInsertUpgradedPrompt={async (text) => {
          const sid = sessionRef.current ?? activeSessionId;
          if (!sid) throw new Error('No active terminal session');
          // Never called during upgrade itself — only after user confirms Insert.
          // Single-line: submit with CR. Multi-line: type body without auto-run.
          await invoke('terminal_write', {
            sessionId: sid,
            data: prepareUpgradedPromptInsert(text),
          });
        }}
        onInstallCli={installTerminalCli}
        onUninstallCli={uninstallTerminalCli}
        onInstallShellIntegration={installTerminalShellIntegration}
        onUninstallShellIntegration={uninstallTerminalShellIntegration}
      />
      <div
        data-sakura-terminal-content="preserve"
        ref={containerRef}
        style={{ backgroundColor: currentTerminalTheme().background }}
        className="min-h-0 w-full flex-1 overflow-hidden pt-2 px-1.5 pb-1"
      />
    </div>
  );
}

/** Standalone chrome X: hold 1.5s then Confirm (matches PaneToolbar close). */
function StandaloneCloseChrome({ label, onClose }: { label: string; onClose: () => void }) {
  const [phase, setPhase] = useState<HoldConfirmPhase>('idle');
  const ctrlRef = useRef(createHoldToConfirmController({ onPhaseChange: setPhase }));

  useEffect(() => {
    const ctrl = ctrlRef.current;
    return () => ctrl.dispose();
  }, []);

  const begin = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    ctrlRef.current.beginHold();
  };
  const cancel = () => ctrlRef.current.cancelHold();
  const confirm = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ctrlRef.current.confirm()) return;
    onClose();
  };

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-b border-border bg-paper-soft px-2">
      <span className="truncate font-mono text-metadata text-muted-foreground">{label}</span>
      {phase === 'confirm' ? (
        <button
          type="button"
          onClick={confirm}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Confirm close terminal"
          className="inline-flex h-4 items-center rounded border border-accent-copper bg-accent-copper/20 px-1.5 text-[9px] font-bold uppercase tracking-wider text-accent-copper animate-pulse"
        >
          Confirm?
        </button>
      ) : (
        <button
          type="button"
          onPointerDown={begin}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onPointerCancel={cancel}
          aria-label={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to close terminal`}
          title={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to close terminal`}
          className="relative flex h-4 w-4 items-center justify-center overflow-hidden rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground select-none"
        >
          <span
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 bg-accent-copper/30 transition-all ease-linear',
              phase === 'holding' ? 'w-full duration-[1500ms]' : 'w-0 duration-0',
            )}
          />
          <X className="relative z-10 h-3 w-3" />
        </button>
      )}
    </div>
  );
}
