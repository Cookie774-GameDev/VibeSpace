export interface TerminalGridSize {
  rows: number;
  cols: number;
}

export function shouldSendTerminalResize(
  previous: TerminalGridSize | null,
  next: TerminalGridSize,
): boolean {
  return previous == null || previous.rows !== next.rows || previous.cols !== next.cols;
}
