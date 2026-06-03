/**
 * Lightweight env-only helpers for Supabase configuration.
 *
 * Why a separate file: `getSupabaseClient()` lives in `@/lib/supabase` and
 * statically imports `@supabase/supabase-js` (~210KB minified). Anything
 * that touches that module pulls the whole SDK into the boot chunk.
 *
 * This module imports nothing from `@supabase/*`. It just answers two
 * questions any boot-time check needs to make ("is cloud sync wired up
 * at all?", "what's the URL?") without dragging the SDK along.
 *
 * Use it in:
 *   - `useBridgeLifecycle` to short-circuit when the user hasn't pasted
 *     their Supabase env vars.
 *   - Any feature that wants to render a "Sign in" prompt before paying
 *     the cost of loading the SDK.
 *
 * The actual SDK is loaded on demand via:
 *   const { getSupabaseClient } = await import('@/lib/supabase/client');
 */

interface SupabaseEnv {
  url?: string;
  key?: string;
}

/**
 * Read Supabase env vars. Wrapped in a try/catch so test runners that
 * stub `import.meta.env` (or run in environments without it at all)
 * never throw on import.
 */
export function readSupabaseEnv(): SupabaseEnv {
  try {
    const env = import.meta.env as Record<string, string | undefined>;
    return {
      url: env?.VITE_SUPABASE_URL,
      key: env?.VITE_SUPABASE_ANON_KEY,
    };
  } catch {
    return {};
  }
}

/**
 * Cheap boolean: true when both env vars are present. Does NOT verify
 * the URL is reachable or the key is valid — just that they're set.
 *
 * Callers should treat `false` as "stay local-only" and skip every
 * cloud-related code path. A `true` answer means it's safe to start
 * lazy-loading `@supabase/supabase-js` and constructing the client.
 */
export function isSupabaseConfigured(): boolean {
  const { url, key } = readSupabaseEnv();
  return Boolean(url && key);
}
