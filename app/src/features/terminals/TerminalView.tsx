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
 * If the Tauri backend isn't reachable (e.g. running the web dev server
 * before slice 1 lands) we render a calm `bg-paper-soft` placeholder
 * instead of crashing the React tree.
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

import { cn } from '@/lib/utils';
import type { TerminalViewProps } from './types';

interface SpawnResult {
  sessionId: string;
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
  red: '#d97757',          // terracotta
  green: '#7c9870',        // sage
  yellow: '#d4a258',       // honey
  blue: '#9d8aa8',         // lavender
  magenta: '#c97b6e',      // rose
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

function pickTheme() {
  if (typeof document === 'undefined') return DARK_THEME;
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function TerminalView({
  sessionId: existingSessionId,
  command,
  cwd,
  rows = 30,
  cols = 100,
  className,
  onReady,
  onExit,
}: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(existingSessionId ?? null);
  const exitFiredRef = useRef(false);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    existingSessionId ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  // Capture latest callbacks via refs so the mount effect doesn't re-run
  // on every prop change (which would re-spawn the PTY).
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

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

    const dispatchResize = () => {
      const t = termRef.current;
      const f = fitRef.current;
      const sid = sessionRef.current;
      if (!t || !f || !sid) return;
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
    };

    const applyThemeToTerm = () => {
      const t = termRef.current;
      if (!t) return;
      // xterm v5 exposes Terminal.options as a mutable proxy; assigning
      // a new theme triggers a redraw with the new palette.
      t.options.theme = pickTheme();
    };

    const init = async () => {
      term = new Terminal({
        rows,
        cols,
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: pickTheme(),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      if (cancelled) return;
      term.open(containerEl);
      try {
        fit.fit();
      } catch {
        /* container size unknown yet; the post-spawn fit covers it */
      }

      termRef.current = term;
      fitRef.current = fit;

      term.onData((data: string) => {
        const sid = sessionRef.current;
        if (!sid) return;
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
          termRef.current?.write(e.payload.data);
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

      // Spawn or attach.
      let sid: string;
      try {
        if (existingSessionId == null) {
          const result = await invoke<SpawnResult>('terminal_spawn', {
            command,
            cwd,
            rows: term.rows,
            cols: term.cols,
          });
          sid = result.sessionId;
        } else {
          sid = existingSessionId;
        }
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
        return;
      }

      if (cancelled) return;
      sessionRef.current = sid;
      setActiveSessionId(sid);
      onReadyRef.current?.(sid);

      // Geometry observers.
      resizeObserver = new ResizeObserver(() => dispatchResize());
      resizeObserver.observe(containerEl);
      window.addEventListener('resize', dispatchResize);

      // Theme follower — re-skin xterm whenever the app toggles dark/light.
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
    };

    void init().catch((err) => {
      if (!cancelled) setError(String(err));
    });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', dispatchResize);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      // NOTE: deliberately no `terminal_kill` here. Sessions persist past
      // unmount; the user closes them via the chrome `×` button.
    };
    // Mount-only: prop changes after mount don't re-spawn the PTY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKill = async () => {
    const sid = sessionRef.current;
    if (sid) {
      try {
        await invoke('terminal_kill', { sessionId: sid });
      } catch {
        /* still fall through and fire onExit so the parent can react */
      }
    }
    if (!exitFiredRef.current) {
      exitFiredRef.current = true;
      onExitRef.current?.(null);
    }
  };

  if (error) {
    return (
      <div
        className={cn(
          'rounded-lg border border-border bg-paper-soft shadow-soft p-4',
          className,
        )}
        role="status"
      >
        <p className="text-foreground text-body">
          Terminal backend not available. Run the desktop build to use real
          terminals.
        </p>
      </div>
    );
  }

  return (
    <div
      data-session-id={activeSessionId ?? undefined}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-border bg-paper shadow-soft',
        className,
      )}
    >
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
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
