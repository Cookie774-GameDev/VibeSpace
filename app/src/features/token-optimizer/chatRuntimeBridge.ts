import { llmContentToText, type LLMMessage } from '@/lib/ai/types';
import type { ContextBudgetKind, TokenOptimizationMode } from './contracts';
import type { TokenOptimizationReceipt } from './optimizationReport';
import {
  createProductionTokenizers,
  type ProductionTokenizerOptions,
} from './productionTokenizerEngines';
import {
  createTokenOptimizerService,
  type TokenOptimizerService,
  type TokenOptimizationSegment,
} from './tokenOptimizerService';
import { createTokenizerRegistry } from './tokenizerRegistry';

const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_REQUESTED_OUTPUT_TOKENS = 8_192;

export interface ChatTokenOptimizationRequest {
  readonly mode: Exclude<TokenOptimizationMode, 'off'>;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelContextLimit?: number;
  readonly requestedOutputTokens?: number;
  readonly systemPrompt?: string;
  readonly contextSegments?: readonly Readonly<{
    id: string;
    kind: ContextBudgetKind;
    text: string;
    relevance: number;
    protected: boolean;
    reason: string;
  }>[];
  readonly messages: readonly LLMMessage[];
  /**
   * Explicitly authorizes injected provider-native counters for non-protected
   * segments. It never authorizes system, latest-user, attachment, approval,
   * quoted, patch, structured-tool, or secret-warning content.
   */
  readonly allowProviderTokenCountTransport?: boolean;
  readonly signal?: AbortSignal;
}

export interface ChatTokenOptimizationResult {
  readonly messages: LLMMessage[];
  readonly systemPrompt: string;
  readonly outputTokenLimit: number;
  readonly receipt: TokenOptimizationReceipt;
}

export interface ChatTokenOptimizationRuntime {
  optimizeMessages(request: ChatTokenOptimizationRequest): Promise<ChatTokenOptimizationResult>;
}

type ConversationGroup = Readonly<{
  id: string;
  messages: readonly LLMMessage[];
  tokenText: string;
  protected: boolean;
  relevance: number;
}>;

function containsImage(message: LLMMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === 'image');
}

function groupConversation(messages: readonly LLMMessage[]): readonly ConversationGroup[] {
  const groups: LLMMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || groups.length === 0) {
      groups.push([message]);
    } else {
      groups.at(-1)!.push(message);
    }
  }

  let latestUserGroup = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index]!.some((message) => message.role === 'user')) {
      latestUserGroup = index;
      break;
    }
  }
  return Object.freeze(
    groups.map((group, index) => {
      const position = groups.length <= 1 ? 1 : index / (groups.length - 1);
      const isImmediateConversation =
        latestUserGroup >= 0 && index >= Math.max(0, latestUserGroup - 1);
      return Object.freeze({
        id: `conversation-${String(index + 1).padStart(3, '0')}`,
        messages: Object.freeze([...group]),
        tokenText: group
          .map((message) => `[${message.role}]\n${llmContentToText(message.content)}`)
          .join('\n\n'),
        // The active user turn and the immediately preceding exchange form
        // the minimum coherent conversational unit. Older turns remain
        // relevance-ranked and compressible.
        protected: isImmediateConversation || group.some(containsImage),
        relevance: Math.min(1, 0.2 + position * 0.8),
      });
    }),
  );
}

function safeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

async function optimizeWith(
  optimizer: TokenOptimizerService,
  request: ChatTokenOptimizationRequest,
): Promise<ChatTokenOptimizationResult> {
  const groups = groupConversation(request.messages);
  const segments: TokenOptimizationSegment[] = [];
  if (request.systemPrompt?.trim()) {
    segments.push({
      id: 'system-001',
      kind: 'system_instruction',
      text: request.systemPrompt,
      relevance: 1,
      protected: true,
      reason: 'Protected system authority',
    });
  }
  for (const context of request.contextSegments ?? []) {
    segments.push({
      id: `runtime-${context.id}`,
      kind: context.kind,
      text: context.text,
      relevance: context.relevance,
      protected: context.protected,
      reason: context.reason,
    });
  }
  for (const group of groups) {
    segments.push({
      id: group.id,
      kind: group.protected ? 'latest_user_message' : 'conversation_history',
      text: group.tokenText,
      relevance: group.relevance,
      protected: group.protected,
      reason: group.protected
        ? 'Protected current turn or explicit image attachment'
        : 'Recency-ranked conversation history',
    });
  }

  const optimized = await optimizer.optimize({
    mode: request.mode,
    providerId: request.providerId,
    modelId: request.modelId,
    modelContextLimit: safeLimit(
      request.modelContextLimit,
      FALLBACK_CONTEXT_WINDOW_TOKENS,
    ),
    requestedOutputTokens: safeLimit(
      request.requestedOutputTokens,
      DEFAULT_REQUESTED_OUTPUT_TOKENS,
    ),
    segments,
    allowProviderTokenCountTransport:
      request.allowProviderTokenCountTransport === true,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const selected = new Set(optimized.selectedSegments.map(({ id }) => id));
  const selectedRuntimeContext = (request.contextSegments ?? [])
    .filter(({ id }) => selected.has(`runtime-${id}`))
    .map(({ text }) => text);
  return Object.freeze({
    messages: groups
      .filter(({ id }) => selected.has(id))
      .flatMap(({ messages: selectedMessages }) => selectedMessages),
    systemPrompt: [...selectedRuntimeContext, request.systemPrompt ?? '']
      .filter((text) => text.trim().length > 0)
      .join('\n\n'),
    outputTokenLimit: optimized.receipt.outputTokenLimit,
    receipt: optimized.receipt,
  });
}

/**
 * Creates an isolated runtime. Provider-native counters and open-model assets
 * are absent unless the host injects real trusted ports/assets.
 */
export function createChatTokenOptimizationRuntime(
  tokenizerOptions: ProductionTokenizerOptions = {},
): ChatTokenOptimizationRuntime {
  const optimizer = createTokenOptimizerService(
    createTokenizerRegistry(createProductionTokenizers(tokenizerOptions)),
  );
  return Object.freeze({
    optimizeMessages: (request: ChatTokenOptimizationRequest) => optimizeWith(optimizer, request),
  });
}

const productionRuntime = createChatTokenOptimizationRuntime();

export function optimizeChatMessages(
  request: ChatTokenOptimizationRequest,
): Promise<ChatTokenOptimizationResult> {
  return productionRuntime.optimizeMessages(request);
}
