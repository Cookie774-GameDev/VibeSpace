import { CONNECTION_MODEL_OPTIONS } from './adapters/catalog';
import { isOpenAiSubscriptionModelAllowed } from './openCodeOpenAiCatalog';
import { ensureExternalConnectionAutoDetection } from './adapters/autoDetectConnections';
import { claudeCliAdapter } from './adapters/claude';
import { codexCliAdapter } from './adapters/codex';
import { copilotCliAdapter } from './adapters/copilot';
import { geminiCliAdapter } from './adapters/gemini';
import { openCodeCliAdapter } from './adapters/opencode';
import { qwenCliAdapter } from './adapters/qwen';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConnection,
  ProviderEvent,
} from './adapters/types';
import { UnsupportedPromptTransportError } from './providerPromptTransport';
import type { LLMResponse, LLMResponseObservation, LLMStreamChunk } from './types';
import type { ProviderId } from '@/types';
import { isConnectionSessionChecked, readConnectionSessionPickerStates } from './connectionState';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
} from '@/lib/harness/toolGatewayAuthority';

export interface SubscriptionCliBridgeRequest {
  connection: ProviderConnection;
  requestId: string;
  prompt: string;
  modelId?: string;
  reasoningEffort?: string;
  workingDirectory?: string;
  signal?: AbortSignal;
  requirements?: {
    images?: boolean;
    files?: boolean;
    tools?: boolean;
  };
  tools?: Readonly<Record<string, boolean>>;
  onChunk?: (chunk: LLMStreamChunk) => void;
  onResponseObservation?: (observation: LLMResponseObservation) => void;
  onActionDispatch?: (input: { observedAt: number }) => void;
}

const SUBSCRIPTION_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  [codexCliAdapter.id]: codexCliAdapter,
  [claudeCliAdapter.id]: claudeCliAdapter,
  [geminiCliAdapter.id]: geminiCliAdapter,
  [copilotCliAdapter.id]: copilotCliAdapter,
  [qwenCliAdapter.id]: qwenCliAdapter,
  [openCodeCliAdapter.id]: openCodeCliAdapter,
});

function assertCapabilities(
  connection: ProviderConnection,
  requirements: SubscriptionCliBridgeRequest['requirements'] = {},
): void {
  const checks: Array<[keyof ProviderCapabilities, boolean | undefined, string]> = [
    ['images', requirements.images, 'image attachments'],
    ['files', requirements.files, 'file attachments'],
    ['tools', requirements.tools, 'tools'],
  ];
  for (const [capability, required, label] of checks) {
    if (required && !connection.capabilities[capability]) {
      throw new Error(`${connection.displayName} does not support ${label}`);
    }
  }
}

function usageNumber(value: { value?: number } | undefined): number {
  return typeof value?.value === 'number' && Number.isFinite(value.value) ? value.value : 0;
}

function assertFreshSubscriptionAuthentication(connection: Readonly<ProviderConnection>): void {
  const currentState = readConnectionSessionPickerStates()[connection.id];
  if (
    !isConnectionSessionChecked(connection.id) ||
    currentState?.available !== true ||
    currentState.auth !== 'authenticated'
  ) {
    throw new Error('Subscription connection is not authenticated for this session.');
  }
}

/**
 * Executes a user-selected, already-authenticated subscription CLI connection.
 * This boundary is intentionally separate from the ordinary OpenCode router.
 */
export async function runSubscriptionCliBridge(
  request: SubscriptionCliBridgeRequest,
): Promise<LLMResponse> {
  const { connection } = request;
  if (connection.adapterId === 'opencode-cli' || connection.id === 'opencode-cli') {
    throw new Error(
      'OpenCode production send uses the persistent serve harness, not opencode run.',
    );
  }
  const adapter = SUBSCRIPTION_ADAPTERS[connection.adapterId];
  if (!adapter) throw new Error(`Provider adapter is unavailable: ${connection.adapterId}`);
  if (connection.mode !== 'external-cli') {
    throw new Error(`Provider connection is not an external agent: ${connection.id}`);
  }
  if (!connection.enabled) throw new Error(`Provider connection is disabled: ${connection.id}`);
  if (connection.promptTransport === 'unsupported') {
    throw new UnsupportedPromptTransportError(connection.id);
  }
  if (adapter.id !== connection.adapterId) {
    throw new Error(`Provider adapter mismatch for connection: ${connection.id}`);
  }
  const exactModels = CONNECTION_MODEL_OPTIONS[connection.id];
  if (
    exactModels &&
    request.modelId &&
    !(connection.id === 'openai-codex'
      ? isOpenAiSubscriptionModelAllowed(request.modelId, exactModels)
      : exactModels.some((model) => model.id === request.modelId))
  ) {
    throw new Error(`${request.modelId} is unavailable for ${connection.displayName}`);
  }
  assertCapabilities(connection, request.requirements);
  const enabledTools = Object.entries(request.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  if (
    enabledTools.some((name) => !connection.toolAllowlist?.includes(name as 'vibespace_context')) ||
    enabledTools.length > (connection.toolAllowlist?.length ?? 0)
  ) {
    throw new Error(`${connection.displayName} tool scope is unsupported`);
  }
  if (request.requirements?.tools && enabledTools.length !== 1) {
    throw new Error(`${connection.displayName} requires an exact tool scope`);
  }
  if (!adapter.send) throw new Error(`${connection.displayName} cannot send requests`);
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');

  await ensureExternalConnectionAutoDetection();
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');

  const needsAuthority = enabledTools.length === 1;
  const authorityClaim = needsAuthority ? captureToolGatewayAuthorityClaim() : null;
  if (
    needsAuthority &&
    (!authorityClaim || !bindToolGatewaySessionAuthority(request.requestId, authorityClaim))
  ) {
    throw new Error('Codex Context Map authority is unavailable.');
  }
  let text = '';
  let first = true;
  let finishReason: string | undefined;
  let usage: Extract<ProviderEvent, { type: 'usage' }>['usage'] | undefined;
  try {
    // Re-read process-local scan authority at the last synchronous boundary
    // before adapter dispatch. Persisted picker readiness from a prior app
    // session is never sufficient.
    assertFreshSubscriptionAuthentication(connection);
    for await (const event of adapter.send({
      requestId: request.requestId,
      connection,
      prompt: request.prompt,
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
      workingDirectory: request.workingDirectory,
      signal: request.signal,
      tools: request.tools,
      onResponseObservation: request.onResponseObservation,
      onActionDispatch: request.onActionDispatch,
    })) {
      if (request.signal?.aborted) {
        throw new DOMException('The request was aborted.', 'AbortError');
      }
      if (event.type === 'text') {
        text += event.delta;
        request.onChunk?.({ delta: event.delta, first });
        first = false;
      } else if (event.type === 'usage') {
        usage = event.usage;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      } else if (event.type === 'model' && request.modelId && event.modelId !== request.modelId) {
        throw new Error('Codex reported a model identity different from the exact selection.');
      } else if (event.type === 'done') {
        finishReason = event.finishReason;
      }
    }
  } finally {
    if (needsAuthority) releaseToolGatewaySessionAuthority(request.requestId);
  }
  request.onChunk?.({ delta: '', done: true });
  return {
    text,
    usage: {
      input_tokens: usageNumber(usage?.inputTokens),
      output_tokens: usageNumber(usage?.outputTokens),
      cost_usd: usageNumber(usage?.costUsd),
    },
    provider: connection.providerId as ProviderId,
    model: request.modelId ?? connection.modelId ?? connection.displayName,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}
