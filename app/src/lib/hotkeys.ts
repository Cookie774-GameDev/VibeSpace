import { useEffect, useSyncExternalStore } from 'react';
import { isMac } from './utils';

/**
 * Lightweight global hotkey system with user rebinding, conflict detection,
 * and persistence. 'Mod' = Cmd on Mac, Ctrl on Windows/Linux.
 */

export type Hotkey = string;

export type HotkeyId =
  | 'PALETTE'
  | 'TOGGLE_NAV'
  | 'TOGGLE_INSPECTOR'
  | 'TOGGLE_INSPECTOR_I'
  | 'TOGGLE_INSPECTOR_DOT'
  | 'NEW_CHAT'
  | 'NEW_TAB'
  | 'CLOSE_TAB'
  | 'TAB_1'
  | 'TAB_2'
  | 'TAB_3'
  | 'TAB_4'
  | 'TAB_5'
  | 'TAB_6'
  | 'TAB_7'
  | 'TAB_8'
  | 'TAB_9'
  | 'SEND'
  | 'BROADCAST'
  | 'PUSH_TO_TALK'
  | 'SETTINGS'
  | 'ESCAPE'
  | 'TOGGLE_FULLSCREEN'
  | 'TOGGLE_SYSTEM_FULLSCREEN'
  | 'AMBIENT_TOGGLE'
  | 'COMPOSER_STT'
  | 'PROMPT_FORGE'
  | 'GLOBAL_DICTATION'
  | 'SCHEDULE'
  | 'LAUNCHER'
  | 'ASSISTANT'
  | 'JARVIS_BUBBLE'
  | 'ACTIONS'
  | 'DEV_CONSOLE'
  | 'DEV_CONSOLE_F12';

/** Immutable factory defaults — never mutated. */
export const DEFAULT_HOTKEYS: Readonly<Record<HotkeyId, Hotkey>> = Object.freeze({
  PALETTE: 'Mod+K',
  TOGGLE_NAV: 'Mod+B',
  TOGGLE_INSPECTOR: 'Mod+\\',
  TOGGLE_INSPECTOR_I: 'Mod+I',
  TOGGLE_INSPECTOR_DOT: 'Mod+.',
  NEW_CHAT: 'Mod+T',
  NEW_TAB: 'Mod+T',
  CLOSE_TAB: 'Mod+W',
  TAB_1: 'Mod+1',
  TAB_2: 'Mod+2',
  TAB_3: 'Mod+3',
  TAB_4: 'Mod+4',
  TAB_5: 'Mod+5',
  TAB_6: 'Mod+6',
  TAB_7: 'Mod+7',
  TAB_8: 'Mod+8',
  TAB_9: 'Mod+9',
  SEND: 'Mod+Enter',
  BROADCAST: 'Mod+Shift+Enter',
  PUSH_TO_TALK: 'Mod+Space',
  SETTINGS: 'Mod+,',
  ESCAPE: 'Escape',
  TOGGLE_FULLSCREEN: 'Mod+Shift+F',
  TOGGLE_SYSTEM_FULLSCREEN: 'F11',
  AMBIENT_TOGGLE: 'Mod+Shift+.',
  COMPOSER_STT: 'Ctrl+CapsLock',
  PROMPT_FORGE: 'Mod+Shift+U',
  GLOBAL_DICTATION: 'Ctrl+Space',
  SCHEDULE: 'Mod+Shift+S',
  LAUNCHER: 'Mod+Shift+L',
  ASSISTANT: 'Mod+J',
  JARVIS_BUBBLE: 'Shift+Tab',
  ACTIONS: 'Mod+Shift+A',
  DEV_CONSOLE: 'Mod+Shift+D',
  DEV_CONSOLE_F12: 'F12',
});

