import type { StateStorage } from 'zustand/middleware';

/**
 * Diagnostic utility to measure and print LocalStorage sizes.
 * Gated to debug mode or critical events (boot, migration, write failure).
 */
export function measureStorageSizes(stage: 'boot' | 'migration' | 'quota_failure' | 'after_eviction', force = false): void {
  if (typeof window === 'undefined') return;

  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev && !force) return;

  try {
    const keys = ['jarvis-ui', 'jarvis-terminal-transcripts', 'jarvis-auth', 'jarvis-tools', 'jarvis-terminal-scheduler-v1'];
    let totalSize = 0;
    const sizes: Record<string, string> = {};

    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) {
        const val = window.localStorage.getItem(key) || '';
        totalSize += key.length + val.length;
      }
    }

    keys.forEach((k) => {
      const val = window.localStorage.getItem(k);
      sizes[k] = val ? `${(val.length / 1024).toFixed(2)} KB` : 'not found';
    });

    console.info(`[STORAGE MEASUREMENT] Stage: ${stage.toUpperCase()}`);
    console.info(`- Approx Total LocalStorage Size: ${(totalSize / 1024).toFixed(2)} KB`);
    Object.entries(sizes).forEach(([key, sz]) => {
      console.info(`  * Key '${key}': ${sz}`);
    });

    // Inspect jarvis-ui details on boot/migration/failure to spot potential bloat
    if (stage !== 'after_eviction') {
      const uiVal = window.localStorage.getItem('jarvis-ui');
      if (uiVal) {
        try {
          const parsed = JSON.parse(uiVal);
          const stateObj = parsed?.state || parsed;
          if (stateObj && typeof stateObj === 'object') {
            console.info(`[STORAGE MEASUREMENT] 'jarvis-ui' field analysis:`);
            const fields = Object.entries(stateObj).map(([field, val]) => {
              const strVal = JSON.stringify(val);
              return { field, size: strVal ? strVal.length : 0 };
            });
            fields.sort((a, b) => b.size - a.size);
            fields.slice(0, 10).forEach((f) => {
              console.info(`    - ${f.field}: ${(f.size / 1024).toFixed(2)} KB`);
            });
          }
        } catch (e) {
          console.error('[STORAGE MEASUREMENT] Failed to parse jarvis-ui payload:', e);
        }
      }
    }
  } catch (err) {
    console.error('[STORAGE MEASUREMENT] Error calculating storage sizes:', err);
  }
}

/**
 * Custom StateStorage wrapper for Zustand.
 * Prevents QuotaExceededError crashes, handles recovery, and clears corrupted keys.
 */
export const safeLocalStorage: StateStorage = {
  getItem: (name: string): string | null => {
    if (typeof window === 'undefined') return null;
    try {
      const val = window.localStorage.getItem(name);
      if (!val) return null;

      // Corrupted storage detection: verify JSON shape before loading
      JSON.parse(val);
      return val;
    } catch (e) {
      console.error(`[safeLocalStorage] Malformed or corrupted storage found for key '${name}':`, e);
      // Remove corrupted key to let Zustand recover with defaults
      try {
        window.localStorage.removeItem(name);
        console.warn(`[safeLocalStorage] Cleared corrupted storage key '${name}'.`);
      } catch (rmError) {
        console.error(`[safeLocalStorage] Failed to remove corrupted key '${name}':`, rmError);
      }
      return null;
    }
  },

  setItem: (name: string, value: string): void => {
    if (typeof window === 'undefined') return;

    const sizeKb = value.length / 1024;
    // Enforce size warning boundaries
    if (sizeKb > 500) {
      console.error(`[safeLocalStorage] Payload size warning for key '${name}' is extremely large (${sizeKb.toFixed(2)} KB).`);
    } else if (sizeKb > 250) {
      console.warn(`[safeLocalStorage] Payload size warning for key '${name}' is large (${sizeKb.toFixed(2)} KB).`);
    }

    try {
      window.localStorage.setItem(name, value);
    } catch (error: any) {
      console.error(
        `[safeLocalStorage] QuotaExceededError on key '${name}' (size: ${sizeKb.toFixed(2)} KB). Initiating recovery...`,
        error
      );

      // Log current sizes before cleaning
      measureStorageSizes('quota_failure', true);

      // Evict non-critical terminal transcript cache to reclaim space
      try {
        console.warn(`[safeLocalStorage] Evicting 'jarvis-terminal-transcripts' cache key...`);
        window.localStorage.removeItem('jarvis-terminal-transcripts');
        measureStorageSizes('after_eviction', true);
      } catch (evictError) {
        console.error(`[safeLocalStorage] Failed to evict transcripts cache:`, evictError);
      }

      // Retry write once
      try {
        window.localStorage.setItem(name, value);
        console.info(`[safeLocalStorage] Recovery write successful for key '${name}' after eviction.`);
      } catch (retryError) {
        console.error(`[safeLocalStorage] Retry write failed for key '${name}':`, retryError);

        // Minimal safe fallback strategy for crucial UI state store
        if (name === 'jarvis-ui') {
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
              const state = parsed.state || parsed;
              const minimalPayload = {
                state: {
                  activeChatId: state.activeChatId,
                  activeProjectId: state.activeProjectId || state.projectId || null,
                  route: state.route || 'chat',
                  navOpen: state.navOpen !== false,
                  theme: state.theme || 'dark',
                },
                version: parsed.version || 1,
              };
              window.localStorage.setItem(name, JSON.stringify(minimalPayload));
              console.warn(`[safeLocalStorage] Fallback minimal payload successfully written for 'jarvis-ui'.`);
            }
          } catch (fallbackError) {
            console.error(`[safeLocalStorage] Failed to write minimal fallback for 'jarvis-ui':`, fallbackError);
          }
        }
        // Do not re-throw into React. Allow the application to remain functional.
      }
    }
  },

  removeItem: (name: string): void => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(name);
    } catch (e) {
      console.error(`[safeLocalStorage] Failed to removeItem '${name}':`, e);
    }
  },
};
