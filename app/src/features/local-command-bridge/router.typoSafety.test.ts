import { describe, expect, it } from 'vitest';
import { routeLocalCommand } from './router';

describe('local command typo safety', () => {
  it.each(['open codec', 'open codez', 'open clode'])(
    'refuses an ambiguous provider typo: %s',
    (text) => {
      const result = routeLocalCommand(text);
      expect(result.commands).toEqual([]);
      expect(result.classification).toBe('ambiguous');
      expect(result.ambiguous).toMatchObject([{ reason: 'typo-intent-conflict' }]);
      expect(result.residual).toBe(text);
    },
  );

  it.each([
    ['opne settings', 'page.open', { route: 'settings' }],
    ['open settigns', 'page.open', { route: 'settings' }],
    ['open claud', 'terminal.open', { provider: 'claude' }],
    ['open clbude', 'terminal.open', { provider: 'claude' }],
    ['play musci', 'music.play', {}],
  ])('keeps a harmless typo: %s', (text, id, slots) => {
    expect(routeLocalCommand(text)).toMatchObject({
      classification: 'command_only',
      commands: [{ id, slots }],
      residual: '',
    });
  });

  it.each(['cancel open settings', 'do not open codec', 'unknown frobnicator'])(
    'never executes suppressed or unknown input: %s',
    (text) => {
      expect(routeLocalCommand(text).commands).toEqual([]);
    },
  );
});
