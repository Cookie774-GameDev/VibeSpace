import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTerminalScheduleRequest } from './terminalScheduler';

describe('parseTerminalScheduleRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts word-number relative times', () => {
    const parsed = parseTerminalScheduleRequest('send this terminal npm test in twenty-five minutes');
    expect(parsed).toEqual({
      command: 'npm test',
      runAt: Date.parse('2026-06-01T12:25:00.000Z'),
    });
  });

  it('schedules a safe check-in when no command body is provided', () => {
    const parsed = parseTerminalScheduleRequest('message this terminal in five hours');
    expect(parsed).toEqual({
      command: 'echo "Jarvis scheduled check-in for this terminal."',
      runAt: Date.parse('2026-06-01T17:00:00.000Z'),
    });
  });
});
