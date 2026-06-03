/**
 * Wellness break full-screen overlay.
 *
 * Activated via:
 *   - The chat composer when Jarvis proposes a `wellness.eyeBreak` action
 *     and the user clicks Approve.
 *   - The actions palette (Mod+Shift+A → "Start a 20-20-20 eye break").
 *   - Direct call: `useUIStore.getState().startWellness('eye-break-20-20-20', 20_000)`
 *
 * Design intent:
 *   - Full-screen takeover so the eyes physically have to leave the
 *     screen — that's the whole point of 20-20-20. Anything less than a
 *     full takeover (toast, banner) is too easy to ignore.
 *   - Calm warm ground with a soft breathing pulse — same visual
 *     vocabulary as `<AmbientHome />` so it feels like a sibling, not
 *     a notification.
 *   - z-index 80: above ambient idle (z-70), below toasts (z-100). The
 *     completion toast still shines through after the overlay closes.
 *   - Esc dismisses; the overlay also auto-ends when the duration
 *     elapses. We use `requestAnimationFrame` instead of `setInterval`
 *     so the displayed seconds value never lags the wall clock by more
 *     than a frame — important for a feature whose whole job is showing
 *     the right number.
 *
 * Mounted once in `App.tsx` so it covers every route.
 */

import { useEffect, useRef, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/** Seconds remaining derived from `wellnessStartedAt` + `wellnessDurationMs`. */
function useWellnessClock(): { remainingSec: number; elapsedFrac: number } {
  const startedAt = useUIStore((s) => s.wellnessStartedAt);
  const durationMs = useUIStore((s) => s.wellnessDurationMs);
  const active = useUIStore((s) => s.wellnessActive);

  const [, force] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      // Bump a counter to retrigger render without holding `Date.now()`
      // in state (it changes every frame and would re-fire effects).
      force((n) => n + 1);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  if (!active || startedAt === null || durationMs === null) {
    return { remainingSec: 0, elapsedFrac: 0 };
  }
  const now = Date.now();
  const elapsed = Math.max(0, now - startedAt);
  const remaining = Math.max(0, durationMs - elapsed);
  return {
    remainingSec: Math.ceil(remaining / 1000),
    elapsedFrac: Math.min(1, elapsed / Math.max(1, durationMs)),
  };
}

export function WellnessBreak() {
  const active = useUIStore((s) => s.wellnessActive);
  const kind = useUIStore((s) => s.wellnessKind);
  const endWellness = useUIStore((s) => s.endWellness);

  const { remainingSec, elapsedFrac } = useWellnessClock();
  const completedRef = useRef(false);

  // Auto-end when the timer reaches 0. The ref guards against double-
  // fire if the clock hook re-renders during the toast settle.
  useEffect(() => {
    if (!active) {
      completedRef.current = false;
      return;
    }
    if (remainingSec === 0 && !completedRef.current) {
      completedRef.current = true;
      endWellness();
      toast.success('Eye break complete', 'Your eyes thank you.');
    }
  }, [active, remainingSec, endWellness]);

  // Esc to skip.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endWellness();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, endWellness]);

  if (!active) return null;

  // Sub-headline copy varies by kind so future wellness modalities
  // (stretch, breath, hydration) can plug in without forking the
  // overlay.
  const headline =
    kind === 'eye-break-20-20-20'
      ? 'Look 20 feet away'
      : 'Take a moment';
  const subtext =
    kind === 'eye-break-20-20-20'
      ? 'Soften your gaze on something far. Your eyes will thank you.'
      : null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-[80] flex flex-col items-center justify-center',
        'bg-[hsl(var(--ambient-deep))]/95 backdrop-blur-md',
        'animate-fade-in',
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Wellness break"
      style={{
        background: `
          radial-gradient(circle at 30% 30%, hsl(var(--accent-amber) / 0.12) 0%, transparent 55%),
          radial-gradient(circle at 70% 70%, hsl(var(--accent-copper) / 0.10) 0%, transparent 60%),
          radial-gradient(circle at 50% 50%, hsl(var(--ambient-deep) / 0.96) 0%, hsl(var(--ambient-deep)) 80%)
        `,
      }}
    >
      {/* Soft breathing orb above the headline. */}
      <div
        className="mb-10 h-32 w-32 rounded-full animate-breathe"
        style={{
          background:
            'radial-gradient(circle at 35% 35%, hsl(var(--accent-amber) / 0.7) 0%, hsl(var(--accent-copper) / 0.45) 50%, transparent 75%)',
          filter: 'blur(2px)',
        }}
        aria-hidden
      />

      <h1
        className="font-display text-foreground/95 text-center"
        style={{
          fontSize: 'clamp(2.25rem, 5vw, 4rem)',
          fontWeight: 300,
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
        }}
      >
        {headline}
      </h1>

      {subtext && (
        <p className="mt-3 max-w-md text-center text-secondary text-muted-foreground/80">
          {subtext}
        </p>
      )}

      {/* Countdown — big and serene. */}
      <div
        className="mt-10 font-display text-accent-copper tabular-nums"
        style={{
          fontSize: 'clamp(3rem, 8vw, 6rem)',
          fontWeight: 200,
          lineHeight: 1,
        }}
        aria-live="polite"
        aria-atomic="true"
      >
        {remainingSec}
        <span
          className="ml-2 text-secondary text-muted-foreground/70 align-middle"
          style={{ fontSize: 'clamp(0.9rem, 1.4vw, 1.1rem)' }}
        >
          seconds
        </span>
      </div>

      {/* Progress arc — slim, subtle. */}
      <div
        className="mt-8 h-1 w-64 max-w-[60vw] overflow-hidden rounded-full bg-foreground/10"
        aria-hidden
      >
        <div
          className="h-full bg-accent-copper transition-[width] duration-200 ease-linear"
          style={{ width: `${Math.round(elapsedFrac * 100)}%` }}
        />
      </div>

      {/* Skip — bottom of screen so it doesn't compete with the orb. */}
      <div className="absolute bottom-10 flex flex-col items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={endWellness}
          className="text-muted-foreground/70 hover:text-foreground"
          aria-label="Skip wellness break"
        >
          <X className="h-3.5 w-3.5" /> Skip break
        </Button>
        <span className="text-metadata text-muted-foreground/50 uppercase tracking-wide">
          <Eye className="mr-1 inline h-3 w-3" />
          20-20-20 rule · Esc to dismiss
        </span>
      </div>
    </div>
  );
}
