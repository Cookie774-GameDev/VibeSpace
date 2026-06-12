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
 */
export function stripConPtyStartupClears(data: string): string {
  return data.replace(/\x1bc|\x1b\[!p|\x1b\[[0-9;?]*[JK]/g, '');
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
export function filterStartupTerminalOutput(data: string): string {
  return stripOrphanEscapeFragments(stripConPtyStartupClears(data));
}
