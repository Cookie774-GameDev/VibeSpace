import { describe, expect, it } from 'vitest';
import { routeLocalCommand } from './router';

describe('local command intent safety', () => {
  it.each([
    ['opne a cluaed termianl', 'terminal.open', { provider: 'claude' }],
    ['opne settigns', 'page.open', { route: 'settings' }],
    ['set the backgroudn to purpel', 'appearance.background.set', { color: 'purple' }],
  ] as const)('recognizes unambiguous transpositions: %s', (text, id, slots) => {
    const result = routeLocalCommand(text);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ id, slots });
    expect(result.classification).toBe('command_only');
  });

  it.each([
    'Explain terminal illness',
    'open a terminal illness discussion',
    'close a panel discussion',
    'play with music theory',
    'clone the panel',
    'open a Claude terminal or a Codex terminal',
    'do not opne a cluaed termianl',
    'The note says "opne a cluaed termianl".',
    'delete all settings',
  ])('does not execute a different or unresolved intent: %s', (text) => {
    const result = routeLocalCommand(text);
    expect(result.commands).toEqual([]);
  });
});
