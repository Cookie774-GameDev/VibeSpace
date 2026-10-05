import { describe, expect, it, vi } from 'vitest';
import { createAppDiagnosticsCollector, type DiagnosticUiState } from './appDiagnostics';
import {
  APP_DIAGNOSTICS_FEATURES,
  parseTelemetryBatch,
  type AppDiagnosticsEvent,
} from '../../../../supabase/functions/_shared/telemetrySchema';

function setup(enabled = true) {
  let allowed = enabled;
  let visible = true;
  let mono = 0;
  let epoch = 1_790_000_000_000;
  let ui: DiagnosticUiState = {
    route: 'chat',
    settingsOpen: false,
    paletteOpen: false,
    voiceModalOpen: false,
  };
  const listeners = new Set<() => void>();
  const events = new EventTarget();
  const emitted: AppDiagnosticsEvent[] = [];
  const readUi = vi.fn(() => ui);
  const readHeap = vi.fn(() => ({ usedBytes: 128 * 1024 * 1024, limitBytes: 2048 * 1024 * 1024 }));
  const emit = vi.fn((event: AppDiagnosticsEvent) => {
    emitted.push(event);
    return true;
  });
  const collector = createAppDiagnosticsCollector({
    allowed: () => allowed,
    readUi,
    subscribeUi: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    events,
    isVisible: () => visible,
    readHeap,
    now: () => epoch,
    monotonic: () => mono,
    environment: { appVersion: '1.2.3', platform: 'windows' },
    emit,
  });
  return {
    collector,
    events,
    emitted,
    readUi,
    readHeap,
    emit,
    listeners,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
      events.dispatchEvent(new Event('visibilitychange'));
    },
    ui: (patch: Partial<DiagnosticUiState>) => {
      ui = { ...ui, ...patch };
      listeners.forEach((listener) => listener());
    },
    tick: (ms: number) => {
      mono += ms;
      epoch += ms;
      collector.sample();
    },
  };
}

describe('bounded app diagnostics collector', () => {
  it('does not observe UI or resources or attach listeners without current admission', () => {
    const f = setup(false);
    f.ui({ route: 'canvas' });
    f.events.dispatchEvent(new Event('error'));
    f.tick(60_000);
    expect(f.readUi).not.toHaveBeenCalled();
    expect(f.readHeap).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
    expect(f.emitted).toEqual([]);
  });
  it('baselines current UI, counts only later fixed route/modal opens and flushes once per minute', () => {
    const f = setup();
    f.ui({ route: 'canvas' });
    f.ui({ route: 'canvas' });
    f.ui({ settingsOpen: true });
    f.ui({ settingsOpen: true });
    f.ui({ settingsOpen: false });
    f.ui({ settingsOpen: true });
    f.tick(59_999);
    expect(f.emitted).toEqual([]);
    f.tick(1);
    const opens = f.emitted.filter((event) => event.eventName === 'feature_open');
    expect(opens.map((event) => [event.feature, event.metrics.count])).toEqual([
      ['canvas', 1],
      ['settings', 2],
    ]);
    const count = f.emitted.length;
    f.tick(5_000);
    expect(f.emitted).toHaveLength(count);
  });
  it('never reads raw error or UI content and rejects unknown route/operation values', () => {
    const f = setup();
    const event = new Event('error');
    for (const key of ['message', 'error', 'stack', 'filename', 'reason'])
      Object.defineProperty(event, key, {
        get() {
          throw new Error('PRIVATE_SENTINEL');
        },
      });
    expect(() => f.events.dispatchEvent(event)).not.toThrow();
    f.events.dispatchEvent(new Event('unhandledrejection'));
    f.ui({ route: '/private/file?token=PRIVATE_SENTINEL' });
    f.collector.recordOperation('PRIVATE_SENTINEL', 'completed', 10);
    f.collector.recordOperation('terminal-command', 'completed', 42.5);
    f.tick(60_000);
    expect(f.emitted.some((row) => row.diagnostic === 'renderer_error')).toBe(true);
    expect(
      f.emitted.some((row) => row.eventName === 'tool_outcome' && row.feature === 'terminal'),
    ).toBe(true);
    expect(JSON.stringify(f.emitted)).not.toContain('PRIVATE_SENTINEL');
    for (const row of f.emitted)
      expect(() =>
        parseTelemetryBatch(
          { batchId: crypto.randomUUID(), events: [row] },
          { nowMs: row.occurredAt, allowAppDiagnostics: true },
        ),
      ).not.toThrow();
  });
  it('caps counters, aggregate keys and emitted events under a burst', () => {
    const f = setup();
    for (let i = 0; i < 2_000; i++) f.events.dispatchEvent(new Event('error'));
    for (const route of APP_DIAGNOSTICS_FEATURES) f.ui({ route });
    f.ui({ settingsOpen: true, paletteOpen: true, voiceModalOpen: true });
    for (const kind of ['terminal-command', 'semantic-tool', 'harness'])
      for (const phase of ['completed', 'failed', 'cancelled'])
        f.collector.recordOperation(kind, phase, 1);
    f.tick(60_000);
    expect(f.emitted.length).toBeGreaterThan(0);
    expect(f.emitted.length).toBeLessThanOrEqual(32);
    expect(f.emitted.find((row) => row.diagnostic === 'renderer_error')?.metrics.count).toBe(1_000);
    const sent = f.emitted.length;
    f.tick(1);
    expect(f.emitted).toHaveLength(sent);
  });
  it('invalidates buffered events on revoked admission and never replays them on re-enable', () => {
    const f = setup();
    f.ui({ route: 'canvas' });
    f.setAllowed(false);
    f.tick(60_000);
    expect(f.emitted).toEqual([]);
    expect(f.listeners.size).toBe(0);
    const reads = f.readUi.mock.calls.length;
    f.setAllowed(true);
    f.ui({ route: 'notes' });
    f.tick(60_000);
    expect(f.emitted).toEqual([]);
    expect(f.readUi).toHaveBeenCalledTimes(reads);
  });
  it('ignores hidden/sleep intervals and unsupported or failed resource samples', () => {
    const f = setup();
    f.setVisible(false);
    f.tick(300_000);
    expect(f.readHeap).not.toHaveBeenCalled();
    expect(f.emitted).toEqual([]);
    f.setVisible(true);
    f.readHeap.mockImplementation(() => {
      throw new Error('private heap failure');
    });
    f.ui({ route: 'notes' });
    expect(() => f.tick(5_000)).not.toThrow();
    f.tick(55_000);
    expect(f.emitted.some((row) => row.feature === 'notes')).toBe(true);
    expect(f.emitted.some((row) => row.diagnostic === 'resource_sample')).toBe(false);
    expect(
      f.emitted.find((row) => row.diagnostic === 'event_loop_delay')?.metrics.eventLoopDelayMs ?? 0,
    ).toBeLessThanOrEqual(60_000);
  });
  it('cleans up idempotently and keeps sink failures off the product path', () => {
    const f = setup();
    f.emit.mockImplementation(() => {
      throw new Error('private sink failure');
    });
    f.ui({ route: 'notes' });
    expect(() => f.tick(60_000)).not.toThrow();
    f.collector.dispose();
    f.collector.dispose();
    expect(f.listeners.size).toBe(0);
    const calls = f.emit.mock.calls.length;
    f.events.dispatchEvent(new Event('error'));
    f.tick(60_000);
    expect(f.emit).toHaveBeenCalledTimes(calls);
  });
});
