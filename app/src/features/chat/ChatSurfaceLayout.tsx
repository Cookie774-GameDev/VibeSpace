import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './chat-surface-layout.css';

/** Float only the composer footprint; reserve scroll space for the last message. */
export function ChatSurfaceLayout({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    const composer = host?.querySelector<HTMLElement>('[data-tour="chat-composer"]');
    if (!host || !composer) return;
    const measure = () => {
      const style = getComputedStyle(composer);
      const clearance = composer.getBoundingClientRect().height +
        (parseFloat(style.marginBottom) || 0) + 16;
      host.style.setProperty('--chat-composer-clearance', `${Math.ceil(clearance)}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="chat-surface-layout">{children}</div>;
}
