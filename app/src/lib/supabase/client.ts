/**
 * Typed Supabase client for the VibeSpace Cloud tier.
 *
 * Wraps the existing untyped singleton in `@/lib/supabase` so the auth
 * session, storage adapter, and headers stay in one place. Adding a second
 * `createClient` with the same URL/key would split auth state across two
 * in-memory instances.
 *
 * Usage:
 *   import { getSupabaseClient } from '@/lib/supabase/client';
 *   const client = getSupabaseClient();
 *   if (!client) return; // hosted tier not configured
 *   const { data } = await client.from('profiles').select('*').single();
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getSupabaseClient as getRawSupabaseClient,
  isCloudSyncConfigured,
  resetSupabaseClient,
} from '@/lib/supabase';
import type { Database } from './types';

export type TypedSupabaseClient = SupabaseClient<Database>;

/**
 * Return the shared Supabase client typed against the hosted-tier schema,
 * or `null` if env vars aren't wired. Never throws.
 */
export function getSupabaseClient(): TypedSupabaseClient | null {
  return getRawSupabaseClient() as TypedSupabaseClient | null;
}

export { isCloudSyncConfigured, resetSupabaseClient };
export type { Database } from './types';
