import * as React from 'react';
import { cn } from '@/lib/utils';
import { BASELINE_PLAYBACK_RATE } from './tokenSpeedCurve';
import {
  beginResponse,
  endResponse,
  getResponseSnapshot,
  noteOutputTextDelta,
  noteOutputTokens,
  setResponseLifecycle,
  tickResponse,
  type ResponseLifecycle,
} from './responseTokenTracker';

/** Preferred one-second derivative; falls back to full asset with hard segment wrap. */
export const LOADING_LOOP_1S_SRC = '/media/VibeSpace_Icon_Loading_Loop_1s.mp4';
export const LOADING_LOOP_FULL_SRC = '/media/VibeSpace_Icon_Loading_Loop.mp4';
/** Only the first second of the full source is approved for looping. */
export const LOADING_LOOP_SEGMENT_END = 1.0;

export interface TokenReactiveLoadingProps {
  /** Stable id for this response / stream (chat-scoped). */
  responseId: string;
  /** When true, animation is active for a working chat. */
  active: boolean;
  /** Optional lifecycle override (waiting / streaming / tooling / …). */
  lifecycle?: ResponseLifecycle;
  /** Incremental streamed assistant text since last render (optional). */
  textDelta?: string;
  /** Exact output-token delta when the runtime exposes it. */
  tokenDelta?: number;
  /** Compact sizing for inspector / dense panes. */
  compact?: boolean;
  className?: string;
  /** Dev-only diagnostics surface. */
  showDiagnostics?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Token-reactive VibeSpace icon loading loop.
 * Decorative only — surrounding status should expose accessible working text.
 */
export function TokenReactiveLoading({
  responseId,
  active,
  lifecycle,
  textDelta,
  tokenDelta,
  compact = false,
  className,
  showDiagnostics = import.meta.env.DEV && import.meta.env.VITE_LOADING_ANIM_DIAG === '1',
}: TokenReactiveLoadingProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [mediaFailed, setMediaFailed] = React.useState(false);
  const [useFullAsset, setUseFullAsset] = React.useState(false);
  const [diag, setDiag] = React.useState(() => getResponseSnapshot(responseId));
  const lastTextRef = React.useRef('');
  const fadeTimerRef = React.useRef<number | null>(null);
  const reduced = prefersReducedMotion();

  // Begin / end tracker lifecycle with active flag.
  React.useEffect(() => {
    if (!responseId) return;
    if (active) {
      beginResponse(responseId);
      setResponseLifecycle(responseId, lifecycle ?? 'waiting');
      setVisible(true);
      return;
    }
    setResponseLifecycle(responseId, lifecycle === 'error' ? 'error' : 'stopping');
    const fadeMs = lifecycle === 'error' ? 100 : 130;
    if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = window.setTimeout(() => {
      setVisible(false);
      endResponse(responseId);
      const v = videoRef.current;
      if (v) {
        try {
          v.pause();
          v.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
    }, fadeMs);
    return () => {
      if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    };
  }, [active, responseId, lifecycle]);

  React.useEffect(() => {
    if (!active || !responseId || !lifecycle) return;
    if (lifecycle === 'waiting' || lifecycle === 'streaming' || lifecycle === 'tooling') {
      setResponseLifecycle(responseId, lifecycle);
    }
  }, [active, responseId, lifecycle]);

  // Incremental text / token deltas without full re-tokenize.
  React.useEffect(() => {
    if (!active || !responseId || !textDelta) return;
    if (textDelta === lastTextRef.current) return;
    const prev = lastTextRef.current;
    lastTextRef.current = textDelta;
    const delta =
      textDelta.startsWith(prev) && prev.length > 0
        ? textDelta.slice(prev.length)
        : textDelta.length >= prev.length
          ? textDelta.slice(Math.max(0, textDelta.length - 64))
          : textDelta;
    if (delta) noteOutputTextDelta(responseId, delta);
  }, [active, responseId, textDelta]);

  React.useEffect(() => {
    if (!active || !responseId || tokenDelta == null || tokenDelta <= 0) return;
    noteOutputTokens(responseId, tokenDelta, 'exact');
  }, [active, responseId, tokenDelta]);

  // ≤10 Hz tick for smooth rate updates; pause when tab hidden.
  React.useEffect(() => {
    if (!active || !responseId || reduced) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (document.visibilityState === 'hidden') return;
      const snap = tickResponse(responseId);
      const v = videoRef.current;
      if (v && !v.paused) {
        const rate = snap.currentPlaybackRate || BASELINE_PLAYBACK_RATE;
        if (Math.abs((v.playbackRate || 1) - rate) >= 0.01) {
          try {
            v.playbackRate = rate;
          } catch {
            /* some WebViews clamp rates */
          }
        }
      }
      if (showDiagnostics) setDiag(snap);
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [active, responseId, reduced, showDiagnostics]);

  // Playback control + segment wrap for full asset fallback.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v || !active || reduced || mediaFailed) return;

    const onTimeUpdate = () => {
      if (!useFullAsset) return;
      if (v.currentTime >= LOADING_LOOP_SEGMENT_END - 0.02) {
        try {
          v.currentTime = 0;
        } catch {
          /* ignore seek errors */
        }
      }
    };
    const onEnded = () => {
      // 1s derivative ends → restart; full asset should not reach end of 4s.
      try {
        v.currentTime = 0;
        void v.play();
      } catch {
        /* ignore */
      }
    };

    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.loop = !useFullAsset;
    v.playbackRate = BASELINE_PLAYBACK_RATE;
    try {
      v.currentTime = 0;
    } catch {
      /* ignore */
    }
    const playAttempt = v.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => {
        // Autoplay blocked — keep static poster frame; chat continues.
        setMediaFailed(false);
      });
    }

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('ended', onEnded);
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    };
  }, [active, reduced, mediaFailed, useFullAsset]);

  // Unmount cleanup
  React.useEffect(() => {
    return () => {
      endResponse(responseId);
      if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    };
  }, [responseId]);

  if (!active && !visible) return null;

  const sizeClass = compact ? 'h-9 w-16' : 'h-11 w-[4.9rem]';

  return (
    <div
      className={cn(
        'vs-token-loading pointer-events-none select-none',
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
        sizeClass,
        visible ? 'opacity-100' : 'opacity-0',
        'transition-opacity duration-150 ease-out motion-reduce:transition-none',
        className,
      )}
      style={{ aspectRatio: '16 / 9' }}
      aria-hidden="true"
      data-token-loading={active ? 'active' : 'idle'}
      data-response-id={responseId}
    >
      {reduced || mediaFailed ? (
        <div
          className={cn(
            'h-full w-full rounded-md border border-accent-copper/25 bg-accent-copper/10',
            'shadow-[inset_0_0_12px_hsl(var(--accent-copper)/0.15)]',
          )}
          data-token-loading-fallback="static"
        />
      ) : (
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          src={useFullAsset ? LOADING_LOOP_FULL_SRC : LOADING_LOOP_1S_SRC}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          controls={false}
          tabIndex={-1}
          onError={() => {
            if (!useFullAsset) {
              setUseFullAsset(true);
              return;
            }
            setMediaFailed(true);
          }}
        />
      )}
      {showDiagnostics && diag ? (
        <span className="sr-only" data-token-loading-diag>
          {diag.responseId} tps={diag.smoothedTps.toFixed(1)} rate=
          {diag.currentPlaybackRate.toFixed(2)} {diag.lifecycle}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Accessible working status + decorative token loading media.
 * Reserves stable height to avoid layout shift.
 */
export function ChatWorkingIndicator({
  responseId,
  active,
  lifecycle,
  textDelta,
  tokenDelta,
  compact,
  label = 'AI is working',
}: TokenReactiveLoadingProps & { label?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5',
        compact ? 'min-h-9 px-1 py-1' : 'min-h-11 px-1 py-1.5',
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-chat-working={active ? 'true' : 'false'}
    >
      <TokenReactiveLoading
        responseId={responseId}
        active={active}
        lifecycle={lifecycle}
        textDelta={textDelta}
        tokenDelta={tokenDelta}
        compact={compact}
      />
      {active ? (
        <span className="text-metadata text-muted-foreground">{label}</span>
      ) : (
        <span className="text-metadata text-muted-foreground/0 select-none" aria-hidden>
          {/* reserved label width to reduce jump; invisible when idle */}
          {label}
        </span>
      )}
    </div>
  );
}
