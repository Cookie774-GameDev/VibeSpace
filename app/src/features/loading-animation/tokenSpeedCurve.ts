/**
 * Approved output-TPS → video playback-rate curve for the VibeSpace
 * token-reactive loading animation (first-second loop only).
 */

export const BASELINE_PLAYBACK_RATE = 0.25;
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 1.0;
/** Ignore micro jitter smaller than this when easing playback rate. */
export const PLAYBACK_RATE_EPSILON = 0.01;

/** Rolling measurement window for TPS (ms). */
export const TPS_WINDOW_MS = 1000;
/** Hold last stable rate during brief token gaps (ms). */
export const TPS_HOLD_MS = 450;
/** EMA alpha for raw TPS smoothing. */
export const TPS_SMOOTH_ALPHA = 0.25;

const ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0.12],
  [5, 0.16],
  [10, 0.2],
  [20, 0.25],
  [30, 0.3],
  [50, 0.39],
  [75, 0.48],
  [100, 0.58],
  [150, 0.67],
  [200, 0.74],
  [300, 0.85],
  [500, 1.0],
];

/**
 * Map smoothed output tokens-per-second to target video playback rate.
 * Pre-token / unknown telemetry → 0.25×. Clamp outside approved range.
 */
export function playbackRateForOutputTps(smoothedTps: number | null | undefined): number {
  if (smoothedTps == null || !Number.isFinite(smoothedTps) || smoothedTps <= 0) {
    return BASELINE_PLAYBACK_RATE;
  }
  if (smoothedTps < 1) {
    // Below 1 TPS: interpolate from min toward first anchor without dropping under 0.10.
    const t = Math.max(0, Math.min(1, smoothedTps));
    return clampRate(MIN_PLAYBACK_RATE + (0.12 - MIN_PLAYBACK_RATE) * t);
  }
  if (smoothedTps >= 500) return MAX_PLAYBACK_RATE;

  for (let i = 0; i < ANCHORS.length - 1; i += 1) {
    const [t0, r0] = ANCHORS[i]!;
    const [t1, r1] = ANCHORS[i + 1]!;
    if (smoothedTps >= t0 && smoothedTps <= t1) {
      const u = (smoothedTps - t0) / (t1 - t0);
      return clampRate(r0 + (r1 - r0) * u);
    }
  }
  return BASELINE_PLAYBACK_RATE;
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return BASELINE_PLAYBACK_RATE;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

/**
 * Ease current playback rate toward target.
 * Faster acceleration (~250ms) than deceleration (~700ms) at ~10 Hz ticks.
 */
export function easePlaybackRate(
  current: number,
  target: number,
  dtMs: number,
  opts?: { accelerating?: boolean },
): number {
  const from = clampRate(current);
  const to = clampRate(target);
  if (Math.abs(to - from) < PLAYBACK_RATE_EPSILON) return from;
  const accelerating = opts?.accelerating ?? to > from;
  // Half-life style ease: 1 - exp(-dt/tau)
  const tau = accelerating ? 250 : 700;
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return clampRate(from + (to - from) * alpha);
}

/**
 * Approximate output token count from streamed text delta.
 * Uses a lightweight estimator (~4 chars / token) to avoid blocking the UI.
 */
export function estimateOutputTokensFromText(text: string): number {
  if (!text) return 0;
  // Prefer word-ish boundaries when available; fall back to char heuristic.
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const byChars = Math.ceil(trimmed.length / 4);
  // Blend: streaming often has incomplete words.
  return Math.max(1, Math.round(words * 0.55 + byChars * 0.45));
}
