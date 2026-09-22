import { EDGE_AURA_PALETTES } from './edge-aura/palettes';
import { createAuraEngine, type AuraEngine, type EdgeAuraPaletteStops } from './edge-aura/engine';
import { JARVIS_EDGE_PRESETS, type JarvisEdgePreset } from './presets';
import type { JarvisAmbientSnapshot } from './types';

const WARM_SNAPSHOT: JarvisAmbientSnapshot = Object.freeze({
  revision: 0,
  state: 'listening',
  source: 'voice',
  observedAt: 0,
  energy: 0,
  active: true,
});

export function createSoftAura() {
  let engine: AuraEngine | null = null,
    buffer: HTMLCanvasElement | null = null,
    lastState = '',
    lastPreset: JarvisEdgePreset | null = null,
    lastTime = -1,
    lastSize = '',
    lastEnergy = 0;
  function drawSoftAura(
    context: CanvasRenderingContext2D,
    snapshot: JarvisAmbientSnapshot,
    width: number,
    height: number,
    now: number,
    reducedMotion: boolean,
    override?: JarvisEdgePreset,
  ) {
    const preset = override ?? JARVIS_EDGE_PRESETS[snapshot.state],
      moving = ['listening', 'speaking', 'working'].includes(snapshot.state),
      idle = snapshot.state === 'idle';
    const size = width + 'x' + height,
      changed = lastState !== snapshot.state || lastPreset !== preset;
    if (!buffer) {
      buffer = document.createElement('canvas');
      engine = createAuraEngine(buffer, { seed: 19 });
    }
    if (changed) {
      const hex = preset.color,
        n = Number.parseInt(hex.slice(1), 16),
        rgb: [number, number, number] = [n >> 16, (n >> 8) & 255, n & 255];
      const stops: EdgeAuraPaletteStops = moving
        ? EDGE_AURA_PALETTES.ocean.map(([t, c]) => [
            t,
            [c[0] * 0.8 + rgb[0] * 0.2, c[1] * 0.8 + rgb[1] * 0.2, c[2] * 0.8 + rgb[2] * 0.2],
          ])
        : [
            [0, rgb],
            [1, rgb],
          ];
      engine!.updateOptions({
        geometry: {
          inset: 1,
          cornerRadius: 14,
          cornerFill: false,
          band: Math.min(100, 48 + preset.glow),
          coreSigmaBase: 1.15,
          coreSigmaVar: 0.12,
          innerSoftBase: 1.7,
          innerSoftVar: 0.35,
          innerSigmaMax: 23,
        },
        palette: {
          stops,
          pastel: moving ? 0.08 : 0,
          ringAlpha: preset.alpha,
          normalize: false,
          background: 'dark',
          coreWhiten: 0,
          blendMode: 'source-over',
        },
        motion: {
          rotateIdleS: moving ? preset.periodMs / 1000 : 120,
          hueDriftDeg: moving ? 5 : 0,
          highlight: {
            arcDeg: moving ? 65 : 0,
            periodS: preset.periodMs / 1000,
            min: moving ? 0.24 : 1,
          },
        },
      });
      lastState = snapshot.state;
      lastPreset = preset;
    }
    if (size !== lastSize) {
      engine!.resize();
      lastSize = size;
    }
    const dt = lastTime < 0 || changed || now < lastTime ? 0 : Math.min(100, now - lastTime);
    lastTime = now;
    if (snapshot.active === false) {
      context.clearRect(0, 0, width, height);
      return;
    }
    const energy = moving && snapshot.state !== 'working' ? snapshot.energy : 0;
    if (energy > lastEnergy + 0.025) engine!.pulse((energy - lastEnergy) * 0.7);
    lastEnergy = energy;
    if (reducedMotion) engine!.renderStatic();
    else {
      engine!.step(
        dt *
          (snapshot.state === 'listening' || snapshot.state === 'speaking'
            ? 0.55 + energy * 1.45
            : 1),
      );
      engine!.render();
    }
    const phase = (now % preset.periodMs) / preset.periodMs,
      wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const alpha = reducedMotion
      ? 1
      : moving
        ? snapshot.state === 'working'
          ? 0.82 + 0.18 * wave
          : 0.32 + 0.68 * energy
        : idle
          ? 0.15 + 0.45 * wave
          : 0.12 + 0.8 * Math.pow(wave, 1.3);
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalAlpha = alpha;
    context.drawImage(buffer!, 0, 0, width, height);
    context.restore();
  }

  function warm(context: CanvasRenderingContext2D, width: number, height: number) {
    drawSoftAura(context, WARM_SNAPSHOT, width, height, 0, true);
    context.clearRect(0, 0, width, height);
  }

  return {
    draw: drawSoftAura,
    warm,
    destroy() {
      engine?.destroy();
      engine = null;
      buffer = null;
      lastState = '';
      lastPreset = null;
      lastSize = '';
      lastTime = -1;
      lastEnergy = 0;
    },
  };
}
