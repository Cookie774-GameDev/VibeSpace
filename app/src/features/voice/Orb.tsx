import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { VoiceState } from './store';

/**
 * Pure-CSS ambient orb. ~200px (configurable). Layered gradient stack that
 * reacts to voice state via motion's `animate` prop:
 *
 *  layer 1: soft outer halo  - radial blur, scales with state
 *  layer 2: rotating conic   - cyan -> violet -> cyan, blurred
 *  layer 3: glassy sphere    - radial gradient with offset light source
 *  layer 4: specular highlight - small white blob in upper-left
 *  layer 5: thin inner ring  - subtle accent border
 *
 * No three.js, no canvas, no images. Runs on a single compositor thread.
 *
 * State-driven motion (per docs/04 sec 8.2):
 *  - idle      - gentle 4 s breathe
 *  - listening - scale 1.10, halo bright + faster pulse
 *  - thinking  - faster conic rotation, slight scale down
 *  - speaking  - rapid pulse cycle (mock amplitude until Phase 3)
 *  - error     - hue-rotated to rose, dampened
 */

export interface OrbProps {
  /** Current voice state. Defaults to 'idle'. */
  state?: VoiceState;
  /** Diameter in px. Default 200. */
  size?: number;
  className?: string;
  /** Optional stable role label for screen readers. */
  ariaLabel?: string;
}

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

export function Orb({ state = 'idle', size = 200, className, ariaLabel }: OrbProps) {
  const style = STYLES[state];

  return (
    <motion.div
      role="img"
      aria-label={ariaLabel ?? `Voice orb (${state})`}
      className={cn('relative shrink-0 select-none pointer-events-none', className)}
      style={{ width: size, height: size }}
      animate={{
        scale: style.scale,
        filter: `brightness(${style.brightness}) saturate(${style.saturation}) hue-rotate(${style.hueShift}deg)`,
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 22, mass: 0.8 }}
    >
      {/* Layer 1 - Outer halo. Extends well beyond the orb bounds for ambient bloom. */}
      <motion.div
        aria-hidden
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: '-40%',
          background:
            'radial-gradient(circle, hsl(var(--accent-cyan) / 0.55) 0%, hsl(var(--accent-violet) / 0.32) 35%, transparent 70%)',
          filter: 'blur(34px)',
          willChange: 'transform, opacity',
        }}
        animate={{
          scale: [style.haloScale, style.haloScale * 1.06, style.haloScale],
          opacity: [style.haloOpacity, style.haloOpacity + 0.1, style.haloOpacity],
        }}
        transition={{
          duration: style.pulseSeconds,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Layer 2 - Conic gradient ring. Slow rotation supplies "energy" without movement. */}
      <motion.div
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'conic-gradient(from 0deg, hsl(var(--accent-cyan)) 0deg, hsl(var(--accent-violet)) 120deg, hsl(var(--accent-cyan)) 240deg, hsl(var(--accent-violet)) 360deg)',
          filter: 'blur(10px)',
          opacity: 0.78,
          willChange: 'transform',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: style.conicSeconds, repeat: Infinity, ease: 'linear' }}
      />

      {/* Layer 3 - Glassy inner sphere with off-center light source for 3D illusion. */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          inset: '12%',
          background:
            'radial-gradient(circle at 32% 30%, hsl(0 0% 100% / 0.18) 0%, hsl(var(--accent-cyan) / 0.55) 28%, hsl(var(--accent-violet) / 0.85) 70%, hsl(var(--accent-violet) / 0.95) 100%)',
          boxShadow:
            'inset 0 0 28px hsl(var(--accent-cyan) / 0.5), inset 0 -10px 28px hsl(var(--accent-violet) / 0.55)',
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
          background:
            'radial-gradient(ellipse at center, hsl(0 0% 100% / 0.55) 0%, hsl(0 0% 100% / 0.1) 60%, transparent 100%)',
          filter: 'blur(6px)',
        }}
      />

      {/* Layer 5 - Thin inner accent ring. Gives the silhouette a clean edge against dark BG. */}
      <div
        aria-hidden
        className="absolute inset-[10%] rounded-full"
        style={{
          border: '1px solid hsl(0 0% 100% / 0.08)',
          boxShadow: '0 0 0 1px hsl(var(--accent-cyan) / 0.18)',
        }}
      />
    </motion.div>
  );
}
