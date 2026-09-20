import type { Message } from '@/types/chat';
import type { ProviderId } from '@/types';
import type { UsageSnapshot } from './adapters/types';

function providerReportedMetric(
  metric: UsageSnapshot['inputTokens'],
  integer = true,
): number | undefined {
  const value = metric?.value;
  return metric?.provenance === 'provider-reported' &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : undefined;
}

/**
 * Projects only numeric usage that the provider actually reported for a
 * request. Missing, estimated, locally observed, and unavailable values stay
 * absent so a failed turn cannot acquire fabricated token counts.
 */
export function providerPartialUsage(
  snapshot: UsageSnapshot | undefined,
  provider: ProviderId,
  model: string,
): Message['usage'] | undefined {
  if (!snapshot) return undefined;

  const inputTokens = providerReportedMetric(snapshot.inputTokens);
  const outputTokens = providerReportedMetric(snapshot.outputTokens);
  const totalTokens = providerReportedMetric(snapshot.totalTokens);
  const cacheReadTokens = providerReportedMetric(snapshot.cacheReadTokens);
  const cacheWriteTokens = providerReportedMetric(snapshot.cacheWriteTokens);
  const costUsd = providerReportedMetric(snapshot.costUsd, false);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cache_read_tokens: cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
    ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
    provider,
    model,
  });
}
