import { describe, expect, it } from 'vitest';
import { resolveTaskbarPlacement, type MonitorWorkArea } from './taskbarPlacement';

const bottomTaskbar: MonitorWorkArea = {
  name: 'Primary',
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
};

describe('taskbar placement', () => {
  it('infers the taskbar edge and clamps a saved offset inside the work area', () => {
    expect(
      resolveTaskbarPlacement({
        monitors: [bottomTaskbar],
        saved: { monitorName: 'Primary', edge: 'bottom', offset: 9_999 },
        windowSize: { width: 340, height: 128 },
      }),
    ).toEqual({
      monitorName: 'Primary',
      edge: 'bottom',
      offset: 1_580,
      x: 1_580,
      y: 912,
    });
  });

  it('restores on the primary available monitor when the saved monitor disconnects', () => {
    expect(
      resolveTaskbarPlacement({
        monitors: [bottomTaskbar],
        saved: { monitorName: 'Missing', edge: 'left', offset: 40 },
        windowSize: { width: 280, height: 36 },
      }),
    ).toMatchObject({
      monitorName: 'Primary',
      edge: 'bottom',
      x: 40,
      y: 1_004,
    });
  });
});
