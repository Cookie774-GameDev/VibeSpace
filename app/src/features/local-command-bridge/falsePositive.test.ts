import { describe, expect, it } from 'vitest';
import { routeLocalCommand } from './router';

describe('local command false-positive guards', () => {
  it.each([
    'explain how to open a Claude terminal without doing it',
    'Yesterday I opened Claude and changed the background',
    'If you open a Claude terminal, explain it',
    'The documentation says "open a Claude terminal".',
    'Turn 6: The Cedar Room closure is withdrawn.',
    'TURN 06: The Cedar Room closure is withdrawn.',
    'Turn\t6 : The Cedar Room closure is withdrawn.',
    'The Cedar Room closure is withdrawn.',
    '"Turn 6: turn off schedule weekly"',
  ])('leaves non-imperative prose unchanged: %s', (text) => {
    const result = routeLocalCommand(text);
    expect(result.commands).toEqual([]);
    expect(result.residual).toBe(text);
    expect(result.classification).toBe('llm_only');
    expect(result.ambiguous).toEqual([]);
  });

  it('retains the existing negated-command guard', () => {
    const result = routeLocalCommand('Do not turn off schedule weekly.');
    expect(result.commands).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('reports unresolved ambiguity instead of executing a guessed appearance command', () => {
    const result = routeLocalCommand('open a purpel background');
    expect(result.commands).toEqual([]);
    expect(result.classification).toBe('ambiguous');
    expect(result.ambiguous).toMatchObject([
      { reason: 'background-action', source: 'open a purpel background' },
    ]);
  });
});
