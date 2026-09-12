import { describe, expect, it } from 'vitest';
import { createStabilityDiagnostics } from './stabilityDiagnostics';

describe('stability diagnostics', () => {
  it('keeps a bounded local ring of non-content recovery metrics', () => {
    const diagnostics = createStabilityDiagnostics(2);

    diagnostics.record({ type: 'renderer-heartbeat', at: 1 });
    diagnostics.record({ type: 'resource-pressure', at: 2, usedBytes: 80, limitBytes: 100 });
    diagnostics.record({ type: 'terminal-output-trimmed', at: 3, droppedCharacters: 4 });

    expect(diagnostics.snapshot()).toEqual([
      { type: 'resource-pressure', at: 2, usedBytes: 80, limitBytes: 100 },
      { type: 'terminal-output-trimmed', at: 3, droppedCharacters: 4 },
    ]);
  });
});
