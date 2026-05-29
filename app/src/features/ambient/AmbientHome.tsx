/**
 * V2 — Ambient idle home.
 *
 * After the user has been inactive for `useUIStore.ambientThresholdMs`
 * (default 5 min), the app fades into a calm full-screen takeover with a
 * breathing orb, live clock, next event, open task count, and a rotating
 * quote. Any input wakes the app with a smooth zoom-and-fade animation.
 *
 * Design goals:
 *   - Single shared `--ambient-phase` clock — orb halo + drifting dots +
 *     vignette all breathe on the same 4.4s rhythm
 *   - No nags, no notifications — strictly atmospheric
 *   - Reduced-motion safe (CSS handles fallback)
 *   - Wake-on-activity always responsive (escape, click, type, scroll)
 *
 * Disabled if `useUIStore.ambient = false` (Settings → Ambient).
 */
import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { eventRepo, openDb, taskRepo } from '@/lib/db';
import type { EventRow } from '@/types/event';
import type { Task, WorkspaceId } from '@/types';
import { QUOTES } from './quotes';

interface UpcomingEvent {
  title: string;
  in_minutes: number;
}

/**
 * Format unix ms to local HH:MM (24h or 12h depending on locale, but we
 * pick 24h for tabular cleanliness when ambient).
 */
function formatClock(d: Date): { h: string; m: string; date: string; secs: string } {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const secs = d.getSeconds().toString().padStart(2, '0');
  const date = d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return { h, m, secs, date };
}

function minutesUntil(target: number): number {
  return Math.max(0, Math.round((target - Date.now()) / 60_000));
}

/**
 * Render the ambient takeover. Mounted unconditionally; only renders content
 * when `ui.ambientActive` is true. The component owns its own RAF loop for
 * the shared `--ambient-phase` CSS variable so all child layers breathe in
 * sync.
 */
export function AmbientHome() {
  const ambient = useUIStore((s) => s.ambient);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const workspaceId = useAuthStore((s) => s.workspaceId);

  const [now, setNow] = React.useState(() => new Date());
  const [quote, setQuote] = React.useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);
  const [nextEvent, setNextEvent] = React.useState<UpcomingEvent | null>(null);
  const [openTaskCount, setOpenTaskCount] = React.useState<number>(0);
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

  // Pull next event + open task count when activating.
  React.useEffect(() => {
    if (!ambientActive || !workspaceId) return;
    let cancelled = false;
    (async () => {
      try {
        await openDb();
        const wsId = workspaceId as WorkspaceId;
        const upcoming = await eventRepo.listUpcoming(wsId, 1).catch(() => [] as EventRow[]);
        const nextEv = upcoming[0];
        if (!cancelled && nextEv) {
          setNextEvent({ title: nextEv.title, in_minutes: minutesUntil(nextEv.start_at) });
        } else if (!cancelled) {
          setNextEvent(null);
        }
        const open = await taskRepo.listOpen(wsId).catch(() => [] as Task[]);
        if (!cancelled) setOpenTaskCount(open.length);
      } catch {
        /* repos may not be ready on first launch — silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ambientActive, workspaceId]);

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

  const { h, m, date } = formatClock(now);

  return (
    <div
      className="ambient-root"
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

      {/* Center stack: clock, date, glance cards, quote */}
      <div className="relative flex h-full flex-col items-center justify-center gap-8 px-8">
        <div className="ambient-clock select-none" aria-live="polite">
          {h}
          <span className="opacity-60">:</span>
          {m}
        </div>

        <div className="text-sm uppercase tracking-[0.32em] text-foreground/60">{date}</div>

        <div className="flex max-w-3xl flex-wrap items-center justify-center gap-3 pt-4">
          {nextEvent && (
            <GlanceCard
              label="next"
              value={nextEvent.title}
              hint={
                nextEvent.in_minutes < 60
                  ? `in ${nextEvent.in_minutes} min`
                  : `in ${Math.round(nextEvent.in_minutes / 60)} h`
              }
            />
          )}
          {openTaskCount > 0 && (
            <GlanceCard
              label="open tasks"
              value={String(openTaskCount)}
              hint={openTaskCount === 1 ? 'task' : 'tasks'}
            />
          )}
        </div>

        <div className="ambient-quote pt-8">
          <span aria-hidden="true">{'\u201C'}</span>
          {quote.text}
          <span aria-hidden="true">{'\u201D'}</span>
          <div className="mt-2 text-center text-xs not-italic tracking-wider text-foreground/45">
            — {quote.author}
          </div>
        </div>
      </div>

      <div className="ambient-hint">Press any key to wake</div>
    </div>
  );
}

/**
 * Inline glance card. Stays plain so the breathing animation reads.
 */
function GlanceCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="ambient-card flex min-w-[160px] flex-col items-center"
      style={{ ['--drift-dur' as string]: '14s' }}
    >
      <div className="text-[10px] uppercase tracking-[0.24em] text-foreground/55">{label}</div>
      <div className="pt-1 text-base text-foreground/95">{value}</div>
      {hint && <div className="pt-0.5 text-xs text-foreground/55">{hint}</div>}
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
