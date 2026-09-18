import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_DIAGNOSTIC_FIELDS,
  ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS,
  ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
  deriveActivityDiagnosticClockCalibration,
  hasCompatibleActivityDiagnosticCapabilities,
} from './activityDiagnosticContract';

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/lib/diagnostics/activityDiagnosticContract.fixture.json'), 'utf8'),
) as {
  schemaVersion: number;
  events: Array<Record<string, unknown>>;
};

describe('activity diagnostic schema contract', () => {
  it('keeps the canonical fixture on the declared schema and field authority', () => {
    expect(fixture.schemaVersion).toBe(ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION);
    expect(fixture.events).toHaveLength(1);
    const keys = Object.keys(fixture.events[0]!).sort();
    expect(keys).toEqual([...ACTIVITY_DIAGNOSTIC_FIELDS].sort());
    for (const required of ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS) {
      expect(fixture.events[0]).toHaveProperty(required);
    }
  });

  it('derives a bounded cross-process monotonic offset without assuming a shared epoch', () => {
    const calibration = deriveActivityDiagnosticClockCalibration(
      { processId: 42, wallUs: 1_789_300_000_000_000, monotonicUs: 12_500_000 },
      1_789_300_000_010,
      1_000,
      1_789_300_000_014,
      1_004,
    );
    expect(calibration).toMatchObject({
      processId: 42,
      roundTripMs: 4,
      uncertaintyMs: 2,
      offsetMinMs: 11_496,
      offsetMaxMs: 11_500,
    });
    expect(deriveActivityDiagnosticClockCalibration(
      { processId: 42, wallUs: 1, monotonicUs: 2 },
      10,
      20,
      11,
      19,
    )).toBeUndefined();
  });

  it('accepts only a capability descriptor that supports the whole current schema', () => {
    const good = {
      schemaVersions: [ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION],
      fields: [...ACTIVITY_DIAGNOSTIC_FIELDS],
      maxBatchEvents: 64,
    };
    expect(hasCompatibleActivityDiagnosticCapabilities(good)).toBe(true);
    expect(hasCompatibleActivityDiagnosticCapabilities({ ...good, schemaVersions: [0] })).toBe(false);
    expect(hasCompatibleActivityDiagnosticCapabilities({ ...good, maxBatchEvents: 63 })).toBe(false);
    expect(hasCompatibleActivityDiagnosticCapabilities({
      ...good,
      fields: good.fields.filter((field) => field !== 'coalescedRevisions'),
    })).toBe(false);
  });
});
