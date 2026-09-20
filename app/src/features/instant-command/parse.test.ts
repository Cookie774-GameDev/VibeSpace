import { describe, expect, it } from 'vitest';
import { classifyInstantCommandInput, parseInstantCommand } from './parse';

describe('parseInstantCommand', () => {
  it.each([
    ['open codex', { kind: 'open-agent-cli', provider: 'codex', count: 1 }],
    ['open claude', { kind: 'open-agent-cli', provider: 'claude', count: 1 }],
    ['open OpenCode', { kind: 'open-agent-cli', provider: 'opencode', count: 1 }],
    ['open Kiro', { kind: 'open-agent-cli', provider: 'kiro', count: 1 }],
    ['open 3 Codex terminals', { kind: 'open-agent-cli', provider: 'codex', count: 3 }],
    ['open llm', { kind: 'open-model-picker' }],
    [
      'message terminal 3: run npm test',
      { kind: 'terminal-message', target: { ordinal: 3, scope: 'one' }, payload: 'run npm test' },
    ],
    [
      'tell terminal 3 to Run NPM Test',
      { kind: 'terminal-message', target: { ordinal: 3, scope: 'one' }, payload: 'Run NPM Test' },
    ],
    [
      'message terminal one: Keep This Casing',
      {
        kind: 'terminal-message',
        target: { ordinal: 1, scope: 'one' },
        payload: 'Keep This Casing',
      },
    ],
    [
      'Codex, Review the Updater',
      {
        kind: 'agent-message',
        target: { provider: 'codex', scope: 'one' },
        payload: 'Review the Updater',
      },
    ],
    [
      'tell OpenCode to fix the RLM tests',
      {
        kind: 'agent-message',
        target: { provider: 'opencode', scope: 'one' },
        payload: 'fix the RLM tests',
      },
    ],
    [
      'tell Kiro to inspect the release',
      {
        kind: 'agent-message',
        target: { provider: 'kiro', scope: 'one' },
        payload: 'inspect the release',
      },
    ],
    [
      'tell all terminals to run git status',
      { kind: 'terminal-broadcast', target: { scope: 'all' }, payload: 'run git status' },
    ],
    [
      'tell all Codex terminals to inspect regressions',
      {
        kind: 'terminal-broadcast',
        target: { provider: 'codex', scope: 'all' },
        payload: 'inspect regressions',
      },
    ],
  ])('parses %s without changing the payload', (input, expected) => {
    expect(parseInstantCommand(input)).toMatchObject(expected);
  });

  it('runs explicit targeted grammar before legacy parsing', () => {
    expect(parseInstantCommand('tell codex to audit auth')).toMatchObject({
      kind: 'agent-message',
      payload: 'audit auth',
    });
    expect(parseInstantCommand('open 3 terminals with opencode')).toMatchObject({
      kind: 'legacy',
      intent: { kind: 'open_terminals', count: 3 },
    });
    expect(parseInstantCommand('create schedule release review friday at 1pm')).toMatchObject({
      kind: 'legacy',
      intent: { kind: 'create_event' },
    });
  });

  it.each([
    '',
    'codex is useful',
    'tell me about codex',
    'what can codex do?',
    'schedule algorithms explained',
    'message him: continue the audit',
    'message terminal 0: run npm test',
    'open 11 codex terminals',
    'open 11 terminals with opencode',
    'tell codex to ',
    `tell codex to ${'x'.repeat(32_769)}`,
    'tell codex to hello\u0000world',
    'tell codex to hello\u0007world',
  ])('fails closed for %s', (input) => {
    expect(parseInstantCommand(input)).toBeNull();
  });

  it('is synchronous and performs no model or network work', () => {
    const result = parseInstantCommand('Codex, inspect this');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ kind: 'agent-message', payload: 'inspect this' });
  });

  it.each([
    ['missing payload', 'tell codex to '],
    ['oversized payload', `tell codex to ${'x'.repeat(32_769)}`],
    ['control-bearing payload', 'tell codex to hello\u0000world'],
    ['invalid ordinal', 'message terminal 0: run npm test'],
    ['invalid provider count', 'open 11 codex terminals'],
    ['invalid terminal count', 'open 11 terminals'],
  ])('classifies rejected command-shaped input without legacy fallback: %s', (_case, input) => {
    expect(classifyInstantCommandInput(input)).toMatchObject({ status: 'rejected' });
  });

  it('distinguishes unmatched prose from a matched command', () => {
    expect(classifyInstantCommandInput('tell me about codex')).toEqual({ status: 'unmatched' });
    expect(classifyInstantCommandInput('Codex, inspect this')).toMatchObject({
      status: 'matched',
      command: { kind: 'agent-message' },
    });
  });

  it.each([
    ['open terminal page', 'page.open', { route: 'terminal' }],
    ['open voice settings', 'settings.section.open', { section: 'voice' }],
    ['go back', 'page.back', {}],
    ['open command palette', 'palette.open', {}],
    ['enter fullscreen', 'fullscreen.set', { enabled: true }],
    ['/connect', 'connections.open', { section: 'connections' }],
  ])('classifies catalog navigation locally: %s', (input, commandId, slots) => {
    expect(classifyInstantCommandInput(input)).toEqual({
      status: 'matched',
      command: {
        kind: 'catalog',
        id: commandId,
        family: 'navigation',
        authority: commandId === 'fullscreen.set' ? 'settings.allowlist' : 'ui.route',
        safety: commandId === 'fullscreen.set' ? 'reversible' : 'read',
        slots,
      },
    });
  });

  it('rejects a matched catalog command whose canonical authority is not implemented yet', () => {
    expect(classifyInstantCommandInput('rename terminal two to reviewer')).toEqual({
      status: 'rejected',
      reason: 'That Instant Command is not available yet.',
    });
  });

  it.each([
    ['connect terminals one and two as a team', 'team.connect'],
    ['list teams', 'team.list'],
    ['team status team alpha', 'team.status'],
    ['tell team alpha to run the release audit', 'team.message'],
    ['broadcast team alpha release is ready', 'team.broadcast'],
  ])('admits capability-gated Fabric commands to the deterministic boundary: %s', (input, id) => {
    expect(classifyInstantCommandInput(input)).toMatchObject({
      status: 'matched',
      command: {
        kind: 'catalog',
        id,
        family: 'team',
        authority: 'terminal-peer-fabric',
      },
    });
  });
});
