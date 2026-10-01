import { useEffect } from 'react';
import { bootstrapOllamaConnection } from '@/lib/ai/ollamaBootstrap';

const FOCUS_DEBOUNCE_MS = 8_000;
const BACKGROUND_PROBE_MS = 45_000;
const RETRY_MS = [0, 2_000, 4_000, 8_000, 12_000, 20_000, 30_000, 45_000, 60_000];
let lastFocusBootstrapAt = 0;

/**
 * Keeps Ollama connected in the background: launch bootstrap, retry until the
 * daemon responds on loopback /api/version, and re-check on focus + interval.
 */
export function OllamaConnectionHost() {
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timers: number[] = [];
    let backgroundTimer: number | null = null;

    const schedule = (attempt: number) => {
      if (cancelled || attempt >= RETRY_MS.length) return;
      const delay = RETRY_MS[attempt] ?? 60_000;
      const timer = window.setTimeout(() => {
        void bootstrapOllamaConnection({ force: attempt > 0, signal: controller.signal })
          .then((result) => {
            if (cancelled || result.ready) return;
            schedule(attempt + 1);
          })
          .catch((err) => {
            if (!cancelled) {
              console.warn('[ollama] bootstrap retry failed:', err);
              schedule(attempt + 1);
            }
          });
      }, delay);
      timers.push(timer);
    };

    schedule(0);

    backgroundTimer = window.setInterval(() => {
      if (cancelled) return;
      void bootstrapOllamaConnection({ force: true, signal: controller.signal }).catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        console.warn('[ollama] background probe failed:', err);
      });
    }, BACKGROUND_PROBE_MS);

    function onFocus() {
      const now = Date.now();
      if (now - lastFocusBootstrapAt < FOCUS_DEBOUNCE_MS) return;
      lastFocusBootstrapAt = now;
      void bootstrapOllamaConnection({ force: true, signal: controller.signal }).catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        console.warn('[ollama] focus bootstrap failed:', err);
      });
    }

    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
      if (backgroundTimer !== null) window.clearInterval(backgroundTimer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return null;
}
