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
 *     a) await `document.fonts.ready` before `term.open()`,
 *     b) re-assign `fontFamily` after open() to bust xterm's metric cache,
 *     c) one belt-and-braces re-fit when fonts settle later.
 *
 * If the Tauri backend isn't reachable (e.g. running the web dev server
 * before slice 1 lands) we render a calm `bg-paper-soft` placeholder
 * instead of crashing the React tree.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from 'xterm';
import { isTauri } from '@/lib/utils';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
import 'xterm/css/xterm.css';

import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import type { TerminalViewProps } from './types';
import { useTerminalTranscriptStore } from './transcriptStore';
import { resolveTerminalRestoreSession, type BackendTerminalInfo } from './restoreSession';
import {
  buildAgentSpawnEnv,
  buildTerminalAgentInjectionMessage,
  deliverAgentTerminalContext,
  detectInteractiveAgentCli,
  resolveAgentForSlug,
} from './agentPromptDelivery';
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
import { VoiceService } from '@/features/voice/VoiceService';
import {
  CONTEXT_MIME,
  formatContextAttachmentForTerminal,
  parseContextAttachment,
} from '@/features/context/tree';

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
}
interface OutputPayload {
  sessionId: string;
  data: string;
}
interface ExitPayload {
  sessionId: string;
  code: number | null;
}

/* ---------- Cozy palette mapped to xterm ITheme ----------
 * Dark: warm-wood/coffee surface, cream ink, copper cursor, terracotta /
 *       honey / sage / lavender ANSI palette.
 * Light: cream paper surface, brown ink, deeper copper cursor with the
 *        same hue family, just dropped in luminance for AA contrast.
 */

const DARK_THEME = {
  foreground: '#f5e6c8',
  background: '#2a2018',
  cursor: '#d97757',
  cursorAccent: '#2a2018',
  selectionBackground: '#d97757',
  selectionForeground: '#2a2018',
  black: '#2a2018',
  red: '#d97757', // terracotta
  green: '#7c9870', // sage
  yellow: '#d4a258', // honey
  blue: '#9d8aa8', // lavender
  magenta: '#c97b6e', // rose
  cyan: '#7c9870',
  white: '#f5e6c8',
  brightBlack: '#5d4c3c',
  brightRed: '#d97757',
  brightGreen: '#7c9870',
  brightYellow: '#d4a258',
  brightBlue: '#9d8aa8',
  brightMagenta: '#c97b6e',
  brightCyan: '#7c9870',
  brightWhite: '#fffbf5',
};

const LIGHT_THEME = {
  foreground: '#3a2e22',
  background: '#fffbf5',
  cursor: '#c66442',
  cursorAccent: '#fffbf5',
  selectionBackground: '#c66442',
  selectionForeground: '#fffbf5',
  black: '#3a2e22',
  red: '#c66442',
  green: '#5d7855',
  yellow: '#bf8d44',
  blue: '#8c7796',
  magenta: '#b96e62',
  cyan: '#5d7855',
  white: '#3a2e22',
  brightBlack: '#6b5d4f',
  brightRed: '#c66442',
  brightGreen: '#5d7855',
  brightYellow: '#bf8d44',
  brightBlue: '#8c7796',
  brightMagenta: '#b96e62',
  brightCyan: '#5d7855',
  brightWhite: '#3a2e22',
};

const JARVIS_THEME = {
  foreground: '#eee4d7',
  background: '#080a0f',
  cursor: '#ff8500',
  cursorAccent: '#080a0f',
  selectionBackground: '#7a410f',
  selectionForeground: '#fff5e8',
  black: '#080a0f',
  red: '#ff5d47',
  green: '#47d45b',
  yellow: '#ffb000',
  blue: '#4ca8ff',
  magenta: '#b37aff',
  cyan: '#45d4d4',
  white: '#eee4d7',
  brightBlack: '#5f626b',
  brightRed: '#ff7b68',
  brightGreen: '#6ce17c',
  brightYellow: '#ffc247',
  brightBlue: '#7bc0ff',
  brightMagenta: '#cb9cff',
  brightCyan: '#7be3e3',
  brightWhite: '#fff8ef',
};

