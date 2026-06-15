import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { runAgent } from '../router';
import type { LLMMessage } from '../types';
import { canUseHostedStack, runHostedStackStep } from './hostedStack';
import type { StackRunResult, StackStepResult, StackStepSpec } from './types';

export interface RunStackInput {
  agent: Agent;
  userText: string;
  history: LLMMessage[];
  steps: StackStepSpec[];
  signal?: AbortSignal;
  onStep?: (step: StackStepResult) => void;
}

function providerHasKey(provider: StackStepSpec['provider']): boolean {
  const auth = useAuthStore.getState();
  if (provider === 'ollama' || provider === 'local') {
    return auth.offlineMode || Boolean(auth.apiKeys.ollama?.trim());
  }
  return Boolean(auth.apiKeys[provider]?.trim());
}

function stepAgent(base: Agent, step: StackStepSpec): Agent {
  return {
    ...base,
    model: { provider: step.provider, model: step.model },
    temperature: step.temperature ?? base.temperature,
    max_output_tokens: step.max_output_tokens ?? base.max_output_tokens,
    system_prompt: [
      base.system_prompt,
      `--- Hive step: ${step.label} ---`,
      step.systemAppend,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

async function runStep(
  baseAgent: Agent,
  step: StackStepSpec,
  messages: LLMMessage[],
  signal?: AbortSignal,
): Promise<StackStepResult> {
  const auth = useAuthStore.getState();
  const startedAt = Date.now();
  const agent = stepAgent(baseAgent, step);

  if (!providerHasKey(step.provider) && canUseHostedStack(auth.plan)) {
    const hosted = await runHostedStackStep({
      provider: step.provider,
      model: step.model,
      systemPrompt: agent.system_prompt,
      messages,
      temperature: agent.temperature,
      max_output_tokens: agent.max_output_tokens,
      signal,
    });
    return {
      ...step,
      text: hosted.text,
      status: 'done',
      input_tokens: hosted.input_tokens,
      output_tokens: hosted.output_tokens,
      cost_usd: hosted.cost_usd,
      duration_ms: Date.now() - startedAt,
    };
  }

  const response = await runAgent({
    agent,
    messages,
    signal,
    temperature: step.temperature,
    max_output_tokens: step.max_output_tokens,
  });

  return {
    ...step,
    text: response.text,
    status: 'done',
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cost_usd: response.usage.cost_usd,
    duration_ms: Date.now() - startedAt,
  };
}

export async function runStack({
  agent,
  userText,
  history,
  steps,
  signal,
  onStep,
}: RunStackInput): Promise<StackRunResult> {
  if (steps.length === 0) {
    return {
      finalText: '',
      steps: [],
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }

  const messages: LLMMessage[] = [
    ...history,
    { role: 'user', content: userText },
  ];
  const results: StackStepResult[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const result = await runStep(agent, step, messages, signal);
    usage.input_tokens += result.input_tokens ?? 0;
    usage.output_tokens += result.output_tokens ?? 0;
    usage.cost_usd += result.cost_usd ?? 0;
    results.push(result);
    onStep?.(result);

    if (index < steps.length - 1) {
      const next = steps[index + 1]!;
      messages.push({ role: 'assistant', content: result.text });
      messages.push({
        role: 'user',
        content: `Continue to the next Hive step (${next.label}). Use the content above as input.`,
      });
    }
  }

  return {
    finalText: results.at(-1)?.text ?? '',
    steps: results,
    usage,
  };
}
