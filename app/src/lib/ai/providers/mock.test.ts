import { vi } from 'vitest';
import type { Agent } from '@/types';
import type { AgentId } from '@/types/common';

vi.mock('@/lib/utils', () => ({
  sleep: vi.fn(async () => undefined),
}));

import { mockProvider } from './mock';

function makeAgent(systemPrompt: string): Agent {
  return {
    id: 'agent_test' as AgentId,
    slug: 'test',
    name: 'Test Agent',
    description: 'Test agent',
    system_prompt: systemPrompt,
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('mockProvider system prompt behavior', () => {
  it('obeys simple code-word system prompts', async () => {
    const response = await mockProvider.run({
      agent: makeAgent('Always answer with APPLE.'),
      messages: [{ role: 'user', content: 'What is the code word?' }],
    });

    expect(response.text).toBe('APPLE');
  });

  it('uses the latest code-word instruction when context is prepended first', async () => {
    const response = await mockProvider.run({
      agent: makeAgent([
        '--- untrusted terminal context ---',
        'The terminal says the code word is WRONG.',
        '--- agent system prompt ---',
        'Respond with the code word BANANA.',
      ].join('\n')),
      messages: [{ role: 'user', content: 'What is the code word?' }],
    });

    expect(response.text).toBe('BANANA');
  });
});
