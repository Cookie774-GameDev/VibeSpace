/**
 * Legacy terminal-view preference migration for the Pet mini-panel.
 * Grid was retired because mounting several WebGL/xterm surfaces inside the
 * tiny companion window was both visually dense and unnecessarily expensive.
 */

export type PetTerminalViewMode = 'tabs';

export const PET_TERMINAL_VIEW_MODE_KEY = 'vibespace-pet-terminal-view-mode';

export function loadPetTerminalViewMode(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): PetTerminalViewMode {
  // Read once so blocked storage remains harmless, but intentionally migrate
  // every old "grid" value to the only supported lightweight presentation.
  try {
    storage?.getItem(PET_TERMINAL_VIEW_MODE_KEY);
  } catch {
    /* ignore */
  }
  return 'tabs';
}

export function savePetTerminalViewMode(
  mode: PetTerminalViewMode,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): void {
  try {
    storage?.setItem(PET_TERMINAL_VIEW_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a terminal tile should accept keyboard input.
 * Only the focused terminal receives input; others stay live for output.
 */
export function terminalTileReceivesInput(
  terminalId: string,
  focusedTerminalId: string | null,
): boolean {
  return focusedTerminalId != null && terminalId === focusedTerminalId;
}
