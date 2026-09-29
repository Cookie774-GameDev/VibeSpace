/**
 * Browser-safe bridge to Tauri pet window commands.
 * No-ops gracefully when not running inside Tauri.
 *
 * Panel open path (Axo + Glitch share one function):
 *   openOrFocusPetMiniPanel → single-flight → show/focus pet-mini-panel →
 *   confirm visible while the standalone pet remains visible.
 */

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type PetPanelMode = 'follow-pet' | 'always-on-top' | 'normal';

export type PetOverlayShowReason =
  | 'geometry_unavailable'
  | 'main_thread_unavailable'
  | 'native_callback_lost'
  | 'native_command_failed'
  | 'native_result_invalid'
  | 'native_task_failed'
  | 'native_unavailable'
  | 'not_visible'
  | 'position_failed'
  | 'show_failed'
  | 'size_failed'
  | 'stale_window_retire_failed'
  | 'topmost_failed'
  | 'visibility_check_failed'
  | 'visibility_timeout'
  | 'window_create_failed'
  | 'window_label_conflict'
  | 'window_missing';

/**
 * A native acknowledgement of the detached Pet overlay lifecycle. `rendererReady`
 * is intentionally nullable: window APIs cannot truthfully prove a Pixi paint.
 */
export type PetOverlayShowResult = {
  mode: 'app-only' | 'native-overlay';
  created: boolean;
  visible: boolean;
  topmostApplied: boolean;
  rendererReady: boolean | null;
  reason: PetOverlayShowReason | null;
};

export type PetPanelOpenReason =
  | 'focus_check_failed'
  | 'focus_failed'
  | 'geometry_unavailable'
  | 'native_command_failed'
  | 'native_result_invalid'
  | 'native_unavailable'
  | 'not_focused'
  | 'not_visible'
  | 'panel_state_unavailable'
  | 'position_failed'
  | 'restore_failed'
  | 'show_failed'
  | 'size_failed'
  | 'topmost_failed'
  | 'visibility_check_failed'
  | 'visibility_timeout'
  | 'window_create_failed';

/** Native acknowledgement that the single Pet Panel is visible and focused. */
export type PetPanelOpenResult = {
  mode: 'native-panel';
  created: boolean;
  visible: boolean;
  focused: boolean;
  topmostApplied: boolean;
  rendererReady: boolean | null;
  reason: PetPanelOpenReason | null;
};

/** Shared-origin signal consumed by the already-mounted pet-overlay WebView. */
export const PET_OVERLAY_SHOW_EPOCH_KEY = 'vibespace-pet-overlay-show-epoch';
export const PET_OVERLAY_SHOW_EVENT = 'vibespace:pet-overlay-show';
let overlayShowSignalSequence = 0;
const NATIVE_PET_INVOKE_TIMEOUT_MS = 1_500;
type NativeInvokeOutcome<T> =
  { status: 'ok'; value: T } | { status: 'failed' } | { status: 'timeout' };
const nativeInvokes = new Map<string, Promise<NativeInvokeOutcome<unknown>>>();

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

