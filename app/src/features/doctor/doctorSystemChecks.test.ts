import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runDefaultDoctorSystemChecks,
  runDoctorSystemChecks,
  withDoctorDeadline,
} from './doctorSystemChecks';

const cloud = vi.hoisted(() => ({
  client: vi.fn(),
  session: vi.fn(),
  user: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  invoke: vi.fn(),
  phone: vi.fn(),
  privacy: vi.fn(),
  learning: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: cloud.client }));
vi.mock('@/features/telemetry/telemetryConsent', () => ({ telemetryConsentStore: { getSnapshot: cloud.privacy } }));
vi.mock('@/features/jarvis-memory/learningStore', () => ({
  useJarvisLearningStore: { getState: cloud.learning },
}));
vi.mock('@/features/call/config', () => ({
  callCloudUrl: () => '',
  checkCallCloudReadiness: cloud.phone,
}));

describe('Doctor production system wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const query = {
      eq: cloud.eq,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null, count: 1 }).then(resolve),
    };
    cloud.eq.mockReturnValue(query);
    cloud.select.mockReturnValue(query);
    cloud.from.mockReturnValue({ select: cloud.select });
    cloud.session.mockResolvedValue({
      data: { session: { user: { id: 'account-a' } } },
      error: null,
    });
    cloud.user.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    cloud.invoke.mockImplementation(async (name: string) => ({
      error: null,
      data: name === 'third-party-call' ? { schedules: [] } : { company_messaging_available: true },
    }));
    cloud.client.mockReturnValue({
      auth: { getSession: cloud.session, getUser: cloud.user },
      from: cloud.from,
      functions: { invoke: cloud.invoke },
    });
    cloud.phone.mockResolvedValue({ state: 'missing' });
    cloud.privacy.mockReturnValue({ consent: { productUsage: false, diagnostics: false, toolOutcomes: false } });
    cloud.learning.mockReturnValue({
      activeAccountId: 'account-a',
      profiles: { 'account-a': { accountId: 'account-a', enabled: false } },
      lastError: null,
    });
  });

  it('reports canonical per-class telemetry consent', async () => {
    cloud.privacy.mockReturnValue({ consent: { productUsage: true, diagnostics: false, toolOutcomes: true } });
    const checks = await runDefaultDoctorSystemChecks();
    expect(checks.find((check) => check.label === 'Privacy')?.detail).toContain('2 of 3 classes enabled');
  });

  it('uses only account-scoped metadata reads and never claims delivery or restore', async () => {
    const checks = await runDefaultDoctorSystemChecks();
    expect(cloud.user).toHaveBeenCalledOnce();
    expect(cloud.select).toHaveBeenCalledWith('row_id', { count: 'exact', head: true });
    expect(cloud.eq.mock.calls).toEqual([
      ['user_id', 'account-a'],
      ['table_name', 'encrypted_workspace_backup_v1'],
      ['row_id', 'latest'],
    ]);
    expect(cloud.invoke.mock.calls).toEqual(
      expect.arrayContaining([
        ['third-party-call', { body: { action: 'list-scheduled' } }],
        ['get-message-usage', { method: 'GET' }],
      ]),
    );
    expect(cloud.invoke).toHaveBeenCalledTimes(2);
    expect(checks.find((check) => check.label === 'Encrypted cloud backup')?.detail).toContain(
      'Upload and restore not exercised',
    );
    expect(checks.find((check) => check.label === 'Calls / phone messaging')?.ok).toBe(false);
    expect(checks.find((check) => check.label === 'Privacy')?.detail).toContain('disabled');
  });

  it('does not query cloud data or services when signed out', async () => {
    cloud.session.mockResolvedValue({ data: { session: null }, error: null });
    const checks = await runDefaultDoctorSystemChecks();
    expect(cloud.user).not.toHaveBeenCalled();
    expect(cloud.from).not.toHaveBeenCalled();
    expect(cloud.invoke).not.toHaveBeenCalled();
    expect(checks.find((check) => check.label === 'Cloud account')?.ok).toBe(false);
  });

  it('rejects mismatched session identity without exposing private errors', async () => {
    cloud.user.mockResolvedValue({ data: { user: { id: 'account-b' } }, error: null });
    const checks = await runDefaultDoctorSystemChecks();
    expect(cloud.from).not.toHaveBeenCalled();
    expect(cloud.invoke).not.toHaveBeenCalled();
    expect(checks.find((check) => check.label === 'Cloud account')?.ok).toBe(false);
    expect(checks.find((check) => check.label === 'Privacy')?.ok).toBe(true);
  });

  it('reports a session read error as unverified rather than signed out', async () => {
    cloud.session.mockResolvedValue({
      data: { session: null },
      error: new Error('private auth details'),
    });
    const checks = await runDefaultDoctorSystemChecks();
    expect(checks.find((check) => check.label === 'Cloud account')?.detail).toBe(
      'Check failed; readiness remains unverified',
    );
    expect(cloud.invoke).not.toHaveBeenCalled();
  });

  it('reports missing service deployment without suppressing independent checks', async () => {
    cloud.invoke.mockResolvedValue({ error: new Error('private deployment details'), data: null });
    const checks = await runDefaultDoctorSystemChecks();
    expect(checks.find((check) => check.label === 'Call Anyone service')?.ok).toBe(false);
    expect(checks.find((check) => check.label === 'Message service')?.ok).toBe(false);
    expect(checks.find((check) => check.label === 'Encrypted cloud backup')?.ok).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('private deployment details');
  });

  it('reports incomplete transports and unavailable messaging credits accurately', async () => {
    cloud.phone.mockResolvedValue({
      state: 'partial',
      transports: { livekit: true, telnyx: false, callAnyone: false, supabase: true },
    });
    cloud.invoke.mockResolvedValue({ error: null, data: { company_messaging_available: false } });
    const checks = await runDefaultDoctorSystemChecks();
    expect(checks.find((check) => check.label === 'Calls / phone messaging')?.detail).toContain(
      'telnyx, callAnyone',
    );
    expect(checks.find((check) => check.label === 'Message service')?.ok).toBe(false);
  });
});

describe('Doctor subsystem isolation', () => {
  it('checks every supplied system and hides private failure details', async () => {
    const checks = await runDoctorSystemChecks([
      { label: 'Account', run: async () => 'Session verified' },
      {
        label: 'Calls',
        run: async () => {
          throw new Error('secret provider token');
        },
      },
      { label: 'Privacy', run: async () => 'Telemetry disabled' },
    ]);
    expect(checks.map((check) => [check.label, check.ok])).toEqual([
      ['Account', true],
      ['Calls', false],
      ['Privacy', true],
    ]);
    expect(JSON.stringify(checks)).not.toContain('secret provider token');
  });

  it('finishes a stuck read-only check without blocking the other systems', async () => {
    vi.useFakeTimers();
    try {
      const pending = runDoctorSystemChecks(
        [
          { label: 'Account', run: () => new Promise<string>(() => {}) },
          { label: 'Privacy', run: async () => 'Readable' },
        ],
        50,
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toEqual([
        { label: 'Account', ok: false, detail: 'Check timed out; readiness remains unverified' },
        { label: 'Privacy', ok: true, detail: 'Readable' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up deadlines when the operation completes', async () => {
    vi.useFakeTimers();
    try {
      expect(await withDoctorDeadline(() => Promise.resolve('ready'), 50)).toBe('ready');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
