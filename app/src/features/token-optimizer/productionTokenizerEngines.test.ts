import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProductionTokenizers,
  createTokenizerRegistry,
  type TrustedOpenModelTokenizerAsset,
} from './index';

const wordPieceTokenizer = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [],
  normalizer: null,
  pre_tokenizer: { type: 'Whitespace' },
  post_processor: null,
  decoder: null,
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: { '[UNK]': 0, hello: 1, world: 2 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production exact-local tokenizer engines', () => {
  it('lazy-loads pinned OpenAI encodings for registered families and falls back truthfully', async () => {
    const loadO200k = vi.fn(() => import('gpt-tokenizer/encoding/o200k_base'));
    const loadCl100k = vi.fn(() => import('gpt-tokenizer/encoding/cl100k_base'));
    const registry = createTokenizerRegistry(
      createProductionTokenizers({
        loadOpenAiO200k: loadO200k,
        loadOpenAiCl100k: loadCl100k,
      }),
    );

    expect(loadO200k).not.toHaveBeenCalled();
    expect(loadCl100k).not.toHaveBeenCalled();
    await expect(registry.estimateText('openai', 'gpt-4o', 'hello world')).resolves.toMatchObject({
      source: 'exact_local',
      tokenizerId: 'gpt-tokenizer:o200k_base',
    });
    expect(loadO200k).toHaveBeenCalledTimes(1);
    expect(loadCl100k).not.toHaveBeenCalled();

    await expect(registry.estimateText('openai', 'gpt-4', 'hello world')).resolves.toMatchObject({
      source: 'exact_local',
      tokenizerId: 'gpt-tokenizer:cl100k_base',
    });
    await expect(
      registry.estimateText('openai', 'future-unknown-model', 'hello world'),
    ).resolves.toMatchObject({
      source: 'conservative_estimate',
      tokenizerId: 'builtin:utf8-conservative-estimate',
    });
    await expect(
      registry.estimateText('openai', 'gpt-oss-120b', 'hello world'),
    ).resolves.toMatchObject({
      source: 'conservative_estimate',
      tokenizerId: 'builtin:utf8-conservative-estimate',
    });
  });

  it('loads only injected local Qwen, DeepSeek, Llama, and Mistral assets without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const families = [
      ['qwen', 'qwen-2.5-coder'],
      ['deepseek', 'deepseek-v3'],
      ['llama', 'llama-3.3'],
      ['mistral', 'mistral-large'],
    ] as const;
    const loads = new Map<string, ReturnType<typeof vi.fn>>();
    const assets: TrustedOpenModelTokenizerAsset[] = families.map(([family, modelId]) => {
      const load = vi.fn(async () => ({
        tokenizerJson: wordPieceTokenizer,
        tokenizerConfig: {},
      }));
      loads.set(family, load);
      return {
        assetId: `${family}-local-v1`,
        family,
        providerId: 'openrouter',
        modelIds: [modelId],
        load,
      };
    });
    const registry = createTokenizerRegistry(
      createProductionTokenizers({ openModelAssets: assets }),
    );

    for (const [family, modelId] of families) {
      await expect(
        registry.estimateText('openrouter', modelId, 'hello world'),
      ).resolves.toMatchObject({
        tokens: 2,
        source: 'exact_local',
        tokenizerId: `huggingface:${family}:${family}-local-v1`,
      });
      expect(loads.get(family)).toHaveBeenCalledTimes(1);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      registry.estimateText('openrouter', 'qwen-unregistered', 'hello world'),
    ).resolves.toMatchObject({ source: 'conservative_estimate' });
  });

  it('uses deterministic LRU eviction for the bounded model/asset cache', async () => {
    const loadCounts = new Map<string, number>();
    const assets: TrustedOpenModelTokenizerAsset[] = (
      [
        ['qwen', 'qwen-a'],
        ['llama', 'llama-a'],
        ['deepseek', 'deepseek-a'],
      ] as const
    ).map(([family, modelId]) => ({
      assetId: `${family}-asset`,
      family,
      providerId: 'local',
      modelIds: [modelId],
      async load() {
        loadCounts.set(family, (loadCounts.get(family) ?? 0) + 1);
        return { tokenizerJson: wordPieceTokenizer, tokenizerConfig: {} };
      },
    }));
    const registry = createTokenizerRegistry(
      createProductionTokenizers({
        openModelAssets: assets,
        maxCachedOpenModelAssets: 2,
      }),
    );

    await registry.estimateText('local', 'qwen-a', 'hello');
    await registry.estimateText('local', 'llama-a', 'hello');
    await registry.estimateText('local', 'qwen-a', 'hello');
    await registry.estimateText('local', 'deepseek-a', 'hello');
    await registry.estimateText('local', 'llama-a', 'hello');

    expect(Object.fromEntries(loadCounts)).toEqual({ qwen: 1, llama: 2, deepseek: 1 });
  });

  it('propagates cancellation during lazy local loading without claiming exact provenance', async () => {
    const controller = new AbortController();
    let startLoad!: () => void;
    const started = new Promise<void>((resolve) => {
      startLoad = resolve;
    });
    const registry = createTokenizerRegistry(
      createProductionTokenizers({
        loadOpenAiO200k: async () => {
          startLoad();
          return new Promise<never>(() => undefined);
        },
      }),
    );
    const pending = registry.estimateText('openai', 'gpt-4o', 'private prompt', {
      signal: controller.signal,
    });
    await started;
    controller.abort(new DOMException('Cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves Anthropic and Gemini on explicitly authorized provider-native ports', async () => {
    const countText = vi.fn(
      async ({ providerId, modelId }: { providerId: string; modelId: string }) => ({
        tokens: 7,
        providerId,
        modelId,
      }),
    );
    const registry = createTokenizerRegistry(
      createProductionTokenizers({
        providerNativePorts: [
          {
            id: 'native:anthropic',
            providerId: 'anthropic',
            modelPattern: /^claude-3-7-sonnet$/,
            countText,
          },
          {
            id: 'native:gemini',
            providerId: 'gemini',
            modelPattern: /^gemini-2\.5-pro$/,
            countText,
          },
        ],
      }),
    );

    await expect(
      registry.estimateText('anthropic', 'claude-3-7-sonnet', 'hello', {
        allowProviderTransport: true,
      }),
    ).resolves.toMatchObject({ source: 'provider_native', tokens: 7 });
    await expect(registry.estimateText('gemini', 'gemini-2.5-pro', 'hello')).resolves.toMatchObject(
      { source: 'conservative_estimate' },
    );
    expect(countText).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous or stateful provider-native registrations', () => {
    const port = {
      id: 'native:anthropic',
      providerId: 'anthropic',
      modelPattern: /claude/g,
      countText: async () => ({
        tokens: 1,
        providerId: 'anthropic',
        modelId: 'claude',
      }),
    };
    expect(() => createProductionTokenizers({ providerNativePorts: [port] })).toThrow(
      /anchored and stateless/i,
    );

    const exactPort = { ...port, modelPattern: /^claude$/ };
    expect(() =>
      createProductionTokenizers({ providerNativePorts: [exactPort, exactPort] }),
    ).toThrow(/duplicate provider-native tokenizer id/i);
  });

  it('retries a transient OpenAI module load instead of claiming exactness', async () => {
    const loadOpenAiO200k = vi
      .fn()
      .mockRejectedValueOnce(new Error('local chunk unavailable'))
      .mockResolvedValue({ encode: () => [1, 2] });
    const registry = createTokenizerRegistry(
      createProductionTokenizers({ loadOpenAiO200k }),
    );

    await expect(registry.estimateText('openai', 'gpt-5', 'hello')).resolves.toMatchObject({
      source: 'conservative_estimate',
    });
    await expect(registry.estimateText('openai', 'gpt-5', 'hello')).resolves.toMatchObject({
      tokens: 2,
      source: 'exact_local',
    });
    expect(loadOpenAiO200k).toHaveBeenCalledTimes(2);
  });
});
