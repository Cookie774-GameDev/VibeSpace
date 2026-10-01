import {
  assertCliPrompt,
  boundedProviderText,
  createCliProviderAdapter,
  normalizeProviderJsonl,
  requireModelId,
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

export function buildQwenInvocation(request: CliInvocationRequest): CliInvocation {
  assertCliPrompt(request.prompt);
  const modelId = requireModelId(request.modelId, 'Qwen');
  return {
    args: ['-p', request.prompt, '--output-format', 'stream-json', '--model', modelId],
    ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
  };
}

export function normalizeQwenRecord(
  record: Readonly<Record<string, unknown>>,
): ProviderRecordNormalization {
  if (record.type === 'message') {
    if (record.role !== undefined && record.role !== 'assistant') {
      return { recognized: true, events: [] };
    }
    const delta = boundedProviderText(record.content ?? record.text, 32_768);
    return { recognized: true, events: delta ? [{ type: 'text', delta }] : [] };
  }
  if (record.type === 'result') {
    if (typeof record.status !== 'string') throw new Error('Malformed Qwen terminal event');
    if (record.status !== 'success') {
      const message = boundedProviderText(record.error ?? record.message, 2_048);
      return {
        recognized: true,
        events: [{ type: 'error', message: message || 'Qwen CLI reported an error.' }],
      };
    }
    const usage = recordOf(record.usage ?? record.stats);
    const events: ProviderEvent[] = [];
    if (usage) {
      events.push({
        type: 'usage',
        usage: responseUsageSnapshot({
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
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
      events: [{ type: 'error', message: message || 'Qwen CLI reported an error.' }],
    };
  }
  return { recognized: false, events: [] };
}

export function normalizeQwenJsonl(input: string, limits?: JsonlParserLimits): ProviderEvent[] {
  return normalizeProviderJsonl(input, normalizeQwenRecord, limits);
}

export const QWEN_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'qwen-code-cli',
  connectionId: 'qwen-code',
  promptTransport: 'prefixed-preamble',
  executableName: 'qwen',
  versionArgs: Object.freeze(['--version']),
  modelListArgs: Object.freeze(['/model']),
  buildInvocation: buildQwenInvocation,
  normalizeRecord: normalizeQwenRecord,
});

export const qwenCliAdapter = createCliProviderAdapter(QWEN_CLI_DEFINITION);
