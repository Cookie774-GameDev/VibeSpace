import { describe, expect, it } from 'vitest';
import {
  DOUBLE_ESCAPE_WINDOW_MS,
  createDoubleEscapeSkipState,
  noteEscapeKeyEvent,
} from './doubleEscapeSkip';

function escape(partial: {
  repeat?: boolean;
  now: number;
  key?: string;
  code?: string;
}) {
  return {
    key: partial.key ?? 'Escape',
    code: partial.code ?? 'Escape',
    repeat: partial.repeat ?? false,
    timeStamp: partial.now,
    now: partial.now,
  };
}

describe('doubleEscapeSkip', () => {
  it('ignores a single Escape press', () => {
    const state = createDoubleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
  });

  it('skips on two Escape presses within 600 ms', () => {
    const state = createDoubleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 + DOUBLE_ESCAPE_WINDOW_MS }))).toBe(
      true,
    );
  });

  it('does not skip when the second Escape is outside the window', () => {
    const state = createDoubleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(
      noteEscapeKeyEvent(state, escape({ now: 1000 + DOUBLE_ESCAPE_WINDOW_MS + 1 })),
    ).toBe(false);
    // The late press becomes the new first press.
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 + DOUBLE_ESCAPE_WINDOW_MS + 100 }))).toBe(
      true,
    );
  });

  it('ignores Escape auto-repeat (held key)', () => {
    const state = createDoubleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1050, repeat: true }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1100, repeat: true }))).toBe(false);
  });

  it('ignores non-Escape keys and mouse-like codes', () => {
    const state = createDoubleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000, key: 'Enter', code: 'Enter' }))).toBe(
      false,
    );
    expect(noteEscapeKeyEvent(state, escape({ now: 1100 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1200, key: 'a', code: 'KeyA' }))).toBe(false);
  });
});
