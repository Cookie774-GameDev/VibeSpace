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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildGeminiInvocation(request: CliInvocationRequest): CliInvocation {
  assertCliPrompt(request.prompt);
  return {
    args: ['-p', request.prompt, '--output-format', 'stream-json'],
    ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
  };
}

export function normalizeGeminiRecord(
  record: Readonly<Record<string, unknown>>,
): ProviderRecordNormalization {
  if (record.type === 'init') {
    const events: ProviderEvent[] = [];
    const sessionId = boundedProviderIdentifier(record.session_id);
    const modelId = boundedProviderIdentifier(record.model);
    if (sessionId) events.push({ type: 'session', sessionId });
    if (modelId) events.push({ type: 'model', modelId });
    return { recognized: true, events };
  }
  if (record.type === 'message') {
    if (record.role !== undefined && record.role !== 'assistant') {
      return { recognized: true, events: [] };
    }
    const delta = boundedProviderText(record.content ?? record.text, 32_768);
    return { recognized: true, events: delta ? [{ type: 'text', delta }] : [] };
  }
  if (record.type === 'tool_use' || record.type === 'tool_result') {
    const name = boundedProviderIdentifier(record.name ?? record.tool_name);
    return {
      recognized: true,
      events: name
        ? [
            {
              type: 'tool',
              name,
              status: record.type === 'tool_result' ? 'completed' : 'started',
              ...(boundedProviderIdentifier(record.id)
                ? { callId: boundedProviderIdentifier(record.id) }
                : {}),
            },
          ]
        : [],
    };
  }
  if (record.type === 'result') {
    if (typeof record.status !== 'string') throw new Error('Malformed Gemini terminal event');
    if (record.status !== 'success') {
      const message = boundedProviderText(record.error ?? record.message, 2_048);
      return {
        recognized: true,
        events: [{ type: 'error', message: message || 'Gemini CLI reported an error.' }],
      };
    }
    const usage = recordOf(record.stats ?? record.usage);
    const events: ProviderEvent[] = [];
    if (usage) {
      events.push({
        type: 'usage',
        usage: responseUsageSnapshot({
          inputTokens: usage.input_tokens ?? usage.inputTokens,
          outputTokens: usage.output_tokens ?? usage.outputTokens,
          totalTokens: usage.total_tokens ?? usage.totalTokens,
        }),
      });
    }
    events.push({ type: 'done', finishReason: record.status });
    return { recognized: true, events };
  }
  if (record.type === 'error') {
    const message = boundedProviderText(record.message ?? record.error, 2_048);
    return {
      recognized: true,
      events: [{ type: 'error', message: message || 'Gemini CLI reported an error.' }],
    };
  }
  return { recognized: false, events: [] };
}

export function normalizeGeminiJsonl(input: string, limits?: JsonlParserLimits): ProviderEvent[] {
  return normalizeProviderJsonl(input, normalizeGeminiRecord, limits);
}

export const GEMINI_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'gemini-cli',
  connectionId: 'google-gemini-cli',
  promptTransport: 'prefixed-preamble',
  executableName: 'gemini',
  versionArgs: Object.freeze(['--version']),
  modelListArgs: Object.freeze(['/model']),
  buildInvocation: buildGeminiInvocation,
  normalizeRecord: normalizeGeminiRecord,
});

export const geminiCliAdapter = createCliProviderAdapter(GEMINI_CLI_DEFINITION);
