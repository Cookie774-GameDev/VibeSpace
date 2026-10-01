import { beforeEach, describe, expect, it } from 'vitest';
import { usePetSettingsStore } from './petSettingsStore';

describe('Pet settings store desktop controls', () => {
  beforeEach(() => {
    localStorage.clear();
    usePetSettingsStore.setState({ panelMode: 'normal' });
  });

  it('validates the panel mode and persists movement, animation, sound, and reaction controls', () => {
    const state = usePetSettingsStore.getState();

    expect(state.panelMode).toBe('normal');
    expect(state.positionLocked).toBe(false);
    expect(state.edgeSnapping).toBe(true);
    expect(state.animationLevel).toBe('calm');
    expect(state.soundEnabled).toBe(true);
    expect(state.notificationReactions).toBe(true);
    expect(state.pointerTracking).toBe(true);

    state.setPanelMode('always-on-top');
    state.setPositionLocked(true);
    state.setEdgeSnapping(false);
    state.setAnimationLevel('playful');
    state.setSoundEnabled(false);
    state.setNotificationReactions(false);
    state.setPointerTracking(false);

    expect(usePetSettingsStore.getState()).toMatchObject({
      panelMode: 'always-on-top',
      positionLocked: true,
      edgeSnapping: false,
      animationLevel: 'playful',
      soundEnabled: false,
      notificationReactions: false,
      pointerTracking: false,
    });
  });

  it('rehydrates an explicit topmost choice while invalid persisted modes use normal', async () => {
    localStorage.setItem(
      'vibespace-pet-settings',
      JSON.stringify({ state: { panelMode: 'always-on-top' }, version: 0 }),
    );
    await usePetSettingsStore.persist.rehydrate();
    expect(usePetSettingsStore.getState().panelMode).toBe('always-on-top');

    localStorage.setItem(
      'vibespace-pet-settings',
      JSON.stringify({ state: { panelMode: 'unexpected' }, version: 0 }),
    );
    await usePetSettingsStore.persist.rehydrate();
    expect(usePetSettingsStore.getState().panelMode).toBe('normal');
  });
});
