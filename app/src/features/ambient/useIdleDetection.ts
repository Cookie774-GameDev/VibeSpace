/**
 * Detect user inactivity and toggle ambient mode after a threshold.
 *
 * Listens at the document level for any input. Whenever activity arrives
 * we stamp `lastActivity` and clear the pending takeover; once the silence
 * exceeds `useUIStore.ambientThresholdMs`, we flip `ambientActive=true`.
 *
 * Scenarios that suppress takeover:
 *   - `useUIStore.ambient` master switch is false
 *   - Voice modal is open (user is mid-conversation)
 *   - Voice listening flag is on (push-to-talk active)
 *   - Any other modal is open (palette/settings)
 *   - Document is hidden (visibilityState !== 'visible')
 *   - User is fullscreen-typing in the chat (activeElement is textarea/input)
 */
import * as React from 'react';
import { useUIStore } from '@/stores/ui';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

export function useIdleDetection() {
  const ambient = useUIStore((s) => s.ambient);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const thresholdMs = useUIStore((s) => s.ambientThresholdMs);

  // Use refs for these so the hook doesn't re-bind listeners on each toggle.
  const voiceModalRef = React.useRef(false);
  const voiceListeningRef = React.useRef(false);
  const otherModalRef = React.useRef(false);

  React.useEffect(() => {
    return useUIStore.subscribe((s) => {
      voiceModalRef.current = s.voiceModalOpen;
      voiceListeningRef.current = s.voiceListening;
      otherModalRef.current = s.paletteOpen || s.settingsOpen;
    });
  }, []);

  React.useEffect(() => {
    if (!ambient) return;

    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isInputFocused = (): boolean => {
      const a = document.activeElement;
      if (!a) return false;
      const tag = a.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (a as HTMLElement).isContentEditable === true;
    };

    const isSuppressed = (): boolean => {
      return (
        document.visibilityState !== 'visible' ||
        voiceModalRef.current ||
        voiceListeningRef.current ||
        otherModalRef.current
      );
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, thresholdMs);
    };

    const check = () => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs >= thresholdMs && !isSuppressed() && !isInputFocused()) {
        setAmbientActive(true);
        // Stop scheduling more checks; the AmbientHome component
        // owns wake-on-input and will flip ambientActive=false.
        timer = null;
        return;
      }
      // Not idle long enough yet — try again in remaining time, plus a bit.
      timer = setTimeout(check, Math.max(2000, thresholdMs - idleMs + 500));
    };

    const onActivity = () => {
      lastActivity = Date.now();
      // Don't reset while ambient is active — AmbientHome handles its own wake.
      if (useUIStore.getState().ambientActive) return;
      schedule();
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onActivity);

    schedule();

    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      document.removeEventListener('visibilitychange', onActivity);
    };
  }, [ambient, setAmbientActive, thresholdMs]);

  // If ambient toggled off mid-session while active, force-deactivate.
  React.useEffect(() => {
    if (!ambient && ambientActive) setAmbientActive(false);
  }, [ambient, ambientActive, setAmbientActive]);
}
