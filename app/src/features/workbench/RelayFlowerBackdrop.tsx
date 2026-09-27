import { useEffect, useRef, type RefObject } from 'react';
import { paintRelayFlowers } from './relayFlowerPattern';

export function RelayFlowerBackdrop({ seed, scrollRef }: { seed: string; scrollRef: RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const region = canvas?.parentElement;
    const scroll = scrollRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !region || !scroll || !ctx) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = region.clientWidth;
      const height = region.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintRelayFlowers(ctx, seed, width, height, scroll.scrollTop);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(schedule);
    resize.observe(region);
    scroll.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      resize.disconnect();
      scroll.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    };
  }, [seed, scrollRef]);
  return <canvas ref={canvasRef} className="relay-flower-backdrop" aria-hidden="true" data-relay-flower-seed={seed} />;
}
