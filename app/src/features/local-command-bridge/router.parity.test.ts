import { describe, expect, it } from 'vitest';
import { routeLocalCommand } from './router';

describe('frozen local command router parity', () => {
  it('keeps a command-only terminal route and exact source span', () => {
    expect(routeLocalCommand('open a Claude terminal')).toMatchObject({
      residual: '',
      classification: 'command_only',
      commands: [
        {
          id: 'terminal.open',
          confidence: 0.985,
          source: 'open a Claude terminal',
          sourceStart: 0,
          sourceEnd: 22,
          slots: { provider: 'claude' },
          path: 'local-frame',
        },
      ],
    });
  });

  it('keeps the model residual and offsets for mixed text', () => {
    expect(
      routeLocalCommand('Draft a complete HTML game and open a Claude terminal'),
    ).toMatchObject({
      residual: 'Draft a complete HTML game',
      classification: 'both',
      commands: [
        expect.objectContaining({
          id: 'terminal.open',
          sourceStart: 31,
          sourceEnd: 53,
          slots: { provider: 'claude' },
        }),
      ],
    });
  });

  it('routes multiple commands without broad text replacement', () => {
    const result = routeLocalCommand('open settings and play music');
    expect(result).toMatchObject({ residual: '', classification: 'command_only' });
    expect(result.commands.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 'page.open', source: 'open settings' },
      { id: 'music.play', source: 'play music' },
    ]);
  });

  it('preserves the frozen control-suppression behavior', () => {
    expect(routeLocalCommand('do not open a Claude terminal')).toMatchObject({
      commands: [],
      classification: 'llm_only',
      residual: '',
    });
  });
});
