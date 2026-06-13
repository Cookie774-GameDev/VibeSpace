/**
 * Shared ANSI/OSC escape handling for terminal output paths.
 *
 * PTY reads arrive in arbitrary chunk boundaries. When an ESC byte lands
 * in one chunk and the rest of the sequence in the next, consumers that
 * process each chunk independently can persist or render orphan fragments
 * like `]4;0;rgb:...` or `[0[` as visible text.
 */

export const MAX_PENDING_ESCAPE_CHARS = 4096;

export function splitTrailingIncompleteEscape(input: string): {
  complete: string;
  pendingEscape: string;
} {
  const escIndex = input.lastIndexOf('\x1B');
  if (escIndex < 0) return { complete: input, pendingEscape: '' };

  const candidate = input.slice(escIndex);
  if (candidate.includes('\n') || candidate.includes('\r')) {
    return { complete: input, pendingEscape: '' };
  }
  if (candidate === '\x1B') {
    return { complete: input.slice(0, escIndex), pendingEscape: candidate };
  }

  const kind = candidate[1];
  if (kind === '[') {
    const completeCsi = /^\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/.test(candidate);
    return completeCsi
      ? { complete: input, pendingEscape: '' }
      : { complete: input.slice(0, escIndex), pendingEscape: candidate };
  }

  if (kind === ']') {
    const hasTerminator = candidate.includes('\x07') || candidate.includes('\x1B\\');
    return hasTerminator
      ? { complete: input, pendingEscape: '' }
      : { complete: input.slice(0, escIndex), pendingEscape: candidate };
  }

  if (kind === 'P') {
    const hasTerminator = candidate.includes('\x1B\\');
    return hasTerminator
      ? { complete: input, pendingEscape: '' }
      : { complete: input.slice(0, escIndex), pendingEscape: candidate };
  }

  return { complete: input, pendingEscape: '' };
}

/** Reassemble PTY chunks into complete escape sequences before rendering. */
export function createTerminalOutputBuffer() {
  let pending = '';

  return {
    push(chunk: string): string[] {
      if (!chunk) return [];
      const combined = `${pending}${chunk}`;
      const split = splitTrailingIncompleteEscape(combined);
      pending =
        split.pendingEscape.length > MAX_PENDING_ESCAPE_CHARS ? '' : split.pendingEscape;
      if (!split.complete) return [];
      return [split.complete];
    },
    flush(): string {
      const tail = pending;
      pending = '';
      return tail;
    },
  };
}

/**
 * Strip ConPTY / shell startup clears during the post-restore window so a
 * replayed transcript is not wiped by initialization noise.
 *
 * Beyond plain clears (`ESC c`, `ESC [!p`, `ESC [..J/K`) this also strips
 * absolute cursor positioning emitted while ConPTY attaches:
 *   - CUP / HVP  (`ESC [H`, `ESC [<r>;<c>H`, `ESC [..f`)
 *   - VPA        (`ESC [<n>d`)
 *   - DECSTBM    (`ESC [<t>;<b>r`) scroll-region resets
 *
 * Without these, the fresh shell prompt is painted at the *top* of the
 * viewport, overwriting the just-restored transcript lines — the
 * "content morphed around / deleted after reload" bug. During the short
 * restore window the prompt should simply print at the cursor (i.e.
 * after the replayed transcript), so dropping repositioning is safe.
 */
export interface StartupOutputFilterOptions {
  /**
   * Strip absolute cursor positioning (CUP/HVP/VPA/DECSTBM). Keep enabled when
   * replaying a restored transcript so a fresh shell prompt cannot overwrite it.
   * Disable on brand-new panes so ConPTY's cursor-home lands the prompt at the top.
   */
  stripCursorPositioning?: boolean;
}

export function stripConPtyStartupClears(
  data: string,
  options: StartupOutputFilterOptions = {},
): string {
  const stripCursorPositioning = options.stripCursorPositioning !== false;
  let result = data.replace(/\x1bc|\x1b\[!p|\x1b\[[0-9;?]*[JK]/g, '');
  if (stripCursorPositioning) {
    result = result.replace(
      /\x1b\[[0-9;]*[Hf]|\x1b\[[0-9]*d|\x1b\[[0-9;]*r/g,
      '',
    );
  }
  return result;
}

/**
 * Alternate-screen-buffer enter sequences (`ESC [?1049h` and friends).
 * A fullscreen TUI (opencode, claude, htop…) switching to the alt buffer
 * marks the end of "shell startup noise" — from that point on, absolute
 * cursor positioning is intentional and must pass through untouched. The
 * restored transcript lives in the normal buffer's scrollback, which the
 * alt screen never destroys.
 */
const ALT_SCREEN_ENTER = /\x1b\[\?(?:47|1047|1049)h/;

/**
 * Index of the first alt-screen-enter sequence in `data`, or -1. Used by
 * the renderer to terminate the post-restore filter window early.
 */
export function findAltScreenEnter(data: string): number {
  const match = ALT_SCREEN_ENTER.exec(data);
  return match ? match.index : -1;
}

/**
 * Remove orphan escape fragments that lost their leading ESC byte — the
 * classic `]4;0;rgb:...` / `[0[` / `[<35;43;16M` soup after restarts.
 */
export function stripOrphanEscapeFragments(data: string): string {
  if (!data) return '';
  return data
    .replace(/(^|[\r\n])(?:\]4;|\]10;|\]11;|\]12;)[^\r\n\x07]*(?:\x07)?/g, '$1')
    .replace(
      /(>[^\S\r\n]*)((?:\]4;|\]10;|\]11;|\]12;)[^\r\n\x07]*(?:\x07)?|(?:\[0|\[I|\[<)[^\r\n]*)(?=\s*$|[\r\n])/gm,
      '$1',
    )
    .replace(/(?:^|[\r\n])(?:\[<[\d;]+[Mm])+/g, '\n');
}

/** Apply startup guards to a fully reassembled PTY chunk. */
export function filterStartupTerminalOutput(
  data: string,
  options?: StartupOutputFilterOptions,
): string {
  return stripOrphanEscapeFragments(stripConPtyStartupClears(data, options));
}
