type TerminalClipboardSurface = {
  getSelection: () => string;
  paste: (text: string) => void;
};

type ClipboardSurface = Pick<Clipboard, 'readText' | 'writeText'>;

function isClipboardShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.altKey) return false;
  return event.metaKey || (event.ctrlKey && event.shiftKey);
}

/**
 * Handle only platform-standard terminal clipboard shortcuts. Returning true
 * delegates the key to xterm, which preserves Ctrl+C as SIGINT.
 */
export function handleTerminalClipboardKey(
  event: KeyboardEvent,
  terminal: TerminalClipboardSurface,
  clipboard: ClipboardSurface | undefined,
): boolean {
  if (!isClipboardShortcut(event)) return true;

  const key = event.key.toLowerCase();
  if (key === 'c') {
    const selection = terminal.getSelection();
    if (selection && clipboard) {
      try {
        void Promise.resolve(clipboard.writeText(selection)).catch(() => undefined);
      } catch {
        // Clipboard permissions must never break terminal input.
      }
    }
    return false;
  }

  if (key === 'v') {
    if (clipboard) {
      try {
        void Promise.resolve(clipboard.readText())
          .then((text) => {
            if (text) terminal.paste(text);
          })
          .catch(() => undefined);
      } catch {
        // Clipboard permissions must never break terminal input.
      }
    }
    return false;
  }

  return true;
}
