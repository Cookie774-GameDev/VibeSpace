import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generate, canRoute } = vi.hoisted(() => ({
  generate: vi.fn().mockResolvedValue({
    text: 'Reviewed locally.',
    inputTokens: 11,
    outputTokens: 3,
    artifactManifestSha256: 'a'.repeat(64),
  }),
  canRoute: vi.fn(() => true),
}));

vi.mock('@/features/model-foundry/nativeBridge', () => ({ generateFromFoundryArtifact: generate }));
vi.mock('@/features/model-foundry/adapterRegistry', () => ({ canRoutePromotedAdapter: canRoute }));
vi.mock('@/lib/utils', () => ({ isTauri: true }));

import { foundryProvider } from './foundry';
import { optimizeKernelRuntimeContext } from '../runtimeTokenOptimization';

describe('foundryProvider', () => {
  beforeEach(() => {
    generate.mockClear();
    canRoute.mockReset();
    canRoute.mockReturnValue(true);
  });

  it('preserves a native job id containing a second double hyphen', async () => {
    canRoute.mockReturnValue(false);
    await foundryProvider.run({
      agent: {
        model: { provider: 'foundry', model: 'artifact--job_inner--suffix' },
        system_prompt: '',
      } as never,
      messages: [{ role: 'user', content: 'A public test.' }],
    });
    expect(canRoute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'artifact', jobId: 'job_inner--suffix' }),
    );
  });

  it('preserves a measured zero input-token count instead of replacing it with an estimate', async () => {
    generate.mockResolvedValueOnce({
      text: 'Local answer.',
      inputTokens: 0,
      outputTokens: 3,
      artifactManifestSha256: 'a'.repeat(64),
    });
    const response = await foundryProvider.run({
      agent: {
        model: { provider: 'foundry', model: 'artifact--job_0-vjmMedLqAeGX' },
        system_prompt: '',
      } as never,
      messages: [{ role: 'user', content: 'A public test.' }],
    });
    expect(response.usage.input_tokens).toBe(0);
  });

  it('routes only a bounded project/job adapter id to local native inference', async () => {
    const chunks: string[] = [];
    const response = await foundryProvider.run({
      agent: {
        model: { provider: 'foundry', model: 'project-1--job_2' },
        system_prompt: 'Be precise.',
      } as never,
      messages: [{ role: 'user', content: 'Review this.' }],
      max_output_tokens: 64,
      onChunk: (chunk) => chunks.push(chunk.delta),
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', jobId: 'job_2', maxNewTokens: 64 }),
    );
    expect(response).toMatchObject({
      provider: 'foundry',
      text: 'Reviewed locally.',
      usage: { cost_usd: 0 },
    });
    expect(chunks).toEqual(['Reviewed locally.', '']);
  });

  it('routes a verified native Hub artifact without pretending it is an Ollama model', async () => {
    canRoute.mockReturnValue(false);

    await foundryProvider.run({
      agent: {
        id: 'custom_dnjksbyc',
        model: { provider: 'foundry', model: 'artifact--job_0-vjmMedLqAeGX' },
        system_prompt: 'Compare both sides of a debate before deciding.',
      } as never,
      messages: [
        { role: 'user', content: 'Should cities prioritize buses or protected bike lanes?' },
      ],
    });

    expect(canRoute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'artifact',
        jobId: 'job_0-vjmMedLqAeGX',
        prompt: expect.stringContaining('Should cities prioritize buses or protected bike lanes?'),
        maxNewTokens: 320,
      }),
    );
  });

  it('keeps a long agent system prompt separate from Foundry’s bounded user query', async () => {
    const systemPrompt = 'Follow the saved agent instructions carefully. '.repeat(120);
    const currentUserTurn =
      'Compare both sides of the transit question and give one concise recommendation.';

    await foundryProvider.run({
      agent: {
        model: { provider: 'foundry', model: 'artifact--job_0-vjmMedLqAeGX' },
        system_prompt: systemPrompt,
      } as never,
      messages: [
        { role: 'user', content: 'What are the tradeoffs?' },
        { role: 'assistant', content: 'Ridership and street safety both matter.' },
        { role: 'user', content: currentUserTurn },
      ],
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: systemPrompt.trim() },
          { role: 'user', content: 'What are the tradeoffs?' },
          { role: 'assistant', content: 'Ridership and street safety both matter.' },
          { role: 'user', content: currentUserTurn },
        ],
      }),
    );
  });

  it('keeps governed project adapters behind the explicit promotion gate', async () => {
    canRoute.mockReturnValue(false);

    await expect(
      foundryProvider.run({
        agent: { model: { provider: 'foundry', model: 'project-1--job_2' } } as never,
        messages: [],
      }),
    ).rejects.toThrow('promoted Foundry adapter');
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects model ids that could escape the project/job namespace', async () => {
    await expect(
      foundryProvider.run({
        agent: { model: { provider: 'foundry', model: '../escape' } } as never,
        messages: [],
      }),
    ).rejects.toThrow('verified Foundry adapter');
  });
});

describe('Foundry protected-attempt diagnostic binding', () => {
  it('forwards only opaque attempt correlation to the native bridge', async () => {
    generate.mockClear();
    const protectedAttempt = {
      accountId: 'private-account-must-not-be-diagnostic-metadata',
      runId: 'jrun_11111111-1111-4111-8111-111111111111',
      requestId: 'jreq_22222222-2222-4222-8222-222222222222',
      attemptNumber: 2,
    };
    await foundryProvider.run({
      agent: { model: { provider: 'foundry', model: 'artifact--job_0-vjmMedLqAeGX' },
        system_prompt: 'Private system instructions.' } as never,
      messages: [{ role: 'user', content: 'Private input content.' }],
      protectedAttempt,
    });
    expect(generate.mock.calls[0]?.[0].correlation).toEqual({
      runId: protectedAttempt.runId, requestId: protectedAttempt.requestId, attemptNumber: 2,
    });
    expect(generate.mock.calls[0]?.[0].correlation).not.toHaveProperty('accountId');
  });
});

describe('Foundry planner/provider output-reserve agreement', () => {
  it('uses the same default allowance for planning and the actual native bridge request', async () => {
    generate.mockClear();
    const input = { providerId: 'foundry', modelId: 'artifact--job_budget_join',
      contextMetadataSource: 'foundry_catalog_ceiling' as const, modelContextLimit: 8192,
      mode: 'normal' as const, systemPrompt: 'Required public policy.', blocks: [],
      messages: [{ role: 'user' as const, content: 'Public request.' }] };
    const planned = await optimizeKernelRuntimeContext(input);
    await foundryProvider.run({ agent: { model: { provider: 'foundry', model: input.modelId },
      system_prompt: input.systemPrompt } as never, messages: [...planned.messages] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].maxNewTokens).toBe(320);
    expect(planned.receipt!.outputTokenLimit).toBe(generate.mock.calls[0]?.[0].maxNewTokens);
  });
});

it.each([[undefined, 320], [1, 1], [64, 64], [320, 320], [512, 512], [8192, 512], [0, 1]])(
  'keeps native provider output formula unchanged for %s', async (requested, expected) => {
    generate.mockClear();
    await foundryProvider.run({ agent: { model: { provider: 'foundry', model: 'artifact--job_formula' },
      system_prompt: 'Public policy.' } as never, messages: [{ role: 'user', content: 'Public request.' }],
      max_output_tokens: requested });
    expect(generate.mock.calls[0]?.[0].maxNewTokens).toBe(expected);
  },
);