function pickTheme() {
  if (typeof document === 'undefined') return DARK_THEME;
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light') return LIGHT_THEME;
  if (t === 'jarvis') return JARVIS_THEME;
  return DARK_THEME;
}

function commandToInput(command: string): string {
  return command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`;
}

function inputBeforeSubmit(data: string, currentInput: string): string {
  const submitIdx = data.search(/[\r\n]/);
  if (submitIdx === -1) return '';
  return `${currentInput}${data.slice(0, submitIdx)}`.trim();
}

export function TerminalView({
  sessionId: existingSessionId,
  paneId,
  command,
  startupCommand,
  pendingCommand,
  pendingCommandId,
  cwd,
  rows = 30,
  cols = 100,
  className,
  hideChrome = false,
  fontSize = 13,
  agentSlug,
  onReady,
  onPendingCommandSent,
  onExit,
  onFocus,
  onBlur,
  projectId,
  projectName,
}: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(existingSessionId ?? null);
  // Resolved working directory of the live session — needed to re-deliver
  // the agent briefing (AGENTS.md + coordination doc) on agent switches.
  const cwdRef = useRef<string | null>(cwd ?? null);
  // Last agent slug whose briefing was written for this session's cwd.
  const deliveredSlugRef = useRef<string | null>(null);
  const interactiveBriefingInjectedRef = useRef<string | null>(null);
  const exitFiredRef = useRef(false);
  const focusedRef = useRef(false);
  const dictatingRef = useRef(false);
  const ignoreClearsUntilRef = useRef<number>(0);
  const suppressOutputUntilRef = useRef<number>(0);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(existingSessionId ?? null);
  const [isFocused, setIsFocused] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dropKind, setDropKind] = useState<'file' | 'context' | null>(null);
  const [powerUpTitle, setPowerUpTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const powerUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const slug = agentSlug ?? null;
    agentSlugRef.current = slug;
    if (interactiveBriefingInjectedRef.current !== slug) {
      interactiveBriefingInjectedRef.current = null;
    }
  }, [agentSlug]);

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
    if (deliveredSlugRef.current === slug) return;
    deliveredSlugRef.current = slug;
    const sessionCwd = cwdRef.current;
    if (!sessionCwd) return;
    void deliverAgentTerminalContext({
      cwd: sessionCwd,
      agentSlug: slug,
      projectId: projectId ?? null,
      projectName: projectName ?? null,
      excludeSessionId: sid,
    }).then((result) => {
      if (!result.ok && result.error) {
        console.warn('[Jarvis] agent briefing re-delivery failed:', result.error);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug]);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    let cancelled = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let rafToken: number | null = null;
    let outputRafToken: number | null = null;
    let pendingOutput = '';
    let pendingTranscript = '';
    const outputBuffer = createTerminalOutputBuffer();
    let handleVisible: (() => void) | null = null;
    let onClear: ((e: Event) => void) | null = null;
    let unregisterPaneClear: (() => void) | null = null;
    let startupRestoreMode = false;
    const webglDispose = createWebglDisposeTracker();

    const resetTerminalSurface = () => {
      outputBuffer.flush();
      pendingOutput = '';
      pendingTranscript = '';
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
          return filterStartupTerminalOutput(chunk.slice(0, altIdx), filterOpts) + chunk.slice(altIdx);
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
        invoke('terminal_resize', {
          sessionId: sid,
          rows: t.rows,
          cols: t.cols,
        }).catch(() => {
          /* backend may have torn down -- ignore */
        });
      });
    };

    const applyThemeToTerm = () => {
      const t = termRef.current;
      if (!t) return;
      // xterm v5 exposes Terminal.options as a mutable proxy; assigning
      // a new theme triggers a redraw with the new palette.
      t.options.theme = pickTheme();
    };

    const flushTerminalOutput = () => {
      outputRafToken = null;
      if (!pendingOutput) return;
      const displayData = pendingOutput;
      const transcriptData = pendingTranscript;
      pendingOutput = '';
      pendingTranscript = '';
      const sid = sessionRef.current;
      if (!sid) return;

      try {
        if (Date.now() < ignoreClearsUntilRef.current) {
          // During the post-restore window, keep the viewport pinned to the
          // latest content so the user lands on their prompt — not scrolled
          // to wherever ConPTY's startup noise left the cursor. Fresh panes
          // pin to the top so PowerShell's cursor-home prompt is visible.
          termRef.current?.write(displayData, () => {
            if (cancelled) return;
            if (startupRestoreMode) {
              termRef.current?.scrollToBottom();
            } else {
              termRef.current?.scrollToTop();
            }
          });
        } else {
          termRef.current?.write(displayData);
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
      pendingOutput += displayData;
      pendingTranscript += transcriptData;
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

    const init = async () => {
      term = new Terminal({
        rows,
        cols,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize,
        lineHeight: fontSize <= 10 ? 1.0 : 1.08,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: pickTheme(),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      if (cancelled) return;

      // Critical: wait for JetBrains Mono (loaded via async @import in
      // globals.css) before xterm measures cell width inside `open()`.
      // Without this gate, xterm bakes in fallback monospace metrics and
      // the canvas grid stops matching rendered glyphs once the real font
      // swaps in -> visible text overlap at smaller tile sizes (the
      // "mushed words" bug at 2x2+).
      try {
        await document.fonts?.ready;
      } catch {
        /* not all environments expose document.fonts.ready -- degrade */
      }
      if (cancelled) return;

      term.open(containerEl);

      // GPU renderer. xterm's default DOM renderer re-lays-out HTML rows on
      // every write, which is the dominant frame cost with a 10-pane grid of
      // live CLIs. The WebGL addon renders glyphs on the GPU at the device
      // pixel ratio (crisper at fractional Windows display scaling, too).
      // If WebGL isn't available — or the browser reclaims the context
      // because too many are alive — we dispose the addon and xterm falls
      // back to the DOM renderer transparently.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webglDispose.disposeAddon();
        });
        webglDispose.setAddon(webgl);
        term.loadAddon(webgl);
      } catch (err) {
        webglDispose.setAddon(null);
        console.warn('[Jarvis] WebGL renderer unavailable, using DOM renderer:', err);
      }

      // Belt-and-braces: re-assigning fontFamily forces xterm's option
      // proxy to re-run its cell measurement, in case fonts.ready
      // resolved before the browser had finished building metric tables.
      term.options.fontFamily = term.options.fontFamily;

      termRef.current = term;
      fitRef.current = fit;

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
          onFocusRef.current?.();
        });
        textarea.addEventListener('blur', () => {
          focusedRef.current = false;
          setIsFocused(false);
          onBlurRef.current?.();
        });
      }

      term.onData((data: string) => {
        const sid = sessionRef.current;
        if (!sid) return;

        // Trace currently typed command prompt input
        const store = useTerminalTranscriptStore.getState();
        const currentSession = store.sessions[sid];
        let currentInput = currentSession?.currentInput ?? '';
        const submittedInput = inputBeforeSubmit(data, currentInput);
        for (let i = 0; i < data.length; i++) {
          const char = data[i];
          if (char === '\r' || char === '\n' || char === '\x03') {
            currentInput = '';
          } else if (char === '\x7f' || char === '\x08') {
            currentInput = currentInput.slice(0, -1);
          } else if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
            currentInput += char;
          }
        }

        useTerminalTranscriptStore.getState().setCurrentInput(sid, currentInput);

        const slug = agentSlugRef.current;
        if (
          submittedInput &&
          slug &&
          interactiveBriefingInjectedRef.current !== slug &&
          detectInteractiveAgentCli({
            command: currentSession?.command ?? startupCommand ?? command,
            startupCommand,
            transcript: currentSession?.text ?? '',
          })
        ) {
          interactiveBriefingInjectedRef.current = slug;
          buildTerminalAgentInjectionMessage({
            agentSlug: slug,
            userInput: submittedInput,
            cwd: cwdRef.current,
            projectId: projectId ?? null,
            projectName: projectName ?? null,
            excludeSessionId: sid,
          })
            .then((message) =>
              invoke('terminal_write', {
                sessionId: sid,
                // The user's line is already sitting in the TUI input;
                // clear it, then submit the instruction-bearing message.
                data: `\x15${commandToInput(message)}`,
              }),
            )
            .catch(() =>
              invoke('terminal_write', { sessionId: sid, data }).catch(() => {
                /* backend probably gone */
              }),
            );
          return;
        }

        invoke('terminal_write', { sessionId: sid, data }).catch(() => {
          /* ignore: backend probably gone */
        });
      });

      // Subscribe BEFORE spawning so we don't lose any first-prompt bytes.
      // Each await is paired with a cancelled re-check so we never leak a
      // listener when the component unmounts mid-init (StrictMode dev).
      try {
        const u1 = await listen<OutputPayload>('terminal://output', (e) => {
          if (e.payload.sessionId !== sessionRef.current) return;
          if (Date.now() < suppressOutputUntilRef.current) return;
          // Reassemble split ESC sequences before rendering or persisting so
          // orphan `]4;rgb:` / `[0[` fragments never land in xterm.
          enqueueTerminalChunks(e.payload.data);
        });
        if (cancelled) {
          u1();
          return;
        }
        unlistenOutput = u1;

        const u2 = await listen<ExitPayload>('terminal://exit', (e) => {
          if (e.payload.sessionId !== sessionRef.current) return;
          if (exitFiredRef.current) return;
          exitFiredRef.current = true;
          onExitRef.current?.(e.payload.code);
        });
        if (cancelled) {
          u2();
          return;
        }
        unlistenExit = u2;
      } catch (err) {
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
      let sid: string;
      let spawnedFresh = false;
      let restoredInput = '';
      let sessionCwd: string | null = cwd ?? null;
      let briefingDelivered = false;
      const slugAtSpawn = agentSlugRef.current;
      try {
        let activeSessions: BackendTerminalInfo[] = [];
        if (existingSessionId != null || paneId) {
          try {
            activeSessions = await invoke<BackendTerminalInfo[]>('terminal_list');
          } catch (listErr) {
            console.warn('[Jarvis] Failed to list terminal sessions for restore:', listErr);
          }
        }

        const restoreDecision = resolveTerminalRestoreSession({
          existingSessionId,
          paneId,
          projectId,
          activeSessions,
          transcripts: useTerminalTranscriptStore.getState().sessions,
        });
        startupRestoreMode = Boolean(restoreDecision.restoredText);

        if (restoreDecision.kind === 'spawn') {
          spawnedFresh = true;
          restoredInput = restoreDecision.restoredInput;

          if (restoreDecision.restoredText) {
            term.write(restoreDecision.restoredText);
            term.write('\r\n\x1b[33m[Session restored - process restarted]\x1b[0m\r\n', () => {
              // Land the viewport on the latest restored content. xterm only
              // auto-scrolls when already at the bottom, so pin it once the
              // replay is parsed; subsequent PTY writes then keep it pinned.
              if (!cancelled) termRef.current?.scrollToBottom();
            });
            // Set active window of 3s to bypass ConPTY initialization screen-clear signals only when restoring transcript
            ignoreClearsUntilRef.current = Date.now() + 3000;
          }

          // Deliver the agent briefing (AGENTS.md managed block +
          // coordination doc) BEFORE the process starts whenever the
          // working directory is known, so a CLI spawned directly (e.g.
          // `opencode` as the pane command) reads it on session start.
          if (slugAtSpawn && cwd) {
            const delivery = await deliverAgentTerminalContext({
              cwd,
              agentSlug: slugAtSpawn,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
            });
            briefingDelivered = delivery.ok;
            if (!delivery.ok && delivery.error) {
              console.warn('[Jarvis] agent briefing delivery failed:', delivery.error);
            }
          }

          const result = await invoke<SpawnResult>('terminal_spawn', {
            command,
            cwd,
            rows: term.rows,
            cols: term.cols,
            projectId: projectId,
            projectName: projectName,
            // Make the assignment discoverable by any process in the pane,
            // not just AGENTS.md readers (env is inherited by child CLIs).
            env: slugAtSpawn
              ? buildAgentSpawnEnv({
                  agentSlug: slugAtSpawn,
                  agentName: resolveAgentForSlug(slugAtSpawn).name,
                  cwd: cwd ?? null,
                  projectName: projectName ?? null,
                })
              : undefined,
          });
          sid = result.sessionId;
          sessionCwd = result.cwd || cwd || null;
          console.log(`[Jarvis] Spawned new PTY session: ${sid}`);

          // The backend resolved a cwd we did not know up front — deliver
          // there now, before any startup command launches a CLI.
          if (slugAtSpawn && !briefingDelivered && sessionCwd) {
            const delivery = await deliverAgentTerminalContext({
              cwd: sessionCwd,
              agentSlug: slugAtSpawn,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
              excludeSessionId: sid,
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
          if (slugAtSpawn && sessionCwd) {
            const delivery = await deliverAgentTerminalContext({
              cwd: sessionCwd,
              agentSlug: slugAtSpawn,
              projectId: projectId ?? null,
              projectName: projectName ?? null,
              excludeSessionId: sid,
            });
            briefingDelivered = delivery.ok;
          }
          // Restore visual transcript for active session re-attach
          if (restoreDecision.restoredText) {
            term.write(restoreDecision.restoredText, () => {
              if (!cancelled) termRef.current?.scrollToBottom();
            });
            ignoreClearsUntilRef.current = Date.now() + 3000;
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
        return;
      }

      // Race fix: if the effect was torn down between awaiting the
      // spawn and reaching here, the PTY is already running on the
      // backend but we have no UI handle to it. Without this kill we
      // leak a PTY per cancelled mount (StrictMode dev does this on
      // every render; production does it on fast route changes
      // during the spawn window). We kill the orphan and bail.
      if (cancelled) {
        if (existingSessionId == null) {
          invoke('terminal_kill', { sessionId: sid }).catch(() => {
            /* nothing to do — PTY may have already exited */
          });
        }
        return;
      }
      sessionRef.current = sid;
      if (paneId) {
        setTerminalPaneSessionId(paneId, sid);
      }
      cwdRef.current = sessionCwd;
      if (briefingDelivered || slugAtSpawn == null) {
        // Record what's on disk so the agent-switch effect only rewrites
        // the briefing when the slug actually changes.
        deliveredSlugRef.current = slugAtSpawn;
      }
      setActiveSessionId(sid);
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
      if (spawnedFresh) {
        ignoreClearsUntilRef.current = Math.max(
          ignoreClearsUntilRef.current,
          Date.now() + 1500,
        );
      }
      if (spawnedFresh && startupCommand) {
        invoke('terminal_write', {
          sessionId: sid,
          data: commandToInput(startupCommand),
        }).catch(() => {
          /* backend probably gone */
        });
      }
      if (spawnedFresh && restoredInput) {
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

      // Theme follower -- re-skin xterm whenever the app toggles dark/light.
      mutationObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.attributeName === 'data-theme') {
            applyThemeToTerm();
            break;
          }
        }
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });

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
      unregisterPaneClear?.();
      if (paneId) clearTerminalPaneSessionId(paneId);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      try {
        webglDispose.disposeTerminal(termRef.current);
      } catch {
        /* best-effort teardown */
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
  }, [dictating]);

  useEffect(() => {
    return () => {
      if (dictatingRef.current) VoiceService.stopListening();
    };
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
        toast.warning('Voice unsupported', 'Speech-to-text is not available in this runtime.');
        return;
      }
      try {
        VoiceService.startListening();
        setDictating(true);
      } catch (err) {
        toast.error('Voice error', err instanceof Error ? err.message : 'Voice could not start.');
        setDictating(false);
      }
    };
    window.addEventListener('jarvis:stt:toggle', onGlobalSttToggle);
    return () => window.removeEventListener('jarvis:stt:toggle', onGlobalSttToggle);
  }, []);

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
        className={cn(
          'rounded-lg border border-border bg-paper-soft shadow-soft p-4 space-y-1',
          className,
        )}
        role="status"
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
      data-session-id={activeSessionId ?? undefined}
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
        <div className="flex h-6 shrink-0 items-center justify-between border-b border-border bg-paper-soft px-2">
          <span className="truncate font-mono text-metadata text-muted-foreground">
            {command || 'terminal'}
          </span>
          <button
            type="button"
            onClick={() => void handleKill()}
            aria-label="Kill terminal"
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        style={{ backgroundColor: pickTheme().background }}
        className="min-h-0 w-full flex-1 overflow-hidden pt-2 px-1.5 pb-1"
      />
    </div>
  );
}
