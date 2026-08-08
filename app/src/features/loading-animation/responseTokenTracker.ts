/**
 * Per-response output-token tracker for independent animation speed.
 * No React renders on every token — callers sample at ≤10 Hz.
 */

import {
  BASELINE_PLAYBACK_RATE,
  TPS_HOLD_MS,
  TPS_SMOOTH_ALPHA,
  TPS_WINDOW_MS,
  easePlaybackRate,
  estimateOutputTokensFromText,
  playbackRateForOutputTps,
} from './tokenSpeedCurve';

export type ResponseLifecycle =
  | 'idle'
  | 'waiting'
  | 'streaming'
  | 'tooling'
  | 'settling'
  | 'stopping'
  | 'error';

export interface ResponseTokenSnapshot {
  responseId: string;
  lifecycle: ResponseLifecycle;
  rawTps: number;
  smoothedTps: number;
  targetPlaybackRate: number;
  currentPlaybackRate: number;
  totalOutputTokens: number;
  countingMode: 'exact' | 'estimated' | 'unknown';
  lastTokenAt: number | null;
  updatedAt: number;
}

interface TokenSample {
  at: number;
  tokens: number;
}

interface TrackerState {
  responseId: string;
  lifecycle: ResponseLifecycle;
  samples: TokenSample[];
  totalOutputTokens: number;
  lastTokenAt: number | null;
  lastStableTps: number;
  smoothedTps: number;
  targetRate: number;
  currentRate: number;
  countingMode: 'exact' | 'estimated' | 'unknown';
  lastTickAt: number;
  settleUntil: number | null;
}

const trackers = new Map<string, TrackerState>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function getOrCreate(responseId: string): TrackerState {
  let state = trackers.get(responseId);
  if (!state) {
    const t = now();
    state = {
      responseId,
      lifecycle: 'waiting',
      samples: [],
      totalOutputTokens: 0,
      lastTokenAt: null,
      lastStableTps: 0,
      smoothedTps: 0,
      targetRate: BASELINE_PLAYBACK_RATE,
      currentRate: BASELINE_PLAYBACK_RATE,
      countingMode: 'unknown',
      lastTickAt: t,
      settleUntil: null,
    };
    trackers.set(responseId, state);
  }
  return state;
}

export function beginResponse(responseId: string, opts?: { reset?: boolean }): void {
  if (!opts?.reset && trackers.has(responseId)) {
    const existing = trackers.get(responseId)!;
    if (existing.lifecycle === 'idle' || existing.lifecycle === 'stopping' || existing.lifecycle === 'error') {
      existing.lifecycle = 'waiting';
      existing.settleUntil = null;
    }
    return;
  }
  const t = now();
  trackers.set(responseId, {
    responseId,
    lifecycle: 'waiting',
    samples: [],
    totalOutputTokens: 0,
    lastTokenAt: null,
    lastStableTps: 0,
    smoothedTps: 0,
    targetRate: BASELINE_PLAYBACK_RATE,
    currentRate: BASELINE_PLAYBACK_RATE,
    countingMode: 'unknown',
    lastTickAt: t,
    settleUntil: null,
  });
}

export function noteOutputTokens(
  responseId: string,
  deltaTokens: number,
  mode: 'exact' | 'estimated' = 'estimated',
): void {
  if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return;
  const state = getOrCreate(responseId);
  const t = now();
  state.totalOutputTokens += deltaTokens;
  state.lastTokenAt = t;
  state.countingMode = mode;
  if (state.lifecycle === 'waiting' || state.lifecycle === 'tooling') {
    state.lifecycle = 'streaming';
  }
  state.samples.push({ at: t, tokens: deltaTokens });
  pruneSamples(state, t);
}

export function noteOutputTextDelta(responseId: string, textDelta: string): void {
  if (!textDelta) return;
  noteOutputTokens(responseId, estimateOutputTokensFromText(textDelta), 'estimated');
}

