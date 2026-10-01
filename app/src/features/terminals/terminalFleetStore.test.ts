import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TERMINAL_FLEET_ERRORS,
  MAX_TERMINAL_FLEET_RECORDS,
  useTerminalFleetStore,
} from './terminalFleetStore';

describe('terminal fleet progress store', () => {
  beforeEach(() => {
    useTerminalFleetStore.getState().reset();
  });

  it('tracks bounded numeric progress through a terminal status', () => {
    useTerminalFleetStore.getState().begin({ requestId: 'fleet-1', targetTotal: 8 });
    useTerminalFleetStore.getState().update('fleet-1', {
      status: 'launching',
      createdCount: 2,
      reusedCount: 1,
      launchedCount: 3,
      skippedCount: 0,
      currentBatch: 2,
    });
    useTerminalFleetStore.getState().update('fleet-1', { status: 'complete' });

    expect(useTerminalFleetStore.getState().records).toHaveLength(1);
    expect(useTerminalFleetStore.getState().records[0]).toMatchObject({
      requestId: 'fleet-1',
      targetTotal: 8,
      status: 'complete',
      createdCount: 2,
      reusedCount: 1,
      launchedCount: 3,
      skippedCount: 0,
      currentBatch: 2,
      errors: [],
    });
  });

  it('redacts, normalizes, truncates, and bounds concise errors', () => {
    useTerminalFleetStore.getState().begin({ requestId: 'fleet-errors', targetTotal: 4 });
    useTerminalFleetStore.getState().update('fleet-errors', {
      status: 'partial',
      errors: Array.from(
        { length: MAX_TERMINAL_FLEET_ERRORS + 4 },
        (_, index) =>
          `\u001b[31mAPI_TOKEN=sk-live-abcdefghijklmnopqrstuvwxyz error ${index}\n${'x'.repeat(300)}`,
      ),
    });

    const record = useTerminalFleetStore.getState().records[0]!;
    expect(record.errors).toHaveLength(MAX_TERMINAL_FLEET_ERRORS);
    expect(record.errors.every((error) => error.length <= 160)).toBe(true);
    expect(record.errors.join(' ')).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
    expect(record.errors.join(' ')).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(record.errors.join(' ')).toContain('[REDACTED TOKEN]');
  });

  it('retains only the newest 100 sanitized aggregate records', () => {
    for (let index = 0; index < MAX_TERMINAL_FLEET_RECORDS + 5; index += 1) {
      useTerminalFleetStore.getState().begin({
        requestId: `fleet-${index}`,
        targetTotal: index,
      });
    }

    const records = useTerminalFleetStore.getState().records;
    expect(records).toHaveLength(MAX_TERMINAL_FLEET_RECORDS);
    expect(records[0]?.requestId).toBe('fleet-5');
    expect(records.at(-1)?.requestId).toBe('fleet-104');
    expect(Object.keys(records[0] ?? {})).not.toContain('command');
    expect(Object.keys(records[0] ?? {})).not.toContain('terminalOutput');
  });

  it('clamps counters and cancellation without creating unknown records', () => {
    useTerminalFleetStore.getState().begin({ requestId: 'fleet-cancel', targetTotal: 999 });
    useTerminalFleetStore.getState().update('fleet-cancel', {
      createdCount: -5,
      launchedCount: 2.9,
    });
    useTerminalFleetStore.getState().cancel('fleet-cancel');
    useTerminalFleetStore.getState().update('missing', { status: 'failed' });

    expect(useTerminalFleetStore.getState().records).toHaveLength(1);
    expect(useTerminalFleetStore.getState().records[0]).toMatchObject({
      status: 'cancelled',
      targetTotal: 10,
      createdCount: 0,
      launchedCount: 2,
    });
  });
});
