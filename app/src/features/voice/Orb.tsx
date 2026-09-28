import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useAuthStore, type VoiceAgentProvider } from '@/stores/auth';
import type { VoiceState } from './store';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { useAppForeground } from './useAppForeground';

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
  /** Provider resolved for this voice request; falls back to the saved Main Agent provider. */
  activeProvider?: VoiceAgentProvider;
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

function JarvisHudOrb({
  state,
  className,
  ariaLabel,
  levelRef,
  activeProvider,
  providerAccentsEnabled,
  accentIntensity,
}: {
  state: VoiceState;
  className?: string;
  ariaLabel?: string;
  levelRef?: React.RefObject<number>;
  activeProvider: VoiceAgentProvider;
  providerAccentsEnabled: boolean;
  accentIntensity: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const appForeground = useAppForeground();
  const glowId = `${React.useId().replace(/:/g, '')}-glow`;
  const coreId = `${React.useId().replace(/:/g, '')}-core`;
  const speaking = state === 'speaking';
  const listening = state === 'listening';
  const hudRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const staticEnergy = speaking ? 0.32 : listening ? 0.18 : 0.08;
    hudRef.current?.style.setProperty('--jarvis-signal-energy', staticEnergy.toFixed(3));
    if (!levelRef || !speaking || reducedMotion || !appForeground) return;
    let frame = 0;
    let disposed = false;
    const updateEnergy = () => {
      if (disposed) return;
      const raw = Math.min(1, Math.max(0, levelRef.current ?? 0));
      const energy = Math.max(0.32, raw);
      hudRef.current?.style.setProperty('--jarvis-signal-energy', energy.toFixed(3));
      frame = window.requestAnimationFrame(updateEnergy);
    };
    frame = window.requestAnimationFrame(updateEnergy);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
    };
  }, [appForeground, levelRef, listening, reducedMotion, speaking]);

  return (
    <div
      ref={hudRef}
      role="img"
      aria-label={ariaLabel ?? `Voice orb (${state})`}
      data-orb-motion={reducedMotion ? 'reduced' : speaking && appForeground ? 'active' : 'idle'}
      data-speaking={speaking ? 'true' : 'false'}
      data-orb-presentation="signal-globe"
      data-hud-motion={!reducedMotion && speaking && appForeground ? 'on' : 'off'}
      data-voice-provider={activeProvider}
      data-provider-accents={providerAccentsEnabled ? 'true' : 'false'}
      data-voice-status={state}
      className={cn('jarvis-hud-orb relative shrink-0 select-none pointer-events-none', className)}
      style={{ '--jarvis-accent-intensity': `${accentIntensity}%` } as React.CSSProperties}
    >
      <svg viewBox="0 0 100 100" className="jarvis-hud-svg h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" className="jarvis-lantern-glow-high" />
            <stop offset="58%" className="jarvis-lantern-glow-mid" />
            <stop offset="100%" className="jarvis-lantern-glow-low" />
          </radialGradient>
          <radialGradient id={coreId} cx="34%" cy="28%" r="72%">
            <stop offset="0%" className="jarvis-lantern-core-high" />
            <stop offset="38%" className="jarvis-lantern-core-mid" />
            <stop offset="100%" className="jarvis-lantern-core-low" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="46" fill={`url(#${glowId})`} className="jarvis-lantern-halo" />
        <circle cx="50" cy="50" r="31" className="jarvis-lantern-frame" />
        <circle cx="50" cy="50" r="25" fill={`url(#${coreId})`} className="jarvis-lantern-core" />
        <ellipse cx="42" cy="39" rx="8" ry="5" className="jarvis-lantern-highlight" />
        <circle cx="50" cy="50" r="27.5" className="jarvis-lantern-energy" />
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
  activeProvider,
}: OrbProps) {
  const style = STYLES[state];
  const savedProvider = useAuthStore((auth) => auth.voiceMainAgentProvider);
  const providerAccentsEnabled = useAuthStore((auth) => auth.voiceProviderAccentsEnabled);
  const accentIntensity = useAuthStore((auth) => auth.voiceAccentIntensity);
  const resolvedProvider = activeProvider ?? savedProvider;
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
        activeProvider={resolvedProvider}
        providerAccentsEnabled={providerAccentsEnabled}
        accentIntensity={accentIntensity}
      />
    );
  }

  return (
    <motion.div
      role="img"
      aria-label={ariaLabel ?? `Voice orb (${state})`}
      data-orb-motion={reducedMotion ? 'reduced' : active ? 'active' : 'idle'}
      data-orb-presentation={presentation}
      data-voice-provider={resolvedProvider}
      data-provider-accents={providerAccentsEnabled ? 'true' : 'false'}
      data-voice-status={state}
      className={cn(
        'jarvis-orb-surface relative shrink-0 select-none pointer-events-none',
        className,
      )}
      style={
        {
          width: size,
          height: size,
          '--jarvis-accent-intensity': `${accentIntensity}%`,
          filter:
            reducedMotion && !flat
              ? `brightness(${style.brightness}) saturate(${style.saturation}) hue-rotate(${style.hueShift}deg)`
              : undefined,
        } as React.CSSProperties
      }
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
            : 'radial-gradient(circle, color-mix(in srgb, var(--jarvis-orb-accent-primary) 50%, transparent) 0%, color-mix(in srgb, var(--jarvis-orb-accent-secondary) 30%, transparent) 35%, transparent 70%)',
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
            : 'conic-gradient(from 0deg, var(--jarvis-orb-accent-primary) 0deg, var(--jarvis-orb-accent-secondary) 120deg, var(--jarvis-orb-accent-primary) 240deg, var(--jarvis-orb-accent-secondary) 360deg)',
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
            : 'radial-gradient(circle at 32% 30%, hsl(0 0% 100% / 0.18) 0%, color-mix(in srgb, var(--jarvis-orb-accent-primary) 58%, transparent) 28%, color-mix(in srgb, var(--jarvis-orb-accent-secondary) 86%, transparent) 70%, color-mix(in srgb, var(--jarvis-orb-accent-secondary) 96%, transparent) 100%)',
          border: flat ? '2px solid hsl(var(--foreground) / 0.6)' : undefined,
          boxShadow: flat
            ? undefined
            : 'inset 0 0 28px color-mix(in srgb, var(--jarvis-orb-accent-primary) 48%, transparent), inset 0 -10px 28px color-mix(in srgb, var(--jarvis-orb-accent-secondary) 56%, transparent)',
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
          boxShadow: flat
            ? undefined
            : '0 0 0 1px color-mix(in srgb, var(--jarvis-orb-accent-secondary) 20%, transparent)',
        }}
      />
    </motion.div>
  );
}
