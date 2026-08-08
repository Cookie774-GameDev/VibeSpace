import * as React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHotkeyBindingsForTests,
  setHotkeyBinding,
  useBoundHotkey,
  useHotkey,
} from './hotkeys';

function HotkeyProbe({ onHit }: { onHit: (event: KeyboardEvent) => void }) {
  useHotkey('Mod+Space', onHit, { whenInputs: true });
  return null;
}

function BoundProbe({ onHit }: { onHit: (event: KeyboardEvent) => void }) {
  useBoundHotkey('TOGGLE_NAV', onHit, { whenInputs: true });
  return null;
}

describe('useHotkey', () => {
  beforeEach(() => {
    __resetHotkeyBindingsForTests();
    window.localStorage.removeItem('jarvis-hotkeys-v1');
  });

  afterEach(() => {
    __resetHotkeyBindingsForTests();
    window.localStorage.removeItem('jarvis-hotkeys-v1');
  });

  it('ignores key repeat events so toggle shortcuts do not immediately undo themselves', () => {
    const onHit = vi.fn();
    render(<HotkeyProbe onHit={onHit} />);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        ctrlKey: true,
        repeat: true,
        bubbles: true,
      }),
    );

    expect(onHit).toHaveBeenCalledTimes(1);
  });

  it('applies rebound combos immediately for useBoundHotkey', () => {
    const onHit = vi.fn();
    render(<BoundProbe onHit={onHit} />);

    // Default Mod+B
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
    );
    expect(onHit).toHaveBeenCalledTimes(1);

    // Free a combo and rebind TOGGLE_NAV to Mod+Shift+B
    setHotkeyBinding('TOGGLE_NAV', 'Mod+Shift+B');

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
    );
    // Old combo should no longer fire
    expect(onHit).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(onHit).toHaveBeenCalledTimes(2);
  });
});
