import { useEffect, useRef } from 'react';
import { useUIStore } from '@/stores/ui';
import { paintBotanicalBackground } from './chatBotanicalPattern';
import './chat-botanical.css';

export function ChatBotanicalBackground({ chatId }: { chatId: string }) {
  const theme = useUIStore((state) => state.theme);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const region = canvas?.parentElement;
    if (!canvas || !region || theme !== 'warm') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = region.clientWidth;
      const height = region.clientHeight;
      if (!width || !height) return;
      // Short multi-chat panes can also scroll their outer conversation region.
      canvas.style.transform = `translateY(${region.scrollTop}px)`;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const thread = region.querySelector<HTMLElement>('[data-tour="chat-thread"]');
      paintBotanicalBackground(ctx, chatId, width, height,
        (thread?.scrollTop ?? 0) + region.scrollTop, getComputedStyle(canvas).color);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(schedule);
    resize.observe(region);
    // Capture the real thread's scroll without replacing its history/autoscroll handler.
    region.addEventListener('scroll', schedule, { capture: true, passive: true });
    schedule();
    return () => {
      resize.disconnect();
      region.removeEventListener('scroll', schedule, true);
      cancelAnimationFrame(frame);
    };
  }, [chatId, theme]);
  return theme === 'warm' ? <canvas ref={canvasRef} className="chat-botanical-background" aria-hidden="true" /> : null;
}
