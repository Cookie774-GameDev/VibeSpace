import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_SETTINGS_ORDER,
  __resetHotkeyBindingsForTests,
  findConflicts,
  getHotkeyBindings,
  isHotkeyCustomized,
  loadHotkeyBindingsFromStorage,
  normalizeHotkeyCombo,
  resetAllHotkeyBindings,
  resetHotkeyBinding,
  resolveHotkey,
  setHotkeyBinding,
  validateHotkeyCombo,
} from './hotkeys';

describe('hotkey rebinding + conflicts', () => {
  beforeEach(() => {
    __resetHotkeyBindingsForTests();
    window.localStorage.removeItem('jarvis-hotkeys-v1');
  });

  afterEach(() => {
    __resetHotkeyBindingsForTests();
    window.localStorage.removeItem('jarvis-hotkeys-v1');
  });

  it('lists every registered hotkey in settings order', () => {
    const ids = Object.keys(DEFAULT_HOTKEYS);
    for (const id of ids) {
      expect(HOTKEY_SETTINGS_ORDER).toContain(id);
    }
    expect(HOTKEY_SETTINGS_ORDER.length).toBe(ids.length);
  });

  it('detects conflicts before saving (Ctrl/Mod+K example)', () => {
    // TOGGLE_NAV default is Mod+B; rebind to palette's Mod+K
    const conflicts = findConflicts('TOGGLE_NAV', 'Mod+K');
    expect(conflicts.some((c) => c.id === 'PALETTE')).toBe(true);
    expect(conflicts[0]?.label).toMatch(/command palette/i);

    const result = setHotkeyBinding('TOGGLE_NAV', 'Mod+K');
    expect(result.ok).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    // Nothing saved
    expect(resolveHotkey('TOGGLE_NAV')).toBe(DEFAULT_HOTKEYS.TOGGLE_NAV);
  });

  it('saves when the combo is free and persists across load', () => {
    const result = setHotkeyBinding('TOGGLE_NAV', 'Mod+Shift+B');
    expect(result.ok).toBe(true);
    expect(resolveHotkey('TOGGLE_NAV')).toBe('Mod+Shift+B');
    expect(isHotkeyCustomized('TOGGLE_NAV')).toBe(true);

    // Simulate restart
    __resetHotkeyBindingsForTests();
    expect(resolveHotkey('TOGGLE_NAV')).toBe(DEFAULT_HOTKEYS.TOGGLE_NAV);
    loadHotkeyBindingsFromStorage();
    expect(resolveHotkey('TOGGLE_NAV')).toBe('Mod+Shift+B');
  });

  it('links NEW_CHAT and NEW_TAB so rebind updates both', () => {
    const result = setHotkeyBinding('NEW_CHAT', 'Mod+Shift+T');
    expect(result.ok).toBe(true);
    expect(resolveHotkey('NEW_CHAT')).toBe('Mod+Shift+T');
    expect(resolveHotkey('NEW_TAB')).toBe('Mod+Shift+T');
  });

  it('allows rebinding after the conflicting action is moved', () => {
    // Free PALETTE first
    expect(setHotkeyBinding('PALETTE', 'Mod+Shift+K').ok).toBe(true);
    // Now TOGGLE_NAV can take Mod+K
    const second = setHotkeyBinding('TOGGLE_NAV', 'Mod+K');
    expect(second.ok).toBe(true);
    expect(resolveHotkey('TOGGLE_NAV')).toBe('Mod+K');
    expect(resolveHotkey('PALETTE')).toBe('Mod+Shift+K');
  });

  it('resets one and all to defaults', () => {
    setHotkeyBinding('SCHEDULE', 'Mod+Shift+C');
    setHotkeyBinding('LAUNCHER', 'Mod+Shift+P');
    resetHotkeyBinding('SCHEDULE');
    expect(resolveHotkey('SCHEDULE')).toBe(DEFAULT_HOTKEYS.SCHEDULE);
    expect(resolveHotkey('LAUNCHER')).toBe('Mod+Shift+P');
    resetAllHotkeyBindings();
    expect(resolveHotkey('LAUNCHER')).toBe(DEFAULT_HOTKEYS.LAUNCHER);
    expect(Object.values(getHotkeyBindings()).every((c, i) => {
      const id = Object.keys(DEFAULT_HOTKEYS)[i];
      return c === DEFAULT_HOTKEYS[id as keyof typeof DEFAULT_HOTKEYS];
    })).toBe(true);
  });

  it('rejects bare printable keys and OS-reserved combos', () => {
    expect(validateHotkeyCombo('a')).toBe('bare_printable');
    expect(validateHotkeyCombo('Mod+Q')).toBe('reserved');
    expect(validateHotkeyCombo('Mod')).toBe('modifier_only');
    expect(validateHotkeyCombo('Mod+K')).toBeNull();
    expect(validateHotkeyCombo('F11')).toBeNull();
    expect(validateHotkeyCombo('Escape')).toBeNull();
  });

  it('normalizes combos consistently', () => {
    expect(normalizeHotkeyCombo('mod+shift+k')).toBe('Mod+Shift+K');
    expect(normalizeHotkeyCombo('Ctrl+Space')).toBe('Ctrl+Space');
  });
});
