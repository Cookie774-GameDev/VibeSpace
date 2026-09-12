export type StabilityDiagnostic =
  | { type: 'renderer-heartbeat'; at: number }
  | { type: 'resource-pressure'; at: number; usedBytes: number; limitBytes: number }
  | { type: 'terminal-output-trimmed'; at: number; droppedCharacters: number };

export function createStabilityDiagnostics(limit = 128) {
  const entries: StabilityDiagnostic[] = [];

  return {
    record(entry: StabilityDiagnostic) {
      entries.push(Object.freeze({ ...entry }));
      if (entries.length > limit) {
        entries.splice(0, entries.length - limit);
      }
    },
    snapshot(): readonly StabilityDiagnostic[] {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}

export const stabilityDiagnostics = createStabilityDiagnostics();
