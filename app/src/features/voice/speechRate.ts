/** Clamp and boost speech rates so Jarvis replies feel snappy across all engines. */
const MIN_RATE = 1.05;
const MAX_RATE = 2;

export function resolveSpeechRate(baseRate: number): number {
  if (!Number.isFinite(baseRate)) return 1.22;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, baseRate));
}
