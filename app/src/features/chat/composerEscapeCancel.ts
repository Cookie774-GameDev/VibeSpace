/**
 * Triple-Escape cancel gesture for an active Jarvis run.
 * Pure counter — Composer owns when Esc is free (no open typeahead).
 */

export const ESCAPE_CANCEL_WINDOW_MS = 900;
export const ESCAPE_CANCEL_REQUIRED = 3;

export interface EscapeCancelState {
  count: number;
  lastAt: number;
}

export function createEscapeCancelState(): EscapeCancelState {
  return { count: 0, lastAt: 0 };
}

export function recordEscapePress(
  state: EscapeCancelState,
  now = Date.now(),
  windowMs = ESCAPE_CANCEL_WINDOW_MS,
): { state: EscapeCancelState; shouldCancelRun: boolean; count: number } {
  const withinWindow = state.lastAt > 0 && now - state.lastAt <= windowMs;
  const count = withinWindow ? state.count + 1 : 1;
  const next: EscapeCancelState = { count, lastAt: now };
  if (count >= ESCAPE_CANCEL_REQUIRED) {
    return {
      state: createEscapeCancelState(),
      shouldCancelRun: true,
      count,
    };
  }
  return { state: next, shouldCancelRun: false, count };
}

export const CANCELLED_BY_USER_TOAST = {
  title: 'Cancelled by user',
  body: 'The current request was cancelled. Queue is kept — send again or press Resume when ready.',
} as const;
