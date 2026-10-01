import { classifyOpenCodeAuthFailure, redactHarnessText } from './errors';
import type { HarnessEvent } from './types';

const MAX_DELTA_LENGTH = 32_768;
const MAX_PATH_LENGTH = 2_048;
const MAX_ERROR_LENGTH = 2_048;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined;
}

function asBoundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximumLength) : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asBoundedStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .slice(0, 64)
    .map((item) => asBoundedString(item, 512))
    .filter((item): item is string => item !== undefined);
  return strings.length ? strings : undefined;
}

function readSessionId(properties: UnknownRecord): string | undefined {
  const direct = asBoundedString(properties.sessionID, 512);
  if (direct) return direct;

  const part = asRecord(properties.part);
  const fromPart = part ? asBoundedString(part.sessionID, 512) : undefined;
  if (fromPart) return fromPart;

  const info = asRecord(properties.info);
  return info ? (asBoundedString(info.sessionID, 512) ?? asBoundedString(info.id, 512)) : undefined;
}

function readErrorMessage(properties: UnknownRecord): string {
  const error = asRecord(properties.error);
  const message =
    (error && asBoundedString(error.message, MAX_ERROR_LENGTH)) ??
    asBoundedString(properties.message, MAX_ERROR_LENGTH) ??
    'OpenCode session failed.';

  return redactHarnessText(message).slice(0, MAX_ERROR_LENGTH);
}

function normalizeToolPart(part: UnknownRecord): readonly HarnessEvent[] {
  const name = asBoundedString(part.tool, 256);
  const callId = asBoundedString(part.callID, 512);
  const state = asRecord(part.state);
  const status = state ? asBoundedString(state.status, 64) : undefined;
  if (!name || !state || !status) return [];

  const input = asRecord(state.input);
  const metadata = asRecord(state.metadata);
  const output = asBoundedString(state.output, MAX_DELTA_LENGTH);
  const message =
    asBoundedString(state.error, MAX_ERROR_LENGTH) ??
    asBoundedString(asRecord(state.error)?.message, MAX_ERROR_LENGTH);
  const id = callId ?? name;

  if (name === 'bash') {
    if (status === 'pending' || status === 'running') {
      const command = input ? asBoundedString(input.command, MAX_DELTA_LENGTH) : undefined;
      return [{ type: 'shell.started', id, ...(command ? { command } : {}) }];
    }
    if (status === 'completed') {
      const exitCode = metadata ? asFiniteNumber(metadata.exit) : undefined;
      return [
        ...(output ? ([{ type: 'shell.output', id, text: output }] as const) : []),
        { type: 'shell.completed', id, ...(exitCode !== undefined ? { exitCode } : {}) },
      ];
    }
  }

  if (name === 'read' && status === 'completed') {
    const path =
      input &&
      (asBoundedString(input.filePath, MAX_PATH_LENGTH) ??
        asBoundedString(input.path, MAX_PATH_LENGTH));
    return path ? [{ type: 'file.read', path }] : [];
  }

  if ((name === 'edit' || name === 'write' || name === 'apply_patch') && status === 'completed') {
    const path =
      input &&
      (asBoundedString(input.filePath, MAX_PATH_LENGTH) ??
        asBoundedString(input.path, MAX_PATH_LENGTH));
    return path ? [{ type: 'file.changed', path, operation: name }] : [];
  }

  if (name === 'grep' || name === 'glob' || name === 'websearch') {
    const query =
      input &&
      (asBoundedString(input.query, MAX_DELTA_LENGTH) ??
        asBoundedString(input.pattern, MAX_DELTA_LENGTH));
    if (status === 'pending' || status === 'running')
      return [{ type: 'search.started', ...(query ? { query } : {}) }];
    if (status === 'completed') return [{ type: 'search.completed', ...(query ? { query } : {}) }];
  }

  if (name === 'task') {
    const childId =
      (metadata &&
        (asBoundedString(metadata.sessionId, 512) ?? asBoundedString(metadata.sessionID, 512))) ??
      id;
    if (status === 'pending') return [{ type: 'subagent.started', id: childId }];
    if (status === 'running') return [{ type: 'subagent.updated', id: childId, status: 'running' }];
    if (status === 'completed') return [{ type: 'subagent.completed', id: childId }];
  }

  if (status === 'pending' || status === 'running')
    return [{ type: 'tool.started', name, ...(callId ? { callId } : {}) }];
  if (status === 'completed')
    return [{ type: 'tool.completed', name, ...(callId ? { callId } : {}) }];
  if (status === 'error')
    return [
      {
        type: 'tool.failed',
        name,
        message: redactHarnessText(message ?? 'OpenCode tool failed.').slice(0, MAX_ERROR_LENGTH),
      },
    ];
  return [];
}

