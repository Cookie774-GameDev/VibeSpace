/**
 * Typed mini-panel window lifecycle.
 * Pure reducer — unit-tested without Tauri.
 */

export type PetPanelLifecycleState =
  | 'closed'
  | 'opening'
  | 'open'
  | 'minimizing'
  | 'minimized'
  | 'confirmingClose'
  | 'closing'
  | 'restoring'
  | 'disposed';

export type PetPanelLifecycleEvent =
  | { type: 'request_open' }
  | { type: 'opened' }
  | { type: 'request_minimize' }
  | { type: 'minimized' }
  | { type: 'request_restore' }
  | { type: 'restored' }
  | { type: 'request_close' }
  | { type: 'confirm_close' }
  | { type: 'cancel_close' }
  | { type: 'closed' }
  | { type: 'dispose' };

export const PET_PANEL_CLOSE_CONFIRM_MESSAGE =
  'Close the mini panel? Your chats and terminal sessions will keep running and can be reopened from the Pet or main VibeSpace application.';

export const PET_PANEL_CLOSE_CONFIRM_BUTTONS = {
  cancel: 'Cancel',
  confirm: 'Close Mini Panel',
} as const;

export const PET_PANEL_TERMINAL_LIMIT_MESSAGE =
  'The Pet panel supports up to 4 terminals. Return or close one before adding another.';

export const PET_PANEL_MAX_TERMINALS = 4;

export function createInitialPanelLifecycle(): PetPanelLifecycleState {
  return 'closed';
}

export function reducePanelLifecycle(
  state: PetPanelLifecycleState,
  event: PetPanelLifecycleEvent,
): PetPanelLifecycleState {
  if (state === 'disposed' && event.type !== 'request_open') {
    return state;
  }

  switch (event.type) {
    case 'request_open':
      if (state === 'open' || state === 'opening') return state;
      if (state === 'minimized' || state === 'minimizing') return 'restoring';
      if (state === 'disposed') return 'opening';
      return 'opening';

    case 'opened':
      if (state === 'opening' || state === 'restoring' || state === 'closed') return 'open';
      return state;

    case 'request_minimize':
      if (state === 'open') return 'minimizing';
      return state;

    case 'minimized':
      if (state === 'minimizing' || state === 'open') return 'minimized';
      return state;

    case 'request_restore':
      if (state === 'minimized') return 'restoring';
      return state;

    case 'restored':
      if (state === 'restoring' || state === 'minimized') return 'open';
      return state;

    case 'request_close':
      if (state === 'open' || state === 'minimized' || state === 'minimizing') {
        return 'confirmingClose';
      }
      return state;

    case 'cancel_close':
      if (state === 'confirmingClose') return 'open';
      return state;

    case 'confirm_close':
      if (state === 'confirmingClose') return 'closing';
      return state;

    case 'closed':
      if (
        state === 'closing' ||
        state === 'confirmingClose' ||
        state === 'open' ||
        state === 'minimized' ||
        state === 'opening'
      ) {
        return 'closed';
      }
      return state;

    case 'dispose':
      return 'disposed';

    default:
      return state;
  }
}

/** True when the panel should be visible on screen. */
export function panelIsVisible(state: PetPanelLifecycleState): boolean {
  return (
    state === 'open' || state === 'confirmingClose' || state === 'opening' || state === 'restoring'
  );
}

/** Sessions must never be killed by panel transitions. */
export function panelPreservesSessions(state: PetPanelLifecycleState): boolean {
  return state !== 'disposed';
}

/**
 * Authoritative rule: standalone pet-overlay visibility for both Axo and Glitch.
 * The pet remains visible while the mini panel is open. Only explicit pet
 * visibility preferences or application shutdown may remove it.
 */
export function shouldShowStandalonePet(input: {
  enabled: boolean;
  overlayVisible: boolean;
  /** Cross-window localStorage / React flag set while panel is open or opening. */
  panelOpenFlag: boolean;
  /** Tauri isPetPanelVisible() result. */
  panelVisible: boolean;
  /** Application is exiting — never respawn pet. */
  shuttingDown?: boolean;
  /** openPetPanelSafely confirmed failure after an optimistic hide. */
  panelOpenFailed?: boolean;
}): boolean {
  if (input.shuttingDown) return false;
  if (!input.enabled || !input.overlayVisible) return false;
  return true;
}
