import type { Message } from '@/types';
import { readNativeTaskActivity, type NativeTaskActivity } from '@/lib/ai/openCodeNativeActivity';
import type { ChatActivityEvent, ChatActivityStatus } from '../activity/types';

export interface NativeTaskRun extends Omit<NativeTaskActivity, 'status'> {
  id: string;
  status: ChatActivityStatus | 'unknown';
}

/** Keep known native children across parent turns, merging the newest evidence. */
export function collectNativeTaskRuns(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  since: number,
  parentEnded = false,
): NativeTaskRun[] {
  const runs = new Map<string, NativeTaskRun>();
  const observed = new Map<string, number>();
  const add = (
    value: unknown,
    source: string,
    status: ChatActivityStatus,
    observedAt: number,
    startedAt = observedAt,
  ) => {
    const task = readNativeTaskActivity(value);
    if (!task || (startedAt < since && !(task.sessionId && task.harness))) return;
    const id = task.sessionId ? `native-session:${task.sessionId}` : source;
    const previous = runs.get(id);
    if (previous && (observed.get(id) ?? 0) > observedAt) {
      // Earlier metadata can fill an omitted model/route, never rewind status.
      runs.set(id, { ...task, ...previous });
      return;
    }
    observed.set(id, observedAt);
    const nextStatus = task.status ?? status;
    runs.set(id, {
      ...runs.get(id),
      ...task,
      id,
      status: nextStatus,
      ...(nextStatus !== 'done' ? { result: undefined } : {}),
      ...(nextStatus !== 'error' ? { error: undefined } : {}),
    });
  };
  for (const event of activity) {
    add(
      event.nativeTask,
      `${event.messageId ?? event.id}:${event.providerCallId ?? event.id}`,
      event.status,
      event.ts,
      event.startedAt ?? event.ts,
    );
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const results = new Map(
      message.parts
        .filter((part) => part.kind === 'tool_result')
        .map((part) => [part.call_id, part]),
    );
    for (const part of message.parts) {
      if (part.kind !== 'tool_call' || part.tool !== 'task') continue;
      const result = results.get(part.call_id);
      const confirmed =
        result?.result !== null &&
        typeof result?.result === 'object' &&
        'status' in result.result &&
        result.result.status === 'completed';
      add(
        part.args?.nativeTask,
        `${message.id}:${part.call_id}`,
        result?.error ? 'error' : confirmed ? 'done' : 'running',
        message.updated_at ?? message.created_at,
        message.created_at,
      );
    }
  }
  return [...runs.values()].map((run) =>
    parentEnded && (run.status === 'running' || run.status === 'pending')
      ? { ...run, status: 'unknown', currentStep: 'Final status unavailable' }
      : run,
  );
}
