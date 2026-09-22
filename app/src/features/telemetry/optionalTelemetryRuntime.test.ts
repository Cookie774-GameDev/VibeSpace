import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  startOptionalTelemetryRuntime,
  optionalTelemetryExporter,
} from './optionalTelemetryRuntime';
import { telemetryConsentStore } from './telemetryConsent';
import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';

const state = vi.hoisted(() => ({
  events: [] as IntelligenceTelemetryEvent[],
  consent: vi.fn(),
  invoke: vi.fn(),
  pending: [] as { accountId: string }[],
  withdrawalListeners: new Set<() => void>(),
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
      getSession: async () => ({
        data: { session: { user: { id: 'a' }, access_token: 'unit-token' } },
      }),
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
  state.events = [];
  state.pending = [];
  state.withdrawalListeners.clear();
  optionalTelemetryExporter.configure(null, false);
  telemetryConsentStore.resetForTests();
  state.consent
    .mockReset()
    .mockResolvedValue({ ok: true, state: { enabled: true, eligible: true } });
  state.invoke
    .mockReset()
    .mockImplementation(async (_name, options) => ({
      data: {
        acceptedEventIds: options.body.events.map((row: { eventId: string }) => row.eventId),
      },
    }));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
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
  telemetryConsentStore.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
  const configure = vi.spyOn(optionalTelemetryExporter, 'configure');
  try {
    stop = startOptionalTelemetryRuntime(null);
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    expect(configure).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    state.consent.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    stop = startOptionalTelemetryRuntime('a');
    state.events.push(event());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(configure).not.toHaveBeenCalled();
    expect(state.invoke).not.toHaveBeenCalled();
    resolve({ ok: true, state: { enabled: true, eligible: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(configure).toHaveBeenLastCalledWith('a', true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.invoke).not.toHaveBeenCalled();
    telemetryConsentStore.revoke();
    expect(configure).toHaveBeenLastCalledWith('a', false);
  } finally {
    configure.mockRestore();
  }
});
