import type { ProviderEvent } from './adapters/types';

/** A registered question proves its tool is waiting even if the tool SSE event lags. */
export function questionEventsWithActivity(
  question: Extract<ProviderEvent, { type: 'question' }>,
  localCallId: (callId: string) => string,
  emittedToolStates: Set<string>,
  onStarted?: () => void,
): ProviderEvent[] {
  const rawCallId = question.request.tool?.callId;
  if (!rawCallId) return [question];
  const callId = localCallId(rawCallId);
  const key = `${callId}:started`;
  if (emittedToolStates.has(key)) return [question];
  emittedToolStates.add(key);
  onStarted?.();
  return [{ type: 'tool', name: 'question', status: 'started', callId }, question];
}