export function setResponseLifecycle(responseId: string, lifecycle: ResponseLifecycle): void {
  const state = getOrCreate(responseId);
  const t = now();
  if (lifecycle === 'settling') {
    state.lifecycle = 'settling';
    state.settleUntil = t + 150;
    return;
  }
  if (lifecycle === 'stopping' || lifecycle === 'error' || lifecycle === 'idle') {
    state.lifecycle = lifecycle;
    state.settleUntil = t + (lifecycle === 'stopping' ? 120 : 0);
    return;
  }
  state.lifecycle = lifecycle;
  state.settleUntil = null;
}

function pruneSamples(state: TrackerState, t: number): void {
  const cutoff = t - TPS_WINDOW_MS;
  while (state.samples.length > 0 && state.samples[0]!.at < cutoff) {
    state.samples.shift();
  }
}

function computeRawTps(state: TrackerState, t: number): number {
  pruneSamples(state, t);
  if (state.samples.length === 0) return 0;
  const windowStart = Math.min(state.samples[0]!.at, t - TPS_WINDOW_MS);
  const elapsed = Math.max(1, t - windowStart);
  const tokens = state.samples.reduce((sum, s) => sum + s.tokens, 0);
  return (tokens * 1000) / elapsed;
}

/**
 * Advance smoothing / ease clocks. Call from a ≤10 Hz interval while active.
 */
export function tickResponse(responseId: string, at = now()): ResponseTokenSnapshot {
  const state = getOrCreate(responseId);
  const dt = Math.max(0, at - state.lastTickAt);
  state.lastTickAt = at;

  if (state.lifecycle === 'settling' && state.settleUntil != null && at >= state.settleUntil) {
    state.lifecycle = 'idle';
  }

  let rawTps = computeRawTps(state, at);
  const gap = state.lastTokenAt == null ? Number.POSITIVE_INFINITY : at - state.lastTokenAt;

  if (
    (state.lifecycle === 'streaming' || state.lifecycle === 'tooling') &&
    gap > TPS_HOLD_MS &&
    rawTps < 0.01
  ) {
    // Ease toward baseline after brief hold of last stable rate.
    rawTps = 0;
  } else if (gap <= TPS_HOLD_MS && rawTps < 0.01 && state.lastStableTps > 0) {
    rawTps = state.lastStableTps;
  }

  if (rawTps > 0) {
    state.smoothedTps =
      state.smoothedTps <= 0
        ? rawTps
        : state.smoothedTps + TPS_SMOOTH_ALPHA * (rawTps - state.smoothedTps);
    state.lastStableTps = state.smoothedTps;
  } else if (state.lifecycle === 'waiting' || state.lifecycle === 'tooling') {
    // No tokens yet / tool gap → drift smoothed TPS toward 0 so rate → baseline.
    state.smoothedTps = state.smoothedTps * (1 - TPS_SMOOTH_ALPHA * 0.5);
  }

  const preToken =
    state.lifecycle === 'waiting' ||
    (state.totalOutputTokens === 0 && state.countingMode === 'unknown');
  state.targetRate = preToken
    ? BASELINE_PLAYBACK_RATE
    : playbackRateForOutputTps(state.smoothedTps > 0.05 ? state.smoothedTps : null);

  state.currentRate = easePlaybackRate(state.currentRate, state.targetRate, dt || 100, {
    accelerating: state.targetRate > state.currentRate,
  });

  return snapshotOf(state, at, rawTps);
}

export function getResponseSnapshot(responseId: string): ResponseTokenSnapshot | null {
  const state = trackers.get(responseId);
  if (!state) return null;
  return snapshotOf(state, now(), computeRawTps(state, now()));
}

export function endResponse(responseId: string): void {
  trackers.delete(responseId);
}

export function clearAllResponseTrackers(): void {
  trackers.clear();
}

function snapshotOf(state: TrackerState, at: number, rawTps: number): ResponseTokenSnapshot {
  return {
    responseId: state.responseId,
    lifecycle: state.lifecycle,
    rawTps,
    smoothedTps: state.smoothedTps,
    targetPlaybackRate: state.targetRate,
    currentPlaybackRate: state.currentRate,
    totalOutputTokens: state.totalOutputTokens,
    countingMode: state.countingMode,
    lastTokenAt: state.lastTokenAt,
    updatedAt: at,
  };
}

/** Test helper: number of live trackers. */
export function activeTrackerCount(): number {
  return trackers.size;
}
