export interface IntelligenceUpgradeFlags {
  tokenOptimize: boolean;
  structuralRepositoryIntelligence: boolean;
  temporalContextKnowledge: boolean;
  nativeCapabilityBroker: boolean;
  browserGoalRunner: boolean;
  localAiTelemetry: boolean;
  externalTelemetryExporter: boolean;
}

export const DEFAULT_INTELLIGENCE_UPGRADE_FLAGS: Readonly<IntelligenceUpgradeFlags> = Object.freeze(
  {
    tokenOptimize: false,
    structuralRepositoryIntelligence: false,
    temporalContextKnowledge: false,
    nativeCapabilityBroker: false,
    browserGoalRunner: false,
    localAiTelemetry: false,
    externalTelemetryExporter: false,
  },
);

const FLAG_KEYS = Object.freeze(
  Object.keys(DEFAULT_INTELLIGENCE_UPGRADE_FLAGS) as (keyof IntelligenceUpgradeFlags)[],
);

export function parseIntelligenceUpgradeFlags(value: unknown): IntelligenceUpgradeFlags {
  const parsed = { ...DEFAULT_INTELLIGENCE_UPGRADE_FLAGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parsed;

  for (const key of FLAG_KEYS) {
    if (typeof (value as Record<string, unknown>)[key] === 'boolean') {
      parsed[key] = (value as Record<string, boolean>)[key];
    }
  }
  return parsed;
}
