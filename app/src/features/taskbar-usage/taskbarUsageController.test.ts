import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_PROVIDER_REFRESH_MS,
  DISPLAY_REFRESH_MS,
  FOREGROUND_PROVIDER_REFRESH_MS,
} from './taskbarUsageController';

describe('taskbar usage refresh policy', () => {
  it('updates visible timestamps every five seconds without polling providers every tick', () => {
    expect(DISPLAY_REFRESH_MS).toBe(5_000);
    expect(FOREGROUND_PROVIDER_REFRESH_MS).toBeGreaterThanOrEqual(60_000);
    expect(BACKGROUND_PROVIDER_REFRESH_MS).toBeGreaterThan(FOREGROUND_PROVIDER_REFRESH_MS);
  });
});
