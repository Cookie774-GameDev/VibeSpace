import { describe, expect, it } from 'vitest';
import { adaptLocalCommand } from './vibespaceAdapter';
import type { LocalDetectedCommand } from './types';

function detected(id: string, slots: Readonly<Record<string, unknown>>): LocalDetectedCommand {
  return Object.freeze({
    id,
    confidence: 0.99,
    source: id,
    sourceStart: 0,
    sourceEnd: id.length,
    slots,
    path: 'local-frame',
  });
}

describe('VibeSpace local-command adapter', () => {
  it('preserves the canonical authority for a status command with empty slots', () => {
    expect(adaptLocalCommand(detected('status.show', {}))).toEqual({
      status: 'mapped',
      command: {
        kind: 'catalog',
        id: 'status.show',
        family: 'navigation',
        authority: 'router.status',
        safety: 'read',
        slots: {},
      },
    });
  });

  it.each([
    ['unexpected argument', { format: 'json' }],
    ['unexpected target', { route: 'settings' }],
    ['array', []],
    ['null', null],
    ['missing slots', undefined],
    ['number', 7],
    ['string', 'status'],
  ])('rejects status %s instead of erasing malformed slots', (_label, slots) => {
    expect(
      adaptLocalCommand(
        detected('status.show', slots as unknown as Readonly<Record<string, unknown>>),
      ),
    ).toEqual({ status: 'unsupported', reason: 'invalid_slots' });
  });

  it('passes validated terminal counts through to open-agent-cli', () => {
    expect(adaptLocalCommand(detected('terminal.open', { provider: 'claude', count: 2 }))).toEqual({
      status: 'mapped',
      command: { kind: 'open-agent-cli', provider: 'claude', count: 2 },
    });
  });

  it('defaults terminal count to one and rejects invalid counts/providers', () => {
    expect(adaptLocalCommand(detected('terminal.open', { provider: 'codex' }))).toEqual({
      status: 'mapped',
      command: { kind: 'open-agent-cli', provider: 'codex', count: 1 },
    });
    expect(adaptLocalCommand(detected('terminal.open', { provider: 'claude', count: 11 }))).toEqual(
      { status: 'unsupported', reason: 'invalid_slots' },
    );
    expect(adaptLocalCommand(detected('terminal.open', { provider: 'cursor', count: 2 }))).toEqual({
      status: 'unsupported',
      reason: 'invalid_slots',
    });
  });

  it('maps explicit ordinal/provider payload commands only with valid targets', () => {
    expect(
      adaptLocalCommand(
        detected('terminal.message', {
          target: { ordinal: 2, scope: 'one' },
          payload: 'run npm test',
        }),
      ),
    ).toEqual({
      status: 'mapped',
      command: {
        kind: 'terminal-message',
        target: { ordinal: 2, scope: 'one' },
        payload: 'run npm test',
      },
    });

    expect(
      adaptLocalCommand(
        detected('terminal.broadcast', {
          target: { provider: 'claude', scope: 'all' },
          payload: 'inspect the project',
        }),
      ),
    ).toEqual({
      status: 'mapped',
      command: {
        kind: 'terminal-broadcast',
        target: { provider: 'claude', scope: 'all' },
        payload: 'inspect the project',
      },
    });

    expect(
      adaptLocalCommand(
        detected('agent.message', {
          target: { provider: 'codex', scope: 'one' },
          payload: 'inspect the project',
        }),
      ),
    ).toEqual({
      status: 'mapped',
      command: {
        kind: 'agent-message',
        target: { provider: 'codex', scope: 'one' },
        payload: 'inspect the project',
      },
    });
  });

  it('reuses canonical page and media authority metadata', () => {
    expect(adaptLocalCommand(detected('page.open', { route: 'settings' }))).toEqual({
      status: 'mapped',
      command: {
        kind: 'catalog',
        id: 'settings.open',
        family: 'navigation',
        authority: 'ui.route',
        safety: 'read',
        slots: {},
      },
    });

    expect(adaptLocalCommand(detected('music.resume', {}))).toEqual({
      status: 'mapped',
      command: {
        kind: 'catalog',
        id: 'music.resume',
        family: 'media',
        authority: 'media.player',
        safety: 'reversible',
        slots: {},
      },
    });

    expect(adaptLocalCommand(detected('music.track', { text: 'synthwave' }))).toEqual({
      status: 'mapped',
      command: {
        kind: 'catalog',
        id: 'music.track',
        family: 'media',
        authority: 'media.player',
        safety: 'reversible',
        slots: { text: 'synthwave' },
      },
    });
  });

  it('fails closed for invalid targeted payloads and unsupported expanded IDs', () => {
    expect(
      adaptLocalCommand(
        detected('terminal.message', {
          target: { ordinal: 0, scope: 'one' },
          payload: 'run tests',
        }),
      ),
    ).toEqual({ status: 'unsupported', reason: 'invalid_slots' });

    expect(
      adaptLocalCommand(
        detected('terminal.broadcast', {
          target: { provider: 'cursor', scope: 'all' },
          payload: 'run tests',
        }),
      ),
    ).toEqual({ status: 'unsupported', reason: 'invalid_slots' });

    expect(adaptLocalCommand(detected('task.create', { task: 'review release' }))).toEqual({
      status: 'unsupported',
      reason: 'unsupported_authority',
    });
  });
});

it('maps generic terminal counts through the existing bounded shell authority', () => {
  expect(adaptLocalCommand(detected('terminal.open', { provider: 'shell', count: 2 }))).toEqual({
    status: 'mapped',
    command: { kind: 'legacy', intent: { kind: 'open_terminals', count: 2 } },
  });
});

it.each([
  ['terminal.message', { scope: 'one' }],
  ['terminal.message', { scope: 'all' }],
  ['terminal.broadcast', { ordinal: 1, scope: 'all' }],
  ['terminal.broadcast', { provider: 'claude', scope: 'one' }],
  ['agent.message', { provider: 'codex', scope: 'all' }],
  ['terminal.message', { ordinal: 1, scope: 'one', sessionId: 'unexpected-target' }],
] as const)('rejects incomplete or contradictory target for %s', (id, target) => {
  expect(adaptLocalCommand(detected(id, { target, payload: 'inspect the task' }))).toEqual({
    status: 'unsupported',
    reason: 'invalid_slots',
  });
});
