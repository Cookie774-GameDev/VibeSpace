import { describe, expect, it } from 'vitest';
import { INSTANT_COMMAND_CATALOG, INSTANT_COMMAND_INDEX } from './catalog';
import { NAVIGATION_COMMAND_INPUTS, PAGE_TARGET_ALIASES } from './catalog/navigation';
import { TERMINAL_AGENT_COMMAND_INPUTS } from './catalog/terminals';

describe('INSTANT_COMMAND_CATALOG', () => {
  it('preserves every page phrase within the fixed alias budget and rejects extra arguments', () => {
    const page = INSTANT_COMMAND_CATALOG.find((entry) => entry.id === 'page.open')!;
    expect(page.aliases.length).toBeLessThanOrEqual(64);
    for (const [route, aliases] of Object.entries(PAGE_TARGET_ALIASES)) {
      for (const phrase of aliases) {
        const match = INSTANT_COMMAND_INDEX.matchWithOffsets(phrase)[0]!;
        expect(match.definition.id, phrase).toBe('page.open');
        expect(match.definition.parseSlots(match, phrase), phrase).toEqual({
          status: 'parsed', slots: { route },
        });
      }
    }
    for (const phrase of ['open files page garbage', '/files page', 'open notes delete all']) {
      const match = INSTANT_COMMAND_INDEX.matchWithOffsets(phrase)[0]!;
      expect(match.definition.parseSlots(match, phrase).status).toBe('rejected');
    }
    expect(INSTANT_COMMAND_INDEX.match('/notes')).toEqual([]);
  });
  it('covers every canonical route with a locally indexed navigation command', () => {
    const terminal = INSTANT_COMMAND_INDEX.matchWithOffsets('open terminal page')[0];
    expect(terminal?.definition.id).toBe('page.open');
    expect(terminal?.definition.parseSlots(terminal, 'open terminal page')).toEqual({
      status: 'parsed',
      slots: { route: 'terminal' },
    });
    expect(INSTANT_COMMAND_INDEX.match('open Jarvis settings')[0]?.id).toBe('settings.open');
  });

  it('contains the approved deterministic families and Calyx commands', () => {
    const families = new Set(INSTANT_COMMAND_CATALOG.map((entry) => entry.family));
    expect(families).toEqual(
      new Set([
        'navigation',
        'terminal',
        'agent',
        'project',
        'chat',
        'schedule',
        'settings',
        'media',
        'tools',
        'files',
        'tasks',
        'workbench',
        'team',
      ]),
    );

    const teamIds = INSTANT_COMMAND_CATALOG.filter((entry) => entry.family === 'team').map(
      (entry) => entry.id,
    );
    expect(teamIds).toEqual([
      'team.connect',
      'team.list',
      'team.message',
      'team.broadcast',
      'team.status',
    ]);
    expect(INSTANT_COMMAND_INDEX.match('connect terminals one and two as a team')[0]?.id).toBe(
      'team.connect',
    );
    expect(INSTANT_COMMAND_INDEX.match('tell team alpha to run the release audit')[0]?.id).toBe(
      'team.message',
    );
    expect(INSTANT_COMMAND_INDEX.match('pause team')).toEqual([]);
  });

  it('marks unproven or destructive commands unavailable or confirmation-gated', () => {
    const byId = new Map(INSTANT_COMMAND_CATALOG.map((entry) => [entry.id, entry]));
    expect(byId.get('team.connect')).toMatchObject({
      availability: 'capability-gated',
      authority: 'terminal-peer-fabric',
    });
    expect(byId.get('schedule.delete')?.safety).toBe('confirm');
    expect(byId.get('chat.delete')?.safety).toBe('confirm');
    expect(byId.get('tool.run')?.safety).toBe('approval');
    expect(byId.get('file.delete')).toBeUndefined();
  });

  it('declares a slot grammar and parses original-text remainder for every command', () => {
    for (const command of INSTANT_COMMAND_CATALOG) {
      expect(command.slotGrammar).toBeTruthy();
      expect(command.parseSlots).toBeTypeOf('function');
    }

    const source = 'message terminal two: Run NPM --Flag!';
    const match = INSTANT_COMMAND_INDEX.matchWithOffsets(source).find(
      (candidate) => candidate.definition.id === 'terminal.message',
    );
    expect(match).toBeDefined();
    expect(match!.definition.parseSlots(match!, source)).toEqual({
      status: 'parsed',
      slots: { remainder: 'two: Run NPM --Flag!' },
    });
  });

  it('maps every remaining family and team command to one canonical namespaced slash alias', () => {
    const previouslySpecializedIds = new Set([
      ...NAVIGATION_COMMAND_INPUTS.map((entry) => entry.id),
      ...TERMINAL_AGENT_COMMAND_INPUTS.map((entry) => entry.id),
    ]);
    const remaining = INSTANT_COMMAND_CATALOG.filter(
      (entry) => !previouslySpecializedIds.has(entry.id),
    );

    expect(remaining.length).toBeGreaterThan(0);
    for (const entry of remaining) {
      const slashAlias = `/${entry.id.replace(/[._]+/gu, '-')}`;
      expect(entry.aliases).toContain(slashAlias);
      expect(entry.aliases[0]).not.toMatch(/^\//u);
      expect(entry.aliases.filter((alias) => alias === slashAlias)).toHaveLength(1);
    }
  });

  it('keeps all normalized aliases unique and bounded while reserving /connect for Providers', () => {
    const normalizedAliases = INSTANT_COMMAND_CATALOG.flatMap((entry) => entry.aliases).map(
      (alias) => alias.trim().toLocaleLowerCase(),
    );
    expect(new Set(normalizedAliases).size).toBe(normalizedAliases.length);
    expect(normalizedAliases.filter((alias) => alias === '/connect')).toHaveLength(1);
    expect(INSTANT_COMMAND_INDEX.match('/connect')[0]).toMatchObject({
      id: 'connections.open',
    });
    expect(INSTANT_COMMAND_INDEX.match('/plugin-connect')[0]?.id).toBe('plugin.connect');
    expect(INSTANT_COMMAND_INDEX.match('/team-connect')[0]?.id).toBe('team.connect');
    for (const entry of INSTANT_COMMAND_CATALOG)
      expect(entry.aliases.length).toBeLessThanOrEqual(64);
  });

  it('preserves authority, safety, availability, and original-text slots through slash aliases', () => {
    expect(INSTANT_COMMAND_INDEX.match('/schedule-delete release')[0]).toMatchObject({
      id: 'schedule.delete',
      authority: 'schedule.repository',
      safety: 'confirm',
      availability: 'blocked',
    });
    expect(INSTANT_COMMAND_INDEX.match('/tool-run formatter')[0]).toMatchObject({
      id: 'tool.run',
      authority: 'tool.gateway',
      safety: 'approval',
      availability: 'blocked',
    });
    expect(INSTANT_COMMAND_INDEX.match('/team-status alpha')[0]).toMatchObject({
      id: 'team.status',
      authority: 'terminal-peer-fabric',
      safety: 'read',
      availability: 'capability-gated',
    });

    const source = '/plugin-connect OpenCode Provider';
    const match = INSTANT_COMMAND_INDEX.matchWithOffsets(source)[0];
    expect(match?.definition.id).toBe('plugin.connect');
    expect(match?.definition.parseSlots(match, source)).toEqual({
      status: 'parsed',
      slots: { remainder: 'OpenCode Provider' },
    });
  });

  it('makes the complete media family available with exact typed slots', () => {
    const media = INSTANT_COMMAND_CATALOG.filter((entry) => entry.family === 'media');
    expect(media.map((entry) => entry.id)).toEqual([
      'music.play',
      'music.pause',
      'music.resume',
      'music.stop',
      'music.next',
      'music.previous',
      'music.track',
      'music.volume',
      'music.mute',
      'music.unmute',
      'ambient.set',
    ]);
    expect(media.every((entry) => entry.availability === 'available')).toBe(true);
    expect(
      INSTANT_COMMAND_INDEX.matchWithOffsets('/music-volume 42.5')[0]?.definition.parseSlots(
        INSTANT_COMMAND_INDEX.matchWithOffsets('/music-volume 42.5')[0]!,
        '/music-volume 42.5',
      ),
    ).toEqual({ status: 'parsed', slots: { value: 42.5 } });
    for (const [source, expected] of [
      ['/music-track Northern Lights', { text: 'Northern Lights' }],
      ['/ambient-set Rain', { text: 'Rain' }],
    ] as const) {
      const match = INSTANT_COMMAND_INDEX.matchWithOffsets(source)[0]!;
      expect(match.definition.parseSlots(match, source)).toEqual({
        status: 'parsed',
        slots: expected,
      });
    }
    const invalid = INSTANT_COMMAND_INDEX.matchWithOffsets('/music-play private')[0]!;
    expect(invalid.definition.parseSlots(invalid, '/music-play private')).toMatchObject({
      status: 'rejected',
    });
  });
});
