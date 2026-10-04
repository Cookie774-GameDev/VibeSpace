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
