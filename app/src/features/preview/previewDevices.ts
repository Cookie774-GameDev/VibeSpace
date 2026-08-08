/**
 * CSS viewport presets (logical CSS pixels — not physical screen pixels).
 * Sources: iOS resolution tables, Chrome DevTools, yesviz/ios-resolution.
 */
export type DeviceCategory = 'responsive' | 'phone' | 'tablet' | 'laptop' | 'desktop' | 'custom';

export interface DevicePreset {
  id: string;
  name: string;
  category: DeviceCategory;
  /** CSS viewport width in portrait (logical px) */
  width: number;
  /** CSS viewport height in portrait (logical px) */
  height: number;
  dpr: number;
  touch: boolean;
  userAgentProfile: 'mobile' | 'desktop';
  safeArea?: { top: number; bottom: number };
}

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    id: 'responsive',
    name: 'Responsive',
    category: 'responsive',
    width: 0,
    height: 0,
    dpr: 1,
    touch: false,
    userAgentProfile: 'desktop',
  },
  // iPhone SE (3rd gen) — 375×667 @2x
  {
    id: 'iphone-se',
    name: 'iPhone SE',
    category: 'phone',
    width: 375,
    height: 667,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
    safeArea: { top: 20, bottom: 0 },
  },
  // iPhone 14 / 15 / 16 standard — 393×852 @3x
  {
    id: 'iphone-15',
    name: 'iPhone 15',
    category: 'phone',
    width: 393,
    height: 852,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
    safeArea: { top: 59, bottom: 34 },
  },
  // iPhone 15 / 16 Pro Max — 430×932 @3x
  {
    id: 'iphone-15-pro-max',
    name: 'iPhone 15 Pro Max',
    category: 'phone',
    width: 430,
    height: 932,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
    safeArea: { top: 59, bottom: 34 },
  },
  // Pixel 7 / 8 class — 412×915 @2.625
  {
    id: 'pixel',
    name: 'Pixel phone',
    category: 'phone',
    width: 412,
    height: 915,
    dpr: 2.625,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // iPad mini (6th / A17 Pro) — 744×1133 @2x
  {
    id: 'ipad-mini',
    name: 'iPad Mini',
    category: 'tablet',
    width: 744,
    height: 1133,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // iPad Pro 11" (M4) — 834×1210 @2x (was 834×1194 on older gens)
  {
    id: 'ipad-pro-11',
    name: 'iPad Pro 11-inch',
    category: 'tablet',
    width: 834,
    height: 1210,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // iPad Pro 13" (M4) — 1032×1376 @2x (not the older 1024×1366 12.9")
  {
    id: 'ipad-pro-13',
    name: 'iPad Pro 13-inch',
    category: 'tablet',
    width: 1032,
    height: 1376,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // Common Windows / Chromebook laptop CSS layout
  {
    id: 'small-laptop',
    name: 'Small laptop',
    category: 'laptop',
    width: 1366,
    height: 768,
    dpr: 1,
    touch: false,
    userAgentProfile: 'desktop',
  },
  // MacBook-style default CSS viewport (Retina often reports 1440×900)
  {
    id: 'macbook',
    name: 'MacBook-style laptop',
    category: 'laptop',
    width: 1440,
    height: 900,
    dpr: 2,
    touch: false,
    userAgentProfile: 'desktop',
  },
  {
    id: 'desktop-1440',
    name: 'Desktop 1440p',
    category: 'desktop',
    width: 1440,
    height: 900,
    dpr: 1,
    touch: false,
    userAgentProfile: 'desktop',
  },
  {
    id: 'desktop-1080',
    name: 'Full HD desktop',
    category: 'desktop',
    width: 1920,
    height: 1080,
    dpr: 1,
    touch: false,
    userAgentProfile: 'desktop',
  },
  {
    id: 'custom',
    name: 'Custom',
    category: 'custom',
    width: 390,
    height: 844,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
];

export function getDevicePreset(id: string): DevicePreset {
  return DEVICE_PRESETS.find((d) => d.id === id) ?? DEVICE_PRESETS[0]!;
}

export function defaultOrientationForPreset(
  preset: DevicePreset,
): 'portrait' | 'landscape' {
  return preset.category === 'laptop' ||
    preset.category === 'desktop' ||
    preset.category === 'responsive'
    ? 'landscape'
    : 'portrait';
}

/**
 * Exact CSS viewport size for the device (never scaled).
 * Scaling for display must use CSS transform so media queries still see real width/height.
 */
export function orientSize(
  preset: DevicePreset,
  orientation: 'portrait' | 'landscape',
  customW: number,
  customH: number,
  hostW: number,
  hostH: number,
): { width: number; height: number } {
  if (preset.id === 'responsive') {
    return { width: Math.max(320, Math.round(hostW)), height: Math.max(240, Math.round(hostH)) };
  }
  let w = preset.id === 'custom' ? customW : preset.width;
  let h = preset.id === 'custom' ? customH : preset.height;
  if (!Number.isFinite(w) || w <= 0) w = 390;
  if (!Number.isFinite(h) || h <= 0) h = 844;
  if (orientation === 'landscape' && w < h) {
    [w, h] = [h, w];
  }
  if (orientation === 'portrait' && w > h) {
    [w, h] = [h, w];
  }
  return {
    width: Math.min(Math.max(200, Math.round(w)), 3840),
    height: Math.min(Math.max(200, Math.round(h)), 2400),
  };
}

export const ZOOM_STEPS = [0.25, 0.35, 0.5, 0.65, 0.75, 1] as const;
