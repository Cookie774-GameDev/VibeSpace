import * as React from 'react';
import { cn } from '@/lib/utils';

const API_KEY_SAVE_BURST_EVENT = 'jarvis:api-key-save-burst';

interface ApiKeySaveBurstDetail {
  x: number;
  y: number;
}

interface Burst extends ApiKeySaveBurstDetail {
  id: number;
  phase: 'expanding' | 'holding' | 'retracting' | 'sparkle';
}

export function fireApiKeySaveBurstFromElement(element: Element | null): void {
  if (typeof window === 'undefined') return;
  const rect = element?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  window.dispatchEvent(
    new CustomEvent<ApiKeySaveBurstDetail>(API_KEY_SAVE_BURST_EVENT, {
      detail: { x, y },
    }),
  );
}

export function ApiKeySaveBurst() {
  const [bursts, setBursts] = React.useState<Burst[]>([]);
  const nextId = React.useRef(1);
  const timers = React.useRef<number[]>([]);

  React.useEffect(() => {
    const onBurst = (event: Event) => {
      const detail = (event as CustomEvent<ApiKeySaveBurstDetail>).detail;
      if (!detail) return;
      const id = nextId.current++;

      setBursts((current) => [...current, { id, x: detail.x, y: detail.y, phase: 'expanding' }]);

      const timer1 = window.setTimeout(() => {
        setBursts((current) =>
          current.map((b) => (b.id === id ? { ...b, phase: 'holding' } : b))
        );
      }, 400);

      const timer2 = window.setTimeout(() => {
        setBursts((current) =>
          current.map((b) => (b.id === id ? { ...b, phase: 'retracting' } : b))
        );
      }, 900);

      const timer3 = window.setTimeout(() => {
        setBursts((current) =>
          current.map((b) => (b.id === id ? { ...b, phase: 'sparkle' } : b))
        );
      }, 1600);

      const timer4 = window.setTimeout(() => {
        setBursts((current) => current.filter((burst) => burst.id !== id));
      }, 2800);

      timers.current.push(timer1, timer2, timer3, timer4);
    };

    window.addEventListener(API_KEY_SAVE_BURST_EVENT, onBurst);
    return () => {
      window.removeEventListener(API_KEY_SAVE_BURST_EVENT, onBurst);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
    };
  }, []);

  if (bursts.length === 0) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[80] overflow-hidden">
      {bursts.map((burst) => (
        <React.Fragment key={burst.id}>
          <div
            className={cn(
              'jarvis-api-key-save-burst-wave',
              burst.phase === 'expanding' && 'phase-expanding',
              burst.phase === 'holding' && 'phase-holding',
              burst.phase === 'retracting' && 'phase-retracting',
              burst.phase === 'sparkle' && 'phase-sparkle',
            )}
            style={{ left: burst.x, top: burst.y }}
          />
          <div
            className={cn(
              'jarvis-api-key-save-burst-glow',
              burst.phase === 'expanding' && 'phase-expanding',
              burst.phase === 'holding' && 'phase-holding',
              burst.phase === 'retracting' && 'phase-retracting',
              burst.phase === 'sparkle' && 'phase-sparkle',
            )}
            style={{ left: burst.x, top: burst.y }}
          />
          {burst.phase === 'sparkle' && (
            <div className="jarvis-api-key-sparkles" style={{ left: burst.x, top: burst.y }}>
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="jarvis-sparkle"
                  style={{
                    '--sparkle-angle': `${i * 45}deg`,
                    '--sparkle-delay': `${i * 40}ms`,
                  } as React.CSSProperties}
                />
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export default ApiKeySaveBurst;
