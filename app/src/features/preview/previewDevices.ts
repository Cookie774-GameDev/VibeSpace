/**
 * Full-screen CSS viewport presets (logical pixels, never physical display pixels).
 * Browser chrome and platform safe-area insets vary by browser and are not emulated.
 * Sources are recorded in docs/WORKBENCH_DEVICE_PRESETS.md.
 */
export type DeviceCategory =
  'responsive' | 'phone' | 'tablet' | 'adaptive' | 'laptop' | 'desktop' | 'custom';

export type DevicePlatform = 'responsive' | 'apple' | 'android' | 'adaptive' | 'desktop' | 'custom';

export type DeviceVerificationAuthority =
  | 'chrome-devtools'
  | 'playwright'
  | 'android-window-size-classes'
  | 'platform-spec'
  | 'common-layout'
  | 'user-defined';

export type DevicePresetGroupId =
  | 'responsive'
  | 'apple-phones'
  | 'android-phones'
  | 'tablets'
  | 'adaptive'
  | 'computers'
  | 'custom';

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
  platform?: DevicePlatform;
  verifiedBy?: DeviceVerificationAuthority;
}

export interface DevicePresetGroup {
  id: DevicePresetGroupId;
  label: string;
  devices: DevicePreset[];
}

export interface AndroidWindowClasses {
  width: 'compact' | 'medium' | 'expanded' | 'large' | 'extra-large';
  height: 'compact' | 'medium' | 'expanded';
}