async function invokeWithStatus<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<NativeInvokeOutcome<T>> {
  if (!isTauriRuntime()) return { status: 'failed' };
  const key = `${cmd}:${JSON.stringify(args ?? null)}`;
  let operation = nativeInvokes.get(key);
  if (!operation) {
    operation = import('@tauri-apps/api/core')
      .then(({ invoke: inv }) => inv<unknown>(cmd, args))
      .then((value): NativeInvokeOutcome<unknown> => ({ status: 'ok', value }))
      .catch((err): NativeInvokeOutcome<unknown> => {
        console.warn('[pets] invoke failed', cmd, err);
        return { status: 'failed' };
      })
      .finally(() => {
        if (nativeInvokes.get(key) === operation) nativeInvokes.delete(key);
      });
    nativeInvokes.set(key, operation);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<NativeInvokeOutcome<unknown>>((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: 'timeout' }), NATIVE_PET_INVOKE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([operation, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  return outcome as NativeInvokeOutcome<T>;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const outcome = await invokeWithStatus<T>(cmd, args);
  return outcome.status === 'ok' ? outcome.value : null;
}

function failedOverlayShow(reason: PetOverlayShowReason): PetOverlayShowResult {
  return {
    mode: 'native-overlay',
    created: false,
    visible: false,
    topmostApplied: false,
    rendererReady: null,
    reason,
  };
}

function isPetOverlayShowResult(value: unknown): value is PetOverlayShowResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PetOverlayShowResult>;
  const validReason =
    result.reason === null ||
    result.reason === 'geometry_unavailable' ||
    result.reason === 'main_thread_unavailable' ||
    result.reason === 'native_callback_lost' ||
    result.reason === 'native_task_failed' ||
    result.reason === 'not_visible' ||
    result.reason === 'position_failed' ||
    result.reason === 'show_failed' ||
    result.reason === 'size_failed' ||
    result.reason === 'stale_window_retire_failed' ||
    result.reason === 'topmost_failed' ||
    result.reason === 'visibility_check_failed' ||
    result.reason === 'visibility_timeout' ||
    result.reason === 'window_create_failed' ||
    result.reason === 'window_label_conflict' ||
    result.reason === 'window_missing';
  return (
    result.mode === 'native-overlay' &&
    typeof result.created === 'boolean' &&
    typeof result.visible === 'boolean' &&
    typeof result.topmostApplied === 'boolean' &&
    (result.rendererReady === null || typeof result.rendererReady === 'boolean') &&
    validReason
  );
}

function failedPetPanelOpen(reason: PetPanelOpenReason): PetPanelOpenResult {
  return {
    mode: 'native-panel',
    created: false,
    visible: false,
    focused: false,
    topmostApplied: false,
    rendererReady: null,
    reason,
  };
}

function isPetPanelOpenResult(value: unknown): value is PetPanelOpenResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PetPanelOpenResult>;
  const validReason =
    result.reason === null ||
    result.reason === 'focus_check_failed' ||
    result.reason === 'focus_failed' ||
    result.reason === 'geometry_unavailable' ||
    result.reason === 'not_focused' ||
    result.reason === 'not_visible' ||
    result.reason === 'panel_state_unavailable' ||
    result.reason === 'position_failed' ||
    result.reason === 'restore_failed' ||
    result.reason === 'show_failed' ||
    result.reason === 'size_failed' ||
    result.reason === 'topmost_failed' ||
    result.reason === 'visibility_check_failed' ||
    result.reason === 'window_create_failed';
  return (
    result.mode === 'native-panel' &&
    typeof result.created === 'boolean' &&
    typeof result.visible === 'boolean' &&
    typeof result.focused === 'boolean' &&
    typeof result.topmostApplied === 'boolean' &&
    (result.rendererReady === null || typeof result.rendererReady === 'boolean') &&
    validReason
  );
}

let overlayShowInFlight: Promise<PetOverlayShowResult> | null = null;

export async function showPetOverlay(): Promise<PetOverlayShowResult> {
  if (overlayShowInFlight) return overlayShowInFlight;
  overlayShowInFlight = (async () => {
    if (!isTauriRuntime()) {
      return {
        ...failedOverlayShow('native_unavailable'),
        mode: 'app-only' as const,
      };
    }

    const outcome = await invokeWithStatus<unknown>('pet_show_overlay');
    if (outcome.status === 'timeout') {
      return failedOverlayShow('visibility_timeout');
    }
    if (outcome.status === 'failed') {
      return failedOverlayShow('native_command_failed');
    }
    const response = outcome.value;

    if (!isPetOverlayShowResult(response)) {
      return failedOverlayShow('native_result_invalid');
    }
    const result = response;

    if (result.mode === 'native-overlay' && result.visible) {
      signalPetOverlayShown();
    }
    return result;
  })().finally(() => {
    overlayShowInFlight = null;
  });
  return overlayShowInFlight;
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
  panelMode: PetPanelMode = 'normal',
): Promise<PetPanelOpenResult> {
  if (!isTauriRuntime()) return failedPetPanelOpen('native_unavailable');
  const outcome = await invokeWithStatus<unknown>('pet_open_or_focus_panel', {
    nearX: nearX ?? null,
    nearY: nearY ?? null,
    panelMode,
  });
  if (outcome.status === 'timeout') {
    return failedPetPanelOpen('visibility_timeout');
  }
  if (outcome.status === 'failed') {
    return failedPetPanelOpen('native_command_failed');
  }
  const response = outcome.value;
  return isPetPanelOpenResult(response) ? response : failedPetPanelOpen('native_result_invalid');
}

/** Open/focus the mini panel without changing standalone pet visibility. */
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
  /** Inline panel is allowed only in browser/non-Tauri mode. */
  useInlineFallback: boolean;
  /** Whether the detached native overlay was confirmed visible after failure. */
  overlayVisible: boolean;
  /** Safe reason for a native-panel acknowledgement failure, if any. */
  reason: PetPanelOpenReason | null;
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
 * Confirmed open used by tests and internal callers.
 * Prefer {@link openOrFocusPetMiniPanel} for production (single-flight).
 */
export async function openPetPanelSafely(
  nearX?: number,
  nearY?: number,
  panelMode: PetPanelMode = 'normal',
): Promise<{ panelVisible: boolean }> {
  const result = await openOrFocusPetMiniPanel(nearX, nearY, panelMode);
  return { panelVisible: result.panelVisible };
}

async function restoreDetachedOverlay(reason: PetPanelOpenReason): Promise<OpenPetMiniPanelResult> {
  setPetPanelOpenFlag(false);
  const overlay = await showPetOverlay();
  return {
    panelVisible: false,
    useInlineFallback: false,
    overlayVisible: overlay.mode === 'native-overlay' && overlay.visible,
    reason,
    coalesced: false,
  };
}

/**
 * Canonical open path for Axo and Glitch.
 *
 * - Single-flight: concurrent clicks share one open promise (no duplicate panels).
 * - If pet-mini-panel already exists (hidden/minimized), show/unminimize/focus.
 * - Hide the standalone overlay once the panel is confirmed visible.
 * - In Tauri, panel failure preserves/restores the detached overlay; it never
 *   silently substitutes an inline Pet panel.
 * - Browser / non-Tauri keeps the explicit in-app panel path.
 */
export async function openOrFocusPetMiniPanel(
  nearX?: number,
  nearY?: number,
  panelMode: PetPanelMode = 'normal',
): Promise<OpenPetMiniPanelResult> {
  if (openPanelInFlight) {
    const result = await openPanelInFlight;
    return { ...result, coalesced: true };
  }

  openPanelInFlight = (async (): Promise<OpenPetMiniPanelResult> => {
    if (!isTauriRuntime()) {
      // Browser / non-Tauri: in-app panel only.
      setPetPanelOpenFlag(true);
      return {
        panelVisible: false,
        useInlineFallback: true,
        overlayVisible: false,
        reason: 'native_unavailable',
        coalesced: false,
      };
    }

    let nativeResult = await openOrFocusPetPanel(nearX, nearY, panelMode);
    // Creation is queued after the first invoke returns. Finish configuring the
    // materialized window rather than leaving its initial native host exposed.
    if (nativeResult.created && nativeResult.reason === 'not_visible') {
      for (let attempt = 0; attempt < 6 && nativeResult.reason === 'not_visible'; attempt += 1) {
        await waitMs(160);
        nativeResult = await openOrFocusPetPanel(nearX, nearY, panelMode);
      }
    }
    if (!nativeResult.visible || !nativeResult.focused) {
      return restoreDetachedOverlay(nativeResult.reason ?? 'not_visible');
    }
    // Check immediately; poll only if the native window has not settled yet.
    let panelVisible = await pollPanelVisible(6, 90);

    if (!panelVisible) {
      // Second attempt: re-invoke show/focus in case the window was racing.
      nativeResult = await openOrFocusPetPanel(nearX, nearY, panelMode);
      if (!nativeResult.visible || !nativeResult.focused) {
        return restoreDetachedOverlay(nativeResult.reason ?? 'not_visible');
      }
      panelVisible = await pollPanelVisible(4, 100);
    }

    if (panelVisible) {
      setPetPanelOpenFlag(true);
      await hidePetOverlay().catch(() => undefined);
      return {
        panelVisible: true,
        useInlineFallback: false,
        overlayVisible: false,
        reason: null,
        coalesced: false,
      };
    }

    return restoreDetachedOverlay('visibility_timeout');
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

export async function hidePetPanel(): Promise<boolean> {
  const outcome = await invokeWithStatus<void>('pet_hide_panel');
  return outcome.status === 'ok';
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
