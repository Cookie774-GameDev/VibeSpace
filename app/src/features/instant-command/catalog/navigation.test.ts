import { describe, expect, it } from 'vitest';
import { APP_ROUTES } from '@/features/navigation/routeSchema';
import {
  NAVIGATION_COMMAND_INPUTS,
  PAGE_TARGET_ALIASES,
  SETTINGS_SECTION_ALIASES,
} from './navigation';

describe('navigation command catalog', () => {
  it('generates a unique page target alias set for every route schema entry', () => {
    expect(Object.keys(PAGE_TARGET_ALIASES).sort()).toEqual([...APP_ROUTES].sort());
    const normalized = Object.values(PAGE_TARGET_ALIASES)
      .flat()
      .map((alias) => alias.trim().toLocaleLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it('preserves the established human aliases while generating every route', () => {
    expect(PAGE_TARGET_ALIASES.chat).toContain('open chat');
    expect(PAGE_TARGET_ALIASES.terminal).toContain('open terminals');
    expect(PAGE_TARGET_ALIASES.account).toContain('open account');
    expect(PAGE_TARGET_ALIASES['model-foundry']).toContain('open model foundry');
  });

  it('gives every targetless top-level route one exact slash alias within the fixed bound', () => {
    const pageOpen = NAVIGATION_COMMAND_INPUTS.find((command) => command.id === 'page.open')!;
    const topLevelRoutes = APP_ROUTES.filter(
      (route) => route !== 'agent-detail' && route !== 'project-detail' && route !== 'notes',
    );
    for (const route of topLevelRoutes) {
      const alias = `/${route}`;
      expect(PAGE_TARGET_ALIASES[route]).toContain(alias);
      expect(
        pageOpen.parseSlots?.(
          {
            definition: undefined as never,
            alias,
            sourceStart: 0,
            sourceEnd: alias.length,
            remainder: '',
          },
          alias,
        ),
      ).toEqual({ status: 'parsed', slots: { route } });
    }
    expect(pageOpen.aliases.length).toBeLessThanOrEqual(64);
    // /notes belongs to the Chat attachment flow, not page navigation.
    expect(PAGE_TARGET_ALIASES.notes).not.toContain('/notes');
    expect(PAGE_TARGET_ALIASES['agent-detail']).not.toContain('/agent-detail');
    expect(PAGE_TARGET_ALIASES['project-detail']).not.toContain('/project-detail');
  });

  it('maps bounded slash controls through existing navigation commands without collisions', () => {
    const expected = {
      'page.back': '/back',
      'page.forward': '/forward',
      'page.home': '/home',
      'settings.open': '/settings',
      'palette.open': '/palette',
      'launcher.open': '/launcher',
    } as const;
    for (const [id, alias] of Object.entries(expected)) {
      expect(NAVIGATION_COMMAND_INPUTS.find((command) => command.id === id)?.aliases).toContain(
        alias,
      );
    }
    const aliases = NAVIGATION_COMMAND_INPUTS.flatMap((command) => command.aliases).map((alias) =>
      alias.trim().toLocaleLowerCase(),
    );
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases.filter((alias) => alias === '/connect')).toEqual(['/connect']);
  });

  it('declares every canonical navigation command as locally available', () => {
    expect(NAVIGATION_COMMAND_INPUTS.map((command) => command.id)).toEqual([
      'page.open',
      'page.back',
      'page.forward',
      'page.home',
      'settings.open',
      'settings.close',
      'settings.section.open',
      'palette.open',
      'launcher.open',
      'fullscreen.set',
      'connections.open',
    ]);
    expect(NAVIGATION_COMMAND_INPUTS.every((command) => command.availability === 'available')).toBe(
      true,
    );
  });

  it('exposes /connect through the existing secure Connections surface', () => {
    const connect = NAVIGATION_COMMAND_INPUTS.find((command) => command.id === 'connections.open');
    expect(connect).toMatchObject({
      aliases: expect.arrayContaining(['/connect', 'connect provider', '/connect openai']),
      authority: 'ui.route',
      safety: 'read',
      availability: 'available',
    });
    expect(
      connect?.parseSlots?.(
        {
          definition: undefined as never,
          alias: '/connect',
          sourceStart: 0,
          sourceEnd: '/connect'.length,
          remainder: '',
        },
        '/connect',
      ),
    ).toEqual({
      status: 'parsed',
      slots: { section: 'connections' },
    });
    expect(
      connect?.parseSlots?.(
        {
          definition: undefined as never,
          alias: '/connect openai',
          sourceStart: 0,
          sourceEnd: '/connect openai'.length,
          remainder: '',
        },
        '/connect openai',
      ),
    ).toEqual({ status: 'parsed', slots: { section: 'providers', providerId: 'openai' } });
    expect(
      connect?.parseSlots?.(
        {
          definition: undefined as never,
          alias: '/connect codex',
          sourceStart: 0,
          sourceEnd: '/connect codex'.length,
          remainder: '',
        },
        '/connect codex',
      ),
    ).toEqual({
      status: 'parsed',
      slots: { section: 'connections', connectionId: 'openai-codex' },
    });
    for (const remainder of ['ollama', 'unknown', 'openai extra', 'sk-private']) {
      expect(
        connect?.parseSlots?.(
          {
            definition: undefined as never,
            alias: '/connect',
            sourceStart: 0,
            sourceEnd: '/connect'.length,
            remainder,
          },
          `/connect ${remainder}`,
        ),
      ).toEqual({ status: 'rejected', reason: 'Choose one supported provider in Settings.' });
    }
  });

  it('exposes only typed settings sections and parses fullscreen state locally', () => {
    expect(SETTINGS_SECTION_ALIASES.voice).toContain('open voice settings');
    expect(SETTINGS_SECTION_ALIASES.providers).toContain('open provider settings');

    const settings = NAVIGATION_COMMAND_INPUTS.find(
      (command) => command.id === 'settings.section.open',
    )!;
    const settingsAlias = settings.aliases.indexOf('open voice settings');
    expect(
      settings.parseSlots?.(
        {
          definition: undefined as never,
          alias: settings.aliases[settingsAlias]!,
          sourceStart: 0,
          sourceEnd: 'open voice settings'.length,
          remainder: '',
        },
        'open voice settings',
      ),
    ).toEqual({ status: 'parsed', slots: { section: 'voice' } });

    const fullscreen = NAVIGATION_COMMAND_INPUTS.find(
      (command) => command.id === 'fullscreen.set',
    )!;
    expect(
      fullscreen.parseSlots?.(
        {
          definition: undefined as never,
          alias: 'enter fullscreen',
          sourceStart: 0,
          sourceEnd: 'enter fullscreen'.length,
          remainder: '',
        },
        'enter fullscreen',
      ),
    ).toEqual({ status: 'parsed', slots: { enabled: true } });
  });
});
