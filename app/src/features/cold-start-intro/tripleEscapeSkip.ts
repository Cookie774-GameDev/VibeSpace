/**
 * Three-Escape skip detector for the cold-start cinematic intro.
 *
 * Three distinct Escape key presses within three seconds skip. Holding Escape
 * (auto-repeat) must not count as multiple presses.
 */

export const THREE_ESCAPE_WINDOW_MS = 3000;

export type TripleEscapeSkipState = {
  /** Timestamp of the first accepted Escape press in the current window. */
  firstEscapeAt: number | null;
  /** Number of distinct, non-repeating Escape keydowns in the current window. */
  escapeCount: number;
};

export function createTripleEscapeSkipState(): TripleEscapeSkipState {
  return { firstEscapeAt: null, escapeCount: 0 };
}

/**
 * Process a keyboard event. Returns true when the third valid Escape arrives
 * within the window that began with the first accepted press.
 */
export function noteEscapeKeyEvent(
  state: TripleEscapeSkipState,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'repeat' | 'timeStamp'> & {
    now?: number;
  },
): boolean {
  const isEscape = event.key === 'Escape' || event.code === 'Escape';
  if (!isEscape) return false;
  // Keyboard auto-repeat must never count as another distinct press.
  if (event.repeat) return false;

  const now =
    typeof event.now === 'number'
      ? event.now
      : typeof event.timeStamp === 'number' && event.timeStamp > 0
        ? event.timeStamp
        : Date.now();

  if (
    state.firstEscapeAt == null ||
    now < state.firstEscapeAt ||
    now - state.firstEscapeAt > THREE_ESCAPE_WINDOW_MS
  ) {
    state.firstEscapeAt = now;
    state.escapeCount = 1;
    return false;
  }

  state.escapeCount += 1;
  if (state.escapeCount >= 3) {
    state.firstEscapeAt = null;
    state.escapeCount = 0;
    return true;
  }
  return false;
}
