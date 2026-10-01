import type { ReasoningMode, ReasoningPreference } from '@/lib/ai/reasoningControls';
import type { TokenOptimizationMode } from './contracts';

const REASONING_MODE_BY_OPTIMIZATION: Readonly<
  Record<Exclude<TokenOptimizationMode, 'off'>, ReasoningMode>
> = Object.freeze({
  saver: 'token-saver',
  normal: 'normal',
  final_boss: 'token-final-boss',
});

/**
 * The single Token Optimize control also drives the matching provider-neutral
 * reasoning policy. An explicit effort override remains authoritative; the
 * selected provider and model are never changed here.
 */
export function reasoningPreferenceForOptimization(
  mode: TokenOptimizationMode,
  current: ReasoningPreference,
): ReasoningPreference {
  if (mode === 'off') return current;
  return Object.freeze({
    mode: REASONING_MODE_BY_OPTIMIZATION[mode],
    effortOverride: current.effortOverride,
  });
}
