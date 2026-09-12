import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { VoiceState } from './store';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';

/**
 * Pure-CSS ambient orb. ~200px (configurable). Layered gradient stack that
 * reacts to voice state via motion's `animate` prop:
 *
 *  layer 1: soft outer halo  - radial blur, scales with state
 *  layer 2: rotating conic   - amber -> copper -> amber, blurred
 *  layer 3: glassy sphere    - radial gradient with offset light source
 *  layer 4: specular highlight - small white blob in upper-left
 *  layer 5: thin inner ring  - subtle accent border
 *
 * No three.js, no canvas, no images. Runs on a single compositor thread.
 *
 * State-driven motion (per docs/04 sec 8.2):
 *  - idle      - still warm presentation
 *  - listening - scale 1.10, halo bright + faster pulse
 *  - thinking  - faster conic rotation, slight scale down
 *  - speaking  - rapid pulse cycle (mock amplitude until Phase 3)
 *  - paused    - still, dimmed presentation
 *  - error     - still, hue-rotated to rose and dampened
 *
 * Nonessential movement is disabled when reduced motion is requested.
 */

export interface OrbProps {
  /** Current voice state. Defaults to 'idle'. */
  state?: VoiceState;
  /** Diameter in px. Default 200. */
  size?: number;
  className?: string;
  /** Optional stable role label for screen readers. */
  ariaLabel?: string;
  /** Visual treatment. Defaults to the ambient layered presentation. */
  presentation?: 'default' | 'monochrome-flat' | 'signal-globe';
  /** Mutable 0..1 signal sampled without causing React renders. */
  levelRef?: React.RefObject<number>;
}

const LEGACY_ORB_STATE_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 220,
  damping: 22,
  mass: 0.8,
} as const);
const LEGACY_ORB_HALO_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 180,
  damping: 24,
} as const);

interface StateStyle {
  scale: number;
  brightness: number;
  haloScale: number;
  haloOpacity: number;
  conicSeconds: number;
  pulseSeconds: number;
  saturation: number;
  hueShift: number;
}

const STYLES: Record<VoiceState, StateStyle> = {
  idle: {
    scale: 1,
    brightness: 0.95,
    haloScale: 1,
    haloOpacity: 0.55,
    conicSeconds: 12,
    pulseSeconds: 4,
    saturation: 1,
    hueShift: 0,
  },
  listening: {
    scale: 1.1,
    brightness: 1.2,
    haloScale: 1.18,
    haloOpacity: 0.85,
    conicSeconds: 5,
    pulseSeconds: 1.6,
    saturation: 1.15,
    hueShift: 0,
  },
  thinking: {
    scale: 1.04,
    brightness: 1.05,
    haloScale: 1.06,
    haloOpacity: 0.7,
    conicSeconds: 2.4,
    pulseSeconds: 3,
    saturation: 1,
    hueShift: 0,
  },
  speaking: {
    scale: 1.07,
    brightness: 1.15,
    haloScale: 1.12,
    haloOpacity: 0.78,
    conicSeconds: 6,
    pulseSeconds: 0.9,
    saturation: 1.05,
    hueShift: 0,
  },
  paused: {
    scale: 0.98,
    brightness: 0.85,
    haloScale: 0.98,
    haloOpacity: 0.5,
    conicSeconds: 16,
    pulseSeconds: 6,
    saturation: 0.8,
    hueShift: 0,
  },
  error: {
    scale: 0.96,
    brightness: 0.7,
    haloScale: 0.95,
    haloOpacity: 0.45,
    conicSeconds: 14,
    pulseSeconds: 5,
    saturation: 0.5,
    hueShift: 220,
  },
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

function tickMarks(count: number, inner: number, outer: number): string {
  const marks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const x1 = 50 + Math.cos(angle) * inner;
    const y1 = 50 + Math.sin(angle) * inner;
    const x2 = 50 + Math.cos(angle) * outer;
    const y2 = 50 + Math.sin(angle) * outer;
    marks.push(`M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`);
  }
  return marks.join('');
}

