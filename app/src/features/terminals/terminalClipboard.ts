import { quoteResourcePath, type ResourceShellFamily } from '@/lib/resourceInteraction';

type TerminalClipboardSurface = {
  getSelection: () => string;
  paste: (text: string) => void;
};

export function formatTerminalClipboard(
  value: { text: string; paths: string[] },
  shell: ResourceShellFamily,
): string {
  if (!value.paths.length) return value.text;
  return value.paths
    .map((path) => {
      const quoted = quoteResourcePath(path, shell);
      if (!quoted) throw new Error('The clipboard contains an invalid file path.');
      return quoted;
    })
    .join(' ');
}

/** Capture before xterm so one gesture produces exactly one bracketed paste. */
export function installTerminalPaste(
  element: HTMLElement,
  terminal: TerminalClipboardSurface,
  read: () => Promise<string>,
  onError: () => void,
): () => void {
  let disposed = false;
  let pending = false;
  const paste = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending) return;
    pending = true;
    void read()
      .then((text) => {
        if (!disposed && text) terminal.paste(text);
      })
      .catch(() => {
        if (!disposed) onError();
      })
      .finally(() => {
        pending = false;
      });
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.altKey || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (
      (key === 'v' && (event.ctrlKey || event.metaKey)) ||
      (key === 'insert' && event.shiftKey && !event.ctrlKey && !event.metaKey)
    ) {
      paste(event);
    }
  };
  element.addEventListener('paste', paste, true);
  element.addEventListener('keydown', keydown, true);
  return () => {
    disposed = true;
    element.removeEventListener('paste', paste, true);
    element.removeEventListener('keydown', keydown, true);
  };
}

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
