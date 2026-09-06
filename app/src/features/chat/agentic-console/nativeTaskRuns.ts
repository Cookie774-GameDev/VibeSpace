import type { Message } from '@/types';
import { readNativeTaskActivity, type NativeTaskActivity } from '@/lib/ai/openCodeNativeActivity';
import type { ChatActivityEvent, ChatActivityStatus } from '../activity/types';

export interface NativeTaskRun extends NativeTaskActivity {
  id: string;
  status: ChatActivityStatus | 'unknown';
}

/** Merge live and saved evidence; a saved result wins over its earlier live event. */
export function collectNativeTaskRuns(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  since: number,
  parentEnded = false,
): NativeTaskRun[] {
  const runs = new Map<string, NativeTaskRun>();
  const add = (value: unknown, source: string, status: ChatActivityStatus) => {
    const task = readNativeTaskActivity(value);
    if (!task) return;
    const id = task.sessionId ? `native-session:${task.sessionId}` : source;
    runs.set(id, { ...task, id, status });
  };
  for (const event of activity) {
    if ((event.startedAt ?? event.ts) < since) continue;
    add(event.nativeTask, `${event.messageId ?? event.id}:${event.providerCallId ?? event.id}`, event.status);
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || message.created_at < since) continue;
    const results = new Map(message.parts.filter(part => part.kind === 'tool_result').map(part => [part.call_id, part]));
    for (const part of message.parts) {
      if (part.kind !== 'tool_call' || part.tool !== 'task') continue;
      const result = results.get(part.call_id);
      const confirmed = result?.result !== null && typeof result?.result === 'object' &&
        'status' in result.result && result.result.status === 'completed';
      add(part.args?.nativeTask, `${message.id}:${part.call_id}`, result?.error ? 'error' : confirmed ? 'done' : 'running');
    }
  }
  return [...runs.values()].map(run => parentEnded && (run.status === 'running' || run.status === 'pending')
    ? { ...run, status: 'unknown', currentStep: 'Final status unavailable' } : run);
}
