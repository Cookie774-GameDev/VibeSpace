import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({ rpc }),
}));

import { clearEntitlementsCache, fetchMyEntitlements } from './entitlements';

describe('fetchMyEntitlements', () => {
  beforeEach(() => {
    rpc.mockReset();
    clearEntitlementsCache();
  });

  it('uses the own-user RPC without a client-controlled user id', async () => {
    rpc.mockResolvedValue({
      data: [{
        user_id: 'user-a',
        plan: 'starter',
        is_admin: false,
        cloud_sync_allowed: true,
        message_credits: 1485,
        call_minutes: 14,
        sms_count: 41,
      }],
      error: null,
    });

    await expect(fetchMyEntitlements('user-a')).resolves.toMatchObject({
      userId: 'user-a',
      plan: 'starter',
      isAdmin: false,
      cloudSyncAllowed: true,
    });
    expect(rpc).toHaveBeenCalledWith('get_my_entitlements');
  });

  it('fails closed when the RPC returns another identity', async () => {
    rpc.mockResolvedValue({
      data: [{ user_id: 'user-b', plan: 'apex', is_admin: true, cloud_sync_allowed: true }],
      error: null,
    });

    await expect(fetchMyEntitlements('user-a')).resolves.toBeNull();
  });

  it('fails closed on database errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });

    await expect(fetchMyEntitlements('user-a')).resolves.toBeNull();
  });
});
