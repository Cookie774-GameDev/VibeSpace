/**
 * Product gate for the scrapped Hive multi-model chat surface.
 *
 * Hive implementation modules remain in the tree for recovery. Product
 * navigation, settings, slash commands, model-picker entry, and runtime stack
 * execution are off by default until explicitly re-enabled.
 *
 * Re-enable for local recovery:
 *   VITE_HIVE_ENABLED=true
 *
 * See docs/HIVE_PRODUCT_GATE.md.
 */

export const HIVE_PRODUCT_FLAG = 'VITE_HIVE_ENABLED' as const;

/** Settings tab id retained for deep-link fallback and future revival. */
export const GATED_SETTINGS_HIVE_TAB = 'hive' as const;

export interface HiveProductGateEnvironment {
  readonly VITE_HIVE_ENABLED?: string;
}

function truthyFlag(raw: string | undefined): boolean {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Whether Hive product surfaces and multi-model stack execution are active.
 * Default is false (scrapped / not resourced).
 */
export function isHiveProductEnabled(
  environment: HiveProductGateEnvironment = typeof import.meta !== 'undefined'
    ? (import.meta.env as HiveProductGateEnvironment)
    : {},
): boolean {
  return truthyFlag(environment.VITE_HIVE_ENABLED);
}

/** True when a settings deep link targets the gated Hive tab. */
export function isGatedSettingsHiveTab(value: string | null | undefined): boolean {
  return value === GATED_SETTINGS_HIVE_TAB && !isHiveProductEnabled();
}
