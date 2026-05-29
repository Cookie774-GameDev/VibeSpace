import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Props for AnimatedBeam.
 *
 * Renders a single SVG path with a flowing dashed stroke, intended to live
 * inside a parent <svg> that provides the linearGradient referenced by
 * gradientId.
 */
export interface AnimatedBeamProps {
  /** Beam start point in the parent SVG's coordinate space */
  x1: number;
  y1: number;
  /** Beam end point in the parent SVG's coordinate space */
  x2: number;
  y2: number;
  /** ID of the <linearGradient> defined in the parent SVG's <defs> */
  gradientId: string;
  /** Stagger entrance in seconds */
  delay?: number;
  /** Reverse the dash flow direction (visualizes inbound vs outbound) */
  reverse?: boolean;
  /** Stroke width (default 1.5) */
  strokeWidth?: number;
  /** Optional className for the path */
  className?: string;
}

/**
 * AnimatedBeam renders a smooth cubic Bezier from (x1,y1) to (x2,y2) with a
 * gradient stroke and a dasharray that animates via the `beam-flow` keyframe
 * defined in tailwind.config. Used by BeamLayer.
 *
 * The control points keep the curve flat at both endpoints which produces
 * clean S-curves regardless of relative panel position to the hub.
 */
export function AnimatedBeam({
  x1,
  y1,
  x2,
  y2,
  gradientId,
  delay = 0,
  reverse = false,
  strokeWidth = 1.5,
  className,
}: AnimatedBeamProps) {
  // S-curve: control points horizontally aligned to endpoints,
  // pulled to the midpoint along x. Looks clean for any hub direction.
  const cpx = x1 + (x2 - x1) * 0.5;
  const path = `M ${x1} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${x2} ${y2}`;

  return (
    <motion.path
      d={path}
      stroke={`url(#${gradientId})`}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeDasharray="4 4"
      fill="none"
      className={cn('animate-beam-flow', className)}
      style={{
        animationDirection: reverse ? 'reverse' : 'normal',
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, delay }}
    />
  );
}
