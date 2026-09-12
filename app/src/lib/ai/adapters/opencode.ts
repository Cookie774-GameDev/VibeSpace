import {
  assertCliPrompt,
  boundedProviderIdentifier,
  boundedProviderText,
  createCliProviderAdapter,
  normalizeProviderJsonl,
  responseUsageSnapshot,
  type CliInvocation,
  type CliInvocationRequest,
  type CliProviderDefinition,
  type JsonlParserLimits,
  type ProviderRecordNormalization,
} from './cliBridge';
import type { ProviderEvent } from './types';
import { formatOpenCodeModelRef } from '../openCodeOpenAiCatalog';

const MAX_MODEL_LIST_CHARS = 65_536;
const MAX_DISCOVERED_MODELS = 2_000;
const UNSAFE_MODEL_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u;

export interface OpenCodeDiscoveredModel {
  id: string;
  providerId: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildOpenCodeInvocation(request: CliInvocationRequest): CliInvocation {
  assertCliPrompt(request.prompt);
  const modelId = requireOpenCodeModelId(request.modelId);
  return {
    args: [
      'run',
      '--format',
      'json',
      '--model',
      formatOpenCodeModelRef(modelId, request.reasoningEffort),
    ],
    stdin: request.prompt,
    ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
  };
}

/**
 * OpenCode receives argv as a literal array through the native supervisor, so
 * spaces and ordinary punctuation do not require shell escaping. Option-looking,
 * control, and bidirectional text is rejected fail-closed.
 */
export function requireOpenCodeModelId(modelId: string | undefined): string {
  const value = modelId?.trim();
  if (!value) throw new Error('OpenCode CLI requires an explicit model');
  if (value.length > 512) throw new Error('OpenCode CLI model ID exceeds 512 characters');
  if (value.startsWith('-') || UNSAFE_MODEL_TEXT.test(value)) {
    throw new Error('OpenCode CLI model ID contains unsafe characters');
  }
  return value;
}

function discoveredModel(value: unknown): OpenCodeDiscoveredModel | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : undefined;
  if (typeof raw !== 'string') return undefined;
  let id: string;
  try {
    id = requireOpenCodeModelId(raw);
  } catch {
    return undefined;
  }
  const separator = id.indexOf('/');
  const providerId = separator > 0 ? id.slice(0, separator) : 'opencode';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(providerId)) return undefined;
  return Object.freeze({ id, providerId });
}

/** Parses the read-only `opencode models` output without reading or writing auth files. */
export function parseOpenCodeModelList(output: string): readonly OpenCodeDiscoveredModel[] {
  if (typeof output !== 'string' || output.length > MAX_MODEL_LIST_CHARS) {
    throw new Error('OpenCode model list output exceeds the safe bound');
  }
  const trimmed = output.trim();
  if (!trimmed) return Object.freeze([]);
  let entries: readonly unknown[];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Malformed OpenCode model list output');
    }
    if (!Array.isArray(parsed)) throw new Error('Malformed OpenCode model list output');
    entries = parsed;
  } else {
    entries = trimmed.split(/\r?\n/u);
  }
  if (entries.length > MAX_DISCOVERED_MODELS) {
    throw new Error('OpenCode model list exceeds the safe model count');
  }
  const byId = new Map<string, OpenCodeDiscoveredModel>();
  for (const entry of entries) {
    const model = discoveredModel(entry);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return Object.freeze([...byId.values()]);
}

export function normalizeOpenCodeRecord(
  record: Readonly<Record<string, unknown>>,
): ProviderRecordNormalization {
  const part = recordOf(record.part);
  if (record.type === 'step_start') {
    const events: ProviderEvent[] = [];
    const sessionId = boundedProviderIdentifier(
      part?.sessionID ?? part?.session_id ?? record.sessionID ?? record.session_id,
    );
    const modelId = boundedProviderIdentifier(
      part?.modelID ?? part?.model_id ?? record.modelID ?? record.model_id,
    );
    if (sessionId) events.push({ type: 'session', sessionId });
    if (modelId) events.push({ type: 'model', modelId });
    return { recognized: true, events };
  }
  if (record.type === 'text') {
    const delta = boundedProviderText(part?.text, 32_768);
    return { recognized: true, events: delta ? [{ type: 'text', delta }] : [] };
  }
  if (record.type === 'reasoning') {
    const delta = boundedProviderText(part?.text, 32_768);
    return { recognized: true, events: delta ? [{ type: 'reasoning', delta }] : [] };
  }
  if (record.type === 'tool_use') {
    const state = recordOf(part?.state);
    const name = boundedProviderIdentifier(part?.tool);
    const rawStatus = state?.status;
    const status =
      rawStatus === 'completed' ? 'completed' : rawStatus === 'error' ? 'failed' : 'started';
    const callId = boundedProviderIdentifier(part?.callID ?? part?.call_id);
    return {
      recognized: true,
      events: name
        ? [
            {
              type: 'tool',
              name,
              status,
              ...(callId ? { callId } : {}),
            },
          ]
        : [],
    };
  }
  if (record.type === 'step_finish') {
    if (!part || part.type !== 'step-finish' || typeof part.reason !== 'string') {
      throw new Error('Malformed OpenCode terminal event');
    }
    const tokens = recordOf(part.tokens);
    const events: ProviderEvent[] = [];
    if (tokens || typeof part.cost === 'number') {
      events.push({
        type: 'usage',
        usage: responseUsageSnapshot({
          inputTokens: tokens?.input,
          outputTokens: tokens?.output,
          totalTokens: tokens?.total,
          costUsd: part.cost,
        }),
      });
    }
    events.push({
      type: 'done',
      ...(boundedProviderIdentifier(part.reason)
        ? { finishReason: boundedProviderIdentifier(part.reason) }
        : {}),
    });
    return { recognized: true, events };
  }
  if (record.type === 'error') {
    const message = boundedProviderText(record.message ?? record.error, 2_048);
    return {
      recognized: true,
      events: [{ type: 'error', message: message || 'OpenCode CLI reported an error.' }],
    };
  }
  return { recognized: false, events: [] };
}

export function normalizeOpenCodeJsonl(input: string, limits?: JsonlParserLimits): ProviderEvent[] {
  return normalizeProviderJsonl(input, normalizeOpenCodeRecord, limits);
}

export const OPENCODE_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'opencode-cli',
  connectionId: 'opencode-cli',
  promptTransport: 'prefixed-preamble',
  executableName: 'opencode',
  versionArgs: Object.freeze(['--version']),
  authProbeArgs: Object.freeze(['auth', 'list']),
  modelListArgs: Object.freeze(['models', 'openai', '--refresh']),
  parseModelList: (output: string) =>
    parseOpenCodeModelList(output).map((model) => Object.freeze({ id: model.id, label: model.id })),
  buildInvocation: buildOpenCodeInvocation,
  normalizeRecord: normalizeOpenCodeRecord,
});

export const openCodeDiagnosticCliAdapter = createCliProviderAdapter(OPENCODE_CLI_DEFINITION);
/** @deprecated Production chat uses the persistent OpenCode server adapter. */
export const openCodeCliAdapter = openCodeDiagnosticCliAdapter;
