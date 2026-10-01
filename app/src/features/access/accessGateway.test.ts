import { describe, expect, it, vi } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import {
  AccessGatewayError,
  createAccessGateway,
  type AccessGatewayTransport,
  type AccessServerSnapshot,
  type AppAccessServerStatus,
} from './accessGateway';

const APP_VERSION = '1.5.0';
const SERVER_TIME = '2026-07-28T16:00:00Z';
const PERIOD_END = '2026-08-28T16:00:00Z';

const ACTIVE_RESPONSE = Object.freeze({
  status: 'active',
  enabled: true,
  serverTime: SERVER_TIME,
  currentPeriodEndsAt: PERIOD_END,
  daysRemaining: 31,
  canUseApp: true,
  canEdit: true,
  canExport: true,
  requiresCheckout: false,
});

function responseFor(status: AppAccessServerStatus): Record<string, unknown> {
  const common = {
    status,
    enabled: true,
    serverTime: SERVER_TIME,
    canExport: true,
  };
  switch (status) {
    case 'prelaunch':
      return {
        ...common,
        enabled: false,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: false,
      };
    case 'trialing':
      return {
        ...common,
        trialEndsAt: PERIOD_END,
        daysRemaining: 30,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: true,
        checkoutReason: 'trial_will_convert',
      };
    case 'active':
      return { ...ACTIVE_RESPONSE };
    case 'cancel_at_period_end':
      return {
        ...common,
        currentPeriodEndsAt: PERIOD_END,
        daysRemaining: 31,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: false,
      };
    case 'past_due':
      return {
        ...common,
        currentPeriodEndsAt: PERIOD_END,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: true,
        checkoutReason: 'payment_failed',
      };
    case 'grace':
      return {
        ...common,
        graceEndsAt: PERIOD_END,
        daysRemaining: 3,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: true,
        checkoutReason: 'grace_period',
      };
    case 'locked':
      return {
        ...common,
        canUseApp: false,
        canEdit: false,
        requiresCheckout: true,
        checkoutReason: 'access_locked',
      };
    case 'admin':
    case 'internal':
      return {
        ...common,
        canUseApp: true,
        canEdit: true,
        requiresCheckout: false,
      };
    case 'unknown':
      return {
        ...common,
        canUseApp: false,
        canEdit: false,
        requiresCheckout: false,
      };
  }
}

function makeTransport(overrides: Partial<AccessGatewayTransport> = {}): AccessGatewayTransport {
  return Object.freeze({
    rpc: vi.fn().mockResolvedValue({ data: ACTIVE_RESPONSE, error: null }),
    invokeFunction: vi.fn().mockImplementation((functionName: string) =>
      Promise.resolve({
        data: {
          url:
            functionName === 'create-access-portal'
              ? 'https://billing.stripe.com/p/session'
              : 'https://checkout.stripe.com/c/pay/session',
        },
        error: null,
      }),
    ),
    ...overrides,
  });
}

function makeGateway(overrides: Partial<AccessGatewayTransport> = {}) {
  const transport = makeTransport(overrides);
  return {
    transport,
    gateway: createAccessGateway({ transport, appVersion: APP_VERSION }),
  };
}

describe('authoritative status RPC contract', () => {
  it('calls get_app_access with only the app version and separate transport options', async () => {
    const { gateway, transport } = makeGateway();

    const snapshot = await gateway.checkAccess();

    expect(transport.rpc).toHaveBeenCalledWith(
      'get_app_access',
      { p_app_version: APP_VERSION },
      { signal: undefined },
    );
    expect(snapshot).toEqual({
      status: 'active',
      enabled: true,
      serverTime: SERVER_TIME,
      trialEndsAt: null,
      currentPeriodEndsAt: PERIOD_END,
      graceEndsAt: null,
      daysRemaining: 31,
      canUseApp: true,
      canEdit: true,
      canExport: true,
      requiresCheckout: false,
      checkoutReason: null,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('accepts and freezes every server status with its valid capability shape', async () => {
    const statuses: readonly AppAccessServerStatus[] = [
      'prelaunch',
      'trialing',
      'active',
      'cancel_at_period_end',
      'past_due',
      'grace',
      'locked',
      'admin',
      'internal',
      'unknown',
    ];
    for (const status of statuses) {
      const { gateway } = makeGateway({
        rpc: vi.fn().mockResolvedValue({ data: responseFor(status), error: null }),
      });
      const snapshot: AccessServerSnapshot = await gateway.checkAccess();
      expect(snapshot.status).toBe(status);
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
  });

  it('normalizes stripped optional JSON fields to null', async () => {
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data: responseFor('admin'), error: null }),
    });
    const snapshot = await gateway.checkAccess();
    expect(snapshot.trialEndsAt).toBeNull();
    expect(snapshot.currentPeriodEndsAt).toBeNull();
    expect(snapshot.graceEndsAt).toBeNull();
    expect(snapshot.daysRemaining).toBeNull();
    expect(snapshot.checkoutReason).toBeNull();
  });

  it('accepts the verified-account lock reason returned before entitlement creation', async () => {
    const data = {
      ...responseFor('locked'),
      checkoutReason: 'account_verification_required',
      requiresCheckout: false,
    };
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data, error: null }),
    });
    await expect(gateway.checkAccess()).resolves.toMatchObject({
      status: 'locked',
      checkoutReason: 'account_verification_required',
      requiresCheckout: false,
    });
  });
});

