import { createSoftAura } from './softAura';
import { JARVIS_EDGE_PRESETS, type JarvisEdgePreset } from './presets';
import type { JarvisAmbientSnapshot } from './types';
export const JARVIS_AURA_SENSITIVITY = 5.5;
export function auraEnergy(state: JarvisAmbientSnapshot['state'], energy: number) {
  return (state === 'listening' || state === 'speaking') && Number.isFinite(energy)
    ? Math.min(1, Math.max(0, energy) * JARVIS_AURA_SENSITIVITY)
    : 0;
}
export function createAuraRenderer() {
  const soft = createSoftAura();
  function drawAura(
    context: CanvasRenderingContext2D,
    snapshot: JarvisAmbientSnapshot,
    width: number,
    height: number,
    now: number,
    reducedMotion: boolean,
    override?: JarvisEdgePreset,
  ) {
    if (['listening', 'speaking', 'working', 'done'].includes(snapshot.state)) {
      soft.draw(context, snapshot, width, height, now, reducedMotion, override);
      return;
    }
    context.clearRect(0, 0, width, height);
    if (snapshot.active === false || (snapshot.state === 'idle' && snapshot.active !== true))
      return;
    const preset = override ?? JARVIS_EDGE_PRESETS[snapshot.state];
    const energy =
      snapshot.state === 'listening' || snapshot.state === 'speaking'
        ? Math.min(1, Math.pow(snapshot.energy * preset.energyGain, 0.82))
        : 0;
    const phase =
      reducedMotion || preset.periodMs === 0 ? 0 : (now % preset.periodMs) / preset.periodMs;
    const flash =
      snapshot.state === 'needs' || snapshot.state === 'error'
        ? reducedMotion
          ? 0.9
          : 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2))
        : 1;
    const depth = Math.min(width, height) * 0.09 + preset.glow + energy * 48;
    const rgba = (hex: string, alpha: number) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return (
        'rgba(' +
        (value >> 16) +
        ',' +
        ((value >> 8) & 255) +
        ',' +
        (value & 255) +
        ',' +
        alpha +
        ')'
      );
    };
    context.save();
    context.globalCompositeOperation = 'source-over';
    // Continuous inward falloff: no outlined rectangle or sharp travelling core.
    const edges = [
      [0, 0, 0, depth, 0, 0, width, depth],
      [width, 0, width - depth, 0, width - depth, 0, depth, height],
      [0, height, 0, height - depth, 0, height - depth, width, depth],
      [0, 0, depth, 0, 0, 0, depth, height],
    ];
    const breathe = reducedMotion ? 1 : 0.84 + 0.16 * Math.sin(phase * Math.PI * 2);
    for (const [x0, y0, x1, y1, x, y, w, h] of edges) {
      const gradient = context.createLinearGradient(x0, y0, x1, y1);
      const opacity =
        preset.alpha *
        flash *
        breathe *
        (snapshot.state === 'error' || snapshot.state === 'needs' ? 0.68 : 0.3 + energy * 0.15);
      gradient.addColorStop(0, rgba(preset.color, opacity));
      gradient.addColorStop(0.25, rgba(preset.color, opacity * 0.52));
      gradient.addColorStop(0.6, rgba(preset.color, opacity * 0.12));
      gradient.addColorStop(1, rgba(preset.color, 0));
      context.fillStyle = gradient;
      context.fillRect(x, y, w, h);
    }
    context.restore();
  }

  return {
    draw: drawAura,
    warm(context: CanvasRenderingContext2D, width: number, height: number) {
      soft.warm(context, width, height);
    },
    destroy() {
      soft.destroy();
    },
  };
}
