import { describe, expect, it } from 'vitest';
import {
  TASKBAR_USAGE_DETAILS_SIZE,
  TASKBAR_USAGE_EXPANDED_SIZE,
  TASKBAR_USAGE_WINDOW_LABEL,
  taskbarUsageWindowOptions,
} from './taskbarUsageNativeWindow';

describe('taskbar usage window contract', () => {
  it('is a single fixed frameless transparent taskbar-adjacent surface', () => {
    expect(TASKBAR_USAGE_WINDOW_LABEL).toBe('taskbar-usage');
    expect(TASKBAR_USAGE_EXPANDED_SIZE).toEqual({ width: 380, height: 360 });
    expect(TASKBAR_USAGE_DETAILS_SIZE).toEqual({ width: 920, height: 640 });
    expect(taskbarUsageWindowOptions()).toMatchObject({
      width: 380,
      height: 360,
      maxWidth: 920,
      maxHeight: 640,
      decorations: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  });
});