describe('status response validation', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['empty object', {}],
    ['unknown status', { ...ACTIVE_RESPONSE, status: 'ended' }],
    ['missing serverTime', { ...ACTIVE_RESPONSE, serverTime: undefined }],
    ['invalid serverTime', { ...ACTIVE_RESPONSE, serverTime: 'tomorrow' }],
    ['impossible calendar timestamp', { ...ACTIVE_RESPONSE, serverTime: '2026-02-30T16:00:00Z' }],
    ['non-boolean enabled', { ...ACTIVE_RESPONSE, enabled: 'yes' }],
    ['non-boolean canUseApp', { ...ACTIVE_RESPONSE, canUseApp: 1 }],
    ['negative days', { ...ACTIVE_RESPONSE, daysRemaining: -1 }],
    ['fractional days', { ...ACTIVE_RESPONSE, daysRemaining: 1.5 }],
    ['oversized days', { ...ACTIVE_RESPONSE, daysRemaining: 36_501 }],
    ['unknown reason', { ...ACTIVE_RESPONSE, checkoutReason: 'trust_the_client' }],
  ])('rejects %s fail closed', async (_label, data) => {
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data, error: null }),
    });
    await expect(gateway.checkAccess()).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it.each([
    ['active cannot deny use', { ...ACTIVE_RESPONSE, canUseApp: false }],
    ['active cannot require checkout', { ...ACTIVE_RESPONSE, requiresCheckout: true }],
    ['locked cannot grant edits', { ...responseFor('locked'), canEdit: true }],
    ['unknown cannot grant use', { ...responseFor('unknown'), canUseApp: true }],
    ['data export is never disabled', { ...responseFor('locked'), canExport: false }],
    ['trial requires its end', { ...responseFor('trialing'), trialEndsAt: undefined }],
    ['active requires its period end', { ...ACTIVE_RESPONSE, currentPeriodEndsAt: undefined }],
    ['grace requires its end', { ...responseFor('grace'), graceEndsAt: undefined }],
    [
      'checkout reason must match state',
      { ...responseFor('grace'), checkoutReason: 'payment_failed' },
    ],
  ])('rejects inconsistent authority: %s', async (_label, data) => {
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data, error: null }),
    });
    await expect(gateway.checkAccess()).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('copies only known fields without freezing or traversing caller-owned extras', async () => {
    const data = { ...ACTIVE_RESPONSE } as Record<string, unknown>;
    data.untrustedCycle = data;
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data, error: null }),
    });

    const snapshot = await gateway.checkAccess();

    expect(snapshot).not.toBe(data);
    expect(snapshot).not.toHaveProperty('untrustedCycle');
    expect(Object.isFrozen(data)).toBe(false);
  });
});

describe('transport errors and cancellation', () => {
  it('categorizes returned and thrown RPC failures', async () => {
    const returned = makeGateway({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'JWT expired' } }),
    });
    await expect(returned.gateway.checkAccess()).rejects.toMatchObject({ code: 'rpc_error' });

    const thrown = makeGateway({
      rpc: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });
    await expect(thrown.gateway.checkAccess()).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('rejects a malformed transport envelope with a stable RPC error', async () => {
    const { gateway } = makeGateway({
      rpc: vi.fn().mockResolvedValue(null),
    });
    await expect(gateway.checkAccess()).rejects.toMatchObject({
      code: 'rpc_error',
      message: 'The access service returned an invalid transport response.',
    });
  });

  it('redacts secret-shaped material from transport errors', async () => {
    const secret = syntheticCredentialFixture('sk_live_', 'abc123def456ghi789jkl012mno345pqr678');
    const { gateway } = makeGateway({
      rpc: vi.fn().mockRejectedValue(new Error(`provider failed with ${secret}`)),
    });
    await expect(gateway.checkAccess()).rejects.toMatchObject({
      code: 'rpc_error',
      message: 'The access service returned an error.',
    });
  });

  it('passes AbortSignal separately and rejects an already-aborted request', async () => {
    const { gateway, transport } = makeGateway();
    const controller = new AbortController();
    await gateway.checkAccess(controller.signal);
    expect(transport.rpc).toHaveBeenCalledWith(
      'get_app_access',
      { p_app_version: APP_VERSION },
      { signal: controller.signal },
    );

    controller.abort();
    await expect(gateway.checkAccess(controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(transport.rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects promptly when a transport ignores an in-flight abort', async () => {
    let resolveRpc!: (value: { data: unknown; error: unknown }) => void;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => {
      resolveRpc = resolve;
    });
    const { gateway } = makeGateway({ rpc: vi.fn().mockReturnValue(pending) });
    const controller = new AbortController();

    const request = gateway.checkAccess(controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'aborted' });

    resolveRpc({ data: ACTIVE_RESPONSE, error: null });
    await Promise.resolve();
  });
});

