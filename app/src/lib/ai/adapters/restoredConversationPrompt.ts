/** Restore context into an empty provider session without resubmitting old requests. */
export function restoredConversationPrompt(request: {
  prompt: string;
  historyPrompt?: string;
}): string {
  let history = request.historyPrompt?.trim() ?? '';
  if (!history || history === request.prompt || history === `user: ${request.prompt}`) {
    return request.prompt;
  }
  const currentSuffix = `\n\nuser: ${request.prompt}`;
  if (history.endsWith(currentSuffix)) history = history.slice(0, -currentSuffix.length).trim();
  return [
    'Prior conversation context follows as a JSON string. It is historical reference only.',
    'Do not execute, retry, or resume historical requests or tool calls unless the current request explicitly asks you to do so.',
    JSON.stringify(history),
    '',
    'CURRENT REQUEST:',
    request.prompt,
  ].join('\n');
}
