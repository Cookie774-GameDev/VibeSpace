import type { ProviderTokenizer, ProviderTokenizerEstimateInput } from './contracts';

export interface ExactLocalTokenizerEngine {
  readonly id: string;
  readonly providerId: string;
  readonly modelPattern: RegExp;
  readonly reviewed: true;
  countText(
    input: Readonly<{ providerId: string; modelId: string; text: string; signal?: AbortSignal }>,
  ): Promise<number>;
}

export interface ProviderNativeTokenCountResult {
  readonly tokens: number;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ProviderNativeTokenCountPort {
  readonly id: string;
  readonly providerId: string;
  readonly modelPattern: RegExp;
  countText(
    input: Readonly<{
      providerId: string;
      modelId: string;
      text: string;
      authorization: 'explicit_token_count_transport';
      signal?: AbortSignal;
    }>,
  ): Promise<ProviderNativeTokenCountResult>;
}

function assertSelectedIdentity(
  input: Readonly<ProviderTokenizerEstimateInput>,
  providerId: string,
  modelPattern: RegExp,
): void {
  const matcher = new RegExp(modelPattern.source, modelPattern.flags.replace(/[gy]/gu, ''));
  if (input.providerId !== providerId || !matcher.test(input.modelId)) {
    throw new Error('Tokenizer selection identity mismatch.');
  }
}

function assertCount(tokens: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error('Tokenizer returned an invalid token count.');
  }
  return tokens;
}

export function createExactLocalProviderTokenizer(
  engine: ExactLocalTokenizerEngine,
): ProviderTokenizer {
  if (engine.reviewed !== true) {
    throw new Error('Exact-local tokenizer engine has not been reviewed.');
  }
  return Object.freeze({
    id: engine.id,
    providerId: engine.providerId,
    modelPattern: new RegExp(engine.modelPattern.source, engine.modelPattern.flags),
    source: 'exact_local' as const,
    transmitsContent: false,
    async estimateText(input: Readonly<ProviderTokenizerEstimateInput>) {
      assertSelectedIdentity(input, engine.providerId, engine.modelPattern);
      return assertCount(
        await engine.countText({
          providerId: input.providerId,
          modelId: input.modelId,
          text: input.text,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    },
  });
}

export function createProviderNativeTokenizer(
  port: ProviderNativeTokenCountPort,
): ProviderTokenizer {
  return Object.freeze({
    id: port.id,
    providerId: port.providerId,
    modelPattern: new RegExp(port.modelPattern.source, port.modelPattern.flags),
    source: 'provider_native' as const,
    transmitsContent: true,
    async estimateText(input: Readonly<ProviderTokenizerEstimateInput>) {
      assertSelectedIdentity(input, port.providerId, port.modelPattern);
      if (!input.providerTransportAuthorized) {
        throw new Error('Provider token-count transport is not authorized.');
      }
      const result = await port.countText({
        providerId: input.providerId,
        modelId: input.modelId,
        text: input.text,
        authorization: 'explicit_token_count_transport',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.providerId !== input.providerId || result.modelId !== input.modelId) {
        throw new Error('Provider token counter substituted the selected model.');
      }
      return assertCount(result.tokens);
    },
  });
}
