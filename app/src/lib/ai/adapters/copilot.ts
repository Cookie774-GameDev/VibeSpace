import {
  assertCliPrompt,
  boundedProviderIdentifier,
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

export function buildCopilotInvocation(request: CliInvocationRequest): CliInvocation {
  assertCliPrompt(request.prompt);
  const modelId = requireModelId(request.modelId, 'Copilot');
  return {
    args: ['-p', request.prompt, '--output-format=json', `--model=${modelId}`],
    ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
  };
}

export function normalizeCopilotRecord(
  record: Readonly<Record<string, unknown>>,
): ProviderRecordNormalization {
  if (record.type === 'assistant.message_delta') {
    return { recognized: true, events: [] };
  }
  if (record.type === 'assistant.message' || record.type === 'message') {
    const data = recordOf(record.data);
    const delta = boundedProviderText(record.content ?? data?.content ?? record.text, 32_768);
    const events: ProviderEvent[] = delta ? [{ type: 'text', delta }] : [];
    const modelId = boundedProviderIdentifier(record.model ?? data?.model);
    if (modelId) events.push({ type: 'model', modelId });
    return { recognized: true, events };
  }
  if (record.type === 'result') {
    const exitCode = record.exitCode;
    const legacyStatus = record.status;
    const hasExitCode =
      typeof exitCode === 'number' && Number.isFinite(exitCode) && Number.isInteger(exitCode);
    const hasLegacyStatus = typeof legacyStatus === 'string';
    if (!hasExitCode && !hasLegacyStatus) throw new Error('Malformed Copilot terminal event');
    const successful = hasExitCode ? exitCode === 0 : legacyStatus === 'success';
    if (!successful) {
      const message = boundedProviderText(record.error ?? record.message, 2_048);
      return {
        recognized: true,
        events: [
          {
            type: 'error',
            message:
              message ||
              (hasExitCode
                ? `Copilot CLI exited with code ${exitCode}.`
                : 'Copilot CLI reported an error.'),
          },
        ],
      };
    }
    const usage = recordOf(record.usage);
    const events: ProviderEvent[] = [];
    const sessionId = boundedProviderIdentifier(record.sessionId ?? record.session_id);
    if (sessionId) events.push({ type: 'session', sessionId });
    if (usage) {
      events.push({
        type: 'usage',
        usage: responseUsageSnapshot({
          inputTokens: usage.inputTokens ?? usage.input_tokens,
          outputTokens: usage.outputTokens ?? usage.output_tokens,
          totalTokens: usage.totalTokens ?? usage.total_tokens,
        }),
      });
    }
    events.push({ type: 'done', finishReason: 'completed' });
    return { recognized: true, events };
  }
  if (record.type === 'error') {
    const message = boundedProviderText(record.message ?? record.error, 2_048);
    return {
      recognized: true,
      events: [{ type: 'error', message: message || 'Copilot CLI reported an error.' }],
    };
  }
  return { recognized: false, events: [] };
}

export function normalizeCopilotJsonl(input: string, limits?: JsonlParserLimits): ProviderEvent[] {
  return normalizeProviderJsonl(input, normalizeCopilotRecord, limits);
}

export const COPILOT_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'github-copilot-cli',
  connectionId: 'github-copilot-cli',
  promptTransport: 'prefixed-preamble',
  executableName: 'copilot',
  versionArgs: Object.freeze(['version']),
  modelListArgs: Object.freeze(['/model']),
  buildInvocation: buildCopilotInvocation,
  normalizeRecord: normalizeCopilotRecord,
});

export const copilotCliAdapter = createCliProviderAdapter(COPILOT_CLI_DEFINITION);
