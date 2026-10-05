import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const session = vi.fn();
const user = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({
    functions: { invoke },
    auth: { getSession: session, getUser: user },
  }),
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
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    invoke.mockReset();
    session.mockReset();
    user.mockReset();
  });

  it('never sends a saved withdrawal using a different signed-in account', async () => {
    session.mockResolvedValue({
      data: { session: { user: { id: 'b' }, access_token: 'test-token-b' } },
      error: null,
    });
    await expect(updateAccountTelemetryConsent(false, response, 'a')).resolves.toEqual({
      ok: false,
      error: 'account_changed',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('pins the verified account token for the request', async () => {
    session.mockResolvedValue({
      data: { session: { user: { id: 'a' }, access_token: 'test-token-a' } },
      error: null,
    });
    user.mockResolvedValue({ data: { user: { id: 'a' } }, error: null });
    invoke.mockResolvedValue({ data: response, error: null });
    await updateAccountTelemetryConsent(false, response, 'a');
    expect(user).toHaveBeenCalledWith('test-token-a');
    expect(invoke).toHaveBeenCalledWith(
      'telemetry-consent',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token-a' } }),
    );
  });

  it('reads authoritative account state without assuming eligibility', async () => {
    invoke.mockResolvedValue({ data: response, error: null });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({ ok: true, state: response });
    expect(invoke).toHaveBeenCalledWith('telemetry-consent', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('preserves the known service configuration error without exposing response details', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        context: new Response(
          JSON.stringify({
            error: 'telemetry_reward_unconfigured',
            internal: 'must never be returned',
          }),
          { status: 503 },
        ),
      },
    });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({
      ok: false,
      error: 'telemetry_reward_unconfigured',
    });
  });

  it.each([
    [503, '{invalid json'],
    [503, JSON.stringify({ error: 'private_server_detail' })],
    [401, JSON.stringify({ error: 'telemetry_reward_unconfigured' })],
  ])('keeps other HTTP errors generic (%s)', async (status, body) => {
    invoke.mockResolvedValue({ data: null, error: { context: new Response(body, { status }) } });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({
      ok: false,
      error: 'request_failed',
    });
  });

  it('sends the exact disclosed classes only when enrolling', async () => {
    invoke.mockResolvedValue({ data: { ...response, enabled: true, eligible: true }, error: null });
    await updateAccountTelemetryConsent(true, response);
    expect(invoke).toHaveBeenCalledWith('telemetry-consent', {
      method: 'PUT',
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
      body: { enabled: false, policyVersion: response.policyVersion, dataClasses: [] },
    });
    await expect(getAccountTelemetryConsent()).resolves.toEqual({
      ok: false,
      error: 'invalid_server_response',
    });
  });

  it('releases a stalled consent request and prevents late authentication from sending it', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    session.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = getAccountTelemetryConsent('a');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({ ok: false, error: 'request_timeout' });
    finish({ data: { session: { user: { id: 'a' }, access_token: 'test-token-a' } }, error: null });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });
});
