import { describe, expect, it } from 'vitest';
import {
  canEnterSleep,
  canScheduleIdleFun,
  clickOpensPanelAndWakes,
  createInitialPetState,
  reducePetEvent,
  type PetMachineState,
} from './petStateMachine';

describe('petStateMachine', () => {
  it('starts with welcome once then goes to idlePrimary', () => {
    let s = createInitialPetState();
    expect(s.anim).toBe('welcome');
    s = reducePetEvent(s, { type: 'welcome_done' });
    expect(s.anim).toBe('idlePrimary');
    expect(s.welcomePlayed).toBe(true);
  });

  it('boot after welcomePlayed stays on idlePrimary (no welcome spam)', () => {
    let s = createInitialPetState();
    s = reducePetEvent(s, { type: 'boot' });
    expect(s.anim).toBe('welcome');
    s = reducePetEvent(s, { type: 'welcome_done' });
    s = reducePetEvent(s, { type: 'boot' });
    expect(s.anim).toBe('idlePrimary');
    expect(s.welcomePlayed).toBe(true);
  });

  it('maps velocity-resolved walk anims and stops on drag_end', () => {
    let s = reducePetEvent(createInitialPetState(), { type: 'welcome_done' });
    s = reducePetEvent(s, { type: 'drag_start', walk: 'walkLeft' });
    expect(s.anim).toBe('walkLeft');
    expect(s.dragging).toBe(true);
    s = reducePetEvent(s, { type: 'drag_move', walk: 'walkRight' });
    expect(s.anim).toBe('walkRight');
    s = reducePetEvent(s, { type: 'drag_move', walk: 'idlePrimary' });
    expect(s.anim).toBe('idlePrimary');
    s = reducePetEvent(s, { type: 'drag_end' });
    expect(s.dragging).toBe(false);
    expect(s.anim).toBe('idlePrimary');
  });

  it('plays idleFun only from idlePrimary', () => {
    let s = reducePetEvent(createInitialPetState(), { type: 'welcome_done' });
    expect(canScheduleIdleFun(s)).toBe(true);
    s = reducePetEvent(s, { type: 'idle_fun_tick' });
    expect(s.anim).toBe('idleFun');
    s = reducePetEvent(s, { type: 'idle_fun_done' });
    expect(s.anim).toBe('idlePrimary');
  });

  it('continues idle animations while the panel is open', () => {
    let s: PetMachineState = {
      ...createInitialPetState(),
      panelOpen: true,
      welcomePlayed: true,
      anim: 'idlePrimary',
    };
    expect(canScheduleIdleFun(s)).toBe(true);
    s = reducePetEvent(s, { type: 'idle_fun_tick' });
    expect(s.anim).toBe('idleFun');
  });

  it('sleep transition enters sleepingLoop until click wakes + opens panel', () => {
    let s = reducePetEvent(createInitialPetState(), { type: 'welcome_done' });
    expect(canEnterSleep(s)).toBe(true);
    s = reducePetEvent(s, { type: 'sleep_timeout' });
    s = reducePetEvent(s, { type: 'sleep_transition_done' });
    expect(s.anim).toBe('sleepingLoop');
    expect(s.sleeping).toBe(true);
    expect(clickOpensPanelAndWakes(s)).toBe(true);
    s = reducePetEvent(s, { type: 'click' });
    expect(s.panelOpen).toBe(true);
    expect(s.anim).toBe('wakeFromSleep');
    expect(s.sleeping).toBe(false);
  });

  it('drag while sleeping wakes into walk direction', () => {
    let s = reducePetEvent(createInitialPetState(), { type: 'welcome_done' });
    s = reducePetEvent(s, { type: 'sleep_timeout' });
    s = reducePetEvent(s, { type: 'sleep_transition_done' });
    s = reducePetEvent(s, { type: 'drag_start', walk: 'walkLeft' });
    expect(s.sleeping).toBe(false);
    expect(s.anim).toBe('walkLeft');
  });

  it('replays welcome when the mini panel closes and the pet reappears', () => {
    let s = reducePetEvent(createInitialPetState(), { type: 'welcome_done' });
    s = reducePetEvent(s, { type: 'click' });
    expect(s.panelOpen).toBe(true);

    s = reducePetEvent(s, { type: 'panel_close' });

    expect(s.panelOpen).toBe(false);
    expect(s.anim).toBe('welcome');
    expect(s.welcomePlayed).toBe(false);
  });
});
