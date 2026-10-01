import type { ProviderTokenizer } from './contracts';
import {
  createExactLocalProviderTokenizer,
  createProviderNativeTokenizer,
  type ExactLocalTokenizerEngine,
  type ProviderNativeTokenCountPort,
} from './tokenizerAdapters';

export type OpenModelTokenizerFamily = 'qwen' | 'deepseek' | 'llama' | 'mistral';

export interface TrustedOpenModelTokenizerAsset {
  readonly assetId: string;
  readonly family: OpenModelTokenizerFamily;
  readonly providerId: string;
  readonly modelIds: readonly string[];
  load(signal?: AbortSignal): Promise<
    Readonly<{
      tokenizerJson: object;
      tokenizerConfig: object;
    }>
  >;
}

export interface ProductionTokenizerModuleLoaders {
  readonly loadOpenAiO200k?: () => Promise<GptTokenizerModule>;
  readonly loadOpenAiCl100k?: () => Promise<GptTokenizerModule>;
  readonly loadHuggingFace?: () => Promise<HuggingFaceTokenizerModule>;
}

export interface ProductionTokenizerOptions extends ProductionTokenizerModuleLoaders {
  readonly openModelAssets?: readonly TrustedOpenModelTokenizerAsset[];
  readonly providerNativePorts?: readonly ProviderNativeTokenCountPort[];
  readonly maxCachedOpenModelAssets?: number;
}

interface GptTokenizerModule {
  encode(text: string, options?: Readonly<{ disallowedSpecial?: Set<string> }>): number[];
}

interface LocalHuggingFaceTokenizer {
  encode(
    text: string,
    options?: Readonly<{ add_special_tokens?: boolean }>,
  ): Readonly<{ ids: readonly number[] }>;
}

interface HuggingFaceTokenizerModule {
  Tokenizer: new (tokenizerJson: object, tokenizerConfig: object) => LocalHuggingFaceTokenizer;
}