/** Human labels for Settings → Hotkeys (and conflict messages). */
export const HOTKEY_LABELS: Readonly<Record<HotkeyId, string>> = Object.freeze({
  PALETTE: 'Open command palette',
  TOGGLE_NAV: 'Toggle nav pane',
  TOGGLE_INSPECTOR: 'Toggle inspector pane',
  TOGGLE_INSPECTOR_I: 'Toggle inspector pane (alias)',
  TOGGLE_INSPECTOR_DOT: 'Toggle inspector pane (alias)',
  NEW_CHAT: 'New chat',
  NEW_TAB: 'New tab',
  CLOSE_TAB: 'Close tab',
  TAB_1: 'Switch to tab 1',
  TAB_2: 'Switch to tab 2',
  TAB_3: 'Switch to tab 3',
  TAB_4: 'Switch to tab 4',
  TAB_5: 'Switch to tab 5',
  TAB_6: 'Switch to tab 6',
  TAB_7: 'Switch to tab 7',
  TAB_8: 'Switch to tab 8',
  TAB_9: 'Switch to tab 9',
  SEND: 'Send to current agent',
  BROADCAST: 'Broadcast to all agents (council)',
  PUSH_TO_TALK: 'Push-to-talk (global)',
  SETTINGS: 'Open settings',
  ESCAPE: 'Close modal / exit focus mode',
  TOGGLE_FULLSCREEN: 'Toggle Workspace Focus Mode',
  TOGGLE_SYSTEM_FULLSCREEN: 'Toggle True System Fullscreen',
  AMBIENT_TOGGLE: 'Toggle ambient mode',
  COMPOSER_STT: 'Voice-to-text in composer',
  PROMPT_FORGE: 'Upgrade composer draft with Prompt Forge',
  GLOBAL_DICTATION: 'VibeSpace dictation — in-app input when focused, overlay outside',
  SCHEDULE: 'Open schedule',
  LAUNCHER: 'Open quick launcher',
  ASSISTANT: 'Open assistant command bar',
  JARVIS_BUBBLE: 'Toggle chat auto-approve (chat) / open Assistant elsewhere',
  ACTIONS: 'Open actions palette',
  DEV_CONSOLE: 'Toggle developer console',
  DEV_CONSOLE_F12: 'Toggle developer console (F12)',
});

/** Display order in Settings (groups related actions). */
export const HOTKEY_SETTINGS_ORDER: readonly HotkeyId[] = Object.freeze([
  'PALETTE',
  'ACTIONS',
  'ASSISTANT',
  'LAUNCHER',
  'SETTINGS',
  'TOGGLE_NAV',
  'TOGGLE_INSPECTOR',
  'TOGGLE_INSPECTOR_I',
  'TOGGLE_INSPECTOR_DOT',
  'NEW_CHAT',
  'NEW_TAB',
  'CLOSE_TAB',
  'TAB_1',
  'TAB_2',
  'TAB_3',
  'TAB_4',
  'TAB_5',
  'TAB_6',
  'TAB_7',
  'TAB_8',
  'TAB_9',
  'SEND',
  'BROADCAST',
  'PROMPT_FORGE',
  'PUSH_TO_TALK',
  'COMPOSER_STT',
  'GLOBAL_DICTATION',
  'SCHEDULE',
  'AMBIENT_TOGGLE',
  'TOGGLE_FULLSCREEN',
  'TOGGLE_SYSTEM_FULLSCREEN',
  'JARVIS_BUBBLE',
  'ESCAPE',
  'DEV_CONSOLE',
  'DEV_CONSOLE_F12',
]);

/** Actions that intentionally share one combo (rebind updates every member). */
export const HOTKEY_LINK_GROUPS: readonly (readonly HotkeyId[])[] = Object.freeze([
  Object.freeze(['NEW_CHAT', 'NEW_TAB'] as const),
]);

const SYNC_LINKED = HOTKEY_LINK_GROUPS;

export type HotkeyValidationError =
  | 'empty'
  | 'invalid'
  | 'modifier_only'
  | 'reserved'
  | 'bare_printable'
  | 'unsupported';

export interface HotkeyConflict {
  combo: string;
  id: HotkeyId;
  label: string;
}

export interface HotkeySetResult {
  ok: boolean;
  conflicts: HotkeyConflict[];
  error?: HotkeyValidationError;
  message?: string;
}

const STORAGE_KEY = 'jarvis-hotkeys-v1';
const CHANGE_EVENT = 'jarvis:hotkeys-changed';

type Options = {
  whenInputs?: boolean;
  disabled?: boolean;
};

let customBindings: Partial<Record<HotkeyId, Hotkey>> = {};
let version = 0;
const versionListeners = new Set<() => void>();

function emitHotkeysChanged(): void {
  version += 1;
  for (const listener of versionListeners) listener();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
}

function subscribeHotkeyVersion(onStoreChange: () => void): () => void {
  versionListeners.add(onStoreChange);
  return () => {
    versionListeners.delete(onStoreChange);
  };
}

function getHotkeyVersion(): number {
  return version;
}

export function isHotkeyId(value: string): value is HotkeyId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, value);
}

