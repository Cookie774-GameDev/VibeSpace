import { describe, expect, it } from 'vitest';
import { DIRECT_COMMANDS } from './registry';
import { routeLocalCommand, signature } from './router';

const expected = (id: string, slots: Readonly<Record<string, unknown>> = {}) =>
  id + ':' + JSON.stringify(slots);

function phraseFor(command: (typeof DIRECT_COMMANDS)[number]): string {
  const alias = command.aliases[0]!;
  if (command.slot === 'number') return alias + ' 42';
  if (command.slot === 'remainder' || command.slot === 'optional_remainder') {
    return alias + ' sample target';
  }
  return alias;
}

describe('expanded local-command acceptance', () => {
  it('keeps vague two-Claude coordination for the main model after spawning exactly two terminals', () => {
    const result = routeLocalCommand(
      'HEY PLEASE SPAWN 2 CLAUDE AGENTS TERMINALS AND TEELL BOTH OF THEM TO USE THE SKILLS FROM TEH ENVOIRMENT AND LIKE RENFERACE THE DOWNLADOS FOLDER AND ALSO TELL THEM TO DO A READ AUDIT ON VIBESAPCE OAKY',
    );
    expect(result.classification).toBe('both');
    expect(result.commands.map(signature)).toEqual([
      expected('terminal.open', { provider: 'claude', count: 2 }),
    ]);
    expect(result.residual).toContain('TEELL BOTH OF THEM');
    expect(result.residual).toContain('SKILLS FROM TEH ENVOIRMENT');
    expect(result.residual).toContain('DOWNLADOS FOLDER');
    expect(result.residual).toContain('READ AUDIT ON VIBESAPCE');
    expect(result.residual).not.toContain('SPAWN 2 CLAUDE AGENTS TERMINALS');
  });

  it('supports generic multi-terminal counts', () => {
    expect(routeLocalCommand('open 2 terminals')).toMatchObject({
      classification: 'command_only',
      residual: '',
      commands: [{ id: 'terminal.open', slots: { provider: 'shell', count: 2 } }],
    });
  });

  it('keeps explicit ordinal/provider messages local', () => {
    expect(routeLocalCommand('tell terminal 2 to run npm test').commands.map(signature)).toEqual([
      expected('terminal.message', {
        target: { ordinal: 2, scope: 'one' },
        payload: 'run npm test',
      }),
    ]);
    expect(
      routeLocalCommand('tell all Claude terminals to inspect the project').commands.map(signature),
    ).toEqual([
      expected('terminal.broadcast', {
        target: { provider: 'claude', scope: 'all' },
        payload: 'inspect the project',
      }),
    ]);
    expect(routeLocalCommand('tell Codex to inspect the project').commands.map(signature)).toEqual([
      expected('agent.message', {
        target: { provider: 'codex', scope: 'one' },
        payload: 'inspect the project',
      }),
    ]);
  });

  it('does not invent local targets for vague pronoun coordination', () => {
    const result = routeLocalCommand(
      'tell both of them to inspect Downloads and use the environment skills',
    );
    expect(result.commands).toEqual([]);
    expect(result.classification).toBe('llm_only');
    expect(result.residual).toContain('tell both of them');
  });

  it('protects compound explanation requests from connector context loss', () => {
    const text =
      'Please explain how to spawn 2 Claude terminals and tell all Claude terminals to run npm test without doing any of it.';
    const result = routeLocalCommand(text);
    expect(result.commands).toEqual([]);
    expect(result.classification).toBe('llm_only');
    expect(result.residual).toBe(text);
  });

  it('routes every expanded direct command in its canonical positive form', () => {
    const failures: string[] = [];
    for (const command of DIRECT_COMMANDS) {
      const result = routeLocalCommand(phraseFor(command));
      if (
        result.commands.length !== 1 ||
        result.commands[0]?.id !== command.id ||
        result.classification !== 'command_only'
      ) {
        failures.push(
          JSON.stringify({
            id: command.id,
            result: {
              classification: result.classification,
              commands: result.commands,
              residual: result.residual,
            },
          }),
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('preserves model work after every expanded direct command', () => {
    const failures: string[] = [];
    for (const command of DIRECT_COMMANDS) {
      const result = routeLocalCommand(
        phraseFor(command) +
          ' and also analyze the VibeSpace repository and write a read-only audit',
      );
      if (
        result.commands.length !== 1 ||
        result.commands[0]?.id !== command.id ||
        result.classification !== 'both' ||
        !result.residual.toLowerCase().includes('analyze the vibespace repository')
      ) {
        failures.push(command.id);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps all expanded direct commands inert in quoted, explanatory, negated, historical, question, and translation contexts', () => {
    const wrappers = [
      (phrase: string) => `The documentation says "${phrase}" as an example.`,
      (phrase: string) => `Please explain how to ${phrase} without doing it.`,
      (phrase: string) => `Do not ${phrase}.`,
      (phrase: string) => `Yesterday I used the phrase "${phrase}" in a test.`,
      (phrase: string) => `Should I ${phrase} before continuing?`,
      (phrase: string) => `Please translate "${phrase}" into French.`,
    ];
    const failures: string[] = [];
    for (const command of DIRECT_COMMANDS) {
      const phrase = phraseFor(command);
      for (const wrap of wrappers) {
        const result = routeLocalCommand(wrap(phrase));
        if (result.commands.length !== 0) failures.push(command.id + ':' + wrap(phrase));
      }
    }
    expect(failures).toEqual([]);
  });
});
