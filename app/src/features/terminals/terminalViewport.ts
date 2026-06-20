type TerminalLike = {
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
    };
  };
};

export function isTerminalViewportAtBottom(term: TerminalLike): boolean {
  const buffer = term.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

export function terminalUserHasScrolled(term: TerminalLike): boolean {
  return !isTerminalViewportAtBottom(term);
}

export function shouldAutoFollowTerminalOutput({
  term,
  userHasScrolled,
}: {
  term: TerminalLike;
  userHasScrolled: boolean;
}): boolean {
  return !userHasScrolled || isTerminalViewportAtBottom(term);
}
