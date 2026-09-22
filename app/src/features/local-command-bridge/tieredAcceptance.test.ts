import { describe, expect, it } from 'vitest';
import { routeLocalCommand, signature } from './router';

describe('tiered local router acceptance fixtures', () => {
  it('recognizes corrected provider vocabulary while preserving path metadata', () => {
    const result = routeLocalCommand('please open opencode terminal');
    expect(result).toMatchObject({ classification: 'command_only', residual: '' });
    expect(result.commands[0]).toMatchObject({
      id: 'terminal.open',
      slots: { provider: 'opencode' },
      path: 'exact',
    });
    expect(signature(result.commands[0]!)).toBe('terminal.open:{"provider":"opencode"}');
  });

  it('keeps an adjacent model request when it has a meaningful residual', () => {
    const result = routeLocalCommand(
      'Please draft a complete playable educational game and play music',
    );
    expect(result.classification).toBe('both');
    expect(result.residual).toBe('Please draft a complete playable educational game');
    expect(result.commands).toMatchObject([
      { id: 'music.play', source: 'play music', sourceStart: 54, sourceEnd: 64 },
    ]);
  });

  it('returns bounded llm-only output for controls and oversized input', () => {
    const control = routeLocalCommand('\u0000open terminal');
    expect(control.commands).toEqual([]);
    expect(control.classification).toBe('llm_only');
    const oversized = 'x'.repeat(200_001);
    expect(routeLocalCommand(oversized)).toMatchObject({
      commands: [],
      classification: 'llm_only',
      residual: oversized.trim(),
    });
  });
});
