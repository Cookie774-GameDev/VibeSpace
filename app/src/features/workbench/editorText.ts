/** Keep unchanged file bytes when a textarea normalizes CRLF or CR to LF. */
export function preserveEditorLineEndings(previous: string, input: string): string {
  const before = previous.replace(/\r\n?/g, '\n');
  const next = input.replace(/\r\n?/g, '\n');
  if (before === next) return previous;
  let start = 0;
  while (start < before.length && start < next.length && before[start] === next[start]) start++;
  let endBefore = before.length;
  let endNext = next.length;
  while (endBefore > start && endNext > start && before[endBefore - 1] === next[endNext - 1]) {
    endBefore--;
    endNext--;
  }
  const rawOffset = (offset: number) => {
    let raw = 0;
    for (let normalized = 0; normalized < offset; normalized++) {
      raw += previous[raw] === '\r' && previous[raw + 1] === '\n' ? 2 : 1;
    }
    return raw;
  };
  const ending = previous.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const replacement = next.slice(start, endNext).replace(/\n/g, ending);
  return previous.slice(0, rawOffset(start)) + replacement + previous.slice(rawOffset(endBefore));
}
