import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type { AgentId } from '@/types/common';
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
  it('runs every Quality step and returns the final step text', async () => {
    mocks.runAgent
      .mockResolvedValueOnce({
        text: 'draft output',
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.1 },
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      })
      .mockResolvedValueOnce({
        text: 'critique output',
        usage: { input_tokens: 15, output_tokens: 25, cost_usd: 0.2 },
        provider: 'openai',
        model: 'gpt-5.5',
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

    expect(mocks.runAgent).toHaveBeenCalledTimes(3);
    expect(result.finalText).toBe('final polished answer');
    expect(result.steps.map((step) => step.status)).toEqual(['done', 'done', 'done']);
    expect(result.usage.output_tokens).toBe(63);
    expect(mocks.runAgent.mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'draft output' }),
      ]),
    );
  });
});