export function normalizeHotkeyCombo(combo: string): string {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  const mods: string[] = [];
  let key = '';
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    const lower = raw.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'meta' || lower === 'command') {
      mods.push('Mod');
    } else if (lower === 'ctrl' || lower === 'control') {
      // Ctrl is explicit (not Mod) — keep for COMPOSER_STT / GLOBAL_DICTATION style
      if (i === parts.length - 1) key = 'Ctrl';
      else mods.push('Ctrl');
    } else if (lower === 'shift') {
      mods.push('Shift');
    } else if (lower === 'alt' || lower === 'option') {
      mods.push('Alt');
    } else {
      key = raw.length === 1 ? raw.toUpperCase() === raw.toLowerCase() ? raw : raw.toUpperCase() : capitalizeKey(raw);
    }
  }

  // Single-key shortcuts (Escape, F11, …)
  if (!key && mods.length === 1 && !['Mod', 'Ctrl', 'Shift', 'Alt'].includes(mods[0]!)) {
    key = mods.pop()!;
  }

  // Dedupe mods preserving order Mod, Ctrl, Alt, Shift
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'];
  const uniq = order.filter((m) => mods.includes(m));
  if (!key) return uniq.join('+');
  // Single-char keys stored uppercase (Mod+K) to match DEFAULT_HOTKEYS;
  // matchesHotkey lowercases both sides when comparing KeyboardEvents.
  const keyOut = key.length === 1 ? key.toUpperCase() : key;
  return [...uniq, keyOut].join('+');
}

function capitalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'esc') return 'Escape';
  if (lower === 'escape') return 'Escape';
  if (lower === 'enter' || lower === 'return') return 'Enter';
  if (lower === 'space' || lower === 'spacebar') return 'Space';
  if (lower === 'capslock') return 'CapsLock';
  if (lower === 'tab') return 'Tab';
  if (lower === 'backslash' || raw === '\\') return '\\';
  if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase();
  if (raw.length === 1) return raw.toLowerCase();
  return raw;
}

/** Platform / browser reserved combos we refuse to steal. */
const RESERVED_COMBOS: readonly string[] = [
  'Mod+Q',
  'Mod+W', // allow CLOSE_TAB which IS Mod+W by default — reserved only as browser close when not our binding
  'Mod+N',
  'Mod+Shift+N',
  'Mod+R',
  'Mod+Shift+R',
  'Alt+F4',
  'Mod+Alt+Delete',
  'Ctrl+Alt+Delete',
].map(normalizeHotkeyCombo);

// Mod+W is our CLOSE_TAB — don't block it globally. Remove from reserved for app-owned defaults.
const HARD_RESERVED = new Set(
  ['Mod+Q', 'Mod+N', 'Mod+Shift+N', 'Mod+R', 'Mod+Shift+R', 'Alt+F4', 'Mod+Alt+Delete', 'Ctrl+Alt+Delete'].map(
    normalizeHotkeyCombo,
  ),
);

export function validateHotkeyCombo(combo: string): HotkeyValidationError | null {
  const trimmed = combo.trim();
  if (!trimmed) return 'empty';
  const normalized = normalizeHotkeyCombo(trimmed);
  if (!normalized) return 'invalid';

  const parts = normalized.split('+');
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (mods.length === 0 && parts.length === 1) {
    // Bare keys: only allow Escape, F-keys, Tab with shift already handled
    const bareOk =
      key === 'Escape' ||
      /^F\d{1,2}$/i.test(key) ||
      key === 'Tab' ||
      key === 'CapsLock';
    if (!bareOk) {
      // Printable bare keys hijack typing
      if (key.length === 1 || key === 'Space' || key === 'Enter') return 'bare_printable';
    }
  }
  if (['Mod', 'Ctrl', 'Shift', 'Alt'].includes(key) && mods.length === 0) return 'modifier_only';
  if (HARD_RESERVED.has(normalized)) return 'reserved';
  // Unsupported: empty key after normalize
  if (!key) return 'unsupported';
  return null;
}

export function resolveHotkey(id: HotkeyId): Hotkey {
  return customBindings[id] ?? DEFAULT_HOTKEYS[id];
}

/**
 * Live map of all bindings. Prefer this over reading HOTKEYS in effects so
 * rebinds apply immediately.
 */
export function getHotkeyBindings(): Record<HotkeyId, Hotkey> {
  const out = {} as Record<HotkeyId, Hotkey>;
  for (const id of Object.keys(DEFAULT_HOTKEYS) as HotkeyId[]) {
    out[id] = resolveHotkey(id);
  }
  return out;
}