function JarvisHudOrb({
  state,
  className,
  ariaLabel,
  levelRef,
}: {
  state: VoiceState;
  className?: string;
  ariaLabel?: string;
  levelRef?: React.RefObject<number>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const glowId = `${React.useId().replace(/:/g, '')}-glow`;
  const speaking = state === 'speaking';
  const listening = state === 'listening';
  const hudRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!levelRef) return;
    let frame = 0;
    let disposed = false;
    const updateEnergy = () => {
      if (disposed) return;
      const raw = Math.min(1, Math.max(0, levelRef.current ?? 0));
      const energy = speaking
        ? reducedMotion
          ? Math.max(0.2, raw * 0.5)
          : Math.max(0.32, raw)
        : listening
          ? 0.18
          : 0.08;
      hudRef.current?.style.setProperty('--jarvis-signal-energy', energy.toFixed(3));
      frame = window.requestAnimationFrame(updateEnergy);
    };
    frame = window.requestAnimationFrame(updateEnergy);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
    };
  }, [levelRef, listening, reducedMotion, speaking]);

  return (
    <div
      ref={hudRef}
      role="img"
      aria-label={ariaLabel ?? `Voice orb (${state})`}
      data-orb-motion={reducedMotion ? 'reduced' : speaking ? 'active' : 'idle'}
      data-speaking={speaking ? 'true' : 'false'}
      data-orb-presentation="signal-globe"
      data-hud-motion={reducedMotion ? 'off' : 'on'}
      className={cn('jarvis-hud-orb relative shrink-0 select-none pointer-events-none', className)}
    >
      <svg viewBox="0 0 100 100" className="jarvis-hud-svg h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7ef6ff" stopOpacity="0.55" />
            <stop offset="42%" stopColor="#12d4ea" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#03141c" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="48" fill={`url(#${glowId})`} className="jarvis-hud-bloom" />
        <g className="jarvis-hud-spin-slow">
          <circle cx="50" cy="50" r="46" className="jarvis-hud-ring jarvis-hud-ring-outer" />
          <path
            d="M8 50a42 42 0 0 1 18-34"
            className="jarvis-hud-arc jarvis-hud-arc-bright"
          />
          <path
            d="M86 72a42 42 0 0 1-28 22"
            className="jarvis-hud-arc jarvis-hud-arc-bright"
          />
        </g>
        <g className="jarvis-hud-spin-rev">
          <circle cx="50" cy="50" r="38" className="jarvis-hud-ring" />
          <path d="M18 38a34 34 0 0 1 28-20" className="jarvis-hud-arc" />
          <path d="M78 70a34 34 0 0 1-22 16" className="jarvis-hud-arc" />
          <circle cx="50" cy="50" r="34" className="jarvis-hud-dots" />
        </g>
        <g className="jarvis-hud-spin-mid">
          <path d={tickMarks(28, 27.2, 30.6)} className="jarvis-hud-ticks" />
          <path d={tickMarks(12, 24.4, 26.8)} className="jarvis-hud-ticks jarvis-hud-ticks-long" />
        </g>
        <circle cx="50" cy="50" r="20.5" className="jarvis-hud-core-ring" />
        <circle cx="50" cy="50" r="17.8" className="jarvis-hud-core-fill" />
        <text x="50" y="52.2" textAnchor="middle" className="jarvis-hud-wordmark">
          J.A.R.V.I.S
        </text>
      </svg>
    </div>
  );
}

