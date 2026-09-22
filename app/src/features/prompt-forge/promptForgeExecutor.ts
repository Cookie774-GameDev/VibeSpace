import type { Agent, AgentId, ProviderId } from '@/types';
import { runAgent, type RunAgentRequest } from '@/lib/ai/router';
import { DEFAULT_CHAT_RUNTIME_SETTINGS } from '@/features/chat/runtime/chatRuntimeCommandController';
import type { LLMResponse, LLMStreamChunk, TokenUsage } from '@/lib/ai/types';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { TOOL_GATEWAY_CATALOG } from '@/lib/harness/toolGatewayProtocol';
import { hasDetectedSecret } from '@/lib/security/secretDetector';
import type { PromptForgeJob } from './contracts';
import { resolvePromptForgeExecutionScope } from './promptForgeExecutionScope';
import { preparePromptForgeImageParts } from './promptForgeImages';
import type { ResolvedPromptForgeModel } from './modelSelection';
import {
  validatePromptPreservation,
  type PromptPreservationContract,
  type PromptPreservationResult,
} from './preservation';
import type { PromptForgeSourcePack } from './sourcePack';
import promptForgeSkillRaw from '../../../.jarvis/skills/prompt-forge-upgrader/SKILL.md?raw';

const PROMPT_FORGE_AGENT_ID = 'agent_prompt_forge' as AgentId;
const MAX_OUTPUT_TOKENS = 16_384;
const PROMPT_FORGE_TOOL_POLICY: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(TOOL_GATEWAY_CATALOG.map((tool) => [tool, false])),
);

function skillBody(raw: string): string {
  const normalized = raw.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith('---\n')) return normalized.trim();
  const closing = normalized.indexOf('\n---\n', 4);
  return closing < 0 ? normalized.trim() : normalized.slice(closing + 5).trim();
}

const PROMPT_FORGE_SYSTEM_PROMPT = [
  'You are VibeSpace Prompt Forge — a shared prompt upgrade engine for Chat and Terminal.',
  skillBody(promptForgeSkillRaw),
].join('\n\n');

export type PromptForgeExecutionErrorCode = 'empty_output' | 'model_mismatch' | 'sensitive_input';

export class PromptForgeExecutionError extends Error {
  constructor(readonly code: PromptForgeExecutionErrorCode) {
    super(
      code === 'empty_output'
        ? 'The Prompt Forge model returned no upgraded prompt.'
        : code === 'model_mismatch'
          ? 'The Prompt Forge provider silently changed the selected model.'
          : 'Prompt Forge blocked detected secrets before model transport.',
    );
    this.name = 'PromptForgeExecutionError';
  }
}

export type PromptForgeExecutionResult = Readonly<{
  upgradedPrompt: string;
  validation: PromptPreservationResult;
  usage: Readonly<TokenUsage>;
  provider: ProviderId;
  model: string;
  finishReason: string | null;
  startedAt: number;
  completedAt: number;
}>;

export type PromptForgeExecutionInput = Readonly<{
  job: Pick<
    PromptForgeJob,
    | 'id'
    | 'originalDraft'
    | 'regenerationInstructions'
    | 'createdAt'
    | 'accountId'
    | 'chatId'
    | 'projectId'
  >;
  model: ResolvedPromptForgeModel;
  sourcePack: PromptForgeSourcePack;
  preservation: PromptPreservationContract;
  imageAttachments?: readonly ChatImageAttachment[];
  signal?: AbortSignal;
  workingDirectory?: string;
  onChunk?: (chunk: LLMStreamChunk) => void;
}>;

export type PromptForgeModelRunner = (request: RunAgentRequest) => Promise<LLMResponse>;

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The Prompt Forge request was aborted.', 'AbortError');
  }
}

function createExecutionAgent(model: ResolvedPromptForgeModel, createdAt: number): Readonly<Agent> {
  const agentEffort =
    model.effort === 'minimal' ||
    model.effort === 'low' ||
    model.effort === 'medium' ||
    model.effort === 'high' ||
    model.effort === 'max'
      ? model.effort
      : undefined;
  const agent: Agent = {
    id: PROMPT_FORGE_AGENT_ID,
    slug: 'prompt-forge',
    name: 'Prompt Forge',
    description: 'A tool-free prompt refinement agent.',
    system_prompt: PROMPT_FORGE_SYSTEM_PROMPT,
    model: { provider: model.providerId, model: model.modelId },
    tools_allowed: [],
    memory_scope: 'project',
    temperature: 0.2,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    capabilities: ['writing', 'reasoning'],
    builtin: true,
    ...(agentEffort === undefined ? {} : { effort: agentEffort }),
    source: 'builtin',
    created_at: createdAt,
    updated_at: createdAt,
  };
  Object.freeze(agent.model);
  Object.freeze(agent.tools_allowed);
  Object.freeze(agent.capabilities);
  return Object.freeze(agent);
}

