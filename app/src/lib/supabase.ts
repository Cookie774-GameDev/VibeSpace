/**
 * Supabase client singleton for VibeSpace.
 *
 * Cloud sync is optional. If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`
 * are missing or invalid, this module returns `null` from
 * `getSupabaseClient()` rather than throwing - the rest of the app degrades
 * gracefully into local-only mode.
 *
 * Usage:
 *   import { getSupabaseClient, isCloudSyncConfigured } from '@/lib/supabase';
 *   const client = getSupabaseClient();
 *   if (client) {
 *     const { data } = await client.from('tasks').select('*');
 *   }
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null | undefined;

/**
 * Read env vars in a way that's resilient to missing `import.meta.env` at
 * test time. Vite injects these at build; jsdom-based tests may not.
 */
function readEnv(): { url?: string; key?: string } {
  try {
    const env = import.meta.env;
    return {
      url: env?.VITE_SUPABASE_URL,
      key: env?.VITE_SUPABASE_ANON_KEY,
    };
  } catch {
    return {};
  }
}

/**
 * Return the shared Supabase client, or `null` when cloud sync is not
 * configured. Memoised per process - the first call creates the client and
 * subsequent calls reuse it.
 *
 * NEVER throws. If the SDK fails to initialise (bad URL, etc.) the error is
 * logged and `null` is returned so the app keeps running.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (_client !== undefined) return _client;

  const { url, key } = readEnv();
  if (!url || !key) {
    _client = null;
    return null;
  }

  try {
    _client = createClient(url, key, {
      auth: {
        // Persist sessions in localStorage so the user stays signed in across
        // app launches. Tauri's webview supports localStorage.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'x-client-info': 'vibespace-desktop/0.1.30',
        },
      },
    });
    return _client;
  } catch (e) {
    // Don't crash the app if Supabase init blows up - log and degrade.
    // eslint-disable-next-line no-console
    console.warn('[supabase] init failed, running local-only:', e);
    _client = null;
    return null;
  }
}

/**
 * True when the Supabase client successfully initialised. Cheap to call -
 * triggers initialisation on first call, then memoised.
 */
export function isCloudSyncConfigured(): boolean {
  return getSupabaseClient() !== null;
}

/**
 * Clear the cached client. Useful when the user wires up env vars at runtime
 * (e.g. through a settings panel) and wants to re-initialise without a
 * full app reload. Consumers should call `getSupabaseClient()` again
 * afterwards.
 */
export function resetSupabaseClient(): void {
  _client = undefined;
}