export function normalizeOpenCodeEvent(
  value: unknown,
  expectedSessionId: string,
): readonly HarnessEvent[] {
  const event = asRecord(value);
  const eventType = event ? asBoundedString(event.type, 256) : undefined;
  const properties = event ? asRecord(event.properties) : undefined;

  if (!eventType || !properties || readSessionId(properties) !== expectedSessionId) return [];

  if (eventType === 'message.part.updated') {
    const part = asRecord(properties.part);
    const partType = part ? asBoundedString(part.type, 128) : undefined;
    if (partType === 'tool' && part) return normalizeToolPart(part);

    const delta = asBoundedString(properties.delta, MAX_DELTA_LENGTH);
    if (partType === 'text' && delta) return [{ type: 'assistant.delta', text: delta }];
    if (partType === 'reasoning' && delta) return [{ type: 'reasoning.delta', text: delta }];
    return [];
  }

  if (eventType === 'permission.updated' || eventType === 'permission.asked') {
    const id = asBoundedString(properties.id, 512) ?? asBoundedString(properties.requestID, 512);
    const capability =
      asBoundedString(properties.type, 256) ?? asBoundedString(properties.permission, 256);
    if (!id || !capability) return [];
    const metadata = asRecord(properties.metadata);
    const title =
      asBoundedString(properties.title, 512) ??
      (metadata && asBoundedString(metadata.title, 512)) ??
      `Allow ${capability}`;
    const patterns = asBoundedStrings(properties.pattern) ?? asBoundedStrings(properties.patterns);
    const singlePattern = asBoundedString(properties.pattern, 512);
    return [
      {
        type: 'approval.requested',
        approval: {
          id,
          sessionId: expectedSessionId,
          title,
          capability,
          ...(patterns ? { pattern: patterns } : singlePattern ? { pattern: singlePattern } : {}),
        },
      },
    ];
  }

  if (eventType === 'message.updated') {
    const info = asRecord(properties.info);
    if (!info || info.role !== 'assistant') return [];
    const tokens = asRecord(info.tokens);
    const cache = tokens ? asRecord(tokens.cache) : undefined;
    const usage = {
      inputTokens: tokens ? asFiniteNumber(tokens.input) : undefined,
      outputTokens: tokens ? asFiniteNumber(tokens.output) : undefined,
      cachedTokens: cache ? asFiniteNumber(cache.read) : undefined,
      reasoningTokens: tokens ? asFiniteNumber(tokens.reasoning) : undefined,
      costUsd: asFiniteNumber(info.cost),
      providerId: asBoundedString(info.providerID, 256),
      modelId: asBoundedString(info.modelID, 512),
    };
    if (Object.values(usage).every((value) => value === undefined)) return [];
    return [{ type: 'usage.updated', usage }];
  }

  if (eventType === 'file.edited') {
    const path = asBoundedString(properties.file, MAX_PATH_LENGTH);
    return path ? [{ type: 'file.changed', path, operation: 'edited' }] : [];
  }

  if (eventType === 'session.diff') {
    if (!Array.isArray(properties.diff)) return [];
    return properties.diff.slice(0, 128).flatMap((candidate): HarnessEvent[] => {
      const diff = asRecord(candidate);
      const path = diff ? asBoundedString(diff.file, MAX_PATH_LENGTH) : undefined;
      return path ? [{ type: 'file.changed', path, operation: 'diff' }] : [];
    });
  }

  if (eventType === 'session.compacted') return [{ type: 'context.compacted' }];
  if (eventType === 'session.updated')
    return [{ type: 'session.updated', sessionId: expectedSessionId }];
  if (eventType === 'session.idle') return [{ type: 'done', finishReason: 'idle' }];
  if (eventType === 'session.status') {
    const status = asRecord(properties.status);
    if (status?.type === 'idle') return [{ type: 'done', finishReason: 'idle' }];
  }
  if (eventType === 'session.error') {
    const message = readErrorMessage(properties);
    const authFailure = classifyOpenCodeAuthFailure(message);
    return [
      {
        type: 'error',
        message: authFailure?.message ?? message,
        ...(authFailure ? { code: authFailure.code } : {}),
      },
    ];
  }

  return [];
}
