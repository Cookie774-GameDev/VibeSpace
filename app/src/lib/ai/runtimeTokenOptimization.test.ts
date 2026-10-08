import { describe, expect, it, vi } from 'vitest';
import { optimizeKernelRuntimeContext } from './runtimeTokenOptimization';
import { JARVIS_IDENTITY_POLICY } from '@/lib/jarvis/identity';
import type { JarvisRuntimeContextBlock } from '@/lib/jarvis/runtimeContextCandidates';

const base = {
  providerId: 'opencode',
  modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
  systemPrompt: 'Protected instructions remain exact.',
  modelContextLimit: 10000,
  messages: [{ role: 'user' as const, content: 'Preserve the latest user request verbatim.' }],
  blocks: [
    { key: 'explicit_files', text: 'Exact user attachment.', score: 0 },
    { key: 'intent_policy', text: 'Mandatory approval boundary.', score: 0 },
    { key: 'repository_context', text: 'Irrelevant old background.', score: 0.01 },
    { key: 'repository_context', text: 'Relevant evidence.', score: 0.8 },
    { key: 'repository_context', text: 'Relevant evidence.', score: 0.9 },
  ] satisfies JarvisRuntimeContextBlock[],
};

describe('kernel token optimization admission', () => {
  it('keeps Off unchanged without tokenization', async () => {
    const optimizer = vi.fn();
    const result = await optimizeKernelRuntimeContext({ ...base, mode: 'off' }, optimizer);
    expect(result.blocks).toBe(base.blocks);
    expect(result.messages).toBe(base.messages);
    expect(result.receipt).toBeNull();
    expect(optimizer).not.toHaveBeenCalled();
  });

  it.each(['saver', 'normal', 'final_boss'] as const)(
    'deduplicates optional exact context for %s while preserving protected inputs',
    async (mode) => {
      const result = await optimizeKernelRuntimeContext({ ...base, mode });
      expect(result.blocks).toEqual(base.blocks.slice(0, 4));
      expect(result.messages).toEqual(base.messages);
      expect(result.receipt).toMatchObject({
        mode,
        providerId: base.providerId,
        modelId: base.modelId,
        modelChanged: false,
        estimatedTokensSaved: 18,
        selectedCount: 6,
        excludedCount: 1,
      });
      expect(result.receipt!.exclusions).toEqual([
        {
          segmentRef: 'segment-6',
          kind: 'repository_file',
          reason: 'duplicate',
          tokens: 18,
        },
      ]);
    },
  );

  it('fails closed when estimated context exceeds the selected window', async () => {
    await expect(
      optimizeKernelRuntimeContext({ ...base, mode: 'saver', modelContextLimit: 1 }),
    ).rejects.toMatchObject({
      name: 'TokenOptimizationOverflowError',
      receipt: expect.objectContaining({
        fitsContext: false,
        estimatedTokensSaved: 18,
        selectedCount: 6,
        excludedCount: 1,
      }),
    });
    await expect(
      optimizeKernelRuntimeContext({ ...base, mode: 'saver', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// Public policy plus synthetic task only. No private native prompt is reconstructed.
describe('registered native Foundry planning versus authoritative native input validation', () => {
  const foundryInput = {
    providerId: 'foundry', modelId: 'artifact--job_budget_probe',
    contextMetadataSource: 'foundry_catalog_ceiling' as const,
    modelContextLimit: 8192, mode: 'normal' as const,
    systemPrompt: 'Preserve this public policy exactly.',
    blocks: [{ key: 'explicit_files' as const, text: 'Public required attachment.' }],
    messages: [{ role: 'user' as const, content: 'Return the public code CL-041.' }],
  };

  it('plans the native default320 reserve for a known Foundry artifact instead of consuming its entire window', async () => {
    const result = await optimizeKernelRuntimeContext(foundryInput);
    expect(result.receipt).toMatchObject({ outputTokenLimit: 320, fitsContext: true });
    expect(result.messages).toEqual(foundryInput.messages);
    expect(result.blocks).toEqual(foundryInput.blocks);
  });

  it('retains a conservative overflow as an estimate while preserving every required byte for the native guard', async () => {
    const systemPrompt = [JARVIS_IDENTITY_POLICY.responseContract, JARVIS_IDENTITY_POLICY.identityCore].join('\n\n');
    expect(new TextEncoder().encode(systemPrompt).byteLength).toBeGreaterThan(8192);
    const result = await optimizeKernelRuntimeContext({ ...foundryInput, systemPrompt, requestedOutputTokens: 320 });
    expect(result.messages).toEqual(foundryInput.messages);
    expect(result.blocks).toEqual(foundryInput.blocks);
    expect(result.receipt).toMatchObject({ mode: 'normal', tokenizerSource: 'conservative_estimate',
      outputTokenLimit: 320, fitsContext: false, nativeValidationPending: true, estimatedTokensSaved: 0, excludedCount: 0 });
    expect(result.receipt!.overflowTokens).toBeGreaterThan(0);
  });

  it('does not treat a public UTF-8 upper bound as a measured tokenizer count', async () => {
    const systemPrompt = [JARVIS_IDENTITY_POLICY.responseContract, JARVIS_IDENTITY_POLICY.identityCore].join('\n\n');
    await expect(optimizeKernelRuntimeContext({ ...foundryInput,
      contextMetadataSource: undefined, modelId: 'artifact--unknown_probe', systemPrompt, requestedOutputTokens: 320,
    })).rejects.toMatchObject({ name: 'TokenOptimizationOverflowError', receipt: expect.objectContaining({
      tokenizerSource: 'conservative_estimate',
      estimatedInputTokensBefore: new TextEncoder().encode(systemPrompt).byteLength
        + new TextEncoder().encode(foundryInput.blocks[0]!.text).byteLength
        + new TextEncoder().encode('[user]\n' + foundryInput.messages[0]!.content).byteLength,
    }) });
  });
});
