import { describe, expect, it, vi } from 'vitest';
import { optimizeKernelRuntimeContext } from './runtimeTokenOptimization';
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
    'applies %s to kernel inputs while retaining protected content and identity',
    async (mode) => {
      const result = await optimizeKernelRuntimeContext({ ...base, mode });
      expect(result.blocks).toEqual([base.blocks[0], base.blocks[1], base.blocks[4]]);
      expect(result.messages).toEqual(base.messages);
      expect(result.receipt).toMatchObject({
        mode,
        providerId: base.providerId,
        modelId: base.modelId,
        modelChanged: false,
      });
      expect(result.receipt!.estimatedTokensSaved).toBeGreaterThan(0);
    },
  );

  it('never silently falls back after cancellation or protected context overflow', async () => {
    await expect(
      optimizeKernelRuntimeContext({ ...base, mode: 'saver', modelContextLimit: 1 }),
    ).rejects.toThrow(/Protected context/);
    await expect(
      optimizeKernelRuntimeContext({ ...base, mode: 'saver', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
