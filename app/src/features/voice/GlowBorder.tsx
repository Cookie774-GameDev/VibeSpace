import { useUIStore } from '@/stores/ui';

/**
 * Apple-Intelligence-style screen-edge glow.
 *
 * The visual is implemented entirely in `globals.css` under `.glow-border`
 * (a fixed inset-0 layer with a rotating conic-gradient mask). This component
 * is a thin React wrapper that:
 *   - subscribes to `useUIStore.voiceListening`
 *   - mirrors the value into the `data-active` attribute the CSS reacts to
 *   - is `aria-hidden` because it's purely decorative
 *
 * Render once at the App root, above content, below modals.
 */
export function GlowBorder() {
  const active = useUIStore((s) => s.voiceListening);
  return <div className="glow-border" data-active={active ? 'true' : 'false'} aria-hidden="true" />;
}
