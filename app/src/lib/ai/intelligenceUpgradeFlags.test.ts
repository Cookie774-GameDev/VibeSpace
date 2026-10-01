import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTELLIGENCE_UPGRADE_FLAGS,
  parseIntelligenceUpgradeFlags,
} from './intelligenceUpgradeFlags';

describe('intelligence upgrade feature flags', () => {
  it('keeps every new runtime path off by default', () => {
    expect(DEFAULT_INTELLIGENCE_UPGRADE_FLAGS).toEqual({
      tokenOptimize: false,
      structuralRepositoryIntelligence: false,
      temporalContextKnowledge: false,
      nativeCapabilityBroker: false,
      browserGoalRunner: false,
      localAiTelemetry: false,
      externalTelemetryExporter: false,
    });
    expect(Object.isFrozen(DEFAULT_INTELLIGENCE_UPGRADE_FLAGS)).toBe(true);
  });

  it('accepts only explicit booleans and never enables external export implicitly', () => {
    expect(
      parseIntelligenceUpgradeFlags({
        tokenOptimize: true,
        browserGoalRunner: true,
        externalTelemetryExporter: 'true',
        unknownFlag: true,
      }),
    ).toEqual({
      ...DEFAULT_INTELLIGENCE_UPGRADE_FLAGS,
      tokenOptimize: true,
      browserGoalRunner: true,
      externalTelemetryExporter: false,
    });
  });
});
