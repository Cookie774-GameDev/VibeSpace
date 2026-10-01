import { describe, expect, it } from 'vitest';
import {
  formatJarvisIntervalLabel,
  intervalMsFromParts,
  normalizeJarvisIntervalMs,
  buildJarvisScheduleEventInput,
  parseJarvisScheduleMetadata,
} from './jarvisSchedules';
import { computeNextJarvisRunAt } from './jarvisScheduleRunner';
import type { WorkspaceId } from '@/types/common';
import type { EventRow } from '@/types/event';

describe('Jarvis custom interval recurrence', () => {
  it('normalizes interval bounds', () => {
    expect(normalizeJarvisIntervalMs(60_000)).toBeUndefined(); // < 5 min
    expect(normalizeJarvisIntervalMs(5 * 60_000)).toBe(5 * 60_000);
    expect(intervalMsFromParts(2, 'hours')).toBe(2 * 3_600_000);
    expect(intervalMsFromParts(3, 'days')).toBe(3 * 86_400_000);
    expect(formatJarvisIntervalLabel(2 * 3_600_000)).toMatch(/2 hr/i);
  });

  it('persists intervalMs on custom_interval schedules', () => {
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'wks_1' as WorkspaceId,
      createdBy: 'usr_local',
      title: 'Heartbeat',
      prompt: 'Check status',
      startAt: 1_000_000,
      recurrence: 'custom_interval',
      intervalMs: 2 * 3_600_000,
      timezone: 'UTC',
      modelSelection: {
        mode: 'single',
        providerId: 'google',
        modelId: 'gemini-2.5-flash',
      },
      agentId: 'agent_jarvis',
    });
    const event = {
      id: 'evt_1',
      ...input,
      attendees: [],
      created_at: 1,
      updated_at: 1,
      status: 'scheduled',
    } as unknown as EventRow;
    const meta = parseJarvisScheduleMetadata(event);
    expect(meta?.recurrence).toBe('custom_interval');
    expect(meta?.intervalMs).toBe(2 * 3_600_000);
  });

  it('computes next run from fixed custom intervals', () => {
    const start = new Date(2026, 6, 8, 8, 0, 0, 0).getTime();
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'wks_1' as WorkspaceId,
      createdBy: 'usr_local',
      title: 'Pulse',
      prompt: 'Ping',
      startAt: start,
      recurrence: 'custom_interval',
      intervalMs: 60 * 60 * 1000,
      timezone: 'UTC',
      modelSelection: {
        mode: 'single',
        providerId: 'google',
        modelId: 'gemini-2.5-flash',
      },
      agentId: 'agent_jarvis',
    });
    const event = {
      id: 'evt_2',
      ...input,
      attendees: [],
      created_at: start,
      updated_at: start,
      status: 'scheduled',
    } as unknown as EventRow;

    expect(computeNextJarvisRunAt(event, start)).toBe(start + 3_600_000);
    expect(computeNextJarvisRunAt(event, start + 3_600_000 - 1)).toBe(start + 3_600_000);
    expect(computeNextJarvisRunAt(event, start + 3_600_000)).toBe(start + 2 * 3_600_000);
  });
});
