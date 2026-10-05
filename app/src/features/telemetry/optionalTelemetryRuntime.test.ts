import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  startOptionalTelemetryRuntime,
  optionalTelemetryExporter,
} from './optionalTelemetryRuntime';
import { telemetryConsentStore } from './telemetryConsent';
import * as appDiagnosticsModule from './appDiagnostics';
import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';

const state = vi.hoisted(() => ({
  events: [] as IntelligenceTelemetryEvent[],
  consent: vi.fn(),
  invoke: vi.fn(),
  session: vi.fn(),
  ui: { route: 'chat', settingsOpen: false, paletteOpen: false, voiceModalOpen: false },
  uiListeners: new Set<() => void>(),
  pending: [] as { accountId: string }[],
  withdrawalListeners: new Set<() => void>(),
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => state.ui,
    subscribe: (listener: () => void) => {
      state.uiListeners.add(listener);
      return () => state.uiListeners.delete(listener);
    },
  },
}));
vi.mock('@/lib/ai/intelligenceTelemetryRuntime', () => ({
  localIntelligenceTelemetryRuntime: { snapshot: () => ({ events: state.events }) },
}));
vi.mock('./accountTelemetryConsent', () => ({ getAccountTelemetryConsent: state.consent }));
vi.mock('./telemetryWithdrawal', () => ({
  telemetryWithdrawalQueue: {
    getSnapshot: () => ({ pending: state.pending }),
    subscribe: (listener: () => void) => {
      state.withdrawalListeners.add(listener);
      return () => state.withdrawalListeners.delete(listener);
    },
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: state.session,
    },
    functions: { invoke: state.invoke },
  }),
}));
const event = (): IntelligenceTelemetryEvent => ({
  schemaVersion: 1,
  eventId: crypto.randomUUID(),
  requestId: 'private',
  attemptNumber: 1,
  accountScopeHash: 'private-account',
  projectScopeHash: 'private-project',
  kind: 'context_retrieval',
  observedAt: Date.now(),
  metrics: { durationMs: 1 },
  attributes: { resultState: 'completed' },
});
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T13:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  state.session
    .mockReset()
    .mockResolvedValue({ data: { session: { user: { id: 'a' }, access_token: 'unit-token' } } });
  state.ui = { route: 'chat', settingsOpen: false, paletteOpen: false, voiceModalOpen: false };
  state.uiListeners.clear();
  state.events = [];
  state.pending = [];
  state.withdrawalListeners.clear();
  optionalTelemetryExporter.configure(null, false);
  telemetryConsentStore.resetForTests();
  state.consent
    .mockReset()
    .mockResolvedValue({ ok: true, state: { enabled: true, eligible: true } });
  state.invoke.mockReset().mockImplementation(async (_name, options) => ({
    data: {
      acceptedEventIds: options.body.events.map((row: { eventId: string }) => row.eventId),
    },
  }));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('requires all local classes and current account enrollment before exporting new events', async () => {
  telemetryConsentStore.updateConsent({ productUsage: true, diagnostics: true });
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  state.events.push(event());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.invoke).not.toHaveBeenCalled();
  telemetryConsentStore.updateConsent({ toolOutcomes: true });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.invoke).not.toHaveBeenCalled();
  state.events.push(event());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.invoke).toHaveBeenCalledTimes(1);
  expect(state.invoke.mock.calls[0][1].body.events).toHaveLength(1);
  expect(JSON.stringify(state.invoke.mock.calls[0][1].body)).not.toContain('private');
});
it('stops sharing synchronously on withdrawal and never lets a late consent response re-enable it', async () => {
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  let resolve!: (value: unknown) => void;
  state.consent.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  stop = startOptionalTelemetryRuntime('a');
  telemetryConsentStore.revoke();
  resolve({ ok: true, state: { enabled: true, eligible: true } });
  await vi.advanceTimersByTimeAsync(0);
  state.events.push(event());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(optionalTelemetryExporter.getSnapshot().enabled).toBe(false);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('a saved withdrawal blocks export even if the server still reports enrolled', async () => {
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  state.pending = [{ accountId: 'a' }];
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  state.events.push(event());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(optionalTelemetryExporter.getSnapshot().enabled).toBe(false);
  expect(state.invoke).not.toHaveBeenCalled();
});

it('preserves the outbox while startup identity and enrollment are pending, without collecting', async () => {
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  const configure = vi.spyOn(optionalTelemetryExporter, 'configure');
  try {
    stop = startOptionalTelemetryRuntime(null);
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    expect(configure).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    state.consent.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    stop = startOptionalTelemetryRuntime('a');
    state.events.push(event());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(configure).not.toHaveBeenCalled();
    expect(state.invoke).not.toHaveBeenCalled();
    resolve({ ok: true, state: { enabled: true, eligible: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(configure).toHaveBeenLastCalledWith('a', true, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.invoke).not.toHaveBeenCalled();
    telemetryConsentStore.revoke();
    expect(configure).toHaveBeenLastCalledWith('a', false, false);
  } finally {
    configure.mockRestore();
  }
});

const expandedState = {
  enabled: true,
  eligible: true,
  policyVersion: 'telemetry-app-diagnostics-2026-10-05-v1',
  acceptedPolicyVersion: 'telemetry-app-diagnostics-2026-10-05-v1',
  diagnosticsScope: 'app-diagnostics-v1',
  acceptedDiagnosticsScope: 'app-diagnostics-v1',
  supportedSchemaVersions: [1, 2],
  noticeUrl: 'https://example.test/notice',
  discountPercent: 10,
  requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
} as const;
function grantExpanded() {
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  expect(telemetryConsentStore.acceptAppDiagnostics('a', expandedState)).toBe(true);
  state.consent.mockResolvedValue({ ok: true, state: expandedState });
}
function navigate(route: string) {
  state.ui = { ...state.ui, route };
  state.uiListeners.forEach((listener) => listener());
}
it('collects post-consent feature aggregates through the existing outbox only with both expanded gates', async () => {
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(1);
  navigate('canvas');
  navigate('notes');
  await vi.advanceTimersByTimeAsync(59_999);
  expect(state.invoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.invoke).toHaveBeenCalled();
  const events = state.invoke.mock.calls.flatMap((call) => call[1].body.events);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        schemaVersion: 2,
        eventName: 'feature_open',
        feature: 'canvas',
        metrics: { count: 1 },
      }),
    ]),
  );
});
it('leaves the expanded collector off for legacy or incompatible server consent', async () => {
  grantExpanded();
  state.consent.mockResolvedValue({
    ok: true,
    state: {
      ...expandedState,
      diagnosticsScope: null,
      acceptedDiagnosticsScope: null,
      supportedSchemaVersions: [1],
    },
  });
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(0);
  navigate('canvas');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('requires a new server decision after pending withdrawal changes and discards buffered v2', async () => {
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  navigate('canvas');
  let finish!: (value: unknown) => void;
  state.consent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  state.pending = [{ accountId: 'a' }];
  state.withdrawalListeners.forEach((listener) => listener());
  expect(state.consent).toHaveBeenCalledTimes(2);
  expect(state.uiListeners.size).toBe(0);
  state.pending = [];
  state.withdrawalListeners.forEach((listener) => listener());
  expect(state.uiListeners.size).toBe(0);
  state.consent.mockResolvedValue({
    ok: true,
    state: { ...expandedState, enabled: false, eligible: false },
  });
  finish({ ok: true, state: expandedState });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('cannot let a delayed expanded approval from an old A lifetime grant an A-to-B-to-A replacement', async () => {
  grantExpanded();
  let finish!: (value: unknown) => void;
  state.consent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = startOptionalTelemetryRuntime('a');
  old();
  const middle = startOptionalTelemetryRuntime('b');
  await vi.advanceTimersByTimeAsync(0);
  middle();
  state.consent.mockResolvedValue({
    ok: true,
    state: { ...expandedState, acceptedDiagnosticsScope: null },
  });
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  finish({ ok: true, state: expandedState });
  await vi.advanceTimersByTimeAsync(0);
  navigate('canvas');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.uiListeners.size).toBe(0);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('aborts a v2 send waiting on captured authentication when local consent is revoked', async () => {
  grantExpanded();
  let finish!: (value: unknown) => void;
  state.session.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  navigate('canvas');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.session).toHaveBeenCalled();
  telemetryConsentStore.revoke();
  expect(state.uiListeners.size).toBe(0);
  finish({ data: { session: { user: { id: 'a' }, access_token: 'unit-token' } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.invoke).not.toHaveBeenCalled();
});

it('does not treat server enrollment plus legacy device flags as fresh expanded device consent', async () => {
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  state.consent.mockResolvedValue({ ok: true, state: expandedState });
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(0);
  navigate('canvas');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('stops expanded collection when the latest server verification fails and does not replay later UI changes', async () => {
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  navigate('canvas');
  state.consent.mockResolvedValue({ ok: false, error: 'synthetic offline' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.uiListeners.size).toBe(0);
  const calls = state.invoke.mock.calls.length;
  navigate('notes');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.invoke).toHaveBeenCalledTimes(calls);
});

it('independent review invalidates expanded admission after an authoritative ingest rejection', async () => {
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  // A fix may reauthorize immediately or at its normal cadence; no new grant may settle yet.
  state.consent.mockImplementation(() => new Promise(() => {}));
  state.invoke.mockResolvedValue({ error: { context: new Response(null, { status: 403 }) } });
  const row = {
    schemaVersion: 2 as const,
    eventId: crypto.randomUUID(),
    eventName: 'feature_open' as const,
    feature: 'canvas' as const,
    occurredAt: Date.now(),
    appVersion: '1.5.0',
    platform: 'windows' as const,
    outcome: 'ok' as const,
    metrics: { count: 1 },
  };
  expect(optionalTelemetryExporter.enqueue(row)).toBe(true);
  await optionalTelemetryExporter.flush();
  expect(optionalTelemetryExporter.getSnapshot().enabled).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    optionalTelemetryExporter.enqueue({
      ...row,
      eventId: crypto.randomUUID(),
      occurredAt: Date.now(),
    }),
  ).toBe(false);
  expect(state.uiListeners.size).toBe(0);
});
it('independent review excludes operation backlog from before expanded admission', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  grantExpanded();
  state.consent.mockResolvedValue({
    ok: true,
    state: {
      ...expandedState,
      diagnosticsScope: null,
      acceptedDiagnosticsScope: null,
      supportedSchemaVersions: [1],
    },
  });
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  appActivityLog.record(
    'terminal-command',
    'completed',
    { ignored: 'PRIVATE_SENTINEL' },
    'review-before-grant',
    9,
  );
  state.consent.mockResolvedValue({ ok: true, state: expandedState });
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(1);
  appActivityLog.record(
    'terminal-command',
    'completed',
    { ignored: 'PRIVATE_SENTINEL' },
    'review-after-grant',
    17,
  );
  await vi.advanceTimersByTimeAsync(65000);
  const rows = state.invoke.mock.calls
    .flatMap((call) => call[1].body.events)
    .filter(
      (row: { schemaVersion: number; eventName: string; feature?: string }) =>
        row.schemaVersion === 2 && row.eventName === 'tool_outcome' && row.feature === 'terminal',
    );
  expect(rows).toHaveLength(1);
  expect(rows[0].metrics).toEqual({ count: 1, durationMs: 17 });
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_SENTINEL');
});

it('ignores a verification begun before ingest rejection and resumes only after a new current reply', async () => {
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  let oldReply!: (value: unknown) => void;
  let freshReply!: (value: unknown) => void;
  state.consent
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldReply = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          freshReply = resolve;
        }),
    );
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  state.invoke.mockResolvedValueOnce({ error: { context: new Response(null, { status: 403 }) } });
  const row = {
    schemaVersion: 2 as const,
    eventId: crypto.randomUUID(),
    eventName: 'feature_open' as const,
    feature: 'canvas' as const,
    occurredAt: Date.now(),
    appVersion: '1.5.0',
    platform: 'windows' as const,
    outcome: 'ok' as const,
    metrics: { count: 1 },
  };
  expect(optionalTelemetryExporter.enqueue(row)).toBe(true);
  await optionalTelemetryExporter.flush();
  oldReply({ ok: true, state: expandedState });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(0);
  expect(optionalTelemetryExporter.enqueue({ ...row, eventId: crypto.randomUUID() })).toBe(false);
  expect(state.consent).toHaveBeenCalledTimes(3);
  freshReply({ ok: true, state: expandedState });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.uiListeners.size).toBe(1);
  navigate('notes');
  await vi.advanceTimersByTimeAsync(60_000);
  const latest = state.invoke.mock.calls.at(-1)![1].body.events;
  expect(latest).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ eventName: 'feature_open', feature: 'notes' }),
    ]),
  );
  expect(latest.some((event: { eventId: string }) => event.eventId === row.eventId)).toBe(false);
});

it('treats null diagnostic listeners as a no-op for both document and window adapters', async () => {
  const factory = vi.spyOn(appDiagnosticsModule, 'createAppDiagnosticsCollector');
  grantExpanded();
  stop = startOptionalTelemetryRuntime('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(factory).toHaveBeenCalledOnce();
  const events = factory.mock.calls[0][0].events;
  const windowAdd = vi.spyOn(window, 'addEventListener');
  const windowRemove = vi.spyOn(window, 'removeEventListener');
  const documentAdd = vi.spyOn(document, 'addEventListener');
  const documentRemove = vi.spyOn(document, 'removeEventListener');
  for (const type of ['error', 'visibilitychange']) {
    events.addEventListener(type, null);
    events.removeEventListener(type, null);
  }
  expect(windowAdd).not.toHaveBeenCalled();
  expect(windowRemove).not.toHaveBeenCalled();
  expect(documentAdd).not.toHaveBeenCalled();
  expect(documentRemove).not.toHaveBeenCalled();
});
