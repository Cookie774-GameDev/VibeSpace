import type { Agent } from '@/types';
import type { LLMMessage } from '../types';
import { runAgent } from '../router';
import { getAccessibleProviders } from '../models';
import { useAuthStore } from '@/stores/auth';
import { stepsForPreset, pickProviderFallback } from './presets';
import { classifyStackTask, effectiveStackPreset, parseStackSlashCommand } from './classifier';
import { canUseHostedStack, runHostedStackStep } from './hostedStack';
import type { StackPresetId, StackRunCallbacks, StackRunResult, StackStepSpec } from './types';

function providerHasKey(provider: StackStepSpec['provider']): boolean {
  const auth = useAuthStore.getState();
  if (provider === 'ollama' || provider === 'local') {
    return auth.offlineMode || Boolean(auth.apiKeys.ollama?.trim());
  }
  return Boolean(auth.apiKeys[provider]?.trim());
}

async function runStep(
  baseAgent: Agent,
  step: StackStepSpec,
  messages: LLMMessage[],
  signal?: AbortSignal,
  onChunk?: (delta: string, acc: string) => void,
): Promise<{
  text: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  provider: StackStepSpec['provider'];
  model: string;
  durationMs: number;
}> {
  const auth = useAuthStore.getState();
  const started = Date.now();
  const stepAgent: Agent = {
    ...baseAgent,
    system_prompt: `${baseAgent.system_prompt}\n\n--- Stack step: ${step.label} ---\n${step.systemAppend}`,
    model: { provider: step.provider, model: step.model },
    temperature: step.temperature ?? baseAgent.temperature,
    max_output_tokens: step.max_output_tokens ?? baseAgent.max_output_tokens,
  };

  let acc = '';

  if (!providerHasKey(step.provider) && canUseHostedStack(auth.plan)) {
    const hosted = await runHostedStackStep({
      provider: step.provider,
      model: step.model,
      systemPrompt: stepAgent.system_prompt,
      messages,
      temperature: stepAgent.temperature,
      max_output_tokens: stepAgent.max_output_tokens,
      signal,
      onChunk: (chunk) => {
        if (chunk.delta) {
          acc += chunk.delta;
          onChunk?.(chunk.delta, acc);
        }
      },
    });
    return {
      text: hosted.text,
      input_tokens: hosted.input_tokens,
      output_tokens: hosted.output_tokens,
      cost_usd: hosted.cost_usd,
      provider: hosted.provider,
      model: hosted.model,
      durationMs: Date.now() - started,
    };
  }

  const response = await runAgent({
    agent: stepAgent,
    messages,
    signal,
    temperature: step.temperature,
    max_output_tokens: step.max_output_tokens,
    onChunk: (chunk) => {
      if (chunk.delta) {
        acc += chunk.delta;
        onChunk?.(chunk.delta, acc);
      }
    },
  });

  return {
    text: response.text,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cost_usd: response.usage.cost_usd,
    provider: response.provider,
    model: response.model,
    durationMs: Date.now() - started,
  };
}

export interface RunStackOptions {
  agent: Agent;
  userText: string;
  history: LLMMessage[];
  preset?: StackPresetId;
  taskType?: import('./types').StackTaskType;
  customSteps?: StackStepSpec[];
  signal?: AbortSignal;
  callbacks?: StackRunCallbacks;
}

/**
 * Run a Vibe Hive pipeline — sequential multi-model orchestration.
 * Returns the final text plus per-step metadata for the timeline UI.
 */
export async function runStack(opts: RunStackOptions): Promise<StackRunResult | null> {
  const auth = useAuthStore.getState();
  const slash = parseStackSlashCommand(opts.userText);
  const preset = effectiveStackPreset(opts.preset ?? auth.stackPreset ?? 'off', slash.preset);
  if (preset === 'off') return null;

  const taskType = slash.taskType ?? opts.taskType ?? classifyStackTask(slash.cleanText || opts.userText);
  const rawSteps = stepsForPreset(preset, taskType, opts.customSteps ?? auth.stackCustomSteps);
  if (rawSteps.length === 0) return null;

  const accessible = getAccessibleProviders(auth.apiKeys, auth.offlineMode, auth.plan);
  const steps = rawSteps.map((s) => pickProviderFallback(s, accessible));

  const userQuestion = slash.cleanText || opts.userText;
  let conversation: LLMMessage[] = [...opts.history, { role: 'user', content: userQuestion }];
  const stepResults: StackRunResult['steps'] = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let finalText = '';
  let lastProvider = steps[0]!.provider;
  let lastModel = steps[0]!.model;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    opts.callbacks?.onStepStart?.(step, i, steps.length);

    const result = await runStep(
      opts.agent,
      step,
      conversation,
      opts.signal,
      (delta, acc) => opts.callbacks?.onStepDelta?.(step, i, delta, acc),
    );

    const stepResult = {
      step,
      text: result.text,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      cost_usd: result.cost_usd,
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
    };
    stepResults.push(stepResult);
    opts.callbacks?.onStepDone?.(stepResult, i);

    totalIn += result.input_tokens;
    totalOut += result.output_tokens;
    totalCost += result.cost_usd;
    finalText = result.text;
    lastProvider = result.provider;
    lastModel = result.model;

    conversation = [
      ...conversation,
      { role: 'assistant', content: result.text },
      ...(i < steps.length - 1
        ? [
            {
              role: 'user' as const,
              content: `Continue to the next stack step (${steps[i + 1]!.label}). Use the content above as input.`,
            },
          ]
        : []),
    ];
  }

  return {
    finalText,
    steps: stepResults,
    input_tokens: totalIn,
    output_tokens: totalOut,
    cost_usd: totalCost,
    provider: lastProvider,
    model: lastModel,
    taskType,
    preset,
  };
}
