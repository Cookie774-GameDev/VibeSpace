import { describe, expect, it, vi } from 'vitest';
import { handleTerminalClipboardKey } from './terminalClipboard';

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {},
): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

function terminal(selection = 'selected output') {
  return {
    getSelection: vi.fn(() => selection),
    paste: vi.fn(),
  };
}

function clipboard(readText = 'pasted input') {
  return {
    readText: vi.fn(async () => readText),
    writeText: vi.fn(async () => undefined),
  };
}

describe('terminal clipboard shortcuts', () => {
  it('copies an xterm selection with Ctrl+Shift+C', async () => {
    const term = terminal();
    const systemClipboard = clipboard();

    expect(
      handleTerminalClipboardKey(
        keyEvent('c', { ctrlKey: true, shiftKey: true }),
        term,
        systemClipboard,
      ),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(systemClipboard.writeText).toHaveBeenCalledWith('selected output');
    });
  });

  it('copies and pastes with macOS Command shortcuts', async () => {
    const term = terminal('mac selection');
    const systemClipboard = clipboard('mac paste');

    expect(
      handleTerminalClipboardKey(keyEvent('c', { metaKey: true }), term, systemClipboard),
    ).toBe(false);
    expect(
      handleTerminalClipboardKey(keyEvent('v', { metaKey: true }), term, systemClipboard),
    ).toBe(false);

    await vi.waitFor(() => {
      expect(systemClipboard.writeText).toHaveBeenCalledWith('mac selection');
      expect(term.paste).toHaveBeenCalledWith('mac paste');
    });
  });

  it('pastes through xterm with Ctrl+Shift+V', async () => {
    const term = terminal();
    const systemClipboard = clipboard('npm test');

    expect(
      handleTerminalClipboardKey(
        keyEvent('V', { ctrlKey: true, shiftKey: true }),
        term,
        systemClipboard,
      ),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith('npm test');
    });
  });

  it('preserves Ctrl+C and unrelated keys for normal terminal input', () => {
    const term = terminal();
    const systemClipboard = clipboard();

    expect(
      handleTerminalClipboardKey(keyEvent('c', { ctrlKey: true }), term, systemClipboard),
    ).toBe(true);
    expect(handleTerminalClipboardKey(keyEvent('ArrowUp'), term, systemClipboard)).toBe(true);
    expect(systemClipboard.writeText).not.toHaveBeenCalled();
    expect(systemClipboard.readText).not.toHaveBeenCalled();
  });

  it('does nothing safely for empty clipboard values and rejected permissions', async () => {
    const emptySelectionTerminal = terminal('');
    const emptyClipboard = clipboard('');
    const rejectedClipboard = {
      readText: vi.fn(async () => {
        throw new Error('Clipboard read denied');
      }),
      writeText: vi.fn(async () => {
        throw new Error('Clipboard write denied');
      }),
    };

    expect(
      handleTerminalClipboardKey(
        keyEvent('c', { ctrlKey: true, shiftKey: true }),
        emptySelectionTerminal,
        emptyClipboard,
      ),
    ).toBe(false);
    expect(
      handleTerminalClipboardKey(
        keyEvent('v', { ctrlKey: true, shiftKey: true }),
        emptySelectionTerminal,
        emptyClipboard,
      ),
    ).toBe(false);
    expect(
      handleTerminalClipboardKey(
        keyEvent('c', { ctrlKey: true, shiftKey: true }),
        terminal('blocked'),
        rejectedClipboard,
      ),
    ).toBe(false);
    expect(
      handleTerminalClipboardKey(
        keyEvent('v', { ctrlKey: true, shiftKey: true }),
        emptySelectionTerminal,
        rejectedClipboard,
      ),
    ).toBe(false);

    await vi.waitFor(() => {
      expect(emptySelectionTerminal.paste).not.toHaveBeenCalled();
      expect(rejectedClipboard.readText).toHaveBeenCalledTimes(1);
      expect(rejectedClipboard.writeText).toHaveBeenCalledWith('blocked');
    });
  });
});
