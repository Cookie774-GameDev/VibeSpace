import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type {
  CreateHarnessSession,
  HarnessEvent,
  HarnessSendRequest,
  VibeSpaceHarness,
} from '@/lib/harness/types';
import { createOpenCodeRunAgentAdapter } from './openCodeRunAgent';
import { resolveReasoningPolicy, type ReasoningMode } from './reasoningControls';

function harnessFixture() {
  const requests: HarnessSendRequest[] = [];
  const harness: VibeSpaceHarness = {
    ensureReady: vi.fn(async () => ({ source: 'managed' as const, version: '1.18.16' })),
    createSession: vi.fn(async (input: CreateHarnessSession) => ({
      id: `session-${input.chatId}`,
      chatId: input.chatId,
    })),
    deleteSession: vi.fn(async () => undefined),
    send: vi.fn((request: HarnessSendRequest) => {
      requests.push(request);
      return (async function* (): AsyncIterable<HarnessEvent> {
        yield {
          type: 'usage.updated',
          usage: {
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
            inputTokens: 20,
            outputTokens: 4,
          },
        };
        yield { type: 'assistant.delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    }),
    cancel: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            variants: ['low', 'medium', 'high', 'xhigh'],
          },
        ],
      },
    ]),
    listModels: vi.fn(async () => []),
    respondToApproval: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  return { harness, requests };
}

describe('Token mode OpenCode parity', () => {
  it('preserves all three VibeSpace mode contracts through one exact OpenCode model', async () => {
    const fixture = harnessFixture();
    const authorityClaim = {
      scope: {
        accountId: 'account-a',
        accountSource: 'local',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      },
      generation: 0,
    } as const;
    const adapter = createOpenCodeRunAgentAdapter(fixture.harness, {
      capture: () => authorityClaim,
      bind: (_sessionId, expected) => expected === authorityClaim,
      release: () => undefined,
    });
    const modes: readonly ReasoningMode[] = ['token-saver', 'normal', 'token-final-boss'];
    const expected = {
      'token-saver': { label: 'Token Saver', variant: 'low', maxOutputTokens: 2_048 },
      normal: { label: 'Normal', variant: undefined, maxOutputTokens: undefined },
      'token-final-boss': {
        label: 'Token Final Boss',
        variant: 'xhigh',
        maxOutputTokens: undefined,
      },
    } as const;

    for (const mode of modes) {
      const policy = resolveReasoningPolicy({
        selection: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          connectionId: 'openai-codex',
        },
        preference: { mode, effortOverride: null },
      });
      const variant = Object.values(policy.providerOptions).find(
        (value): value is string => typeof value === 'string',
      );
      const agent: Agent = {
        id: `agent-${mode}` as Agent['id'],
        slug: `mode-${mode}`,
        name: mode,
        description: '',
        system_prompt: ['SYSTEM AUTHORITY', policy.executionInstructions].join('\n\n'),
        model: { provider: 'openai', model: 'gpt-5.6-sol' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      };

      await expect(
        adapter.run({
          agent,
          scopeId: `chat-${mode}`,
          selection: {
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
            connectionId: 'openai-codex',
          },
          messages: [{ role: 'user', content: 'Preserve the latest user request.' }],
          ...(variant ? { variant } : {}),
          tools: { 'terminal.list': true, 'terminal.write': false },
        }),
      ).resolves.toMatchObject({
        text: 'done',
        provider: 'openai',
        model: 'gpt-5.6-sol',
      });

      const sent = fixture.requests.at(-1);
      expect(sent).toMatchObject({
        selection: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          connectionId: 'openai-codex',
        },
        system: expect.stringContaining(expected[mode].label),
        tools: { 'terminal.list': true, 'terminal.write': false },
      });
      expect(sent?.variant).toBe(expected[mode].variant);
      expect(policy.maxOutputTokens).toBe(expected[mode].maxOutputTokens);
    }

    expect(fixture.requests).toHaveLength(3);
    expect(
      fixture.requests.every(
        ({ selection }) => selection.providerId === 'openai' && selection.modelId === 'gpt-5.6-sol',
      ),
    ).toBe(true);
  });
});
