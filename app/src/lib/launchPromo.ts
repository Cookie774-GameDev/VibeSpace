/**
 * Launch promo claim trigger (client side).
 *
 * Calls the `claim-launch-promo` Edge Function once per signed-in session. The
 * function is idempotent and fully guarded server-side (slot caps, verified
 * email, pool budget, 7-day expiry — migration 0023), so this is a safe
 * fire-and-forget. While the promo is not yet launched it simply returns
 * `promo_inactive` and does nothing.
 */

const attempted = new Set<string>();

export async function claimLaunchPromo(userId: string | null | undefined): Promise<void> {
  if (!userId || attempted.has(userId)) return;
  attempted.add(userId);
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const client = getSupabaseClient();
    if (!client) return;
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    const url = import.meta.env.VITE_SUPABASE_URL;
    if (!token || !url) return;
    await fetch(`${url}/functions/v1/claim-launch-promo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Promo claim is best-effort; never block app boot.
    attempted.delete(userId);
  }
}
