import { describe, expect, it } from 'vitest';
import cases from './__fixtures__/coordination-v2.json';
import { routeLocalCommand } from './router';

describe('contextual coordination and verbatim local messages', () => {
  it.each(cases)('$name', ({ text, expected, residual }) => {
    const result = routeLocalCommand(text);
    expect(result.commands.map(({ id, slots }) => ({ id, slots }))).toEqual(expected);
    expect(result.residual).toBe(residual);
    for (const command of result.commands) {
      expect(text.slice(command.sourceStart, command.sourceEnd)).toBe(command.source);
    }
  });
  it('keeps 24 contextual target/task combinations for the main model', () => {
    const targets = ['terminal 2', 'all terminals', 'all Claude terminals', 'Codex'];
    const tasks = [
      'use RLM',
      'use the project context map',
      'reference Downloads',
      'use relevant environment skills',
      'prepare a read-only audit',
      'compose project-specific prompts',
    ];
    for (const target of targets)
      for (const task of tasks) {
        const tail = `tell ${target} to ${task}`;
        const result = routeLocalCommand(`spawn 3 Claude terminals and ${tail}`);
        expect(
          result.commands.map(({ id, slots }) => ({ id, slots })),
          tail,
        ).toEqual([{ id: 'terminal.open', slots: { provider: 'claude', count: 3 } }]);
        expect(result.residual, tail).toBe(tail);
        expect(result.classification, tail).toBe('both');
      }
  });
  it('preserves literal content rather than interpreting instructions inside it', () => {
    const payloads = [
      'Use RLM. Keep READ_ONLY.',
      'Audit Settings and open tools; DO NOT write.',
      'run npm test -- --runInBand',
      'Line ONE\nLine TWO',
      'C:\\Users\\viper\\Downloads\\MyFile.TXT',
      'CaseSensitive_ID=ABc-123',
      'JSON {"Scope":"ReadOnly"}',
      'Keep two  spaces, punctuation: !?;',
    ];
    for (const payload of payloads) {
      const text = 'tell terminal 2 exactly: `' + payload + '`';
      const result = routeLocalCommand(text);
      expect(
        result.commands.map(({ id, slots }) => ({ id, slots })),
        text,
      ).toEqual([
        { id: 'terminal.message', slots: { target: { ordinal: 2, scope: 'one' }, payload } },
      ]);
      expect(result.residual, text).toBe('');
    }
  });
  it('never lets a contextual relay escape a negation, example, or question', () => {
    for (const text of [
      'Do not tell all Claude terminals to use RLM.',
      'Yesterday I told Claude to use the context map.',
      'Should I tell terminal 2 to use RLM?',
      'The guide says "tell all Claude terminals exactly: use RLM".',
    ]) {
      expect(routeLocalCommand(text).commands, text).toEqual([]);
    }
  });
});
