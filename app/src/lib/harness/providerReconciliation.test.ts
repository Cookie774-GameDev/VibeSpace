import { describe, expect, it } from 'vitest';
import {
  catalogContainsSelection,
  parseOpenCodeProviderResponse,
  reconcileHarnessProviderCatalog,
  resolveOpenCodeSelection,
  trustedCatalogForSelection,
} from './providerReconciliation';
import type { HarnessProvider } from './types';

const REQUIRED_FAMILIES = [
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google', 'google'],
  ['groq', 'groq'],
  ['xai', 'xai'],
  ['qwen', 'qwen'],
  ['openrouter', 'openrouter'],
  ['deepseek', 'deepseek'],
  ['mistral', 'mistral'],
  ['together', 'together'],
  ['ollama', 'ollama'],
  ['local', 'ollama'],
  ['zai', 'zai'],
  ['azure', 'azure'],
  ['cerebras', 'cerebras'],
  ['huggingface', 'huggingface'],
  ['bedrock', 'amazon-bedrock'],
  ['cohere', 'cohere'],
  ['perplexity', 'perplexity'],
  ['fireworks', 'fireworks'],
  ['replicate', 'replicate'],
  ['hyperbolic', 'hyperbolic'],
  ['novita', 'novita'],
  ['lambda', 'lambda'],
] as const;

function provider(id: string, modelId = `${id}-model`): HarnessProvider {
  return {
    id,
    name: id,
    connected: true,
    models: [{ id: modelId, name: modelId }],
  };
}

describe('OpenCode provider response parsing', () => {
  it('parses dynamic model capability metadata and omits secret configuration', () => {
    const raw = {
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          key: 'never-expose-this-key',
          env: ['OPENROUTER_API_KEY'],
          options: { apiKey: 'also-secret' },
          models: {
            'qwen/qwen3-coder': {
              id: 'upstream-id-is-not-the-selection-id',
              name: 'Qwen 3 Coder',
              attachment: true,
              tool_call: true,
              limit: { context: 262_144, output: 32_768 },
              modalities: { input: ['text', 'image'], output: ['text'] },
              cost: {
                input: 0,
                output: 0,
                cache: { read: 0, write: 0 },
              },
              headers: { authorization: 'Bearer never-expose-model-secret' },
            },
          },
        },
      ],
      default: { openrouter: 'qwen/qwen3-coder' },
    };

    const parsed = parseOpenCodeProviderResponse(raw);

    expect(parsed).toEqual([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        connected: true,
        models: [
          {
            id: 'qwen/qwen3-coder',
            name: 'Qwen 3 Coder',
            contextWindowTokens: 262_144,
            supportsImages: true,
            supportsTools: true,
            pricing: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('never-expose');
    expect(JSON.stringify(parsed)).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.stringify(parsed)).not.toContain('also-secret');
    expect(JSON.stringify(parsed)).not.toContain('upstream-id');
    expect(JSON.stringify(parsed)).not.toContain('never-expose-model-secret');
  });

  it('omits incomplete, unsafe, or unsupported model pricing instead of guessing', () => {
    const costs = [
      { input: 0, output: 0, cache: { read: 0 } },
      { input: 0, output: Number.NaN, cache: { read: 0, write: 0 } },
      { input: -1, output: 0, cache: { read: 0, write: 0 } },
      { input: 0, output: 0, cache: { read: 0, write: 0 }, longContext: { input: 0 } },
      { input: 0, output: 0, cache: { read: 0, write: 1_000_001 } },
    ];
    const parsed = parseOpenCodeProviderResponse({
      providers: [
        {
          id: 'priced',
          models: Object.fromEntries(
            costs.map((cost, index) => [`model-${index}`, { name: `Model ${index}`, cost }]),
          ),
        },
      ],
    });

    expect(parsed[0]?.models).toHaveLength(costs.length);
    expect(parsed[0]?.models.every((model) => model.pricing === undefined)).toBe(true);
  });

  it('bounds collections and ignores malformed provider or model identities', () => {
    const providers = Array.from({ length: 300 }, (_, index) => ({
      id: index === 0 ? '' : `provider-${index}`,
      name: 'n'.repeat(1_000),
      models: {},
    }));

    const parsed = parseOpenCodeProviderResponse({ providers });
    const parsedModels = parseOpenCodeProviderResponse({
      providers: [
        {
          id: 'models',
          models: Object.fromEntries(
            Array.from({ length: 4_100 }, (_value, modelIndex) => [
              modelIndex === 0 ? '' : `model-${modelIndex}`,
              { name: 'm'.repeat(2_000) },
            ]),
          ),
        },
      ],
    });

    expect(parsed).toHaveLength(255);
    expect(parsed[0]?.name).toHaveLength(512);
    expect(parsedModels[0]?.models).toHaveLength(4_095);
    expect(parsedModels[0]?.models[0]?.name).toHaveLength(512);
  });
});

describe('OpenCode provider reconciliation', () => {
  it('preserves catalog order and metadata while appending dynamic runtime models', () => {
    const catalog: HarnessProvider[] = [
      {
        id: 'openai',
        name: 'OpenAI product name',
        models: [
          {
            id: 'gpt-catalog',
            name: 'Favorite GPT',
            contextWindowTokens: 1_000_000,
          },
          { id: 'retired-model', name: 'Retired' },
        ],
      },
    ];
    const runtime: HarnessProvider[] = [
      {
        id: 'openai',
        name: 'OpenAI runtime name',
        connected: true,
        models: [
          { id: 'gpt-catalog', name: 'Runtime GPT', supportsTools: true },
          { id: 'gpt-dynamic', name: 'Dynamic GPT', supportsImages: true },
        ],
      },
      provider('custom-company', 'custom-model'),
    ];

    expect(reconcileHarnessProviderCatalog(catalog, runtime)).toEqual([
      {
        id: 'openai',
        name: 'OpenAI product name',
        available: true,
        runtimeProviderId: 'openai',
        models: [
          {
            id: 'gpt-catalog',
            name: 'Favorite GPT',
            contextWindowTokens: 1_000_000,
            supportsTools: true,
            available: true,
            runtimeModelId: 'gpt-catalog',
          },
          {
            id: 'retired-model',
            name: 'Retired',
            available: false,
          },
          {
            id: 'gpt-dynamic',
            name: 'Dynamic GPT',
            supportsImages: true,
            available: true,
            runtimeModelId: 'gpt-dynamic',
            dynamic: true,
          },
        ],
      },
      {
        id: 'custom-company',
        name: 'custom-company',
        available: true,
        runtimeProviderId: 'custom-company',
        dynamic: true,
        models: [
          {
            id: 'custom-model',
            name: 'custom-model',
            available: true,
            runtimeModelId: 'custom-model',
            dynamic: true,
          },
        ],
      },
    ]);
  });

  it('keeps unavailable catalog entries visible and truthful', () => {
    expect(
      reconcileHarnessProviderCatalog(
        [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] }],
        [],
      ),
    ).toEqual([
      {
        id: 'anthropic',
        name: 'Anthropic',
        available: false,
        models: [{ id: 'claude', name: 'Claude', available: false }],
      },
    ]);
  });

  it('preserves curated local entries and appends an unlisted installed Ollama model', () => {
    const reconciled = reconcileHarnessProviderCatalog(
      [
        {
          id: 'local',
          name: 'Local',
          models: [
            { id: 'llama3.2', name: 'Llama 3.2' },
            { id: 'gpt-oss:20b', name: 'GPT-OSS 20B' },
          ],
        },
      ],
      [
        {
          id: 'ollama',
          name: 'Ollama (local)',
          connected: true,
          models: [
            { id: 'llama3.2', name: 'llama3.2' },
            { id: 'private/unlisted:latest', name: 'private/unlisted:latest' },
          ],
        },
      ],
    );

    expect(reconciled[0]).toEqual(
      expect.objectContaining({
        id: 'local',
        runtimeProviderId: 'ollama',
        models: [
          expect.objectContaining({ id: 'llama3.2', available: true }),
          expect.objectContaining({ id: 'gpt-oss:20b', available: false }),
          expect.objectContaining({
            id: 'private/unlisted:latest',
            available: true,
            dynamic: true,
          }),
        ],
      }),
    );
  });
});

