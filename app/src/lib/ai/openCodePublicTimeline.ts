import { applySecretPolicy } from '../security/secretDetector';
import { nativeShellFailure, projectNativeTaskActivity, type NativeShellFailure, type NativeTaskActivity } from './openCodeNativeActivity';

export type OpenCodePublicTimelinePart =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'reasoning'; text: string }>
  | Readonly<{
      kind: 'tool_call';
      tool: string;
      call_id: string;
      args: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'tool_result';
      call_id: string;
      result?: Readonly<{ status: 'completed'; diff?: string }>;
      error?: 'Tool failed' | 'Context unavailable' | NativeShellFailure;
    }>;

export interface OpenCodePublicMessageRecord {
  info?: Readonly<Record<string, unknown>>;
  parts?: readonly Readonly<Record<string, unknown>>[];
}

export interface OpenCodePublicTimelineSnapshot {
  /** Public OpenCode checkpoints and safe tool lifecycle, excluding the final answer. */
  timeline: readonly OpenCodePublicTimelinePart[];
  /** The last public OpenCode text part. This alone enters Jarvis response policy. */
  finalText: string;
}

type PublicTimelineEntry =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      tool: string;
      callId: string;
      fileLabel?: string;
      diff?: string;
      nativeTask?: NativeTaskActivity;
      status: 'started' | 'completed' | 'failed';
      error?: 'Tool failed' | 'Context unavailable' | NativeShellFailure;
    };

const MAX_MESSAGES = 4_096;
const MAX_PARTS = 16_384;
const MAX_TEXT_CHARS = 1_000_000;

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/u.test(clean)) return undefined;
  return clean;
}

function publicText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.length > MAX_TEXT_CHARS) throw new Error('opencode_public_timeline_text_limit');
  return value;
}

