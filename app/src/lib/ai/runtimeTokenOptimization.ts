import {
  optimizeChatMessages,
  type ChatTokenOptimizationRequest,
  type ContextBudgetKind,
  type TokenOptimizationMode,
} from '@/features/token-optimizer';
import type {
  JarvisRuntimeContextBlock,
  JarvisRuntimeContextBlockKey,
} from '@/lib/jarvis/runtimeContextCandidates';
import type { LLMMessage } from './types';

const PROTECTED_TOKEN_OPTIMIZATION_CONTEXT = new Set<JarvisRuntimeContextBlockKey>([
  'default_write_folder',
  'mcp_tool_schemas',
  'selected_skills',
  'intent_policy',
  'interaction_mode',
  'structured_context',
  'explicit_context',
  'explicit_files',
  'explicit_terminal',
  'coordination',
  'terminal_operating',
  'connected_files',
  'completion_instruction',
]);

export function isProtectedTokenOptimizationContext(key: JarvisRuntimeContextBlockKey): boolean {
  return PROTECTED_TOKEN_OPTIMIZATION_CONTEXT.has(key);
}

export function tokenOptimizationContextKind(key: JarvisRuntimeContextBlockKey): ContextBudgetKind {
  if (key === 'mcp_tool_schemas') return 'tool_schema';
  if (key === 'structured_context') return 'structured_tool_data';
  if (key === 'explicit_context') return 'pinned_context_node';
  if (key === 'explicit_files' || key === 'explicit_terminal' || key === 'connected_files') {
    return 'explicit_attachment';
  }
  if (key === 'project' || key === 'repository_context' || key === 'local_knowledge') {
    return 'repository_file';
  }
  if (key === 'project_tree' || key === 'resolved_context') return 'context_map_node';
  if (key === 'user_identity' || key === 'all_about_me') return 'memory';
  if (key === 'terminal_transcript' || key === 'mentioned_agents') {
    return 'conversation_history';
  }
  if (
    key === 'intent_policy' ||
    key === 'interaction_mode' ||
    key === 'coordination' ||
    key === 'terminal_operating' ||
    key === 'completion_instruction'
  ) {
    return 'approval_requirement';
  }
  return 'documentation';
}

export function tokenOptimizationContextRelevance(
  score: number | undefined,
  index: number,
  count: number,
): number {
  if (typeof score === 'number' && Number.isFinite(score) && score >= 0) {
    return Math.min(1, score <= 1 ? score : score / (score + 1));
  }
  return count <= 1 ? 1 : Math.max(0.1, 1 - index / count);
}

export async function optimizeKernelRuntimeContext(
  input: {
    mode: TokenOptimizationMode;
    providerId: string;
    modelId: string;
    systemPrompt: string;
    blocks: readonly JarvisRuntimeContextBlock[];
    messages: readonly LLMMessage[];
    modelContextLimit?: number;
    contextMetadataSource?: 'foundry_catalog_ceiling';
    requestedOutputTokens?: number;
    signal?: AbortSignal;
  },
  optimize = optimizeChatMessages,
) {
  if (input.mode === 'off')
    return { blocks: input.blocks, messages: input.messages, receipt: null };
  const request: ChatTokenOptimizationRequest = {
    mode: input.mode,
    providerId: input.providerId,
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    modelContextLimit: input.modelContextLimit,
    ...(input.contextMetadataSource === undefined ? {} : { contextMetadataSource: input.contextMetadataSource }),
    requestedOutputTokens: input.requestedOutputTokens,
    signal: input.signal,
    contextSegments: input.blocks.map((block, index) => ({
      id: `${block.key}-${index + 1}`,
      kind: tokenOptimizationContextKind(block.key),
      text: block.text,
      relevance: tokenOptimizationContextRelevance(block.score, index, input.blocks.length),
      protected: isProtectedTokenOptimizationContext(block.key),
      reason: `Runtime context: ${block.key}`,
    })),
  };
  const result = await optimize(request);
  const selected = new Set(result.selectedContextIds);
  return {
    blocks: input.blocks.filter((block, index) => selected.has(`${block.key}-${index + 1}`)),
    messages: result.messages,
    receipt: result.receipt,
  };
}