interface CachedAssetTokenizer {
  readonly tokenizer: LocalHuggingFaceTokenizer;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const OPENAI_O200K_MODELS =
  /^(?:chatgpt-4o(?:-[A-Za-z0-9.-]+)?|codex-mini-latest|computer-use-preview(?:-[A-Za-z0-9.-]+)?|gpt-(?:4o|4\.1|4\.5|5)(?:-[A-Za-z0-9.-]+)?|o[134](?:-[A-Za-z0-9.-]+)?)$/u;
const OPENAI_CL100K_MODELS =
  /^(?:gpt-3\.5(?:-[A-Za-z0-9.-]+)?|gpt-4(?:-[A-Za-z0-9.-]+)?|text-embedding-3-(?:small|large))$/u;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Tokenization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

async function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return pending;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    if (signal.reason instanceof Error) {
      rejectAbort(signal.reason);
      return;
    }
    const error = new Error('Tokenization was cancelled.');
    error.name = 'AbortError';
    rejectAbort(error);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

function exactModelPattern(modelIds: readonly string[]): RegExp {
  if (modelIds.length === 0 || modelIds.length > 256) {
    throw new Error('Open-model tokenizer registration requires one to 256 model ids.');
  }
  const unique = [...new Set(modelIds)];
  if (unique.length !== modelIds.length) {
    throw new Error('Open-model tokenizer registration contains duplicate model ids.');
  }
  unique.forEach((modelId) => assertSafeId('open-model id', modelId));
  return new RegExp(`^(?:${unique.map(escapeRegExp).join('|')})$`, 'u');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createOpenAiEngine(input: {
  readonly id: string;
  readonly modelPattern: RegExp;
  readonly load: () => Promise<GptTokenizerModule>;
}): ExactLocalTokenizerEngine {
  let modulePromise: Promise<GptTokenizerModule> | undefined;
  return Object.freeze({
    id: input.id,
    providerId: 'openai',
    modelPattern: input.modelPattern,
    reviewed: true as const,
    async countText({
      text,
      signal,
    }: Readonly<{
      providerId: string;
      modelId: string;
      text: string;
      signal?: AbortSignal;
    }>) {
      throwIfAborted(signal);
      modulePromise ??= input.load().catch((error) => {
        modulePromise = undefined;
        throw error;
      });
      const tokenizer = await awaitWithAbort(modulePromise, signal);
      throwIfAborted(signal);
      const encoded = tokenizer.encode(text, { disallowedSpecial: new Set() });
      throwIfAborted(signal);
      if (!Array.isArray(encoded))
        throw new Error('OpenAI tokenizer returned an invalid encoding.');
      return encoded.length;
    },
  });
}

class DeterministicTokenizerCache {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Promise<CachedAssetTokenizer>>();

  constructor(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
      throw new Error('Open-model tokenizer cache size must be between 1 and 32.');
    }
    this.#maxEntries = maxEntries;
  }

  getOrCreate(
    key: string,
    create: () => Promise<CachedAssetTokenizer>,
  ): Promise<CachedAssetTokenizer> {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing;
    }
    const pending = create().catch((error) => {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, pending);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return pending;
  }
}

function createOpenModelEngines(
  assets: readonly TrustedOpenModelTokenizerAsset[],
  loadHuggingFace: () => Promise<HuggingFaceTokenizerModule>,
  maxCachedAssets: number,
): readonly ExactLocalTokenizerEngine[] {
  const cache = new DeterministicTokenizerCache(maxCachedAssets);
  const registrationKeys = new Set<string>();
  const assetKeys = new Set<string>();

  return assets.map((asset) => {
    assertSafeId('tokenizer asset id', asset.assetId);
    assertSafeId('tokenizer provider id', asset.providerId);
    const cacheKey = `${asset.providerId}\u0000${asset.assetId}`;
    if (assetKeys.has(cacheKey)) {
      throw new Error('Duplicate provider/tokenizer asset registration.');
    }
    assetKeys.add(cacheKey);
    const modelPattern = exactModelPattern(asset.modelIds);
    for (const modelId of asset.modelIds) {
      const registrationKey = `${asset.providerId}\u0000${modelId}`;
      if (registrationKeys.has(registrationKey)) {
        throw new Error('Duplicate provider/model tokenizer registration.');
      }
      registrationKeys.add(registrationKey);
    }
    return Object.freeze({
      id: `huggingface:${asset.family}:${asset.assetId}`,
      providerId: asset.providerId,
      modelPattern,
      reviewed: true as const,
      async countText({
        text,
        signal,
      }: Readonly<{
        providerId: string;
        modelId: string;
        text: string;
        signal?: AbortSignal;
      }>) {
        throwIfAborted(signal);
        const cached = await awaitWithAbort(
          cache.getOrCreate(cacheKey, async () => {
            throwIfAborted(signal);
            const [module, loaded] = await Promise.all([loadHuggingFace(), asset.load(signal)]);
            throwIfAborted(signal);
            if (
              !loaded ||
              typeof loaded.tokenizerJson !== 'object' ||
              typeof loaded.tokenizerConfig !== 'object'
            ) {
              throw new Error('Trusted tokenizer asset loader returned invalid local assets.');
            }
            return {
              tokenizer: new module.Tokenizer(loaded.tokenizerJson, loaded.tokenizerConfig),
            };
          }),
          signal,
        );
        throwIfAborted(signal);
        const encoded = cached.tokenizer.encode(text, { add_special_tokens: false });
        throwIfAborted(signal);
        if (!encoded || !Array.isArray(encoded.ids)) {
          throw new Error('Open-model tokenizer returned an invalid encoding.');
        }
        return encoded.ids.length;
      },
    });
  });
}

function validateNativePorts(
  ports: readonly ProviderNativeTokenCountPort[],
): readonly ProviderNativeTokenCountPort[] {
  const registrations = new Set<string>();
  const ids = new Set<string>();
  return ports.map((port) => {
    assertSafeId('provider-native tokenizer id', port.id);
    assertSafeId('provider-native provider id', port.providerId);
    if (ids.has(port.id)) {
      throw new Error('Duplicate provider-native tokenizer id.');
    }
    ids.add(port.id);
    if (
      !port.modelPattern.source.startsWith('^') ||
      !port.modelPattern.source.endsWith('$') ||
      port.modelPattern.flags.includes('g') ||
      port.modelPattern.flags.includes('y')
    ) {
      throw new Error('Provider-native model pattern must be anchored and stateless.');
    }
    const key = `${port.providerId}\u0000${port.modelPattern.source}\u0000${port.modelPattern.flags}`;
    if (registrations.has(key)) {
      throw new Error('Duplicate provider-native tokenizer registration.');
    }
    registrations.add(key);
    return port;
  });
}

export function createProductionTokenizers(
  options: ProductionTokenizerOptions = {},
): readonly ProviderTokenizer[] {
  const loadOpenAiO200k =
    options.loadOpenAiO200k ??
    (() => import('gpt-tokenizer/encoding/o200k_base') as Promise<GptTokenizerModule>);
  const loadOpenAiCl100k =
    options.loadOpenAiCl100k ??
    (() => import('gpt-tokenizer/encoding/cl100k_base') as Promise<GptTokenizerModule>);
  const loadHuggingFace =
    options.loadHuggingFace ??
    (() => import('@huggingface/tokenizers') as Promise<HuggingFaceTokenizerModule>);

  const engines: ExactLocalTokenizerEngine[] = [
    createOpenAiEngine({
      id: 'gpt-tokenizer:o200k_base',
      modelPattern: OPENAI_O200K_MODELS,
      load: loadOpenAiO200k,
    }),
    createOpenAiEngine({
      id: 'gpt-tokenizer:cl100k_base',
      modelPattern: OPENAI_CL100K_MODELS,
      load: loadOpenAiCl100k,
    }),
    ...createOpenModelEngines(
      options.openModelAssets ?? [],
      loadHuggingFace,
      options.maxCachedOpenModelAssets ?? 4,
    ),
  ];

  const tokenizers = [
    ...engines.map(createExactLocalProviderTokenizer),
    ...validateNativePorts(options.providerNativePorts ?? []).map(
      createProviderNativeTokenizer,
    ),
  ];
  const tokenizerIds = new Set<string>();
  for (const tokenizer of tokenizers) {
    if (tokenizerIds.has(tokenizer.id)) {
      throw new Error('Duplicate production tokenizer id.');
    }
    tokenizerIds.add(tokenizer.id);
  }
  return Object.freeze(tokenizers);
}
