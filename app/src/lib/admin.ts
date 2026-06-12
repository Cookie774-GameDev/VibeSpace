import { useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/auth';
import { isAdminIdentity } from '@/lib/entitlements';
import { getSupabaseClient } from '@/lib/supabase';

let cloudAdminCache: { userId: string; value: boolean } | null = null;

/** Supabase `app_admins` row for the signed-in user (server-side list). */
export async function fetchCloudAdminStatus(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  if (cloudAdminCache?.userId === userId) return cloudAdminCache.value;

  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { data, error } = await client.rpc('is_app_admin', { p_user_id: userId });
    const value = !error && Boolean(data);
    cloudAdminCache = { userId, value };
    return value;
  } catch {
    return false;
  }
}

export function clearCloudAdminCache(): void {
  cloudAdminCache = null;
}

export function useAppAdmin(): boolean {
  const email = useAuthStore((s) => s.email);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email);
  const cloudUserId = useAuthStore((s) => s.cloudSession?.user_id);
  const localUserId = useAuthStore((s) => s.localUserId);
  const localAdmin = isAdminIdentity({ email, cloudEmail, localUserId });
  const [cloudAdmin, setCloudAdmin] = useState(false);

  useEffect(() => {
    if (localAdmin) {
      setCloudAdmin(false);
      return;
    }
    if (!cloudUserId) {
      setCloudAdmin(false);
      return;
    }
    void fetchCloudAdminStatus(cloudUserId).then(setCloudAdmin);
  }, [localAdmin, cloudUserId]);

  return localAdmin || cloudAdmin;
}