export interface PreviewEmulation {
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  deviceScaleFactor: number;
  displayScale: number;
  mobile: boolean;
  touch: boolean;
  orientation: 'portrait' | 'landscape';
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
    platform: 'responsive',
    verifiedBy: 'user-defined',
  },
  // iPhone SE (3rd gen) — 375×667 @2x
  {
    id: 'iphone-se',
    name: 'iPhone SE (3rd generation)',
    category: 'phone',
    width: 375,
    height: 667,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'iphone-13-mini',
    name: 'iPhone 13 mini',
    category: 'phone',
    width: 360,
    height: 780,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'iphone-13',
    name: 'iPhone 13 / 13 Pro',
    category: 'phone',
    width: 390,
    height: 844,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'iphone-13-pro-max',
    name: 'iPhone 13 Pro Max',
    category: 'phone',
    width: 428,
    height: 926,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
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
  },
  {
    id: 'iphone-16-pro',
    name: 'iPhone 16 Pro',
    category: 'phone',
    width: 402,
    height: 874,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'iphone-16-pro-max',
    name: 'iPhone 16 Pro Max',
    category: 'phone',
    width: 440,
    height: 956,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // Playwright's maintained Chromium device descriptor — CSS screen 393×851 @2.75.
  {
    id: 'pixel-5',
    name: 'Google Pixel 5',
    category: 'phone',
    width: 393,
    height: 851,
    dpr: 2.75,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'playwright',
  },
  // Chrome DevTools current Pixel 7 / 8 descriptors — 412×915 @2.625.
  {
    id: 'pixel',
    name: 'Google Pixel 7 / 8',
    category: 'phone',
    width: 412,
    height: 915,
    dpr: 2.625,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'chrome-devtools',
  },
  {
    id: 'pixel-8-pro',
    name: 'Google Pixel 8 Pro',
    category: 'phone',
    width: 448,
    height: 997,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'chrome-devtools',
  },
  {
    id: 'pixel-9',
    name: 'Google Pixel 9',
    category: 'phone',
    width: 412,
    height: 924,
    dpr: 2.625,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'chrome-devtools',
  },
  {
    id: 'pixel-9-pro-xl',
    name: 'Google Pixel 9 Pro XL',
    category: 'phone',
    width: 448,
    height: 997,
    dpr: 3,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'chrome-devtools',
  },
  {
    id: 'galaxy-s20',
    name: 'Samsung Galaxy S20',
    category: 'phone',
    width: 412,
    height: 915,
    dpr: 3.5,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'android',
    verifiedBy: 'chrome-devtools',
  },
  // iPad mini (6th / A17 Pro) — 744×1133 @2x
  {
    id: 'ipad-mini',
    name: 'iPad mini (A17 Pro)',
    category: 'tablet',
    width: 744,
    height: 1133,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'ipad-air-11',
    name: 'iPad Air 11-inch (M3)',
    category: 'tablet',
    width: 820,
    height: 1180,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  {
    id: 'ipad-air-13',
    name: 'iPad Air 13-inch (M3)',
    category: 'tablet',
    width: 1024,
    height: 1366,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // iPad Pro 11" (M4) — 834×1210 @2x (was 834×1194 on older gens)
  {
    id: 'ipad-pro-11',
    name: 'iPad Pro 11-inch (M4)',
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
    name: 'iPad Pro 13-inch (M4)',
    category: 'tablet',
    width: 1032,
    height: 1376,
    dpr: 2,
    touch: true,
    userAgentProfile: 'mobile',
  },
  // Exact probes around Google's official adaptive width/height class boundaries.
  // These are layout canvases, not claims about a physical device model.
  {
    id: 'android-compact',
    name: 'Android compact boundary',
    category: 'adaptive',
    width: 599,
    height: 899,
    dpr: 1,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'adaptive',
    verifiedBy: 'android-window-size-classes',
  },
  {
    id: 'android-medium',
    name: 'Android medium boundary',
    category: 'adaptive',
    width: 600,
    height: 900,
    dpr: 1,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'adaptive',
    verifiedBy: 'android-window-size-classes',
  },
  {
    id: 'android-expanded',
    name: 'Android expanded boundary',
    category: 'adaptive',
    width: 840,
    height: 900,
    dpr: 1,
    touch: true,
    userAgentProfile: 'mobile',
    platform: 'adaptive',
    verifiedBy: 'android-window-size-classes',
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
  {
    id: 'macbook-air-13',
    name: '13-inch Retina laptop layout',
    category: 'laptop',
    width: 1280,
    height: 832,
    dpr: 2,
    touch: false,
    userAgentProfile: 'desktop',
  },
  {
    id: 'macbook-pro-14',
    name: '14-inch Retina laptop layout',
    category: 'laptop',
    width: 1512,
    height: 982,
    dpr: 2,
    touch: false,
    userAgentProfile: 'desktop',
  },
  {
    id: 'macbook-pro-16',
    name: '16-inch Retina laptop layout',
    category: 'laptop',
    width: 1728,
    height: 1117,
    dpr: 2,
    touch: false,
    userAgentProfile: 'desktop',
  },
  // MacBook-style default CSS viewport (Retina often reports 1440×900)
  {
    id: 'macbook',
    name: 'Retina laptop layout',
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

export const WORKBENCH_DEVICE_PRESETS = DEVICE_PRESETS.filter(
  (device) => device.category !== 'responsive',
);

const DEVICE_GROUP_ORDER: ReadonlyArray<{ id: DevicePresetGroupId; label: string }> = [
  { id: 'responsive', label: 'Responsive' },
  { id: 'apple-phones', label: 'Apple phones' },
  { id: 'android-phones', label: 'Android phones' },
  { id: 'tablets', label: 'Tablets' },
  { id: 'adaptive', label: 'Google adaptive layouts' },
  { id: 'computers', label: 'Laptops & desktops' },
  { id: 'custom', label: 'Custom' },
];

function deviceGroupId(device: DevicePreset): DevicePresetGroupId {
  if (device.category === 'responsive') return 'responsive';
  if (device.category === 'custom') return 'custom';
  if (device.category === 'adaptive') return 'adaptive';
  if (device.category === 'tablet') return 'tablets';
  if (device.category === 'laptop' || device.category === 'desktop') return 'computers';
  return device.platform === 'android' ? 'android-phones' : 'apple-phones';
}

export function groupDevicePresets(presets: readonly DevicePreset[]): DevicePresetGroup[] {
  return DEVICE_GROUP_ORDER.map(({ id, label }) => ({
    id,
    label,
    devices: presets.filter((device) => deviceGroupId(device) === id),
  })).filter((group) => group.devices.length > 0);
}

export function classifyAndroidWindow(width: number, height: number): AndroidWindowClasses {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  return {
    width:
      safeWidth < 600
        ? 'compact'
        : safeWidth < 840
          ? 'medium'
          : safeWidth < 1200
            ? 'expanded'
            : safeWidth < 1600
              ? 'large'
              : 'extra-large',
    height: safeHeight < 480 ? 'compact' : safeHeight < 900 ? 'medium' : 'expanded',
  };
}

export function deviceVerificationLabel(preset: DevicePreset): string | null {
  switch (preset.verifiedBy) {
    case 'chrome-devtools':
      return 'Chrome DevTools verified';
    case 'playwright':
      return 'Playwright verified';
    case 'android-window-size-classes':
      return 'Google adaptive boundary';
    default:
      return null;
  }
}

function boundedNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function createPreviewEmulation(
  preset: DevicePreset,
  orientation: 'portrait' | 'landscape',
  logical: { width: number; height: number },
  displayScale: number,
): PreviewEmulation {
  const viewportWidth = Math.round(boundedNumber(logical.width, 390, 200, 3840));
  const viewportHeight = Math.round(boundedNumber(logical.height, 844, 200, 2400));
  return {
    viewportWidth,
    viewportHeight,
    screenWidth: viewportWidth,
    screenHeight: viewportHeight,
    deviceScaleFactor: boundedNumber(preset.dpr, 1, 0.5, 8),
    displayScale: boundedNumber(displayScale, 1, 0.1, 2),
    mobile: preset.userAgentProfile === 'mobile',
    touch: preset.touch,
    orientation,
  };
}

export function defaultOrientationForPreset(preset: DevicePreset): 'portrait' | 'landscape' {
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
