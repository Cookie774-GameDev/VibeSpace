import * as React from 'react';
import { useUIStore, type SakuraPetalSpeed } from '@/stores/ui';
import { SakuraPetals } from './SakuraPetals';
import { SakuraScene } from './SakuraScene';
import {
  browserSupportsSakuraVisualEffects,
  resolveSakuraRenderingMode,
  startSakuraFrameProbe,
  type SakuraFrameProbeResult,
  type SakuraRenderingMode,
} from './sakuraPerformanceMode';
import {
  getBrowserSakuraVisibilityEnvironment,
  readSakuraVisibility,
  subscribeToSakuraVisibility,
  type SakuraVisibilitySnapshot,
} from './sakuraVisibility';
import { resolveSakuraRouteIntensity, type SakuraRouteIntensity } from './routeIntensity';

const STATIC_VISIBILITY: SakuraVisibilitySnapshot = {
  documentVisible: false,
  windowFocused: false,
  paused: true,
};

function readMediaQuery(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(() => readMediaQuery(query));

  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [query]);

  return matches;
}

function useSakuraVisibility(): SakuraVisibilitySnapshot {
  const [snapshot, setSnapshot] = React.useState(() => {
    const environment = getBrowserSakuraVisibilityEnvironment();
    return environment ? readSakuraVisibility(environment) : STATIC_VISIBILITY;
  });

  React.useEffect(() => {
    const environment = getBrowserSakuraVisibilityEnvironment();
    if (!environment) return;
    return subscribeToSakuraVisibility(environment, setSnapshot);
  }, []);

  return snapshot;
}

export interface SakuraBackdropViewProps {
  intensity: SakuraRouteIntensity;
  paused: boolean;
  petalsEnabled?: boolean;
  petalSpeed?: SakuraPetalSpeed;
  rendering: SakuraRenderingMode;
}

export function SakuraBackdropView({
  intensity,
  paused,
  petalsEnabled = true,
  petalSpeed = 'normal',
  rendering,
}: SakuraBackdropViewProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      data-sakura-backdrop=""
      data-sakura-intensity={intensity}
      data-sakura-paused={paused ? 'true' : 'false'}
      data-sakura-petal-speed={petalSpeed}
      data-sakura-rendering={rendering}
      {...({ inert: '' } as Record<string, string>)}
    >
      <SakuraScene />
      {petalsEnabled && (
        <SakuraPetals paused={paused} speed={petalSpeed} staticMode={rendering === 'static'} />
      )}
    </div>
  );
}

export interface SakuraBackdropProps {
  route: string;
}

export function SakuraBackdrop({ route }: SakuraBackdropProps) {
  const petalsEnabled = useUIStore((state) => state.sakuraPetalsEnabled);
  const petalSpeed = useUIStore((state) => state.sakuraPetalSpeed);
  const visibility = useSakuraVisibility();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const forcedColors = useMediaQuery('(forced-colors: active)');
  const supportsVisualEffects = React.useMemo(browserSupportsSakuraVisualEffects, []);
  const [frameProbe, setFrameProbe] = React.useState<SakuraFrameProbeResult>('pending');

  React.useEffect(() => {
    if (
      frameProbe !== 'pending' ||
      visibility.paused ||
      reducedMotion ||
      forcedColors ||
      !supportsVisualEffects
    ) {
      return;
    }
    return startSakuraFrameProbe(
      {
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
      },
      setFrameProbe,
    );
  }, [forcedColors, frameProbe, reducedMotion, supportsVisualEffects, visibility.paused]);

  const rendering = resolveSakuraRenderingMode({
    forcedColors,
    frameProbe,
    reducedMotion,
    supportsVisualEffects,
  });

  return (
    <SakuraBackdropView
      intensity={resolveSakuraRouteIntensity(route)}
      paused={visibility.paused}
      petalsEnabled={petalsEnabled}
      petalSpeed={petalSpeed}
      rendering={rendering}
    />
  );
}
