import * as React from 'react';

const API_KEY_SAVE_BURST_EVENT = 'jarvis:api-key-save-burst';

interface ApiKeySaveBurstDetail {
  x: number;
  y: number;
}

interface Burst extends ApiKeySaveBurstDetail {
  id: number;
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
      setBursts((current) => [...current, { id, x: detail.x, y: detail.y }]);
      const timer = window.setTimeout(() => {
        setBursts((current) => current.filter((burst) => burst.id !== id));
      }, 2600);
      timers.current.push(timer);
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
        <div
          key={burst.id}
          className="jarvis-api-key-save-burst"
          style={{ left: burst.x, top: burst.y }}
        />
      ))}
    </div>
  );
}

export default ApiKeySaveBurst;
