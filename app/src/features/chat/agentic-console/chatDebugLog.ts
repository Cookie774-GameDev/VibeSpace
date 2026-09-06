import type { Chat, Message } from '@/types';
import type { ChatActivityEvent } from '../activity/types';
import type { JarvisArtifactV1, JarvisEvent, JarvisRun } from '@/lib/jarvis/contracts/execution';
import { applySecretPolicy } from '@/lib/security/secretDetector';

export interface ChatDebugRun {
  run: JarvisRun;
  events: readonly JarvisEvent[];
  artifacts: readonly JarvisArtifactV1[];
}

export interface ChatDebugLogInput {
  chatId: string;
  chat?: Pick<Chat, 'title' | 'backend_affinity' | 'created_at' | 'updated_at'>;
  messages: readonly Message[];
  activity: readonly ChatActivityEvent[];
  runs: readonly ChatDebugRun[];
  coverage: readonly string[];
  exportedAt?: number;
  rendererUptimeMs?: number;
}

export interface ChatDebugLog extends Omit<ChatDebugLogInput, 'exportedAt'> {
  version: 1;
  exportedAt: number;
  rendererStartedAt?: number;
}

const PRIVATE_KEY =
  /^(?:api[_-]?key|authorization|cookie|set-cookie|password|passwd|secret|credential[s]?|access[_-]?token|refresh[_-]?token|id[_-]?token|token|private[_-]?key|client[_-]?secret|cancellationKey)$/i;

/** Bound and redact every record before it crosses the portable-file boundary. */
export function buildChatDebugLog(input: ChatDebugLogInput): ChatDebugLog {
  let omitted = false;
  const ancestors = new WeakSet<object>();
  function clean(value: unknown, depth = 0): unknown {
    if (depth > 20) {
      omitted = true;
      return '[record truncated: export limit]';
    }
    if (typeof value === 'string') {
      let text = value;
      if (text.length > 64000) {
        text = text.slice(0, 64000) + '\n[content truncated: 64000-character export limit]';
        omitted = true;
      }
      if (/^\s*[\[{]/.test(text)) {
        try {
          return JSON.stringify(clean(JSON.parse(text), depth + 1));
        } catch {
          /* ordinary text */
        }
      }
      const result = applySecretPolicy(text, 'redact');
      // The shared detector bounds its findings; do not expose an unscanned remainder.
      if (result.findings.length >= 100) {
        omitted = true;
        return '[content omitted: secret detection limit]';
      }
      return result.text ?? '[redacted]';
    }
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[circular record omitted]';
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      result = value.slice(0, 10000).map((entry) => clean(entry, depth + 1));
      if (value.length > 10000) omitted = true;
    } else {
      result = Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          PRIVATE_KEY.test(key) ? '[redacted]' : clean(entry, depth + 1),
        ]),
      );
    }
    ancestors.delete(value);
    return result;
  }
  const exportedAt = input.exportedAt ?? Date.now();
  const uptime = input.rendererUptimeMs;
  const log = clean({
    version: 1,
    chatId: input.chatId,
    chat: input.chat,
    exportedAt,
    ...(uptime !== undefined && Number.isFinite(uptime) && uptime >= 0
      ? { rendererUptimeMs: uptime, rendererStartedAt: exportedAt - uptime }
      : {}),
    messages: input.messages.filter((message) => String(message.chat_id) === input.chatId),
    activity: input.activity.filter((event) => String(event.chatId) === input.chatId),
    runs: input.runs.filter(({ run }) => run.chatId === input.chatId),
    coverage: [
      ...input.coverage,
      'Point-in-time snapshot of recorded evidence. Export again for subsequent activity.',
      'Message received means saved locally; provider receipt time and backend process uptime are not recorded.',
      'Only provider-exposed reasoning is included. Hidden internal thinking is unavailable.',
      'Activity may already be bounded or truncated by its producer. Missing evidence does not prove no work occurred.',
      'Known credentials are redacted. Review private conversation and file content before sharing.',
    ],
  }) as ChatDebugLog;
  if (omitted)
    log.coverage = [
      ...log.coverage,
      'Some records were explicitly truncated or omitted by export safety limits.',
    ];
  return log;
}
