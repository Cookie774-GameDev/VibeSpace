/**
 * Presentation preference only; switching layouts never recreates a PTY.
 */

export type PetTerminalViewMode = 'tabs' | 'grid';

export const PET_TERMINAL_VIEW_MODE_KEY = 'vibespace-pet-terminal-view-mode';

export function loadPetTerminalViewMode(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): PetTerminalViewMode {
  try {
    if (storage?.getItem(PET_TERMINAL_VIEW_MODE_KEY) === 'grid') return 'grid';
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
