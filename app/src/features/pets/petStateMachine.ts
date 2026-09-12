/**
 * Pure Pet animation state machine.
 * Priority / interrupt rules for video-driven animations.
 * Drag direction is supplied as a resolved walk anim (from petDragVelocity).
 */

export type PetAnimId =
  | 'idlePrimary'
  | 'idleFun'
  | 'walkLeft'
  | 'walkRight'
  | 'welcome'
  | 'sleepTransition'
  | 'sleepingLoop'
  | 'wakeFromSleep';

export type PetDomainEvent =
  | { type: 'boot' }
  | { type: 'welcome_done' }
  /** Begin drag; optional initial walk from velocity sample. */
  | { type: 'drag_start'; walk?: 'walkLeft' | 'walkRight' | 'idlePrimary' }
  /** Update walk direction from velocity controller (not raw dx). */
  | { type: 'drag_move'; walk: 'walkLeft' | 'walkRight' | 'idlePrimary' }
  | { type: 'drag_end' }
  | { type: 'idle_fun_tick' }
  | { type: 'idle_fun_done' }
  | { type: 'sleep_timeout' }
  | { type: 'sleep_transition_done' }
  | { type: 'click' }
  | { type: 'wake_done' }
  | { type: 'panel_open' }
  | { type: 'panel_close' }
  | { type: 'shutdown' };

export interface PetMachineState {
  anim: PetAnimId;
  welcomePlayed: boolean;
  dragging: boolean;
  panelOpen: boolean;
  sleeping: boolean;
  lastWalk: 'walkLeft' | 'walkRight' | 'idlePrimary';
  shutdown: boolean;
}

export const PET_ANIM_PRIORITY: Record<PetAnimId, number> = {
  welcome: 90,
  walkLeft: 80,
  walkRight: 80,
  wakeFromSleep: 75,
  sleepTransition: 70,
  sleepingLoop: 65,
  idleFun: 40,
  idlePrimary: 10,
};

export function createInitialPetState(): PetMachineState {
  return {
    anim: 'welcome',
    welcomePlayed: false,
    dragging: false,
    panelOpen: false,
    sleeping: false,
    lastWalk: 'idlePrimary',
    shutdown: false,
  };
}

export function reducePetEvent(state: PetMachineState, event: PetDomainEvent): PetMachineState {
  if (state.shutdown && event.type !== 'boot') return state;

  switch (event.type) {
    case 'boot':
      return {
        ...createInitialPetState(),
        anim: state.welcomePlayed ? 'idlePrimary' : 'welcome',
        welcomePlayed: state.welcomePlayed,
      };

    case 'welcome_done':
      if (state.anim !== 'welcome') return state;
      return { ...state, anim: 'idlePrimary', welcomePlayed: true };

    case 'drag_start': {
      const walk = event.walk ?? 'idlePrimary';
      return {
        ...state,
        dragging: true,
        sleeping: false,
        lastWalk: walk,
        anim: walk === 'idlePrimary' ? 'idlePrimary' : walk,
      };
    }

    case 'drag_move': {
      if (!state.dragging) return state;
      return {
        ...state,
        lastWalk: event.walk,
        anim: event.walk === 'idlePrimary' ? 'idlePrimary' : event.walk,
        sleeping: false,
      };
    }

    case 'drag_end':
      return {
        ...state,
        dragging: false,
        lastWalk: 'idlePrimary',
        anim: 'idlePrimary',
      };

    case 'idle_fun_tick': {
      if (state.dragging || state.sleeping || state.shutdown) return state;
      if (state.anim !== 'idlePrimary') return state;
      return { ...state, anim: 'idleFun' };
    }

    case 'idle_fun_done':
      if (state.anim !== 'idleFun') return state;
      return { ...state, anim: 'idlePrimary' };

    case 'sleep_timeout': {
      if (state.dragging || state.panelOpen || state.sleeping || state.shutdown) return state;
      if (state.anim === 'welcome' || state.anim === 'walkLeft' || state.anim === 'walkRight') {
        return state;
      }
      return { ...state, anim: 'sleepTransition' };
    }

    case 'sleep_transition_done':
      if (state.anim !== 'sleepTransition') return state;
      return { ...state, anim: 'sleepingLoop', sleeping: true };

    case 'click': {
      if (state.sleeping || state.anim === 'sleepingLoop' || state.anim === 'sleepTransition') {
        return {
          ...state,
          sleeping: false,
          panelOpen: true,
          anim: 'wakeFromSleep',
        };
      }
      return { ...state, panelOpen: true, anim: 'idlePrimary' };
    }

    case 'wake_done':
      if (state.anim !== 'wakeFromSleep') return state;
      return { ...state, anim: 'idlePrimary', sleeping: false };

    case 'panel_open':
      return { ...state, panelOpen: true, sleeping: false };

    case 'panel_close':
      return {
        ...state,
        panelOpen: false,
        anim: 'welcome',
        welcomePlayed: false,
        dragging: false,
        sleeping: false,
        lastWalk: 'idlePrimary',
      };

    case 'shutdown':
      return { ...state, shutdown: true, anim: 'idlePrimary', dragging: false };

    default:
      return state;
  }
}

export function canScheduleIdleFun(state: PetMachineState): boolean {
  return (
    !state.shutdown &&
    !state.dragging &&
    !state.sleeping &&
    state.anim === 'idlePrimary' &&
    state.welcomePlayed
  );
}

export function canEnterSleep(state: PetMachineState): boolean {
  return (
    !state.shutdown &&
    !state.dragging &&
    !state.panelOpen &&
    !state.sleeping &&
    state.welcomePlayed &&
    (state.anim === 'idlePrimary' || state.anim === 'idleFun')
  );
}

/** Click while sleeping must open panel + wake in one transition. */
export function clickOpensPanelAndWakes(state: PetMachineState): boolean {
  const next = reducePetEvent(state, { type: 'click' });
  return next.panelOpen === true && (next.anim === 'wakeFromSleep' || next.anim === 'idlePrimary');
}