function safeFileLabel(state: Readonly<Record<string, unknown>> | undefined, workingDirectory?: string): string | undefined {
  const input = recordOf(state?.input);
  const path = input?.path ?? input?.filePath ?? input?.file_path ?? input?.filepath;
  if (typeof path !== 'string' || !path.trim() || path.length > 4_096) return undefined;
  const normalized = path.replace(/\\/g, '/');
  const root = workingDirectory?.replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[a-z]:\//i.test(normalized);
  const withinRoot = root && (windows ? normalized.toLowerCase() : normalized)
    .startsWith((windows ? root.toLowerCase() : root) + '/');
  const relative = withinRoot ? normalized.slice(root.length + 1) : normalized;
  const safeRelative = !/^(?:[a-z]:|\/)/i.test(relative) &&
    !relative.split('/').includes('..');
  const leaf = safeRelative ? relative.replace(/^\.\//, '') : normalized.split('/').filter(Boolean).at(-1);
  if (!leaf) return undefined;
  const redacted = applySecretPolicy(leaf, 'redact').text;
  return boundedIdentifier(redacted, 4096);
}

function relativeDiffHeaders(diff: string, workingDirectory?: string): string {
  let inHunk = false;
  return diff.split('\n').map(line => {
    if (line.startsWith('diff --git ') || line.startsWith('Index: ')) inHunk = false;
    if (line.startsWith('@@')) inHunk = true;
    if (inHunk) return line;
    const match = /^(Index: |--- |\+\+\+ )([^\t\r]+)(.*)$/.exec(line);
    if (!match || match[2] === '/dev/null') return line;
    const label = safeFileLabel({ input: { path: match[2] } }, workingDirectory);
    return label ? `${match[1]}${label}${match[3]}` : line;
  }).join('\n');
}

function toolStatus(value: unknown): 'started' | 'completed' | 'failed' {
  const status = boundedIdentifier(value, 64)?.toLocaleLowerCase('en-US');
  if (status === 'completed') return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  return 'started';
}

export function isFailedVibeSpaceContextOutput(tool: unknown, output: unknown): boolean {
  return vibeSpaceContextFailure(output, tool) !== undefined;
}

function vibeSpaceContextFailure(
  output: unknown,
  tool: unknown,
): 'Tool failed' | 'Context unavailable' | undefined {
  if (boundedIdentifier(tool, 256) !== 'vibespace_context') return undefined;
  if (typeof output !== 'string' || output.length < 1 || output.length > 128 * 1024)
    return undefined;
  try {
    const envelope = recordOf(JSON.parse(output) as unknown);
    const failed = Boolean(
      envelope?.ok === false &&
      boundedIdentifier(envelope.requestId, 200) &&
      boundedIdentifier(envelope.code, 128) &&
      boundedIdentifier(envelope.message, 2_048),
    );
    if (!failed) return undefined;
    return envelope?.code === 'context_unavailable' ? 'Context unavailable' : 'Tool failed';
  } catch {
    return undefined;
  }
}

function freezePart(part: OpenCodePublicTimelinePart): OpenCodePublicTimelinePart {
  return Object.freeze(structuredClone(part));
}

/**
 * Deterministically projects persisted OpenCode messages into the only public
 * Chat UI state we retain: checkpoint text, safe tool lifecycle, and one final
 * answer. It never exposes provider message/part/call identity, tool input,
 * tool output, absolute paths, hidden reasoning, or workflow metadata. Reasoning
 * explicitly exposed in the provider message stream is retained separately.
 */
export function projectOpenCodePublicTimeline(
  messages: readonly OpenCodePublicMessageRecord[],
  options: Readonly<{ workingDirectory?: string }> = {},
): Readonly<OpenCodePublicTimelineSnapshot> {
  if (messages.length > MAX_MESSAGES) throw new Error('opencode_public_timeline_message_limit');

  const entries: PublicTimelineEntry[] = [];
  const callIds = new Map<string, string>();
  const toolsByNativeCallId = new Map<string, Extract<PublicTimelineEntry, { kind: 'tool' }>>();
  let observedParts = 0;
  let textChars = 0;

  const requestLocalCallId = (nativeId: string): string => {
    const existing = callIds.get(nativeId);
    if (existing) return existing;
    const local = `opencode-tool-${callIds.size + 1}`;
    callIds.set(nativeId, local);
    return local;
  };

  messages.forEach((message, messageIndex) => {
    const role = boundedIdentifier(message.info?.role, 32)?.toLocaleLowerCase('en-US');
    if (role !== 'assistant') return;
    for (const [partIndex, part] of (message.parts ?? []).entries()) {
      observedParts += 1;
      if (observedParts > MAX_PARTS) throw new Error('opencode_public_timeline_part_limit');
      const type = boundedIdentifier(part.type, 64)?.toLocaleLowerCase('en-US');
      if (type === 'reasoning') {
        const text = publicText(part.text) ?? '';
        textChars += text.length;
        if (textChars > MAX_TEXT_CHARS) throw new Error('opencode_public_timeline_text_limit');
        entries.push({ kind: 'reasoning', text });
        continue;
      }
      if (type === 'text' || type === 'agent_message') {
        const text = publicText(part.text);
        if (!text) continue;
        textChars += text.length;
        if (textChars > MAX_TEXT_CHARS) throw new Error('opencode_public_timeline_text_limit');
        entries.push({ kind: 'text', text });
        continue;
      }
      if (type !== 'tool' && type !== 'tool_use') continue;

      const tool = boundedIdentifier(part.tool ?? part.name, 256);
      if (!tool) continue;
      const nativeCallId =
        boundedIdentifier(part.callID ?? part.callId ?? part.id, 512) ??
        `anonymous:${messageIndex}:${partIndex}`;
      const state = recordOf(part.state);
      const fileLabel = safeFileLabel(state, options.workingDirectory);
      const transportStatus = toolStatus(state?.status ?? part.status);
      const contextFailure = vibeSpaceContextFailure(state?.output, tool) ?? nativeShellFailure(tool, state);
      const nativeTask = projectNativeTaskActivity(tool, state);
      const status = transportStatus === 'completed' && contextFailure ? 'failed' : transportStatus;
      const rawDiff = recordOf(state?.metadata)?.diff;
      const diff = status === 'completed' && /^(edit|write|apply_patch)$/.test(tool) &&
        typeof rawDiff === 'string' && rawDiff.length <= MAX_TEXT_CHARS
        ? applySecretPolicy(relativeDiffHeaders(rawDiff, options.workingDirectory), 'redact').text : undefined;
      const existing = toolsByNativeCallId.get(nativeCallId);
      if (existing) {
        if (fileLabel) existing.fileLabel = fileLabel;
        if (contextFailure) existing.error = contextFailure;
        if (status !== 'started') existing.status = status;
        if (diff) existing.diff = diff;
        if (nativeTask) existing.nativeTask = nativeTask;
      } else {
        const entry: Extract<PublicTimelineEntry, { kind: 'tool' }> = {
          kind: 'tool',
          tool,
          callId: requestLocalCallId(nativeCallId),
          ...(fileLabel ? { fileLabel } : {}),
          status,
          ...(diff ? { diff } : {}),
          ...(nativeTask ? { nativeTask } : {}),
          ...(contextFailure ? { error: contextFailure } : {}),
        };
        toolsByNativeCallId.set(nativeCallId, entry);
        entries.push(entry);
      }
    }
  });

  const parts = entries.flatMap<OpenCodePublicTimelinePart>((entry) => {
    if (entry.kind === 'text') return [{ kind: 'text', text: entry.text }];
    if (entry.kind === 'reasoning') return [{ kind: 'reasoning', text: entry.text }];
    const call: OpenCodePublicTimelinePart = {
      kind: 'tool_call',
      tool: entry.tool,
      call_id: entry.callId,
      args: { ...(entry.fileLabel ? { path: entry.fileLabel } : {}), ...(entry.nativeTask ? { nativeTask: entry.nativeTask } : {}) },
    };
    if (entry.status === 'completed') {
      return [
        call,
        { kind: 'tool_result', call_id: entry.callId, result: { status: 'completed', ...(entry.diff ? { diff: entry.diff } : {}) } },
      ];
    }
    if (entry.status === 'failed') {
      return [
        call,
        { kind: 'tool_result', call_id: entry.callId, error: entry.error ?? 'Tool failed' },
      ];
    }
    return [call];
  });

  let finalTextIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.kind === 'text') {
      finalTextIndex = index;
      break;
    }
  }
  if (finalTextIndex < 0) return Object.freeze({ finalText: '', timeline: Object.freeze(parts.map(freezePart)) });

  const finalPart = parts[finalTextIndex];
  if (finalPart?.kind !== 'text') throw new Error('opencode_public_timeline_final_text_invalid');
  const timeline = parts.filter((_part, index) => index !== finalTextIndex).map(freezePart);
  return Object.freeze({
    finalText: finalPart.text,
    timeline: Object.freeze(timeline),
  });
}
