import type { ProviderTokenizer, TokenEstimate, TokenizerRegistry } from './contracts';

const TOKENIZER_SOURCE_PRIORITY = {
  exact_local: 0,
  provider_native: 1,
} as const;

function conservativeUtf8Estimate(text: string): TokenEstimate {
  return {
    tokens: new TextEncoder().encode(text).byteLength,
    source: 'conservative_estimate',
    tokenizerId: 'builtin:utf8-conservative-estimate',
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Token optimization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

export function createTokenizerRegistry(
  tokenizers: readonly ProviderTokenizer[],
): TokenizerRegistry {
  const ordered = [...tokenizers].sort(
    (left, right) =>
      TOKENIZER_SOURCE_PRIORITY[left.source] - TOKENIZER_SOURCE_PRIORITY[right.source],
  );

  return {
    async estimateText(providerId, modelId, text, options) {
      throwIfAborted(options?.signal);
      const matching = ordered.filter((candidate) => {
        if (candidate.providerId !== providerId) return false;
        if (candidate.transmitsContent && !options?.allowProviderTransport) return false;
        const matcher = new RegExp(
          candidate.modelPattern.source,
          candidate.modelPattern.flags.replace(/[gy]/g, ''),
        );
        return matcher.test(modelId);
      });

      for (const tokenizer of matching) {
        try {
          throwIfAborted(options?.signal);
          const tokens = await tokenizer.estimateText({
            providerId,
            modelId,
            text,
            providerTransportAuthorized:
              tokenizer.transmitsContent && options?.allowProviderTransport === true,
            ...(options?.signal ? { signal: options.signal } : {}),
          });
          throwIfAborted(options?.signal);
          if (!Number.isSafeInteger(tokens) || tokens < 0) continue;
          return {
            tokens,
            source: tokenizer.source,
            tokenizerId: tokenizer.id,
          };
        } catch {
          throwIfAborted(options?.signal);
          // Expected tokenizer unavailability falls through to the next safe strategy.
        }
      }
      throwIfAborted(options?.signal);
      return conservativeUtf8Estimate(text);
    },
  };
}
