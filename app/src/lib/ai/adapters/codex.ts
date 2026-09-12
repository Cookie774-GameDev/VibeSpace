import {
  assertCliPrompt,
  boundedProviderIdentifier,
  boundedProviderText,
  createCliProviderAdapter,
  normalizeProviderJsonl,
  requireModelId,
  responseUsageSnapshot,
  type CliProbeResult,
  type CliInvocation,
  type CliInvocationRequest,
  type CliProviderDefinition,
  type JsonlParserLimits,
  type ProviderRecordNormalization,
} from './cliBridge';
import type { AuthProbeResult, ProviderEvent } from './types';

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolStatus(value: unknown): Extract<ProviderEvent, { type: 'tool' }>['status'] {
  if (value === 'completed' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  return 'started';
}

export function buildCodexInvocation(request: CliInvocationRequest): CliInvocation {
  assertCliPrompt(request.prompt);
  const enabledTools = Object.entries(request.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  if (
    enabledTools.length > 0 &&
    (enabledTools.length !== 1 || enabledTools[0] !== 'vibespace_context')
  ) {
    throw new Error('Codex CLI tool scope is unsupported');
  }
  const args =
    enabledTools.length === 1
      ? ['exec', '--json']
      : ['exec', '--ignore-user-config', '--ephemeral', '--json'];
  if (request.workingDirectory) args.push('--cd', request.workingDirectory);
  if (request.modelId) args.push('--model', requireModelId(request.modelId, 'Codex'));
  if (request.reasoningEffort) {
    if (!['low', 'medium', 'high', 'xhigh'].includes(request.reasoningEffort)) {
      throw new Error('Codex CLI reasoning effort is unsupported');
    }
    args.push('-c', `model_reasoning_effort="${request.reasoningEffort}"`);
  }
  return {
    args,
    stdin: request.prompt,
    ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
    ...(enabledTools.length === 1 ? { toolScope: 'vibespace_context' as const } : {}),
  };
}

export function normalizeCodexRecord(
  record: Readonly<Record<string, unknown>>,
): ProviderRecordNormalization {
  const type = record.type;
  if (type === 'thread.started') {
    const sessionId = boundedProviderIdentifier(record.thread_id);
    return {
      recognized: true,
      events: sessionId ? [{ type: 'session', sessionId }] : [],
    };
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = recordOf(record.item);
    if (!item) return { recognized: true, events: [] };
    if (item.type === 'agent_message') {
      const delta = boundedProviderText(item.text, 32_768);
      return { recognized: true, events: delta ? [{ type: 'text', delta }] : [] };
    }
    if (item.type === 'reasoning') {
      const delta = boundedProviderText(item.text, 32_768);
      return { recognized: true, events: delta ? [{ type: 'reasoning', delta }] : [] };
    }
    if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
      const rawName = boundedProviderIdentifier(item.name ?? item.command);
      const name = rawName?.split(/\s+/, 1)[0];
      if (!name) return { recognized: true, events: [] };
      return {
        recognized: true,
        events: [
          {
            type: 'tool',
            name,
            status: toolStatus(
              item.status ?? (type === 'item.completed' ? 'completed' : 'started'),
            ),
            ...(boundedProviderIdentifier(item.id)
              ? { callId: boundedProviderIdentifier(item.id) }
              : {}),
          },
        ],
      };
    }
    return { recognized: false, events: [] };
  }
  if (type === 'turn.completed') {
    const usage = recordOf(record.usage);
    if (!usage) throw new Error('Malformed Codex terminal event');
    const events: ProviderEvent[] = [];
    const modelId = boundedProviderIdentifier(record.model);
    if (modelId) events.push({ type: 'model', modelId });
    events.push({
      type: 'usage',
      usage: responseUsageSnapshot({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      }),
    });
    events.push({ type: 'done', finishReason: 'completed' });
    return { recognized: true, events };
  }
  if (type === 'turn.failed' || type === 'error') {
    const nested = recordOf(record.error);
    const message = boundedProviderText(
      typeof record.error === 'string' ? record.error : (record.message ?? nested?.message),
      2_048,
    );
    return {
      recognized: true,
      events: [{ type: 'error', message: message || 'Codex CLI reported an error.' }],
    };
  }
  if (type === 'turn.started') return { recognized: true, events: [] };
  return { recognized: false, events: [] };
}

export function normalizeCodexJsonl(input: string, limits?: JsonlParserLimits): ProviderEvent[] {
  return normalizeProviderJsonl(input, normalizeCodexRecord, limits);
}

export function classifyCodexAuthProbe(probe: Readonly<CliProbeResult>): AuthProbeResult {
  if (probe.timedOut || probe.exitCode !== 0 || probe.stdout.truncated || probe.stderr.truncated) {
    return {
      status: 'unknown',
      detail: 'Codex sign-in status could not be verified.',
    };
  }
  const output = `${probe.stdout.data}\n${probe.stderr.data}`;
  if (/\blogged\s+in\s+(?:to|using)\s+chatgpt\b/iu.test(output)) {
    return {
      status: 'authenticated',
      detail: 'Authenticated through ChatGPT.',
    };
  }
  if (/\b(?:api[- ]?key|openai_api_key)\b/iu.test(output)) {
    return {
      status: 'unauthenticated',
      detail: 'Codex is using an API key, not a ChatGPT subscription session.',
    };
  }
  return {
    status: 'unauthenticated',
    detail: 'ChatGPT subscription sign-in is not active.',
  };
}

export const CODEX_CLI_DEFINITION: CliProviderDefinition = Object.freeze({
  adapterId: 'codex-cli',
  connectionId: 'openai-codex',
  promptTransport: 'prefixed-preamble',
  executableName: 'codex',
  versionArgs: Object.freeze(['--version']),
  authProbeArgs: Object.freeze(['login', 'status']),
  classifyAuthProbe: classifyCodexAuthProbe,
  buildInvocation: buildCodexInvocation,
  normalizeRecord: normalizeCodexRecord,
});

export const codexCliAdapter = createCliProviderAdapter(CODEX_CLI_DEFINITION);