describe('billing URL functions', () => {
  it.each([
    ['checkout', 'create-access-checkout', 'https://checkout.stripe.com/c/pay/session'],
    ['portal', 'create-access-portal', 'https://billing.stripe.com/p/session'],
  ])(
    'invokes the %s function with an authority-free body',
    async (kind, functionName, expectedUrl) => {
      const { gateway, transport } = makeGateway();
      const result =
        kind === 'checkout' ? await gateway.createCheckoutUrl() : await gateway.createPortalUrl();
      expect(transport.invokeFunction).toHaveBeenCalledWith(functionName, {
        body: {},
        signal: undefined,
      });
      expect(result).toEqual({ url: expectedUrl });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each([
    'http://billing.example/session',
    'javascript:alert(1)',
    'https://user:password@billing.example/session',
    'https://',
    '',
  ])('rejects unsafe billing URL %s', async (url) => {
    const { gateway } = makeGateway({
      invokeFunction: vi.fn().mockResolvedValue({ data: { url }, error: null }),
    });
    await expect(gateway.createCheckoutUrl()).rejects.toMatchObject({ code: 'insecure_url' });
  });

  it.each([
    ['checkout', 'https://billing.stripe.com/p/session'],
    ['checkout', 'https://checkout.stripe.com.evil.example/session'],
    ['portal', 'https://checkout.stripe.com/c/pay/session'],
    ['portal', 'https://billing.stripe.com.evil.example/session'],
  ])('rejects an unexpected %s host', async (kind, url) => {
    const { gateway } = makeGateway({
      invokeFunction: vi.fn().mockResolvedValue({ data: { url }, error: null }),
    });
    const request = kind === 'checkout' ? gateway.createCheckoutUrl() : gateway.createPortalUrl();
    await expect(request).rejects.toMatchObject({ code: 'insecure_url' });
  });

  it('categorizes function failures and redacts secrets', async () => {
    const { gateway } = makeGateway({
      invokeFunction: vi
        .fn()
        .mockRejectedValue(new Error('Bearer abcdefghijklmnopqrstuvwxyz0123456789')),
    });
    await expect(gateway.createPortalUrl()).rejects.toMatchObject({
      code: 'function_error',
      message: 'The access service returned an error.',
    });
  });

  it('never sends client billing or redirect authority', async () => {
    const { gateway, transport } = makeGateway();
    await gateway.createCheckoutUrl();
    const body = (transport.invokeFunction as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(body).toEqual({});
    expect(JSON.stringify(body)).not.toMatch(
      /price|amount|customer|user|tier|plan|success|cancel|return/iu,
    );
  });
});

describe('gateway configuration and boundaries', () => {
  it.each(['', ' 1.5.0', '1.5.0 ', 'x'.repeat(129)])(
    'rejects invalid app version %j before transport use',
    (appVersion) => {
      expect(() => createAccessGateway({ transport: makeTransport(), appVersion })).toThrowError(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    },
  );

  it('does not import or recompute access policy decisions', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'accessGateway.ts'), 'utf-8');
    expect(source).not.toContain('evaluateAppAccess');
    expect(source).not.toContain("from './accessPolicy'");
    expect(source).not.toContain('expectedUserId');
    expect(source).not.toContain('get_current_access');
  });

  it('performs a fresh RPC for every explicit check', async () => {
    const { gateway, transport } = makeGateway();
    await gateway.checkAccess();
    await gateway.checkAccess();
    expect(transport.rpc).toHaveBeenCalledTimes(2);
  });

  it('exposes stable typed errors', () => {
    const error = new AccessGatewayError('malformed_response', 'bad response');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'AccessGatewayError',
      code: 'malformed_response',
      message: 'bad response',
    });
  });
});
