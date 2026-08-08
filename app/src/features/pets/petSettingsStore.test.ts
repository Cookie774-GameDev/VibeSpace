import { beforeEach, describe, expect, it } from 'vitest';
import { usePetSettingsStore } from './petSettingsStore';

describe('Pet settings store desktop controls', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('validates the panel mode and persists movement, animation, sound, and reaction controls', () => {
    const state = usePetSettingsStore.getState();

    expect(state.panelMode).toBe('always-on-top');
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
});
