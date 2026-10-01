import { describe, expect, it } from 'vitest';

import type { HarnessProvider } from './types';
import { isCurrentFreeHarnessModel, selectCurrentFreeHarnessModel } from './freeModelSelection';

const free = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function provider(
  id: string,
  models: HarnessProvider['models'],
  connected = true,
): HarnessProvider {
  return { id, name: id, connected, models };
}

describe('dynamic free OpenCode model selection', () => {
  it('selects only complete zero-priced models with a stable provider/model tie break', () => {
    const providers: HarnessProvider[] = [
      provider('z-provider', [{ id: 'a-model', name: 'A', pricing: free }]),
      provider('a-provider', [
        { id: 'z-model', name: 'Z', pricing: free },
        { id: 'a-model', name: 'A', pricing: free },
      ]),
    ];

    expect(selectCurrentFreeHarnessModel(providers)).toEqual({
      providerId: 'a-provider',
      modelId: 'a-model',
    });
  });

  it('fails closed for disconnected, missing, partial, nonfinite, negative, or nonzero prices', () => {
    const providers: HarnessProvider[] = [
      provider('disconnected', [{ id: 'free', name: 'Free', pricing: free }], false),
      provider('missing', [{ id: 'model', name: 'Missing' }]),
      provider('partial', [
        {
          id: 'model',
          name: 'Partial',
          pricing: { input: 0, output: 0, cacheRead: 0 } as never,
        },
      ]),
      provider('nonfinite', [
        {
          id: 'model',
          name: 'Nonfinite',
          pricing: { ...free, output: Number.POSITIVE_INFINITY },
        },
      ]),
      provider('negative', [
        { id: 'model', name: 'Negative', pricing: { ...free, cacheRead: -1 } },
      ]),
      provider('paid', [{ id: 'model', name: 'Paid', pricing: { ...free, output: 0.001 } }]),
    ];

    expect(selectCurrentFreeHarnessModel(providers)).toBeNull();
  });

  it('revalidates a prior selection against only the refreshed current catalog', () => {
    const before = [provider('provider', [{ id: 'old-free', name: 'Old', pricing: free }])];
    const after = [provider('provider', [{ id: 'new-free', name: 'New', pricing: free }])];
    const selected = selectCurrentFreeHarnessModel(before);

    expect(selected).toEqual({ providerId: 'provider', modelId: 'old-free' });
    expect(isCurrentFreeHarnessModel(selected!, after)).toBe(false);
    expect(selectCurrentFreeHarnessModel(after)).toEqual({
      providerId: 'provider',
      modelId: 'new-free',
    });
  });

  it('bounds candidate work and rejects unsafe identities without name heuristics', () => {
    const models = Array.from({ length: 4_100 }, (_, index) => ({
      id: index === 4_099 ? 'free-by-name' : `paid-${String(index).padStart(4, '0')}`,
      name: index === 0 ? 'FREE MODEL' : `Model ${index}`,
      pricing: index === 4_099 ? free : { ...free, input: 1 },
    }));
    const providers = [
      provider(' unsafe\u0000provider', [{ id: 'free', name: 'Free', pricing: free }]),
      provider('bounded', models),
    ];

    expect(selectCurrentFreeHarnessModel(providers)).toBeNull();
  });
});
