/**
 * Browser-safe bridge to Tauri pet window commands.
 * No-ops gracefully when not running inside Tauri.
 *
 * Panel open path (Axo + Glitch share one function):
 *   openOrFocusPetMiniPanel → single-flight → show/focus pet-mini-panel →
 *   confirm visible → hide overlay. On failure: restore overlay, clear lock.
 */

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type PetPanelMode = 'follow-pet' | 'always-on-top' | 'normal';

/** Shared-origin signal consumed by the already-mounted pet-overlay WebView. */
export const PET_OVERLAY_SHOW_EPOCH_KEY = 'vibespace-pet-overlay-show-epoch';
export const PET_OVERLAY_SHOW_EVENT = 'vibespace:pet-overlay-show';
let overlayShowSignalSequence = 0;

function signalPetOverlayShown(): void {
  const epoch = `${Date.now()}:${++overlayShowSignalSequence}`;
  try {
    localStorage.setItem(PET_OVERLAY_SHOW_EPOCH_KEY, epoch);
  } catch {
    /* same-window event below remains available */
  }
  try {
    window.dispatchEvent(new CustomEvent(PET_OVERLAY_SHOW_EVENT, { detail: { epoch } }));
  } catch {
    /* ignore */
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke: inv } = await import('@tauri-apps/api/core');
    return (await inv<T>(cmd, args)) as T;
  } catch (err) {
    console.warn('[pets] invoke failed', cmd, err);
    return null;
  }
}

export async function showPetOverlay(): Promise<void> {
  await invoke('pet_show_overlay');
  signalPetOverlayShown();
}

export async function hidePetOverlay(): Promise<void> {
  await invoke('pet_hide_overlay');
}

export async function isPetOverlayVisible(): Promise<boolean> {
  const v = await invoke<boolean>('pet_is_overlay_visible');
  return v === true;
}

export async function setPetOverlayPosition(x: number, y: number): Promise<void> {
  await invoke('pet_set_overlay_position', { x, y });
}

export async function snapPetOverlayToEdge(): Promise<void> {
  await invoke('pet_snap_overlay_to_edge');
}

export async function reassertPetOverlayTopmost(): Promise<void> {
  await invoke('pet_reassert_overlay_topmost');
}

export async function getPetStartWithWindows(): Promise<boolean | null> {
  return invoke<boolean>('pet_get_start_with_windows');
}

export async function setPetStartWithWindows(enabled: boolean): Promise<boolean | null> {
  return invoke<boolean>('pet_set_start_with_windows', { enabled });
}

export async function openOrFocusPetPanel(
  nearX?: number,
  nearY?: number,
  panelMode: PetPanelMode = 'always-on-top',
): Promise<void> {
  await invoke('pet_open_or_focus_panel', {
    nearX: nearX ?? null,
    nearY: nearY ?? null,
    panelMode,
  });
}

/**
 * Open mini panel, then hide the pet overlay only if the panel is actually
 * visible. Used by both PetHost (main) and PetOverlayWindow (desktop path).
 * Prevents "sprite gone + no panel" when panel open fails.
 */
export const PET_PANEL_OPEN_FLAG_KEY = 'vibespace-pet-panel-open';

/** Cross-window / in-app request that the mini panel must open (fallback path). */
export const PET_OPEN_PANEL_EVENT = 'jarvis:pet:open-panel';

/** Ask the main-shell PetHost to open its in-app mini panel (same-window only). */
export function notifyPetPanelOpenRequested(nearX?: number, nearY?: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent(PET_OPEN_PANEL_EVENT, {
        detail: { nearX: nearX ?? null, nearY: nearY ?? null, source: 'pet' },
      }),
    );
  } catch {
    /* ignore */
  }
}

