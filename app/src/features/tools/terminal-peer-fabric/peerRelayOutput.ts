/** The PTY transcript contains full-screen redraws, not just agent messages. */
export function latestOpenCodeReply(transcript: string): string | null {
  const text = transcript.replace(/[■⬝]/gu, '');
  const footer = /(?:Build|Plan|Explore)\s*·\s*([^\r\n┃╹]{1,90}?)(?:OpenAI|OpenRouter|OpenCode Go|Azure|Anthropic|moon-ai\.pl|Google|Alibaba)(?=\W|$)/giu;
  const model = [...text.matchAll(footer)].at(-1)?.[1]?.trim();
  if (!model) return null;

  const completed = /▣\s*(?:Build|Plan|Explore)\s*·\s*([^\r\n]{1,2000}?)\s*·\s*\d+(?:h|m|s)\b/giu;
  let line = [...text.matchAll(completed)].at(-1)?.[1]?.trim();
  if (!line) return null;
  const repeatedMarker = line.lastIndexOf('▣');
  if (repeatedMarker >= 0) {
    line = line.slice(repeatedMarker + 1).replace(/^\s*(?:Build|Plan|Explore)\s*·\s*/u, '').trim();
  }
  if (!line.startsWith(model)) return null;
  const reply = line.slice(model.length).replace(/[┃╹▀]+/gu, '').trim();
  return reply && reply.length <= 1500 ? reply : null;
}

/** A saved xterm screen keeps message lines separate even when PTY redraws do not. */
export function latestOpenCodeScreenReply(screen: string): string | null {
  const lines = screen.replace(/\r/g, '').split('\n');
  let prompt = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.includes('[CAO acting for user]')) {
      prompt = index;
      break;
    }
  }
  if (prompt < 0) return null;
  const completed = lines.findIndex((line, index) =>
    index > prompt && /▣\s*(?:Build|Plan|Explore)\s*·.+·\s*\d+(?:h|m|s)\b/u.test(line));
  if (completed < 0) return null;
  const answer = lines.slice(prompt + 1, completed)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('┃') && !/^Thought\s*·/u.test(line))
    .join('\n');
  return answer && answer.length <= 1500 ? answer : null;
}
