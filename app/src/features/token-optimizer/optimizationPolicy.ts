import type { TokenOptimizationMode, TokenOptimizationModePolicy } from './contracts';

const MODE_POLICIES: Readonly<
  Record<TokenOptimizationMode, Readonly<TokenOptimizationModePolicy>>
> = Object.freeze({
  off: Object.freeze({
    mode: 'off',
    outputTokenCeiling: null,
    relevanceFloor: 0,
    reasoning: 'unchanged',
    allowModelSwitch: false,
  }),
  saver: Object.freeze({
    mode: 'saver',
    outputTokenCeiling: null,
    relevanceFloor: 0.2,
    reasoning: 'provider_default',
    allowModelSwitch: false,
  }),
  normal: Object.freeze({
    mode: 'normal',
    outputTokenCeiling: null,
    relevanceFloor: 0.1,
    reasoning: 'provider_default',
    allowModelSwitch: false,
  }),
  final_boss: Object.freeze({
    mode: 'final_boss',
    outputTokenCeiling: null,
    relevanceFloor: 0.05,
    reasoning: 'highest_appropriate',
    allowModelSwitch: false,
  }),
});

/**
 * Returns mode metadata used by the runtime controls. It does not select,
 * remove, rewrite, or compress prompt content.
 */
export function optimizationModePolicy(
  mode: TokenOptimizationMode,
): Readonly<TokenOptimizationModePolicy> {
  return MODE_POLICIES[mode];
}
