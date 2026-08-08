/**
 * Double-Escape skip detector for the cold-start cinematic intro.
 *
 * Two distinct Escape key presses within 600 ms skip. Holding Escape
 * (auto-repeat) must not count as two presses.
 */

export const DOUBLE_ESCAPE_WINDOW_MS = 600;

export type DoubleEscapeSkipState = {
  /** Timestamp of the last accepted Escape press (ms since epoch). */
  lastEscapeAt: number | null;
};

export function createDoubleEscapeSkipState(): DoubleEscapeSkipState {
  return { lastEscapeAt: null };
}

/**
 * Process a keyboard event. Returns true when the second valid Escape
 * arrives within the window.
 */
export function noteEscapeKeyEvent(
  state: DoubleEscapeSkipState,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'repeat' | 'timeStamp'> & {
    now?: number;
  },
): boolean {
  const isEscape = event.key === 'Escape' || event.code === 'Escape';
  if (!isEscape) return false;
  // Keyboard auto-repeat must never count as a second press.
  if (event.repeat) return false;

  const now =
    typeof event.now === 'number'
      ? event.now
      : typeof event.timeStamp === 'number' && event.timeStamp > 0
        ? event.timeStamp
        : Date.now();

  if (state.lastEscapeAt == null) {
    state.lastEscapeAt = now;
    return false;
  }

  const delta = now - state.lastEscapeAt;
  if (delta > 0 && delta <= DOUBLE_ESCAPE_WINDOW_MS) {
    state.lastEscapeAt = null;
    return true;
  }

  // Too slow: start a new first press.
  state.lastEscapeAt = now;
  return false;
}