export function setPetPanelOpenFlag(open: boolean): void {
  try {
    if (open) localStorage.setItem(PET_PANEL_OPEN_FLAG_KEY, '1');
    else localStorage.removeItem(PET_PANEL_OPEN_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

export function readPetPanelOpenFlag(): boolean {
  try {
    return localStorage.getItem(PET_PANEL_OPEN_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export type OpenPetMiniPanelResult = {
  /** Tauri pet-mini-panel is visible and focused. */
  panelVisible: boolean;
  /** Caller should mount/show the in-app PetMiniPanel fallback. */
  useInlineFallback: boolean;
  /** True when a concurrent open was coalesced into the in-flight promise. */
  coalesced: boolean;
};

let openPanelInFlight: Promise<OpenPetMiniPanelResult> | null = null;

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll panel visibility a few times — WebView show can lag past a single 180ms wait.
 */
async function pollPanelVisible(attempts = 5, gapMs = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await isPetPanelVisible()) return true;
    if (i + 1 < attempts) await waitMs(gapMs);
  }
  return false;
}

/**
 * Confirm-then-hide open used by tests and internal callers.
 * Prefer {@link openOrFocusPetMiniPanel} for production (single-flight).
 */
export async function openPetPanelSafely(
  nearX?: number,
  nearY?: number,
  panelMode: PetPanelMode = 'always-on-top',
): Promise<{ panelVisible: boolean }> {
  const result = await openOrFocusPetMiniPanel(nearX, nearY, panelMode);
  return { panelVisible: result.panelVisible };
}

/**
 * Canonical open path for Axo and Glitch.
 *
 * - Single-flight: concurrent clicks share one open promise (no duplicate panels).
 * - If pet-mini-panel already exists (hidden/minimized), show/unminimize/focus.
 * - Hide standalone overlay only after panel is confirmed visible.
 * - On failure: clear flag, restore overlay, signal inline fallback.
 * - Also dispatches PET_OPEN_PANEL_EVENT so the main window can mount in-app UI.
 */
export async function openOrFocusPetMiniPanel(
  nearX?: number,
  nearY?: number,
  panelMode: PetPanelMode = 'always-on-top',
): Promise<OpenPetMiniPanelResult> {
  if (openPanelInFlight) {
    const result = await openPanelInFlight;
    return { ...result, coalesced: true };
  }

  openPanelInFlight = (async (): Promise<OpenPetMiniPanelResult> => {
    // Note: do NOT dispatch PET_OPEN_PANEL_EVENT here — PetHost listens for that
    // event and would re-enter openPanel → infinite single-flight churn.
    // Callers that need main-shell fallback should dispatch the event themselves
    // (see notifyPetPanelOpenRequested).

    if (!isTauriRuntime()) {
      // Browser / non-Tauri: in-app panel only.
      setPetPanelOpenFlag(true);
      return { panelVisible: false, useInlineFallback: true, coalesced: false };
    }

    // Optimistic flag so hosts hide the standalone sprite while opening.
    setPetPanelOpenFlag(true);

    await openOrFocusPetPanel(nearX, nearY, panelMode);
    // First settle + retries (minimized restore can be slower than 180ms).
    await waitMs(120);
    let panelVisible = await pollPanelVisible(6, 90);

    if (!panelVisible) {
      // Second attempt: re-invoke show/focus in case the window was racing.
      await openOrFocusPetPanel(nearX, nearY, panelMode);
      await waitMs(150);
      panelVisible = await pollPanelVisible(4, 100);
    }

    if (panelVisible) {
      setPetPanelOpenFlag(true);
      await hidePetOverlay().catch(() => undefined);
      return { panelVisible: true, useInlineFallback: false, coalesced: false };
    }

    // Panel did not confirm — restore sprite and force in-app fallback UI.
    // Keep flag true when useInlineFallback so main host can show PetMiniPanel;
    // callers that only use Tauri should clear via setPetPanelOpenFlag(false).
    setPetPanelOpenFlag(true);
    await showPetOverlay().catch(() => undefined);
    return { panelVisible: false, useInlineFallback: true, coalesced: false };
  })();

  try {
    return await openPanelInFlight;
  } finally {
    openPanelInFlight = null;
  }
}

/** Test-only: clear single-flight guard between cases. */
export function __resetPetPanelOpenFlightForTests(): void {
  openPanelInFlight = null;
}

export async function minimizePetPanel(): Promise<void> {
  await invoke('pet_minimize_panel');
}

export async function hidePetPanel(): Promise<void> {
  await invoke('pet_hide_panel');
}

export async function isPetPanelVisible(): Promise<boolean> {
  const v = await invoke<boolean>('pet_is_panel_visible');
  return v === true;
}

export async function savePetPanelGeometry(
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  await invoke('pet_save_panel_geometry', { x, y, w, h });
}

/** Single-instance guard for React: only one host should drive pet overlay. */
let petHostInstanceCount = 0;

export function claimPetHostInstance(): boolean {
  if (petHostInstanceCount > 0) return false;
  petHostInstanceCount = 1;
  return true;
}

export function releasePetHostInstance(): void {
  petHostInstanceCount = Math.max(0, petHostInstanceCount - 1);
}

export function getPetHostInstanceCount(): number {
  return petHostInstanceCount;
}
