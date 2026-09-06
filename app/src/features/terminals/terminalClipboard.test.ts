import { describe, expect, it, vi } from 'vitest';
import {
  handleTerminalClipboardKey,
  installTerminalPaste,
  formatTerminalClipboard,
} from './terminalClipboard';
import { waitFor } from '@testing-library/react';

describe('native terminal paste', () => {
  it('keeps text exact and quotes file paths without inserting Enter', () => {
    expect(formatTerminalClipboard({ text: 'hello\nworld', paths: [] }, 'powershell')).toBe(
      'hello\nworld',
    );
    expect(
      formatTerminalClipboard(
        { text: 'ignored', paths: ['C:\\My Files\\a.png', "C:\\O'Brien.txt"] },
        'powershell',
      ),
    ).toBe("'C:\\My Files\\a.png' 'C:\\O''Brien.txt'");
    expect(() =>
      formatTerminalClipboard({ text: '', paths: ['bad\npath'] }, 'powershell'),
    ).toThrow();
  });

  it('handles native paste once and drops a delayed result after disposal', async () => {
    const element = document.createElement('div');
    const term = terminal();
    let resolve!: (value: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const dispose = installTerminalPaste(element, term, read, vi.fn());
    const event = new Event('paste', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    dispose();
    resolve('late');
    await Promise.resolve();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it('supports Ctrl+V, Ctrl+Shift+V and Shift+Insert, preserves Ctrl+C, and reports errors', async () => {
    const element = document.createElement('div');
    const term = terminal();
    const read = vi.fn(async () => 'image-path');
    const error = vi.fn();
    const dispose = installTerminalPaste(element, term, read, error);
    for (const options of [
      { key: 'v', ctrlKey: true },
      { key: 'V', ctrlKey: true, shiftKey: true },
      { key: 'Insert', shiftKey: true },
    ]) {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }),
      );
      await waitFor(() => expect(term.paste).toHaveBeenCalledTimes(read.mock.calls.length));
    }
    expect(term.paste).toHaveBeenCalledTimes(3);
    const interrupt = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
    element.dispatchEvent(interrupt);
    expect(interrupt.defaultPrevented).toBe(false);
    read.mockRejectedValueOnce(new Error('unavailable'));
    element.dispatchEvent(new Event('paste', { cancelable: true }));
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    dispose();
  });
});

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
