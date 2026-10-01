import { describe, expect, it } from 'vitest';
import { mergePersistedUiState, migratePersistedUiState, useUIStore } from './ui';

const persistedUiFixture = {
  navOpen: false,
  inspectorOpen: true,
  activeChatId: 'chat-sentinel',
  activeAgentId: 'agent-sentinel',
  navSectionsCollapsed: { workspace: true, nested: { sentinel: 'keep' } },
  chatMode: 'council',
  theme: 'light',
  density: 'compact',
  onboardingComplete: true,
  productTutorialStatus: 'completed',
  ambient: false,
  ambientThresholdMs: 123_456,
  ambientDrone: true,
  ambientTrack: 'music-4',
  ambientVolume: 17,
  ambientAlwaysPlay: true,
  clockFormat: 'military',
  composerStt: false,
  defaultTerminalFontSize: 15,
  notificationMaster: true,
  doneNotifications: {
    jarvis: true,
    terminal: true,
    tasks: false,
    contextMaps: true,
    skills: false,
    connectors: true,
    reminders: false,
  },
  aiCompletionCue: true,
  notificationSound: true,
  notificationBadge: false,
  lastSeenWhatsNewVersion: 'sentinel-version',
  futurePersistedKey: { deeply: { nested: ['preserve', 42] } },
} as const;

describe('UI store theme persistence', () => {
  it('migrates a v4 payload by changing only its theme', () => {
    const migrated = migratePersistedUiState(persistedUiFixture, 4);

    expect(migrated).toEqual({
      ...persistedUiFixture,
      theme: 'monochrome',
    });
    expect(persistedUiFixture.theme).toBe('light');
  });

  it('does not mutate a current-version payload in the version migration', () => {
    const migrated = migratePersistedUiState(persistedUiFixture, 5);

    expect(migrated).toEqual(persistedUiFixture);
    expect(migrated).not.toBe(persistedUiFixture);
  });

  it('migrates deferred Sakura to Default while preserving unrelated keys', () => {
    const currentState = useUIStore.getState();
    const persisted = {
      ...persistedUiFixture,
      theme: 'sakura',
      futurePersistedKey: { deeply: { nested: ['sakura-sentinel', 47] } },
    };

    const migrated = migratePersistedUiState(persisted, 5);
    const merged = mergePersistedUiState(migrated, currentState);

    expect(merged.theme).toBe('default');
    expect((merged as unknown as Record<string, unknown>).futurePersistedKey).toEqual(
      persisted.futurePersistedKey,
    );
    expect(merged.setTheme).toBe(currentState.setTheme);
  });

  it('persists valid Sakura effects and repairs malformed effect preferences', () => {
    const currentState = useUIStore.getState();
    const valid = mergePersistedUiState(
      {
        theme: 'sakura',
        sakuraPetalsEnabled: false,
        sakuraPetalSpeed: 'fast',
      },
      currentState,
    );
    const malformed = mergePersistedUiState(
      {
        theme: 'sakura',
        sakuraPetalsEnabled: 'yes',
        sakuraPetalSpeed: 'instant',
      },
      currentState,
    );

    expect(valid.sakuraPetalsEnabled).toBe(false);
    expect(valid.sakuraPetalSpeed).toBe('fast');
    expect(malformed.sakuraPetalsEnabled).toBe(true);
    expect(malformed.sakuraPetalSpeed).toBe('normal');
    expect(valid.setSakuraPetalsEnabled).toBe(currentState.setSakuraPetalsEnabled);
    expect(valid.setSakuraPetalSpeed).toBe(currentState.setSakuraPetalSpeed);
  });

  it('preserves canonical Warm during current-version hydration', () => {
    const currentState = useUIStore.getState();
    const merged = mergePersistedUiState({ ...persistedUiFixture, theme: 'warm' }, currentState);

    expect(merged.theme).toBe('warm');
    expect(merged.setTheme).toBe(currentState.setTheme);
  });

  it('migrates deferred VibeSpace to Default during current-version hydration', () => {
    const currentState = useUIStore.getState();
    const merged = mergePersistedUiState(
      { ...persistedUiFixture, theme: 'vibespace' },
      currentState,
    );

    expect(merged.theme).toBe('default');
    expect(merged.setTheme).toBe(currentState.setTheme);
  });

  it('migrates deferred Origami to Default during current-version hydration', () => {
    const currentState = useUIStore.getState();
    const merged = mergePersistedUiState({ ...persistedUiFixture, theme: 'origami' }, currentState);

    expect(merged.theme).toBe('default');
    expect(merged.setTheme).toBe(currentState.setTheme);
  });

  it('always validates current-version hydration while retaining state methods and keys', () => {
    const currentState = useUIStore.getState();
    const merged = mergePersistedUiState(
      { ...persistedUiFixture, setTheme: 'corrupted-method' },
      currentState,
    );

    expect(merged.theme).toBe('monochrome');
    expect((merged as unknown as Record<string, unknown>).futurePersistedKey).toEqual(
      persistedUiFixture.futurePersistedKey,
    );
    expect(merged.toggleNav).toBe(currentState.toggleNav);
    expect(merged.setTheme).toBe(currentState.setTheme);
    expect(merged.paletteOpen).toBe(currentState.paletteOpen);
  });

  it('normalizes malformed roots to the default without losing current methods', () => {
    const currentState = useUIStore.getState();

    for (const malformed of [null, undefined, 'broken', [], 42]) {
      const merged = mergePersistedUiState(malformed, currentState);
      expect(merged.theme).toBe('default');
      expect(merged.setTheme).toBe(currentState.setTheme);
      expect(merged.navOpen).toBe(currentState.navOpen);
    }
  });

  it('is idempotent for both migration and merge', () => {
    const migrated = migratePersistedUiState(persistedUiFixture, 4);
    expect(migratePersistedUiState(migrated, 4)).toEqual(migrated);

    const currentState = useUIStore.getState();
    const merged = mergePersistedUiState(persistedUiFixture, currentState);
    expect(mergePersistedUiState(merged, currentState)).toEqual(merged);
  });
});