function buildUpgradeMessage(input: PromptForgeExecutionInput): string {
  let longestFence = 2;
  for (const text of [input.job.originalDraft, input.job.regenerationInstructions ?? '']) {
    for (const match of text.matchAll(/`+/gu)) {
      longestFence = Math.max(longestFence, match[0].length);
    }
  }
  const draftFence = '`'.repeat(longestFence + 1);
  return [
    '# Original user draft',
    `${draftFence}text`,
    input.job.originalDraft,
    draftFence,
    ...(input.job.regenerationInstructions
      ? [
          '',
          '# Additional regeneration instructions',
          `${draftFence}text`,
          input.job.regenerationInstructions,
          draftFence,
        ]
      : []),
    '',
    '# Relevant VibeSpace evidence',
    input.sourcePack.markdown,
    '',
    '# Required result',
    'Return one upgraded prompt only.',
    'Make the result an executable instruction that tells the downstream agent to perform the original task now, not to produce another rewritten prompt.',
    'Include objective, hard constraints, relevant context with source labels, success criteria, autonomy/approval boundaries, and verification requirements when they apply.',
    'Preserve the original intent and every protected element. Use source facts only when the evidence supports them. Cite source labels/paths inline where facts come from the pack.',
  ].join('\n');
}

function providerMatches(selected: ProviderId, actual: ProviderId): boolean {
  return (
    selected === actual ||
    ((selected === 'local' || selected === 'ollama') && (actual === 'local' || actual === 'ollama'))
  );
}

export function createPromptForgeExecutor(
  dependencies: Readonly<{
    runModel?: PromptForgeModelRunner;
    resolveScope?: typeof resolvePromptForgeExecutionScope;
    now?: () => number;
  }> = {},
) {
  const runModel = dependencies.runModel ?? runAgent;
  const resolveScope = dependencies.resolveScope ?? resolvePromptForgeExecutionScope;
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    async execute(input: PromptForgeExecutionInput): Promise<PromptForgeExecutionResult> {
      abortIfRequested(input.signal);
      if (
        hasDetectedSecret(input.job.originalDraft) ||
        (input.job.regenerationInstructions !== null &&
          hasDetectedSecret(input.job.regenerationInstructions))
      ) {
        throw new PromptForgeExecutionError('sensitive_input');
      }
      const startedAt = now();
      const agent = createExecutionAgent(input.model, input.job.createdAt);
      const prompt = buildUpgradeMessage(input);
      const imageParts = preparePromptForgeImageParts(input.imageAttachments ?? [], input.model);
      const scope = await resolveScope(input.job);
      abortIfRequested(input.signal);
      const response = await runModel({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
        purpose: 'prompt_forge',
        agent,
        messages: [
          {
            role: 'user',
            content:
              imageParts.length === 0
                ? prompt
                : [Object.freeze({ type: 'text' as const, text: prompt }), ...imageParts],
          },
        ],
        requestId: `prompt-forge:${input.job.id}`,
        temperature: 0.2,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        runtimeSettings: {
          ...DEFAULT_CHAT_RUNTIME_SETTINGS,
          effort: input.model.effort ?? 'auto',
        },
        tools: PROMPT_FORGE_TOOL_POLICY,
        ...(imageParts.length === 0 ? {} : { connectionRequirements: { images: true } }),
        ...(input.model.connectionId === null ? {} : { connectionId: input.model.connectionId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.workingDirectory === undefined
          ? {}
          : { workingDirectory: input.workingDirectory }),
        ...(input.onChunk === undefined ? {} : { onChunk: input.onChunk }),
      });
      abortIfRequested(input.signal);
      if (response.text.trim().length === 0) {
        throw new PromptForgeExecutionError('empty_output');
      }
      if (
        !providerMatches(input.model.providerId, response.provider) ||
        response.model !== input.model.modelId
      ) {
        throw new PromptForgeExecutionError('model_mismatch');
      }
      const validation = validatePromptPreservation(input.preservation, response.text);
      const completedAt = now();
      return Object.freeze({
        upgradedPrompt: response.text,
        validation,
        usage: Object.freeze({ ...response.usage }),
        provider: response.provider,
        model: response.model,
        finishReason: response.finish_reason ?? null,
        startedAt,
        completedAt,
      });
    },
  });
}

export const promptForgeExecutor = createPromptForgeExecutor();
