/**
 * V2 — Ambient idle home.
 *
 * After the user has been inactive for `useUIStore.ambientThresholdMs`
 * (default 5 min), the app fades into a calm full-screen takeover with a
 * breathing orb, live clock, and a rotating quote. Any input wakes the app
 * with a smooth zoom-and-fade animation.
 *
 * Design goals:
 *   - Single shared `--ambient-phase` clock — orb halo + drifting dots +
 *     vignette all breathe on the same 4.4s rhythm
 *   - No nags, no schedule/task notification cards — strictly atmospheric
 *   - Reduced-motion safe (CSS handles fallback)
 *   - Wake-on-activity always responsive (escape, click, type, scroll)
 *
 * Disabled if `useUIStore.ambient = false` (Settings → Ambient).
 */
import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { formatAmbientClockParts } from '@/lib/timeFormat';
import { QUOTES } from './quotes';
import './sakura-ambient.css';

/**
 * Render the ambient takeover. Mounted unconditionally; only renders content
 * when `ui.ambientActive` is true. The component owns its own RAF loop for
 * the shared `--ambient-phase` CSS variable so all child layers breathe in
 * sync.
 */
export function AmbientHome() {
  const ambient = useUIStore((s) => s.ambient);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const clockFormat = useUIStore((s) => s.clockFormat);
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);

  const [now, setNow] = React.useState(() => new Date());
  const [quote, setQuote] = React.useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);
  const [exiting, setExiting] = React.useState(false);

  // Tick clock every second while active.
  React.useEffect(() => {
    if (!ambientActive) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [ambientActive]);

  // Rotate quote every 30s.
  React.useEffect(() => {
    if (!ambientActive) return;
    const id = setInterval(() => {
      setQuote(QUOTES[Math.floor(Math.random() * QUOTES.length)]);
    }, 30_000);
    return () => clearInterval(id);
  }, [ambientActive]);

  // Drive --ambient-phase in [0,1] from a single 4.4s cycle so child layers
  // can pulse in lockstep without their own timers.
  React.useEffect(() => {
    if (!ambientActive) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const elapsed = (t - start) / 4400;
      const phase = (Math.sin(elapsed * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      document.documentElement.style.setProperty('--ambient-phase', phase.toFixed(4));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.documentElement.style.setProperty('--ambient-phase', '0');
    };
  }, [ambientActive]);

  // Wake on any activity. The hook listens at the document level so it
  // catches mouse/keyboard/touch even before the focus reaches a child.
  React.useEffect(() => {
    if (!ambientActive) return;
    const wake = () => {
      if (exiting) return;
      setExiting(true);
      // Let the ambient-exit keyframes run, then flip the flag and
      // attach the wake animation to <html> so the app fades back in.
      window.setTimeout(() => {
        setAmbientActive(false);
        setExiting(false);
        if (typeof document !== 'undefined') {
          document.documentElement.classList.add('app-wake');
          window.setTimeout(() => {
            document.documentElement.classList.remove('app-wake');
          }, 460);
        }
      }, 360);
    };
    const opts = { capture: true } as const;
    window.addEventListener('keydown', wake, opts);
    window.addEventListener('mousedown', wake, opts);
    window.addEventListener('mousemove', wake, opts);
    window.addEventListener('touchstart', wake, opts);
    window.addEventListener('wheel', wake, opts);
    return () => {
      window.removeEventListener('keydown', wake, opts);
      window.removeEventListener('mousedown', wake, opts);
      window.removeEventListener('mousemove', wake, opts);
      window.removeEventListener('touchstart', wake, opts);
      window.removeEventListener('wheel', wake, opts);
    };
  }, [ambientActive, exiting, setAmbientActive]);

  if (!ambient || !ambientActive) return null;

  const { h, m, period, date } = formatAmbientClockParts(now, clockFormat);

  return (
    <div
      data-monochrome-surface="ambient-home"
      data-sakura-route="ambient"
      data-sakura-surface="ambient-home"
      className="ambient-root [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&_.ambient-orb-wrap]:hidden [html[data-theme=monochrome]_&_.ambient-grain]:hidden [html[data-theme=monochrome]_&_.ambient-dot]:hidden"
      data-state={exiting ? 'exiting' : 'active'}
      role="dialog"
      aria-label="Ambient mode. Press any key to wake."
    >
      {/* The breathing orb sits behind everything */}
      <div className="ambient-orb-wrap" aria-hidden="true">
        <div className="ambient-halo" />
        <div className="ambient-orb" />
      </div>

      {/* Drifting dots around the orb */}
      <DriftField />

      {/* Grain texture for cinematic depth */}
      <div className="ambient-grain" aria-hidden="true" />

      {/* Center stack: clock, date, quote only — no schedule/task cards */}
      <div className="relative flex h-full flex-col items-center justify-center gap-8 px-8">
        <div
          className="ambient-clock select-none [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-tight"
          aria-live="polite"
        >
          {h}
          {m ? (
            <>
              <span className="opacity-60">:</span>
              {m}
            </>
          ) : null}
          {period ? (
            <span className="ml-3 text-[0.35em] align-super tracking-[0.12em] opacity-70">
              {period}
            </span>
          ) : null}
        </div>

        <div className="text-sm uppercase tracking-[0.32em] text-foreground/60 [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-[0.14em]">
          {date}
        </div>

        <div className="ambient-quote pt-8 [html[data-theme=monochrome]_&]:max-w-xl [html[data-theme=monochrome]_&]:border-t [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:font-sans">
          <span aria-hidden="true">{'\u201C'}</span>
          {quote.text}
          <span aria-hidden="true">{'\u201D'}</span>
          <div className="mt-2 text-center text-xs not-italic tracking-wider text-foreground/45">
            — {quote.author}
          </div>
        </div>
      </div>

      <div className="ambient-hint [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:uppercase [html[data-theme=monochrome]_&]:tracking-[0.14em]">
        Press any key to wake
      </div>
    </div>
  );
}

/**
 * Subtle field of 8 drifting dots. Pure decoration; aria-hidden.
 */
function DriftField() {
  // Stable seeds so dots don't reshuffle on each render.
  const dots = React.useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => ({
        left: `${10 + ((i * 11) % 80)}%`,
        top: `${15 + ((i * 17) % 70)}%`,
        dx: `${((i * 7) % 24) - 12}px`,
        dy: `${((i * 5) % 20) - 10}px`,
        dur: `${10 + (i % 5) * 2}s`,
        delay: `${(i * 0.7) % 4}s`,
      })),
    [],
  );
  return (
    <div aria-hidden="true">
      {dots.map((d, i) => (
        <div
          key={i}
          className="ambient-dot"
          style={{
            left: d.left,
            top: d.top,
            animationDuration: d.dur,
            animationDelay: d.delay,
            ['--drift-x' as string]: d.dx,
            ['--drift-y' as string]: d.dy,
          }}
        />
      ))}
    </div>
  );
}
