import { describe, expect, it } from 'vitest';
import { OpenCodeTurnGate } from '../OpenCodeTurnGate';

describe('OpenCodeTurnGate', () => {
  it('rejects events from a cancelled or superseded turn', () => {
    const gate = new OpenCodeTurnGate();
    const first = gate.begin('chat', 'turn-1');
    expect(gate.isCurrent(first)).toBe(true);
    gate.cancel('chat');
    expect(gate.isCurrent(first)).toBe(false);

    const second = gate.begin('chat', 'turn-2');
    const third = gate.begin('chat', 'turn-3');
    expect(gate.isCurrent(second)).toBe(false);
    expect(gate.isCurrent(third)).toBe(true);
    expect(gate.finish(second)).toBe(false);
    expect(gate.finish(third)).toBe(true);
  });
});
