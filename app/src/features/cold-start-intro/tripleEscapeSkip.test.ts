import { describe, expect, it } from 'vitest';
import { createTripleEscapeSkipState, noteEscapeKeyEvent } from './tripleEscapeSkip';

function escape(partial: { repeat?: boolean; now: number; key?: string; code?: string }) {
  return {
    key: partial.key ?? 'Escape',
    code: partial.code ?? 'Escape',
    repeat: partial.repeat ?? false,
    timeStamp: partial.now,
    now: partial.now,
  };
}

describe('tripleEscapeSkip', () => {
  it('ignores a single Escape press', () => {
    const state = createTripleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
  });

  it('requires three distinct Escape presses within three seconds', () => {
    const state = createTripleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 2000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 4000 }))).toBe(true);
  });

  it('resets when three presses do not fit inside the three-second window', () => {
    const state = createTripleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 2000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 4001 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 5000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 6000 }))).toBe(true);
  });

  it('ignores Escape auto-repeat (held key)', () => {
    const state = createTripleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1050, repeat: true }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1100, repeat: true }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1500 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 2000 }))).toBe(true);
  });

  it('ignores non-Escape keys and mouse-like codes', () => {
    const state = createTripleEscapeSkipState();
    expect(noteEscapeKeyEvent(state, escape({ now: 1000, key: 'Enter', code: 'Enter' }))).toBe(
      false,
    );
    expect(noteEscapeKeyEvent(state, escape({ now: 1100 }))).toBe(false);
    expect(noteEscapeKeyEvent(state, escape({ now: 1200, key: 'a', code: 'KeyA' }))).toBe(false);
  });
});
