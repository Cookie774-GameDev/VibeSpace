import { isSafeWallpaperAssetUrl } from './wallpapers';
import type { WallpaperId, WorkbenchWallpaperConfig } from './types';

const WALLPAPER_IDS = new Set<WallpaperId>([
  'none',
  'warm-gradient',
  'space-clouds',
  'starfield',
  'orbital-lights',
  'particles',
  'fluid-gradient',
  'aurora',
  'cozy-night-window',
  'grid-pulse',
  'custom-image',
  'custom-video',
  'user-pack',
]);

// The picker accepts videos up to 18 MiB; base64 encoding expands them by roughly one third.
const MAX_PERSISTED_ASSET_URL_LENGTH = 26_000_000;

export const DEFAULT_CANVAS_WALLPAPER: Readonly<WorkbenchWallpaperConfig> = Object.freeze({
  id: 'none',
  paused: false,
  interactive: true,
  intensity: 0.72,
  brightness: 0.5,
  quality: 'balanced',
});

function clamp(value: unknown, fallback: number): number {
  return Math.max(
    0,
    Math.min(1, typeof value === 'number' && Number.isFinite(value) ? value : fallback),
  );
}

export function normalizeWallpaperConfig(
  value: unknown,
  fallback: Readonly<WorkbenchWallpaperConfig> = DEFAULT_CANVAS_WALLPAPER,
): WorkbenchWallpaperConfig {
  const input =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const id =
    typeof input.id === 'string' && WALLPAPER_IDS.has(input.id as WallpaperId)
      ? (input.id as WallpaperId)
      : fallback.id;
  const assetKind = id === 'custom-image' ? 'image' : id === 'custom-video' ? 'video' : null;
  const candidateAsset =
    typeof input.assetUrl === 'string'
      ? input.assetUrl.slice(0, MAX_PERSISTED_ASSET_URL_LENGTH)
      : undefined;
  const assetUrl =
    assetKind && candidateAsset && isSafeWallpaperAssetUrl(candidateAsset, assetKind)
      ? candidateAsset
      : undefined;

  return {
    id,
    paused: typeof input.paused === 'boolean' ? input.paused : fallback.paused,
    interactive: typeof input.interactive === 'boolean' ? input.interactive : fallback.interactive,
    intensity: clamp(input.intensity, fallback.intensity),
    brightness: clamp(input.brightness, fallback.brightness),
    quality:
      input.quality === 'low' || input.quality === 'balanced' || input.quality === 'high'
        ? input.quality
        : fallback.quality,
    ...(assetUrl ? { assetUrl } : {}),
  };
}
