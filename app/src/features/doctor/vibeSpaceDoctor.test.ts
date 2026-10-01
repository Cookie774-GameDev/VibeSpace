import { describe, expect, it, vi } from 'vitest';
import type { DevLogEntry } from '@/features/dev-console';
// These orchestration tests inject every backend. Do not initialize the real
// app's provider/context graph just to exercise the diagnostic decisions.
vi.mock('@/lib/db', () => ({ db: {}, terminalSessionRepo: {} }));
vi.mock('@/lib/harness/runtimeManager', () => ({ harnessRuntimeManager: {} }));
vi.mock('@/lib/harness/codexRuntimeManager', () => ({ codexRuntimeManager: {} }));
vi.mock('@/lib/doctor/storageDoctor', () => ({ runStorageDoctor: vi.fn() }));
vi.mock('@/features/skills', () => ({ getAllCatalogSkills: vi.fn() }));
vi.mock('@/features/token-optimizer', () => ({ browserTokenOptimizationPreferences: {} }));
vi.mock('@/stores/agents', () => ({ useAgentStore: {} }));
vi.mock('@/stores/auth', () => ({ useAuthStore: {} }));
vi.mock('@/lib/ai/adapters/autoDetectConnections', () => ({
  refreshExternalConnectionAutoDetection: vi.fn(),
}));
vi.mock('@/lib/harness/toolGatewayProduction', () => ({
  installToolGatewayRlmContextPort: vi.fn(),
}));
vi.mock('@/features/context/contextRlmProduction', () => ({ productionRlmContextTool: {} }));
vi.mock('@/features/context/siyuanRlmProduction', () => ({ getProductionSiyuanRlmPort: vi.fn() }));
vi.mock('@/features/dev-console/store', () => ({ useDevConsoleStore: {} }));
vi.mock('./playwrightFeaturePackBridge', () => ({
  runDefaultPlaywrightFeaturePackDoctorCheck: vi.fn(),
}));
import {
  collectRecentDoctorHealthSignals,
  createVibeSpaceDoctorRunner,
  refreshDoctorContextBindings,
  runVibeSpaceDoctorWithDependencies,
  summarizeOpenCodeProviderRecord,
  summarizeCodexRuntime,
  type VibeSpaceDoctorDependencies,
} from './vibeSpaceDoctor';

