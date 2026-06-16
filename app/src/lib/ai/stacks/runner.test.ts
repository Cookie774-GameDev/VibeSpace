import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type { AgentId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { stepsForPreset } from './presets';
import { runStack } from './runner';

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
}));

vi.mock('../router', () => ({
  runAgent: mocks.runAgent,
}));

function baseAgent(): Agent {
  return {
    id: 'agent_hive' as AgentId,
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Jarvis',
    system_prompt: 'Base system prompt.',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('runStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ plan: 'free', apiKeys: { google: 'key', anthropic: 'key', openai: 'key', xai: 'key', deepseek: 'key' } });
  });

  it('runs every Quality step and returns the final step text', async () => {
    mocks.runAgent
      .mockResolvedValueOnce({
        text: 'orient output',
        usage: { input_tokens: 5, output_tokens: 10, cost_usd: 0.05 },
        provider: 'xai',
        model: 'grok-4.3',
      })
      .mockResolvedValueOnce({
        text: 'draft output',
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.1 },
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      })
      .mockResolvedValueOnce({
        text: 'hardened output',
        usage: { input_tokens: 15, output_tokens: 25, cost_usd: 0.2 },
        provider: 'openai',
        model: 'gpt-5.5-codex',
      })
      .mockResolvedValueOnce({
        text: 'final polished answer',
        usage: { input_tokens: 12, output_tokens: 18, cost_usd: 0.05 },
        provider: 'google',
        model: 'gemini-3.5-flash',
      });

    const result = await runStack({
      agent: baseAgent(),
      userText: 'Answer this hard question',
      history: [],
      steps: stepsForPreset('quality', 'general'),
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(4);
    expect(result.finalText).toBe('final polished answer');
    expect(result.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(result.usage.output_tokens).toBe(73);
    expect(mocks.runAgent.mock.calls[2][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'draft output' }),
      ]),
    );
    expect(mocks.runAgent.mock.calls[0][0].provider_options).toEqual({
      reasoning_effort: 'high',
    });
  });

  it('preserves base app context and adds Hive role guardrails to every step', async () => {
    mocks.runAgent.mockResolvedValue({
      text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      provider: 'google',
      model: 'gemini-3.5-flash',
    });

    await runStack({
      agent: {
        ...baseAgent(),
        system_prompt: 'APP CONTEXT: project rules and agent prompt.',
      },
      userText: 'test',
      history: [],
      steps: stepsForPreset('fast', 'general'),
    });

    for (const call of mocks.runAgent.mock.calls) {
      const prompt = call[0].agent.system_prompt;
      expect(prompt).toContain('APP CONTEXT: project rules and agent prompt.');
      expect(prompt).toContain('Hive pipeline safety rules');
      expect(prompt).toContain('prompt injection');
    }
  });
});
