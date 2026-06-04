import { beforeEach, describe, expect, it } from 'vitest';
import { useClockStore } from '@/features/clock/clockStore';
import { toolRegistry } from './index';

describe('built-in MCP tools', () => {
  beforeEach(() => {
    useClockStore.setState({ entries: [] });
  });

  it('registers clock.timer against the local Clock store', async () => {
    const result = await toolRegistry.invoke<{ durationMinutes: number; label: string }, { id: string; dueAt: number }>(
      'clock.timer',
      { durationMinutes: 5, label: 'MCP timer' },
    );

    expect(result.id).toMatch(/^clock_/);
    expect(useClockStore.getState().scheduled()[0]?.label).toBe('MCP timer');
  });
});
