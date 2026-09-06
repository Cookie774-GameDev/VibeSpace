import { applySecretPolicy } from '../security/secretDetector';

export interface NativeTaskActivity {
  name: string;
  sessionId?: string;
  currentStep?: string;
  modelLabel?: string;
  status?: 'running' | 'done' | 'error' | 'cancelled' | 'unknown';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function label(value: unknown, limit = 180): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return undefined;
  // Task prompts, outputs, and absolute local paths are not public progress labels.
  if (/[a-z]:[\\/]|(?:^|\s)\/[^\s]+(?:\/|\.)/i.test(value)) return undefined;
  const sanitized = applySecretPolicy(value, 'redact').text;
  return typeof sanitized === 'string' ? sanitized.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : undefined;
}

/** Whitelist display metadata only; never copies the child prompt or raw output. */
export function projectNativeTaskActivity(tool: string, value: unknown): NativeTaskActivity | undefined {
  if (tool !== 'task') return undefined;
  const state = record(value);
  const input = record(state?.input);
  const metadata = record(state?.metadata);
  const rawSessionId = metadata?.sessionId ?? metadata?.sessionID;
  const sessionId = typeof rawSessionId === 'string' && /^[\w-]{1,512}$/.test(rawSessionId) ? rawSessionId : undefined;
  const summary = Array.isArray(metadata?.summary) ? metadata.summary : [];
  const latest = record(summary.at(-1));
  const currentStep = label(record(latest?.state)?.title) ?? label(latest?.tool);
  const model = record(metadata?.model);
  const modelId = label(model?.modelID ?? model?.modelId);
  const providerId = label(model?.providerID ?? model?.providerId);
  return {
    name: label(input?.description) ?? 'Task',
    ...(sessionId ? { sessionId } : {}),
    ...(currentStep ? { currentStep } : {}),
    ...(modelId ? { modelLabel: providerId ? `${providerId}/${modelId}` : modelId } : {}),
  };
}

/** Revalidate historical display records before projecting them into the Runs panel. */
export function readNativeTaskActivity(value: unknown): NativeTaskActivity | undefined {
  const item = record(value);
  const name = label(item?.name);
  if (!name) return undefined;
  const sessionId = typeof item?.sessionId === 'string' && /^[\w-]{1,512}$/.test(item.sessionId) ? item.sessionId : undefined;
  const currentStep = label(item?.currentStep);
  const modelLabel = label(item?.modelLabel);
  const status = ['running', 'done', 'error', 'cancelled', 'unknown'].includes(String(item?.status))
    ? item?.status as NativeTaskActivity['status'] : undefined;
  return { name, ...(status ? { status } : {}), ...(sessionId ? { sessionId } : {}), ...(currentStep ? { currentStep } : {}), ...(modelLabel ? { modelLabel } : {}) };
}

export type NativeShellFailure = `Command exited with code ${number}`;

export function nativeShellFailure(tool: string, value: unknown): NativeShellFailure | undefined {
  if (!['bash', 'shell', 'terminal'].includes(tool)) return undefined;
  const state = record(value);
  if (state?.status !== 'completed') return undefined;
  const metadata = record(state.metadata);
  const exit = metadata?.exit ?? metadata?.exitCode ?? metadata?.exit_code;
  return typeof exit === 'number' && Number.isSafeInteger(exit) && exit !== 0
    ? `Command exited with code ${exit}` : undefined;
}
