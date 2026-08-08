import { describe, expect, it } from 'vitest';
import {
  CANCELLED_BY_USER_TOAST,
  createEscapeCancelState,
  ESCAPE_CANCEL_WINDOW_MS,
  recordEscapePress,
} from './composerEscapeCancel';

describe('composerEscapeCancel', () => {
  it('does not cancel on the first or second press', () => {
    let state = createEscapeCancelState();
    let r = recordEscapePress(state, 1_000);
    expect(r.shouldCancelRun).toBe(false);
    expect(r.count).toBe(1);
    state = r.state;
    r = recordEscapePress(state, 1_000 + 200);
    expect(r.shouldCancelRun).toBe(false);
    expect(r.count).toBe(2);
  });

  it('cancels on the third press within the window and resets', () => {
    let state = createEscapeCancelState();
    state = recordEscapePress(state, 1_000).state;
    state = recordEscapePress(state, 1_200).state;
    const r = recordEscapePress(state, 1_400);
    expect(r.shouldCancelRun).toBe(true);
    expect(r.count).toBe(3);
    expect(r.state.count).toBe(0);
    expect(CANCELLED_BY_USER_TOAST.title).toBe('Cancelled by user');
  });

  it('resets the count when presses are outside the window', () => {
    let state = createEscapeCancelState();
    state = recordEscapePress(state, 1_000).state;
    state = recordEscapePress(state, 1_200).state;
    const r = recordEscapePress(state, 1_200 + ESCAPE_CANCEL_WINDOW_MS + 1);
    expect(r.shouldCancelRun).toBe(false);
    expect(r.count).toBe(1);
  });
});
