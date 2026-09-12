import { describe, expect, it } from 'vitest';
import {
  DEVICE_PRESETS,
  defaultOrientationForPreset,
  getDevicePreset,
  orientSize,
} from './previewDevices';

describe('device presets', () => {
  it('uses accurate CSS viewport sizes', () => {
    expect(getDevicePreset('iphone-se')).toMatchObject({ width: 375, height: 667, dpr: 2 });
    expect(getDevicePreset('iphone-15')).toMatchObject({ width: 393, height: 852, dpr: 3 });
    expect(getDevicePreset('iphone-15-pro-max')).toMatchObject({ width: 430, height: 932, dpr: 3 });
    expect(getDevicePreset('pixel')).toMatchObject({ width: 412, height: 915 });
    expect(getDevicePreset('ipad-mini')).toMatchObject({ width: 744, height: 1133, dpr: 2 });
    expect(getDevicePreset('ipad-pro-11')).toMatchObject({ width: 834, height: 1210, dpr: 2 });
    expect(getDevicePreset('ipad-pro-13')).toMatchObject({ width: 1032, height: 1376, dpr: 2 });
    expect(getDevicePreset('small-laptop')).toMatchObject({ width: 1366, height: 768 });
    expect(getDevicePreset('macbook')).toMatchObject({ width: 1440, height: 900, dpr: 2 });
    expect(getDevicePreset('desktop-1080')).toMatchObject({ width: 1920, height: 1080 });
  });

  it('keeps exact CSS size (not visually scaled) from orientSize', () => {
    const iphone = getDevicePreset('iphone-15');
    const portrait = orientSize(iphone, 'portrait', 0, 0, 800, 600);
    expect(portrait).toEqual({ width: 393, height: 852 });
    const landscape = orientSize(iphone, 'landscape', 0, 0, 800, 600);
    expect(landscape).toEqual({ width: 852, height: 393 });
  });

  it('all fixed presets have positive width/height', () => {
    for (const d of DEVICE_PRESETS) {
      if (d.id === 'responsive') continue;
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
    }
  });

  it('defaults laptop and desktop previews to landscape without rotating mobile presets', () => {
    expect(defaultOrientationForPreset(getDevicePreset('small-laptop'))).toBe('landscape');
    expect(defaultOrientationForPreset(getDevicePreset('macbook'))).toBe('landscape');
    expect(defaultOrientationForPreset(getDevicePreset('desktop-1080'))).toBe('landscape');
    expect(defaultOrientationForPreset(getDevicePreset('ipad-mini'))).toBe('portrait');
    expect(defaultOrientationForPreset(getDevicePreset('iphone-15'))).toBe('portrait');
  });
});
