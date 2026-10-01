import { describe, expect, it, vi } from 'vitest';

const { generate } = vi.hoisted(() => ({ generate: vi.fn().mockResolvedValue({ text: 'Reviewed locally.', inputTokens: 11, outputTokens: 3, artifactManifestSha256: 'a'.repeat(64) }) }));

vi.mock('@/features/model-foundry/nativeBridge', () => ({ generateFromFoundryArtifact: generate }));
vi.mock('@/features/model-foundry/adapterRegistry', () => ({ canRoutePromotedAdapter: () => true }));
vi.mock('@/lib/utils', () => ({ isTauri: true }));

import { foundryProvider } from './foundry';

describe('foundryProvider', () => {
  it('routes only a bounded project/job adapter id to local native inference', async () => {
    const chunks: string[] = [];
    const response = await foundryProvider.run({
      agent: { model: { provider: 'foundry', model: 'project-1--job_2' }, system_prompt: 'Be precise.' } as never,
      messages: [{ role: 'user', content: 'Review this.' }],
      max_output_tokens: 64,
      onChunk: (chunk) => chunks.push(chunk.delta),
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', jobId: 'job_2', maxNewTokens: 64 }));
    expect(response).toMatchObject({ provider: 'foundry', text: 'Reviewed locally.', usage: { cost_usd: 0 } });
    expect(chunks).toEqual(['Reviewed locally.', '']);
  });

  it('rejects model ids that could escape the project/job namespace', async () => {
    await expect(foundryProvider.run({ agent: { model: { provider: 'foundry', model: '../escape' } } as never, messages: [] })).rejects.toThrow('verified Foundry adapter');
  });
});
