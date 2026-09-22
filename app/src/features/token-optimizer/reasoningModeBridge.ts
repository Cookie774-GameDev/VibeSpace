import type { ReasoningMode, ReasoningPreference } from '@/lib/ai/reasoningControls';
import type { TokenOptimizationMode } from './contracts';

/** Final Boss uses the provider's output allowance, without compression or a savings receipt. */
export function activeTokenOptimizationMode(
  mode: TokenOptimizationMode,
  reasoningMode: ReasoningMode,
): TokenOptimizationMode {
  return mode === 'final_boss' || reasoningMode === 'token-final-boss' ? 'off' : mode;
}

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
  if (mode === 'off') {
    // Turning optimization off must also remove a persisted Saver output cap.
    return current.mode === 'token-saver'
      ? Object.freeze({ mode: 'normal', effortOverride: current.effortOverride })
      : current;
  }
  return Object.freeze({
    mode: REASONING_MODE_BY_OPTIMIZATION[mode],
    effortOverride: current.effortOverride,
  });
}