function dependencies(
  overrides: Partial<VibeSpaceDoctorDependencies> = {},
): VibeSpaceDoctorDependencies {
  return {
    nativeRuntime: true,
    runStorage: vi.fn().mockResolvedValue({ code: 'healthy', attempts: 1 }),
    refreshOpenCode: vi.fn().mockResolvedValue(undefined),
    repairOpenCode: vi.fn().mockResolvedValue(undefined),
    getOpenCodeState: vi
      .fn()
      .mockReturnValue({ kind: 'ready', source: 'system', version: '1.18.21' }),
    getOpenCodeConnection: vi.fn().mockReturnValue({
      source: 'system',
      version: '1.18.21',
      generation: 'opencode-server-test',
    }),
    waitForOpenCodeSettled: vi.fn().mockResolvedValue(undefined),
    inspectCodexRuntime: vi.fn().mockResolvedValue({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-test',
    }),
    repairCodexRuntime: vi.fn().mockResolvedValue({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-test',
    }),
    refreshOpenCodeProvider: vi
      .fn()
      .mockResolvedValue({ label: 'OpenCode provider', ok: true, detail: 'Authenticated' }),
    refreshContextBindings: vi.fn().mockResolvedValue([
      { label: 'RLM', ok: true, detail: 'Tool binding refreshed' },
      { label: 'SiYuan', ok: true, detail: 'Read-only transport probe passed' },
    ]),
    checkPlaywrightFeaturePack: vi.fn().mockResolvedValue({
      label: 'Playwright acceptance runtime',
      ok: true,
      detail: 'Ready · Playwright 1.61.1 · Chromium 1234567',
    }),
    readRecentHealthSignals: vi.fn().mockReturnValue([]),
    captureProtectedRouteState: vi.fn().mockReturnValue('exact-route-state'),
    runAdditionalChecks: vi.fn().mockResolvedValue([]),
    now: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

describe('VibeSpace slash Doctor', () => {
  it('overlaps independent stages without losing diagnostics or repairs', async () => {
    vi.useFakeTimers();
    try {
      const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 100));
      const deps = dependencies({
        runStorage: vi.fn(() => delay({ code: 'healthy', attempts: 1 } as const)),
        inspectCodexRuntime: vi.fn(() => delay({ kind: 'missing' } as const)),
        repairCodexRuntime: vi.fn(() => delay({ kind: 'ready', codexVersion: 'test', openCodexVersion: 'test', executableId: 'test' } as const)),
        refreshOpenCode: vi.fn(() => delay(undefined)),
        refreshOpenCodeProvider: vi.fn(() => delay({ label: 'OpenCode provider', ok: true, detail: 'Authenticated' })),
        checkPlaywrightFeaturePack: vi.fn(() => delay({ label: 'Playwright acceptance runtime', ok: true, detail: 'Ready' })),
        runAdditionalChecks: vi.fn(() => delay([{ label: 'Cloud account', ok: false, detail: 'Signed out' }])),
      });
      const pending = runVibeSpaceDoctorWithDependencies(deps);
      await vi.advanceTimersByTimeAsync(250);
      expect(deps.runAdditionalChecks).toHaveBeenCalledOnce();
      expect(deps.refreshContextBindings).toHaveBeenCalledOnce();
      expect(deps.repairCodexRuntime).toHaveBeenCalledOnce();
      const report = await pending;
      expect(report.ok).toBe(false);
      expect(report.text).toContain('Cloud account — Signed out');
      expect(report.text).toContain('Codex tools — Ready');
      expect(report.text).toContain('Route controls — Unchanged');
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares concurrent requests and allows a fresh check after completion', async () => {
    let finish!: (value: { code: 'healthy'; attempts: 1 }) => void;
    const deps = dependencies({
      runStorage: vi.fn(
        () =>
          new Promise<{ code: 'healthy'; attempts: 1 }>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const run = createVibeSpaceDoctorRunner(deps);
    const first = run();
    expect(run()).toBe(first);
    await Promise.resolve();
    finish({ code: 'healthy', attempts: 1 });
    await first;
    expect(deps.runStorage).toHaveBeenCalledTimes(1);
    const second = run();
    expect(second).not.toBe(first);
    await Promise.resolve();
    finish({ code: 'healthy', attempts: 1 });
    await second;
    expect(deps.runStorage).toHaveBeenCalledTimes(2);
  });

  it('shares progress while isolating a failing observer and reports every stage', async () => {
    const good = vi.fn();
    const run = createVibeSpaceDoctorRunner(dependencies());
    const pending = run(() => { throw new Error('observer'); });
    expect(run(good)).toBe(pending);
    const report = await pending;
    expect(report.stages).toHaveLength(6);
    expect(good).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 6, total: 6 }));
    expect(report.text).toContain('Stage timings:');
  });

  it('serializes diagnosed repairs while inspections overlap', async () => {
    vi.useFakeTimers();
    try {
      let repairs = 0;
      let peak = 0;
      const repair = async () => {
        repairs++;
        peak = Math.max(peak, repairs);
        await new Promise(resolve => setTimeout(resolve, 100));
        repairs--;
      };
      const deps = dependencies({
        inspectCodexRuntime: vi.fn().mockResolvedValue({ kind: 'missing' }),
        repairCodexRuntime: vi.fn(async () => { await repair(); return { kind: 'missing' }; }),
        getOpenCodeState: vi.fn().mockReturnValue({ kind: 'missing' }),
        getOpenCodeConnection: vi.fn().mockReturnValue(undefined),
        repairOpenCode: vi.fn(repair),
      });
      const pending = runVibeSpaceDoctorWithDependencies(deps);
      await vi.advanceTimersByTimeAsync(250);
      await pending;
      expect(peak).toBe(1);
      expect(deps.repairCodexRuntime).toHaveBeenCalledOnce();
      expect(deps.repairOpenCode).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps an active installer serialized across timed-out runs sharing dependencies', async () => {
    vi.useFakeTimers();
    let releaseRepair!: () => void;
    let signalStarted!: () => void;
    const blockedRepair = new Promise<void>((resolve) => { releaseRepair = resolve; });
    const repairStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let active = 0;
    let peak = 0;
    const repairCodexRuntime = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      if (repairCodexRuntime.mock.calls.length === 1) signalStarted();
      try {
        await blockedRepair;
        return {
          kind: 'ready' as const,
          codexVersion: '0.151.0',
          openCodexVersion: '5.0.0',
          executableId: 'cli-executable-test',
        };
      } finally {
        active--;
      }
    });
    const deps = dependencies({
      inspectCodexRuntime: vi.fn().mockResolvedValue({ kind: 'missing' }),
      repairCodexRuntime,
    });

    try {
      const firstRun = runVibeSpaceDoctorWithDependencies(deps);
      await repairStarted;
      await vi.advanceTimersByTimeAsync(180_000);
      const firstReport = await firstRun;
      expect(firstReport.text).toContain('codex_runtime_repair_failed');
      expect(active).toBe(1);

      const secondRun = runVibeSpaceDoctorWithDependencies(deps);
      await vi.advanceTimersByTimeAsync(180_000);
      const secondReport = await secondRun;
      expect(secondReport.text).toContain('codex_runtime_repair_failed');

      releaseRepair();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(repairCodexRuntime).toHaveBeenCalledOnce();
      expect(peak).toBe(1);
    } finally {
      releaseRepair();
      vi.useRealTimers();
    }
  });

  it('does not start a queued repair after its queue deadline expires', async () => {
    vi.useFakeTimers();
    let releaseRepair!: () => void;
    let signalRepairStarted!: () => void;
    let signalOpenCodeInspected!: () => void;
    const blockedRepair = new Promise<void>((resolve) => { releaseRepair = resolve; });
    const repairStarted = new Promise<void>((resolve) => { signalRepairStarted = resolve; });
    const openCodeInspected = new Promise<void>((resolve) => { signalOpenCodeInspected = resolve; });
    const repairOpenCode = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      inspectCodexRuntime: vi.fn().mockResolvedValue({ kind: 'missing' }),
      repairCodexRuntime: vi.fn(async () => {
        signalRepairStarted();
        await blockedRepair;
        return {
          kind: 'ready' as const,
          codexVersion: '0.151.0',
          openCodexVersion: '5.0.0',
          executableId: 'cli-executable-test',
        };
      }),
      getOpenCodeState: vi.fn(() => {
        signalOpenCodeInspected();
        return { kind: 'missing' };
      }),
      getOpenCodeConnection: vi.fn().mockReturnValue(undefined),
      repairOpenCode,
    });

    try {
      const pending = runVibeSpaceDoctorWithDependencies(deps);
      await Promise.all([repairStarted, openCodeInspected]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(180_000);
      const report = await pending;
      expect(report.text).toContain('codex_runtime_repair_failed');
      expect(repairOpenCode).not.toHaveBeenCalled();

      releaseRepair();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(repairOpenCode).not.toHaveBeenCalled();
    } finally {
      releaseRepair();
      vi.useRealTimers();
    }
  });

  it('continues diagnostics after storage stops responding', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies({ runStorage: vi.fn(() => new Promise<never>(() => {})) });
      const pending = runVibeSpaceDoctorWithDependencies(deps);
      await vi.advanceTimersByTimeAsync(20_000);
      const report = await pending;
      expect(report.ok).toBe(false);
      expect(deps.runAdditionalChecks).toHaveBeenCalledOnce();
      expect(report.text).toContain('Route controls — Unchanged');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['checking', 'installing'] as const)(
    'does not reinstall Codex while %s',
    async (kind) => {
      const repairCodexRuntime = vi.fn();
      const report = await runVibeSpaceDoctorWithDependencies(
        dependencies({
          inspectCodexRuntime: vi.fn().mockResolvedValue({ kind }),
          repairCodexRuntime,
        }),
      );
      expect(repairCodexRuntime).not.toHaveBeenCalled();
      expect(report.ok).toBe(false);
      expect(report.text).toContain(`codex_runtime_${kind}`);
    },
  );

  it('reports an unknown Codex inspection failure without guessing that installation is broken', async () => {
    const repairCodexRuntime = vi.fn();
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        inspectCodexRuntime: vi.fn().mockRejectedValue(new Error('private token')),
        repairCodexRuntime,
      }),
    );
    expect(repairCodexRuntime).not.toHaveBeenCalled();
    expect(report.text).toContain('codex_runtime_inspection_failed');
    expect(report.text).not.toContain('private token');
  });

  it.each(['checking', 'starting', 'installing'] as const)(
    'does not replace OpenCode while %s',
    async (kind) => {
      const repairOpenCode = vi.fn();
      await runVibeSpaceDoctorWithDependencies(
        dependencies({
          getOpenCodeState: vi.fn().mockReturnValue({ kind }),
          getOpenCodeConnection: vi.fn(),
          repairOpenCode,
        }),
      );
      expect(repairOpenCode).not.toHaveBeenCalled();
    },
  );

  it('repairs a diagnosed missing managed Codex harness with the pinned installer', async () => {
    const inspectCodexRuntime = vi.fn().mockResolvedValue({ kind: 'missing' });
    const repairCodexRuntime = vi.fn().mockResolvedValue({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-repaired',
    });
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ inspectCodexRuntime, repairCodexRuntime }),
    );

    expect(inspectCodexRuntime).toHaveBeenCalledOnce();
    expect(repairCodexRuntime).toHaveBeenCalledOnce();
    expect(report.ok).toBe(true);
    expect(report.text).toContain('Codex tools — Ready · Codex 0.151.0 · OpenCodex 5.0.0');
    expect(report.text).not.toContain('explicit approval required');
    expect(
      summarizeCodexRuntime({ kind: 'incomplete', reason: 'private path' }).detail,
    ).not.toContain('private path');
  });
  it('includes truthful Playwright external prerequisites without claiming repair', async () => {
    const checkPlaywrightFeaturePack = vi.fn().mockResolvedValue({
      label: 'Playwright acceptance runtime',
      ok: false,
      detail:
        'External prerequisite required · production_trust_not_configured · production-trust-and-signed-artifact',
    });
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ checkPlaywrightFeaturePack }),
    );

    expect(checkPlaywrightFeaturePack).toHaveBeenCalledOnce();
    expect(report.ok).toBe(false);
    expect(report.text).toContain(
      'Playwright acceptance runtime — External prerequisite required · production_trust_not_configured',
    );
    expect(report.text).not.toMatch(/downloaded|installed successfully|repair succeeded/iu);
  });

  it('does not call the native Playwright bridge in browser preview', async () => {
    const checkPlaywrightFeaturePack = vi.fn();
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ nativeRuntime: false, checkPlaywrightFeaturePack }),
    );

    expect(checkPlaywrightFeaturePack).not.toHaveBeenCalled();
    expect(report.text).toContain(
      'Playwright acceptance runtime — Native check unavailable in browser preview',
    );
  });

  it('refreshes OpenCode and rebinds RLM/SiYuan without changing exact route controls', async () => {
    const refreshOpenCode = vi.fn().mockResolvedValue(undefined);
    const refreshOpenCodeProvider = vi
      .fn()
      .mockResolvedValue({ label: 'OpenCode provider', ok: true, detail: 'Authenticated' });
    const refreshContextBindings = vi.fn().mockResolvedValue([
      { label: 'RLM', ok: true, detail: 'Tool binding refreshed' },
      { label: 'SiYuan', ok: true, detail: 'Read-only transport probe passed' },
    ]);
    const captureProtectedRouteState = vi
      .fn()
      .mockReturnValueOnce('opencode-cli/model/high/quality/fast-off')
      .mockReturnValue('opencode-cli/model/high/quality/fast-off');
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        runStorage: vi.fn().mockResolvedValue({ code: 'recovered_after_retry', attempts: 2 }),
        refreshOpenCode,
        refreshOpenCodeProvider,
        refreshContextBindings,
        captureProtectedRouteState,
        runAdditionalChecks: vi.fn().mockResolvedValue([
          { label: 'Agents', ok: true, detail: 'Ready · 4 loaded' },
          { label: 'Settings', ok: true, detail: 'Readable' },
        ]),
        now: vi.fn().mockReturnValueOnce(100).mockReturnValue(450),
      }),
    );

    expect(refreshOpenCode).toHaveBeenCalledOnce();
    expect(refreshOpenCodeProvider).toHaveBeenCalledOnce();
    expect(refreshContextBindings).toHaveBeenCalledOnce();
    expect(captureProtectedRouteState).toHaveBeenCalledTimes(2);
    expect(report.ok).toBe(true);
    expect(report.text).toContain('Local chat storage — Recovered safely after 2 attempts');
    expect(report.text).toContain('OpenCode — Ready · system 1.18.21');
    expect(report.text).toContain('OpenCode provider — Authenticated');
    expect(report.text).toContain('RLM — Tool binding refreshed');
    expect(report.text).toContain('SiYuan — Read-only transport probe passed');
    expect(report.text).toContain('Route controls — Unchanged');
    expect(report.text).toContain('Completed in 350 ms');
  });

  it('force-repairs OpenCode only after refresh diagnoses the harness as unhealthy', async () => {
    const repairOpenCode = vi.fn().mockResolvedValue(undefined);
    const getOpenCodeState = vi
      .fn()
      .mockReturnValueOnce({ kind: 'download_required' })
      .mockReturnValue({ kind: 'ready', source: 'managed', version: '1.18.16' });
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        getOpenCodeState,
        getOpenCodeConnection: vi.fn().mockReturnValue({
          source: 'managed',
          version: '1.18.16',
          generation: 'opencode-server-repaired',
        }),
        repairOpenCode,
      }),
    );

    expect(repairOpenCode).toHaveBeenCalledOnce();
    expect(getOpenCodeState).toHaveBeenCalledTimes(2);
    expect(report.ok).toBe(true);
    expect(report.text).toContain('OpenCode — Ready · managed 1.18.16');
  });

  it('reports provider auth failure without downloading, changing credentials, or claiming repair', async () => {
    const captureProtectedRouteState = vi.fn().mockReturnValue('same-route');
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        refreshOpenCodeProvider: vi.fn().mockResolvedValue({
          label: 'OpenCode provider',
          ok: false,
          detail: 'Authentication required · opencode_provider_auth_required',
        }),
        captureProtectedRouteState,
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.text).toContain('opencode_provider_auth_required');
    expect(report.text).toContain('No destructive cleanup was attempted');
    expect(captureProtectedRouteState).toHaveBeenCalledTimes(2);
    expect(report.text).not.toMatch(/downloaded|credential refreshed|repaired successfully/iu);
  });

  it('does not expose raw runtime failure details or probe provider auth when the server is down', async () => {
    const refreshOpenCodeProvider = vi.fn();
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        getOpenCodeState: vi.fn().mockReturnValue({
          kind: 'failed',
          recoverable: true,
          message: 'C:\\Users\\private\\token=never-export',
        }),
        getOpenCodeConnection: vi.fn(),
        refreshOpenCodeProvider,
      }),
    );

    expect(refreshOpenCodeProvider).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    expect(report.text).toContain('OpenCode — Needs attention · opencode_runtime_failed');
    expect(report.text).not.toMatch(/private|never-export|token=/iu);
  });

  it('derives OpenCode provider health only from refreshed connection metadata', () => {
    expect(
      summarizeOpenCodeProviderRecord({
        installation: 'installed',
        auth: 'authenticated',
      }),
    ).toMatchObject({ ok: true, detail: 'Authenticated' });
    expect(
      summarizeOpenCodeProviderRecord({
        installation: 'installed',
        auth: 'authenticated',
        disabled: true,
      }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('opencode_provider_disabled') });
    expect(summarizeOpenCodeProviderRecord(undefined)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('opencode_provider_unverified'),
    });
  });

  it('rebinds RLM and cycles SiYuan with only a bounded read-only probe', async () => {
    const installRlm = vi.fn();
    const stopActive = vi.fn().mockResolvedValue(undefined);
    const searchBlocks = vi.fn().mockResolvedValue([]);
    const checks = await refreshDoctorContextBindings({
      installRlm,
      getSiyuanPort: () => ({ stopActive, searchBlocks }),
      projectId: () => 'project-safe',
      createProbeId: () => 'probe-safe',
    });

    expect(installRlm).toHaveBeenCalledOnce();
    expect(stopActive).toHaveBeenCalledOnce();
    expect(searchBlocks).toHaveBeenCalledWith('project-safe', 'vibespace-doctor-probe-safe', 1);
    expect(checks).toEqual([
      { label: 'RLM', ok: true, detail: 'Tool binding refreshed' },
      { label: 'SiYuan', ok: true, detail: 'Read-only transport probe passed' },
    ]);
  });

  it('fails closed if any exact provider/model/connection/effort/Fast state changes', async () => {
    const captureProtectedRouteState = vi
      .fn()
      .mockReturnValueOnce('opencode-cli/model/high/quality/fast-off')
      .mockReturnValue('opencode-cli/model/max/quality/fast-on');
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ captureProtectedRouteState }),
    );

    expect(report.ok).toBe(false);
    expect(report.text).toContain(
      'Route controls — Unexpected change detected · doctor_route_identity_changed',
    );
    expect(report.text).not.toContain('opencode-cli/model/max');
  });

  it('fails closed when exact route controls cannot be read before refresh', async () => {
    const captureProtectedRouteState = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('blocked');
      })
      .mockReturnValue('route-after');
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ captureProtectedRouteState }),
    );

    expect(report.ok).toBe(false);
    expect(report.text).toContain(
      'Route controls — Could not verify preservation · doctor_route_identity_unavailable',
    );
    expect(report.text).not.toContain('route-after');
  });

  it('classifies only recent redacted OpenCode/RLM/SiYuan health codes without copying content', () => {
    const now = 1_000_000;
    const entry = (
      id: number,
      message: string,
      overrides: Partial<DevLogEntry> = {},
    ): DevLogEntry => ({
      id,
      ts: now - 100,
      channel: 'ai',
      level: 'error',
      message,
      detail: { prompt: 'private prompt', body: 'private body' },
      ...overrides,
    });
    const signals = collectRecentDoctorHealthSignals(
      [
        entry(1, 'AI error @jarvis: upstream rate limit exceeded apiKey=private-value'),
        entry(2, 'Adaptive VibeSpace Context/RLM retrieval failed safely'),
        entry(3, 'SiYuan transport unavailable'),
        entry(4, 'AI error @jarvis: Unauthorized token refresh 401'),
        entry(5, 'old provider failure', { ts: now - 60 * 60 * 1000 }),
      ],
      now,
    );

    expect(signals.map((signal) => signal.detail)).toEqual([
      'Recent upstream rate limit remains unverified · opencode_upstream_rate_limited',
      'Recent RLM failure remains unverified · rlm_recent_failure',
      'Recent SiYuan failure remains unverified · siyuan_recent_failure',
      'Recent authentication failure remains unverified · opencode_provider_auth_required',
    ]);
    expect(JSON.stringify(signals)).not.toMatch(/private-value|private prompt|private body/iu);
  });

  it('fails unknown categories safely without claiming a universal repair', async () => {
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({
        runStorage: vi.fn().mockResolvedValue({
          code: 'unexpected_failure',
          attempts: 1,
          diagnosticCode: 'storage_unrecognized_failure',
        }),
        refreshOpenCode: vi.fn().mockRejectedValue(new Error('private details')),
        refreshOpenCodeProvider: vi.fn(),
        runAdditionalChecks: vi
          .fn()
          .mockResolvedValue([{ label: 'Agents', ok: false, detail: 'Check failed safely' }]),
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.text).toContain('No destructive cleanup was attempted');
    expect(report.text).toContain('storage_unrecognized_failure');
    expect(report.text).not.toContain('private details');
  });

  it('reports that native checks need the desktop app in browser mode', async () => {
    const refreshOpenCodeProvider = vi.fn();
    const refreshContextBindings = vi.fn();
    const report = await runVibeSpaceDoctorWithDependencies(
      dependencies({ nativeRuntime: false, refreshOpenCodeProvider, refreshContextBindings }),
    );

    expect(refreshOpenCodeProvider).not.toHaveBeenCalled();
    expect(refreshContextBindings).not.toHaveBeenCalled();
    expect(report.text).toContain('OpenCode — Native check unavailable in browser preview');
    expect(report.text).toContain('RLM / SiYuan — Native check unavailable in browser preview');
  });
});
