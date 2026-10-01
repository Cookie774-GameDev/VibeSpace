export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

export function resolveAct(progress, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Act count must be a positive integer.');
  }

  const bounded = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  if (bounded === 1) return { index: count - 1, local: 1 };

  const scaled = bounded * count;
  const index = Math.min(count - 1, Math.floor(scaled));
  return {
    index,
    local: scaled - index,
  };
}
