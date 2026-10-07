import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';

const { foundryRun } = vi.hoisted(() => ({ foundryRun: vi.fn() }));

vi.mock('./providers/foundry', () => ({
  foundryProvider: {
    isAvailable: () => true,
    run: foundryRun,
  },
}));

import { runAgent } from './router';

const agent: Agent = {
  id: 'agent_foundry_contract' as Agent['id'],
  slug: 'foundry-contract',
  name: 'Foundry contract',
  description: '',
  system_prompt: 'LEGACY SYSTEM PROMPT',
  model: { provider: 'foundry', model: 'artifact--verified' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

describe('Foundry compiled prompt transport', () => {
  beforeEach(() => {
    foundryRun.mockReset();
    foundryRun.mockResolvedValue({
      text: 'done',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      provider: 'foundry',
      model: agent.model.model,
      finish_reason: 'stop',
    });
  });

  it.each(['codex', 'opencode'] as const)(
    'uses Foundry native inference while the chat engine is %s',
    async (backend) => {
      const response = await runAgent({
        agent,
        connectionId: 'foundry-local',
        backend,
        messages: [{ role: 'user', content: 'A public local test.' }],
      });
      expect(foundryRun).toHaveBeenCalledOnce();
      expect(response.provider).toBe('foundry');
      expect(response.model).toBe('artifact--verified');
    },
  );

  it('sends the compiled system text to the local provider for protected dispatch', async () => {
    await runAgent({
      agent,
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Summarize the fixture.' }],
      compiledPrompt: {
        schemaVersion: 1,
        layers: [],
        systemText: 'EXACT COMPILED SYSTEM CONTRACT',
        promptHash: 'a'.repeat(64),
        identityVersion: 1,
        profileRevisionId: 'revision-1',
        diagnostics: { totalChars: 30, omittedSourceRefs: [], warnings: [] },
      },
    });

    expect(foundryRun).toHaveBeenCalledOnce();
    expect(foundryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ system_prompt: 'EXACT COMPILED SYSTEM CONTRACT' }),
      }),
    );
  });

  it('keeps the agent prompt for ordinary uncompiled requests', async () => {
    await runAgent({
      agent,
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(foundryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ system_prompt: 'LEGACY SYSTEM PROMPT' }),
      }),
    );
  });
});

describe('Foundry rejects mismatched connection authority', () => {
  it.each([undefined, 'openai-api', 'missing-local-connection'])(
    'never invokes the local provider with connection %s',
    async (connectionId) => {
      foundryRun.mockClear();
      await expect(
        runAgent({ agent, connectionId, messages: [{ role: 'user', content: 'Local fixture.' }] }),
      ).rejects.toThrow(/Foundry.*connection/i);
      expect(foundryRun).not.toHaveBeenCalled();
    },
  );
});

it('rejects an unsupported tool capability before invoking Foundry', async () => {
  foundryRun.mockClear();
  await expect(
    runAgent({
      agent,
      connectionId: 'foundry-local',
      connectionRequirements: { tools: true },
      messages: [{ role: 'user', content: 'Local fixture.' }],
    }),
  ).rejects.toThrow(/tool/i);
  expect(foundryRun).not.toHaveBeenCalled();
});

it('does not route another provider through the Foundry connection', async () => {
  foundryRun.mockClear();
  await expect(
    runAgent({
      agent: { ...agent, model: { provider: 'openai', model: 'arbitrary-model' } },
      backend: 'opencode',
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Local fixture.' }],
    }),
  ).rejects.toThrow(/match provider connection/i);
  expect(foundryRun).not.toHaveBeenCalled();
});
