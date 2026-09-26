import { describe, expect, it } from 'vitest';
import { TERMINAL_AGENT_COMMAND_INPUTS, parseTerminalSelectorText } from './terminals';

describe('terminal and agent command catalog', () => {
  it.each([
    ['terminal two', { ordinal: 2 }],
    ['pane pane_7', { paneId: 'pane_7' }],
    ['session sess_9', { sessionId: 'sess_9' }],
    ['Codex', { provider: 'codex' }],
    ['all terminals', { scope: 'all' }],
  ])('uses one deterministic selector grammar for %s', (source, expected) => {
    const selector = parseTerminalSelectorText(source);
    expect(selector).toEqual(expected);
    expect(Object.isFrozen(selector)).toBe(true);
  });

  it.each([
    42 as unknown as string,
    '',
    'terminal\nprivate',
    'x'.repeat(257),
    'terminal 0',
    'terminal 1025',
    'terminal 999999999999999999999',
    'pane ../private',
    'session bad/id',
  ])('fails closed for malformed or unbounded selectors: %j', (source) => {
    expect(parseTerminalSelectorText(source)).toBeNull();
  });

  it('declares the exhaustive terminal and agent lifecycle IDs without granting blocked authority', () => {
    expect(TERMINAL_AGENT_COMMAND_INPUTS.map((entry) => entry.id)).toEqual([
      'terminal.focus',
      'terminal.list',
      'terminal.status',
      'terminal.split',
      'terminal.rename',
      'terminal.move_project',
      'terminal.restart',
      'terminal.clear',
      'terminal.stop',
      'terminal.close',
      'terminal.cancel_queued',
      'agent.message',
      'agent.broadcast',
      'agent.status',
      'agent.continue',
      'agent.stop',
      'agent.assign_role',
      'agent.give_context',
    ]);
    expect(
      TERMINAL_AGENT_COMMAND_INPUTS.filter((entry) => entry.availability === 'available').map(
        (entry) => entry.id,
      ),
    ).toEqual(['terminal.list', 'terminal.status', 'agent.status']);
  });

  it('maps every lifecycle ID to one collision-free slash alias without replacing human aliases', () => {
    const aliases = TERMINAL_AGENT_COMMAND_INPUTS.flatMap((entry) => entry.aliases).map((alias) =>
      alias.trim().toLocaleLowerCase(),
    );
    for (const entry of TERMINAL_AGENT_COMMAND_INPUTS) {
      const slashAlias = `/${entry.id.replace(/[._]+/gu, '-')}`;
      expect(entry.aliases).toContain(slashAlias);
      expect(entry.aliases[0]).not.toMatch(/^\//u);
      expect(entry.aliases.filter((alias) => alias === slashAlias)).toHaveLength(1);
    }
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).not.toContain('/terminal');
    expect(aliases).not.toContain('/connect');
  });

  it('keeps slash list/status locally available and destructive lifecycle commands blocked', () => {
    expect(
      TERMINAL_AGENT_COMMAND_INPUTS.filter((entry) =>
        ['/terminal-list', '/terminal-status', '/agent-status'].some((alias) =>
          entry.aliases.includes(alias),
        ),
      ).map((entry) => [entry.id, entry.availability]),
    ).toEqual([
      ['terminal.list', 'available'],
      ['terminal.status', 'available'],
      ['agent.status', 'available'],
    ]);
    expect(
      TERMINAL_AGENT_COMMAND_INPUTS.find((entry) => entry.aliases.includes('/terminal-close')),
    ).toMatchObject({ id: 'terminal.close', safety: 'confirm', availability: 'blocked' });
  });

  it('preserves message payload casing and punctuation after the exact selector', () => {
    const input = TERMINAL_AGENT_COMMAND_INPUTS.find((entry) => entry.id === 'agent.message')!;
    const source = 'message agent terminal two: Review API.ts, please!';
    const parsed = input.parseSlots?.(
      {
        definition: undefined as never,
        alias: 'message agent',
        sourceStart: 0,
        sourceEnd: 'message agent'.length,
        remainder: 'terminal two: Review API.ts, please!',
      },
      source,
    );
    expect(parsed).toEqual({
      status: 'parsed',
      slots: { selector: { ordinal: 2 }, payload: 'Review API.ts, please!' },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed && 'slots' in parsed ? parsed.slots : undefined)).toBe(true);
  });

  it('preserves payload casing through the slash agent-message alias', () => {
    const input = TERMINAL_AGENT_COMMAND_INPUTS.find((entry) => entry.id === 'agent.message')!;
    const source = '/agent-message terminal two: Review API.ts, please!';
    expect(
      input.parseSlots?.(
        {
          definition: undefined as never,
          alias: '/agent-message',
          sourceStart: 0,
          sourceEnd: '/agent-message'.length,
          remainder: 'terminal two: Review API.ts, please!',
        },
        source,
      ),
    ).toEqual({
      status: 'parsed',
      slots: { selector: { ordinal: 2 }, payload: 'Review API.ts, please!' },
    });
  });

  it.each([
    'message agent terminal two: private\npayload',
    `message agent terminal two: ${'x'.repeat(4_097)}`,
  ])('fails closed when direct message slot parsing bypasses source bounds', (source) => {
    const input = TERMINAL_AGENT_COMMAND_INPUTS.find((entry) => entry.id === 'agent.message')!;
    const parsed = input.parseSlots?.(
      {
        definition: undefined as never,
        alias: 'message agent',
        sourceStart: 0,
        sourceEnd: 'message agent'.length,
        remainder: source.slice('message agent'.length),
      },
      source,
    );
    expect(parsed).toEqual({ status: 'rejected', reason: 'Name a terminal, then a message.' });
    expect(JSON.stringify(parsed)).not.toMatch(/private|payload|x{20}/iu);
  });
});