export function Orb({
  state = 'idle',
  size = 200,
  className,
  ariaLabel,
  presentation = 'default',
  levelRef,
}: OrbProps) {
  const style = STYLES[state];
  const reducedMotion = usePrefersReducedMotion();
  const stateTransition = useThemeMotionTransition(LEGACY_ORB_STATE_TRANSITION);
  const haloTransition = useThemeMotionTransition(LEGACY_ORB_HALO_TRANSITION);
  const flat = presentation === 'monochrome-flat';
  const signalGlobe = presentation === 'signal-globe';
  const active = state === 'listening' || state === 'thinking' || state === 'speaking';

  if (signalGlobe) {
    return (
      <JarvisHudOrb
        state={state}
        className={className}
        ariaLabel={ariaLabel}
        levelRef={levelRef}
      />
    );
  }

  return (
    <motion.div
      role="img"
      aria-label={ariaLabel ?? `Voice orb (${state})`}
      data-orb-motion={reducedMotion ? 'reduced' : active ? 'active' : 'idle'}
      data-orb-presentation={presentation}
      className={cn('relative shrink-0 select-none pointer-events-none', className)}
      style={{
        width: size,
        height: size,
        filter:
          reducedMotion && !flat
            ? `brightness(${style.brightness}) saturate(${style.saturation}) hue-rotate(${style.hueShift}deg)`
            : undefined,
      }}
      animate={
        reducedMotion
          ? undefined
          : flat
            ? { scale: style.scale }
            : {
                scale: style.scale,
                filter: `brightness(${style.brightness}) saturate(${style.saturation}) hue-rotate(${style.hueShift}deg)`,
              }
      }
      transition={stateTransition}
    >
      {/* Layer 1 - Outer halo. Extends well beyond the orb bounds for ambient bloom. */}
      <motion.div
        aria-hidden
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: flat ? '-18%' : '-40%',
          background: flat
            ? 'hsl(var(--foreground) / 0.08)'
            : 'radial-gradient(circle, hsl(var(--accent-amber) / 0.5) 0%, hsl(var(--accent-copper) / 0.3) 35%, transparent 70%)',
          filter: flat ? undefined : 'blur(34px)',
          willChange: 'transform, opacity',
        }}
        animate={
          reducedMotion
            ? undefined
            : active
              ? {
                  scale: [style.haloScale, style.haloScale * 1.06, style.haloScale],
                  opacity: [style.haloOpacity, style.haloOpacity + 0.1, style.haloOpacity],
                }
              : { scale: style.haloScale, opacity: style.haloOpacity }
        }
        transition={
          reducedMotion
            ? undefined
            : active
              ? { duration: style.pulseSeconds, repeat: Infinity, ease: 'easeInOut' }
              : haloTransition
        }
      />

      {/* Layer 2 - Conic gradient ring. Slow rotation supplies "energy" without movement. */}
      <motion.div
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background: flat
            ? 'hsl(var(--foreground) / 0.16)'
            : 'conic-gradient(from 0deg, hsl(var(--accent-amber)) 0deg, hsl(var(--accent-copper)) 120deg, hsl(var(--accent-amber)) 240deg, hsl(var(--accent-copper)) 360deg)',
          filter: flat ? undefined : 'blur(10px)',
          opacity: 0.78,
          willChange: 'transform',
        }}
        animate={reducedMotion || !active ? undefined : { rotate: 360 }}
        transition={
          reducedMotion || !active
            ? undefined
            : { duration: style.conicSeconds, repeat: Infinity, ease: 'linear' }
        }
      />

      {/* Layer 3 - Glassy inner sphere with off-center light source for 3D illusion. */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          inset: '12%',
          background: flat
            ? 'hsl(var(--accent-copper) / 0.72)'
            : 'radial-gradient(circle at 32% 30%, hsl(0 0% 100% / 0.18) 0%, hsl(var(--accent-amber) / 0.58) 28%, hsl(var(--accent-copper) / 0.86) 70%, hsl(var(--accent-copper) / 0.96) 100%)',
          border: flat ? '2px solid hsl(var(--foreground) / 0.6)' : undefined,
          boxShadow: flat
            ? undefined
            : 'inset 0 0 28px hsl(var(--accent-amber) / 0.48), inset 0 -10px 28px hsl(var(--accent-copper) / 0.56)',
        }}
      />

      {/* Layer 4 - Specular highlight, blurred. Sells the "polished marble" feel. */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          top: '18%',
          left: '22%',
          width: '32%',
          height: '20%',
          background: flat
            ? 'hsl(var(--foreground) / 0.28)'
            : 'radial-gradient(ellipse at center, hsl(0 0% 100% / 0.55) 0%, hsl(0 0% 100% / 0.1) 60%, transparent 100%)',
          filter: flat ? undefined : 'blur(6px)',
        }}
      />

      {/* Layer 5 - Thin inner accent ring. Gives the silhouette a clean edge against dark BG. */}
      <div
        aria-hidden
        className="absolute inset-[10%] rounded-full"
        style={{
          border: flat
            ? '2px solid hsl(var(--foreground) / 0.55)'
            : '1px solid hsl(0 0% 100% / 0.08)',
          boxShadow: flat ? undefined : '0 0 0 1px hsl(var(--accent-copper) / 0.2)',
        }}
      />
    </motion.div>
  );
}
