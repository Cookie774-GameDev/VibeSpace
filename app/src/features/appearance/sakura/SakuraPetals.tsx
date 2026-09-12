import * as React from 'react';
import type { SakuraPetalSpeed } from '@/stores/ui';

const PETALS = [
  { delay: '-4s', duration: '18s', left: '3%', size: '12px', sway: '72px' },
  { delay: '-13s', duration: '24s', left: '8%', size: '8px', sway: '-54px' },
  { delay: '-7s', duration: '21s', left: '13%', size: '10px', sway: '46px' },
  { delay: '-16s', duration: '25s', left: '18%', size: '7px', sway: '-82px' },
  { delay: '-10s', duration: '22s', left: '23%', size: '11px', sway: '64px' },
  { delay: '-2s', duration: '19s', left: '28%', size: '9px', sway: '-45px' },
  { delay: '-20s', duration: '25s', left: '33%', size: '8px', sway: '58px' },
  { delay: '-8s', duration: '23s', left: '38%', size: '12px', sway: '-68px' },
  { delay: '-14s', duration: '17s', left: '43%', size: '9px', sway: '51px' },
  { delay: '-5s', duration: '20s', left: '47%', size: '12px', sway: '-77px' },
  { delay: '-18s', duration: '24s', left: '51%', size: '8px', sway: '61px' },
  { delay: '-11s', duration: '16s', left: '55%', size: '11px', sway: '-49px' },
] as const;

export const SAKURA_PETAL_COUNT = PETALS.length;

export type SakuraPetalProfile = {
  count: number;
  durationMultiplier: number;
};

const SAKURA_PETAL_PROFILES: Record<SakuraPetalSpeed, SakuraPetalProfile> = {
  slow: { count: 7, durationMultiplier: 1.45 },
  normal: { count: 9, durationMultiplier: 1 },
  fast: { count: 12, durationMultiplier: 0.65 },
};

export function resolveSakuraPetalProfile(speed: SakuraPetalSpeed): SakuraPetalProfile {
  return SAKURA_PETAL_PROFILES[speed];
}

export interface SakuraPetalsProps {
  paused: boolean;
  speed?: SakuraPetalSpeed;
  staticMode?: boolean;
}

type PetalStyle = React.CSSProperties & {
  '--sakura-petal-delay': string;
  '--sakura-petal-duration': string;
  '--sakura-petal-left': string;
  '--sakura-petal-size': string;
  '--sakura-petal-sway': string;
};

type PetalFieldStyle = React.CSSProperties & {
  '--sakura-petal-speed-multiplier': number;
};

export function SakuraPetals({ paused, speed = 'normal', staticMode = false }: SakuraPetalsProps) {
  if (staticMode) return null;
  const profile = resolveSakuraPetalProfile(speed);

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden"
      data-sakura-paused={paused ? 'true' : 'false'}
      data-sakura-petals=""
      data-sakura-speed={speed}
      style={
        {
          '--sakura-petal-speed-multiplier': profile.durationMultiplier,
        } as PetalFieldStyle
      }
    >
      {PETALS.slice(0, profile.count).map((petal, index) => (
        <span
          className="absolute block"
          data-sakura-petal={String(index + 1)}
          key={index}
          style={
            {
              '--sakura-petal-delay': petal.delay,
              '--sakura-petal-duration': petal.duration,
              '--sakura-petal-left': petal.left,
              '--sakura-petal-size': petal.size,
              '--sakura-petal-sway': petal.sway,
            } as PetalStyle
          }
        />
      ))}
    </div>
  );
}