describe('exact OpenCode selection mapping', () => {
  it.each(REQUIRED_FAMILIES)(
    'maps the %s family only to exact runtime provider %s',
    (vibeSpaceId, runtimeId) => {
      expect(
        resolveOpenCodeSelection({ providerId: vibeSpaceId, modelId: `${runtimeId}-model` }, [
          provider(runtimeId),
        ]),
      ).toEqual({ providerId: runtimeId, modelId: `${runtimeId}-model` });
    },
  );

  it('maps the Vertex connection and explicit custom provider exactly', () => {
    expect(
      resolveOpenCodeSelection(
        {
          providerId: 'google',
          modelId: 'gemini-vertex',
          connectionId: 'google-vertex',
        },
        [provider('google'), provider('google-vertex', 'gemini-vertex')],
      ),
    ).toEqual({ providerId: 'google-vertex', modelId: 'gemini-vertex' });
    expect(
      resolveOpenCodeSelection(
        {
          providerId: 'custom-product-family',
          modelId: 'custom/model',
          runtimeProviderId: 'company-runtime',
        },
        [provider('company-runtime', 'custom/model')],
      ),
    ).toEqual({ providerId: 'company-runtime', modelId: 'custom/model' });
  });

  it('preserves gateway-qualified Qwen identities without rewriting them', () => {
    expect(
      resolveOpenCodeSelection({ providerId: 'openrouter', modelId: 'qwen/qwen3-coder' }, [
        provider('openrouter', 'qwen/qwen3-coder'),
      ]),
    ).toEqual({ providerId: 'openrouter', modelId: 'qwen/qwen3-coder' });
  });

  it('fails explicitly instead of choosing a provider or model fallback', () => {
    expect(() =>
      resolveOpenCodeSelection({ providerId: 'anthropic', modelId: 'claude' }, [
        provider('openai', 'gpt'),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }));
    expect(() =>
      resolveOpenCodeSelection({ providerId: 'openai', modelId: 'missing' }, [
        provider('openai', 'gpt'),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }));
    expect(() =>
      resolveOpenCodeSelection({ providerId: 'local', modelId: 'removed:model' }, [
        provider('ollama', 'qwen3.5:4b'),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }));
  });

  it('builds a trusted one-model catalog so send can proceed without a full provider scan', () => {
    const catalog = trustedCatalogForSelection({
      providerId: 'openai',
      modelId: 'gpt-5.3-codex-spark',
    });
    expect(catalog).toEqual([
      {
        id: 'openai',
        name: 'openai',
        models: [{ id: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark' }],
        connected: true,
      },
    ]);
    expect(
      catalogContainsSelection({ providerId: 'openai', modelId: 'gpt-5.3-codex-spark' }, catalog),
    ).toBe(true);
    expect(
      resolveOpenCodeSelection({ providerId: 'openai', modelId: 'gpt-5.3-codex-spark' }, catalog),
    ).toEqual({ providerId: 'openai', modelId: 'gpt-5.3-codex-spark' });
  });
});
