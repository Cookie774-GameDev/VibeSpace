import type { WallpaperId } from './types';

export type WallpaperRenderer = 'none' | 'css' | 'canvas' | 'image' | 'video';

/**
 * Wallpaper definitions contain renderer metadata only. There are no render
 * callbacks, module URLs, script fields, or access to app state/Tauri commands.
 */
export interface WallpaperDefinition {
  id: WallpaperId;
  name: string;
  description: string;
  renderer: WallpaperRenderer;
  preview: string;
  interactive: boolean;
  animated: boolean;
  reducedMotionFallback: 'static' | 'slow';
}

export const BUILT_IN_WALLPAPERS: WallpaperDefinition[] = [
  {
    id: 'none',
    name: 'None',
    description: 'A distraction-free solid surface.',
    renderer: 'none',
    preview: 'ink',
    interactive: false,
    animated: false,
    reducedMotionFallback: 'static',
  },
  {
    id: 'warm-gradient',
    name: 'Warm Gradient',
    description: 'Soft copper light across deep paper.',
    renderer: 'css',
    preview: 'ember',
    interactive: false,
    animated: false,
    reducedMotionFallback: 'static',
  },
  {
    id: 'space-clouds',
    name: 'Interactive Space Clouds',
    description: 'Pointer-responsive nebula clouds and distant stars.',
    renderer: 'canvas',
    preview: 'nebula',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'starfield',
    name: 'Starfield',
    description: 'A calm layered field of drifting stars.',
    renderer: 'canvas',
    preview: 'stars',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'slow',
  },
  {
    id: 'orbital-lights',
    name: 'Orbital Lights',
    description: 'Warm lights moving on wide orbital paths.',
    renderer: 'css',
    preview: 'orbit',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'particles',
    name: 'Particle Field',
    description: 'Fine particles gently follow the cursor.',
    renderer: 'canvas',
    preview: 'dust',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'fluid-gradient',
    name: 'Fluid Gradient',
    description: 'A slow, premium copper-violet color flow.',
    renderer: 'css',
    preview: 'fluid',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Muted curtains of teal, violet, and ember.',
    renderer: 'css',
    preview: 'aurora',
    interactive: false,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'cozy-night-window',
    name: 'Cozy Night Window',
    description: 'Rain-lit warmth beyond a quiet window.',
    renderer: 'css',
    preview: 'night',
    interactive: false,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'grid-pulse',
    name: 'Grid Pulse',
    description: 'A precise spatial grid with a faint pulse.',
    renderer: 'css',
    preview: 'grid',
    interactive: true,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'custom-image',
    name: 'Custom Image',
    description: 'A local or trusted remote image.',
    renderer: 'image',
    preview: 'image',
    interactive: false,
    animated: false,
    reducedMotionFallback: 'static',
  },
  {
    id: 'custom-video',
    name: 'Custom Video',
    description: 'A muted, looped local or trusted video.',
    renderer: 'video',
    preview: 'video',
    interactive: false,
    animated: true,
    reducedMotionFallback: 'static',
  },
  {
    id: 'user-pack',
    name: 'Nightfall Haze',
    description: 'A static copper and violet glow over a deep charcoal background.',
    renderer: 'css',
    preview: 'nightfall',
    interactive: false,
    animated: false,
    reducedMotionFallback: 'static',
  },
];

const VALID_RENDERERS = new Set<WallpaperRenderer>(['none', 'css', 'canvas', 'image', 'video']);

export function validateWallpaperDefinition(
  candidate: WallpaperDefinition,
): { ok: true } | { ok: false; reason: string } {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'Invalid entry' };
  if (!BUILT_IN_WALLPAPERS.some((entry) => entry.id === candidate.id)) {
    return { ok: false, reason: 'Unknown wallpaper id' };
  }
  if (!candidate.name.trim() || !candidate.description.trim()) {
    return { ok: false, reason: 'Missing metadata' };
  }
  if (!VALID_RENDERERS.has(candidate.renderer)) {
    return { ok: false, reason: 'Unknown renderer' };
  }
  return { ok: true };
}

export function isSafeWallpaperAssetUrl(url: string, kind: 'image' | 'video'): boolean {
  const value = url.trim();
  if (!value) return false;
  // Full masters played via Tauri asset protocol (convertFileSrc).
  if (
    value.startsWith('asset:') ||
    value.startsWith('http://asset.localhost/') ||
    value.startsWith('https://asset.localhost/') ||
    value.includes('asset.localhost')
  ) {
    return true;
  }
  if (value.startsWith('blob:')) return true;
  if (kind === 'image' && /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(value)) {
    return true;
  }
  if (kind === 'video' && /^data:video\/(?:mp4|webm|ogg);base64,/i.test(value)) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function wallpaperById(id: WallpaperId): WallpaperDefinition {
  return BUILT_IN_WALLPAPERS.find((entry) => entry.id === id) ?? BUILT_IN_WALLPAPERS[0]!;
}
