export const THOUGHT_BLOOM_DURATION_MS = 2190;
export const MAX_THOUGHT_BLOOM_PARTICLES = 360;
export const MAX_ANIMATED_TITLE_GRAPHEMES = 72;

export interface ThoughtBloomOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThoughtBloomParticle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  gravity: number;
  radius: number;
  delay: number;
  life: number;
  alpha: number;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashThoughtBloomSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function splitTitleGraphemes(title: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(title), ({ segment }) => segment);
  }
  return Array.from(title);
}

export function getCanvasPixelSize(width: number, height: number, devicePixelRatio: number) {
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  return {
    width: Math.max(1, Math.round(width * dpr)),
    height: Math.max(1, Math.round(height * dpr)),
    dpr,
  };
}

export function createThoughtBloomParticles(
  origins: readonly ThoughtBloomOrigin[],
  seed: number,
  maximum = MAX_THOUGHT_BLOOM_PARTICLES,
): ThoughtBloomParticle[] {
  const random = mulberry32(seed);
  const particles: ThoughtBloomParticle[] = [];

  for (const origin of origins) {
    const count = 5 + Math.floor(random() * 5);
    for (let index = 0; index < count && particles.length < maximum; index += 1) {
      const angle = -Math.PI * (0.12 + random() * 0.76);
      const speed = 0.65 + random() * 1.35;
      particles.push({
        x: origin.x + (random() - 0.5) * origin.width * 0.72,
        y: origin.y + (random() - 0.5) * origin.height * 0.55,
        velocityX: Math.cos(angle) * speed + (random() - 0.5) * 0.55,
        velocityY: Math.sin(angle) * speed,
        gravity: 0.55 + random() * 0.5,
        radius: 0.7 + random() * 2.1,
        delay: random() * 0.1,
        life: 0.34 + random() * 0.3,
        alpha: 0.34 + random() * 0.5,
      });
    }
    if (particles.length >= maximum) break;
  }

  return particles;
}
