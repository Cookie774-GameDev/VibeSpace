import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({ functions: { invoke } }),
}));

import {
  getAccountTelemetryConsent,
  updateAccountTelemetryConsent,
} from './accountTelemetryConsent';

const response = {
  enabled: false,
  eligible: false,
  policyVersion: 'telemetry-reward-2026-08-03',
  noticeUrl: 'https://vibespaceos.com/privacy/financial-incentive',
  discountPercent: 10,
  requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
} as const;

describe('account telemetry consent', () => {
  beforeEach(() => invoke.mockReset());

  it('reads authoritative account state without assuming eligibility', async () => {
    invoke.mockResolvedValue({ data: response, error: null });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({ ok: true, state: response });
    expect(invoke).toHaveBeenCalledWith('telemetry-consent', { method: 'GET' });
  });

  it('sends the exact disclosed classes only when enrolling', async () => {
    invoke.mockResolvedValue({ data: { ...response, enabled: true, eligible: true }, error: null });
    await updateAccountTelemetryConsent(true, response);
    expect(invoke).toHaveBeenCalledWith('telemetry-consent', {
      method: 'PUT',
      body: {
        enabled: true,
        policyVersion: response.policyVersion,
        dataClasses: response.requiredDataClasses,
      },
    });
  });

  it('withdraws with no enabled classes and fails closed on malformed state', async () => {
    invoke
      .mockResolvedValueOnce({ data: response, error: null })
      .mockResolvedValueOnce({ data: { ...response, discountPercent: 9 }, error: null });
    await updateAccountTelemetryConsent(false, response);
    expect(invoke).toHaveBeenNthCalledWith(1, 'telemetry-consent', {
      method: 'PUT',
      body: { enabled: false, policyVersion: response.policyVersion, dataClasses: [] },
    });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({
      ok: false,
      error: 'invalid_server_response',
    });
  });
});
