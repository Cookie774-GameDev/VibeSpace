import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHotkey } from './hotkeys';

function HotkeyProbe({ onHit }: { onHit: (event: KeyboardEvent) => void }) {
  useHotkey('Mod+Space', onHit, { whenInputs: true });
  return null;
}

describe('useHotkey', () => {
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
});