/** Canonical table — property access always returns the *current* binding. */
export const HOTKEYS: Readonly<Record<HotkeyId, Hotkey>> = new Proxy({} as Record<HotkeyId, Hotkey>, {
  get(_target, prop: string | symbol) {
    if (typeof prop === 'string' && isHotkeyId(prop)) return resolveHotkey(prop);
    return undefined;
  },
  ownKeys() {
    return Object.keys(DEFAULT_HOTKEYS);
  },
  getOwnPropertyDescriptor(_target, prop: string | symbol) {
    if (typeof prop === 'string' && isHotkeyId(prop)) {
      return { configurable: true, enumerable: true, value: resolveHotkey(prop) };
    }
    return undefined;
  },
  has(_target, prop: string | symbol) {
    return typeof prop === 'string' && isHotkeyId(prop);
  },
}) as Readonly<Record<HotkeyId, Hotkey>>;

export function findConflicts(
  id: HotkeyId,
  combo: string,
  bindings: Partial<Record<HotkeyId, Hotkey>> = getHotkeyBindings(),
): HotkeyConflict[] {
  const normalized = normalizeHotkeyCombo(combo);
  const linked = SYNC_LINKED.find((g) => g.includes(id)) ?? [id];
  const conflicts: HotkeyConflict[] = [];
  for (const [otherId, otherCombo] of Object.entries(bindings) as [HotkeyId, Hotkey][]) {
    if (linked.includes(otherId)) continue;
    if (normalizeHotkeyCombo(otherCombo) === normalized) {
      conflicts.push({
        combo: otherCombo,
        id: otherId,
        label: HOTKEY_LABELS[otherId],
      });
    }
  }
  return conflicts;
}

/**
 * Propose a rebinding. Does not save when conflicts exist unless `force` is true.
 * Never silently overwrites another action.
 */
export function setHotkeyBinding(
  id: HotkeyId,
  combo: string,
  options: { force?: boolean } = {},
): HotkeySetResult {
  const validation = validateHotkeyCombo(combo);
  if (validation) {
    return {
      ok: false,
      conflicts: [],
      error: validation,
      message: validationMessage(validation),
    };
  }
  const normalized = normalizeHotkeyCombo(combo);
  const nextMap = getHotkeyBindings();
  const conflicts = findConflicts(id, normalized, nextMap);
  if (conflicts.length > 0 && !options.force) {
    return {
      ok: false,
      conflicts,
      message: `Already used by ${conflicts.map((c) => c.label).join(', ')}. Reassign that action first.`,
    };
  }

  const linked = SYNC_LINKED.find((g) => g.includes(id)) ?? [id];
  const nextCustom = { ...customBindings };
  for (const linkedId of linked) {
    if (normalized === DEFAULT_HOTKEYS[linkedId]) {
      delete nextCustom[linkedId];
    } else {
      nextCustom[linkedId] = normalized;
    }
  }
  // When force-resolving, clear conflicting ids back to empty? No — force means
  // caller already reassigned conflicts. We only write this id (and linked).
  customBindings = nextCustom;
  persistCustomBindings();
  emitHotkeysChanged();
  return { ok: true, conflicts: [] };
}

export function resetHotkeyBinding(id: HotkeyId): void {
  const linked = SYNC_LINKED.find((g) => g.includes(id)) ?? [id];
  const next = { ...customBindings };
  for (const linkedId of linked) {
    delete next[linkedId];
  }
  customBindings = next;
  persistCustomBindings();
  emitHotkeysChanged();
}

export function resetAllHotkeyBindings(): void {
  customBindings = {};
  persistCustomBindings();
  emitHotkeysChanged();
}

export function isHotkeyCustomized(id: HotkeyId): boolean {
  return Object.prototype.hasOwnProperty.call(customBindings, id);
}

function validationMessage(error: HotkeyValidationError): string {
  switch (error) {
    case 'empty':
      return 'Choose a key combination.';
    case 'invalid':
      return 'That combination is not valid.';
    case 'modifier_only':
      return 'Add a non-modifier key (for example Mod+K).';
    case 'reserved':
      return 'That combination is reserved by the operating system or browser.';
    case 'bare_printable':
      return 'Single letter keys would hijack typing. Add a modifier (Mod, Ctrl, Alt, or Shift).';
    case 'unsupported':
      return 'That combination is not supported.';
  }
}

function persistCustomBindings(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customBindings));
  } catch {
    /* ignore quota */
  }
}

export function loadHotkeyBindingsFromStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      customBindings = {};
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      customBindings = {};
      return;
    }
    const next: Partial<Record<HotkeyId, Hotkey>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isHotkeyId(key) || typeof value !== 'string') continue;
      if (validateHotkeyCombo(value)) continue;
      next[key] = normalizeHotkeyCombo(value);
    }
    customBindings = next;
  } catch {
    customBindings = {};
  }
}

/** @internal */
export function __resetHotkeyBindingsForTests(): void {
  customBindings = {};
  version = 0;
}

/** Build a combo string from a KeyboardEvent (for the capture UI). */
export function comboFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return null;
  }
  const parts: string[] = [];
  // Prefer Mod for primary accelerator on the active platform
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  // If both Ctrl and Meta on Mac, also note Ctrl
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Escape';
  else if (key.length === 1) key = key.toLowerCase();
  else if (key === 'CapsLock') key = 'CapsLock';
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();

  parts.push(key);
  return normalizeHotkeyCombo(parts.join('+'));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  // xterm / terminal surfaces
  if (target.closest('.xterm') || target.closest('[data-terminal-surface]')) return true;
  return false;
}

/**
 * Test whether a KeyboardEvent satisfies a hotkey string like
 * 'Mod+Shift+1', 'Enter', or 'Mod+\\'.
 */
export function matchesHotkey(e: KeyboardEvent, hotkey: Hotkey): boolean {
  const parts = hotkey.split('+').map((p) => p.trim().toLowerCase());
  const wantMod = parts.includes('mod') || parts.includes('cmd');
  const wantCtrl = parts.includes('ctrl') || parts.includes('control');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt') || parts.includes('option');
  const key = parts[parts.length - 1]!;

  // Mod = primary accelerator (Cmd on Mac, Ctrl on Windows)
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  // Explicit Ctrl (distinct from Mod on Mac)
  const ctrlPressed = e.ctrlKey;

  if (wantMod && !modPressed) return false;
  // When Mod is requested on Windows, ctrl is the mod key — don't double-require
  if (wantCtrl && !wantMod && !ctrlPressed) return false;
  if (wantCtrl && wantMod && isMac && !ctrlPressed) return false;
  if (!wantMod && modPressed && !(wantCtrl && !isMac)) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;

  const eKey = e.key.toLowerCase();
  const normalizedKey = key.replace(/[\s_-]/g, '');
  const normalizedEventKey = eKey.replace(/[\s_-]/g, '');
  if (key === 'space') return eKey === ' ' || eKey === 'spacebar';
  if (key === 'esc' || key === 'escape') return eKey === 'escape';
  if (key === 'enter') return eKey === 'enter';
  if (normalizedKey === 'capslock') return normalizedEventKey === 'capslock';
  if (key === 'tab') return eKey === 'tab';
  if (key === '\\' || key === 'backslash') return eKey === '\\';
  if (/^f\d{1,2}$/.test(normalizedKey)) return normalizedEventKey === normalizedKey;
  return eKey === key || normalizedEventKey === normalizedKey;
}

/**
 * Bind a hotkey by registry id so rebinds apply immediately without remounting.
 * Prefer this for all app-owned shortcuts.
 */
export function useBoundHotkey(
  id: HotkeyId,
  handler: (e: KeyboardEvent) => void,
  opts: Options = {},
): void {
  const ver = useSyncExternalStore(subscribeHotkeyVersion, getHotkeyVersion, () => 0);
  useEffect(() => {
    if (opts.disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!opts.whenInputs && isEditableTarget(e.target)) return;
      if (matchesHotkey(e, resolveHotkey(id))) {
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // ver ensures re-subscribe when map changes (also re-read resolveHotkey)
  }, [id, handler, opts.whenInputs, opts.disabled, ver]);
}

/**
 * Bind a raw combo string. For dynamic/user link shortcuts.
 * Re-reads the string from a ref each keydown when parent re-renders.
 */
export function useHotkey(
  hotkey: Hotkey | HotkeyId,
  handler: (e: KeyboardEvent) => void,
  opts: Options = {},
): void {
  const ver = useSyncExternalStore(subscribeHotkeyVersion, getHotkeyVersion, () => 0);
  useEffect(() => {
    if (opts.disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!opts.whenInputs && isEditableTarget(e.target)) return;
      const combo = isHotkeyId(hotkey) ? resolveHotkey(hotkey) : hotkey;
      if (matchesHotkey(e, combo)) {
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey, handler, opts.whenInputs, opts.disabled, ver]);
}

// Load persisted bindings as early as this module is first imported in the browser.
if (typeof window !== 'undefined') {
  loadHotkeyBindingsFromStorage();
}
