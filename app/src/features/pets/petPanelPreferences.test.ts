import { describe, expect, it, vi } from 'vitest';
import {
  PET_PANEL_FLOAT_GEOMETRY_KEY,
  PET_PANEL_HEADER_COLLAPSED_KEY,
  computeBottomRightAnchoredResize,
  loadPetPanelFloatGeometry,
  loadPetPanelHeaderCollapsed,
  petPanelDensityForSize,
  petPanelUiScale,
  savePetPanelFloatGeometry,
  savePetPanelHeaderCollapsed,
} from './petPanelPreferences';

describe('Pet panel preferences', () => {
  it('loads and saves the collapsed header without requiring writable storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(loadPetPanelHeaderCollapsed(storage)).toBe(false);
    savePetPanelHeaderCollapsed(true, storage);
    expect(values.get(PET_PANEL_HEADER_COLLAPSED_KEY)).toBe('1');
    expect(loadPetPanelHeaderCollapsed(storage)).toBe(true);

    expect(() =>
      savePetPanelHeaderCollapsed(true, {
        setItem: vi.fn(() => {
          throw new Error('blocked');
        }),
      }),
    ).not.toThrow();
    expect(
      loadPetPanelHeaderCollapsed({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(false);
  });

  it('selects comfortable, compact, and minimum modes from both dimensions', () => {
    expect(petPanelDensityForSize(760, 760)).toBe('comfortable');
    expect(petPanelDensityForSize(575, 748)).toBe('compact');
    expect(petPanelDensityForSize(700, 560)).toBe('compact');
    expect(petPanelDensityForSize(420, 700)).toBe('minimum');
    expect(petPanelDensityForSize(700, 480)).toBe('minimum');
  });

  it('scales UI continuously with panel size and never below 0.62', () => {
    expect(petPanelUiScale(460, 600)).toBe(1);
    expect(petPanelUiScale(920, 1200)).toBe(1);
    expect(petPanelUiScale(320, 400)).toBeLessThan(0.9);
    expect(petPanelUiScale(320, 400)).toBeGreaterThanOrEqual(0.62);
    expect(petPanelUiScale(100, 100)).toBe(0.62);
  });

  it('persists and restores floating panel size/position', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    savePetPanelFloatGeometry({ w: 512, h: 640, right: 44, bottom: 36 }, storage);
    expect(values.get(PET_PANEL_FLOAT_GEOMETRY_KEY)).toBeTruthy();
    expect(loadPetPanelFloatGeometry(storage)).toEqual({
      w: 512,
      h: 640,
      right: 44,
      bottom: 36,
    });
    // Clamps extreme sizes
    savePetPanelFloatGeometry({ w: 40, h: 9999, right: 1, bottom: 1 }, storage);
    const clamped = loadPetPanelFloatGeometry(storage)!;
    expect(clamped.w).toBe(320);
    expect(clamped.h).toBe(1000);
    expect(clamped.right).toBeGreaterThanOrEqual(8);
  });

  it('resizes a bottom-right panel without drifting the opposite edges', () => {
    // Drag SE (bottom-right): right+bottom follow cursor; top-left stays fixed.
    const se = computeBottomRightAnchoredResize({
      edge: 'se',
      dx: 12,
      dy: 16,
      startW: 460,
      startH: 600,
      startRight: 40,
      startBottom: 40,
    });
    expect(se.w).toBe(472);
    expect(se.h).toBe(616);
    expect(se.right).toBe(28);
    expect(se.bottom).toBe(24);

    // Drag west (left edge): right stays fixed.
    const west = computeBottomRightAnchoredResize({
      edge: 'w',
      dx: -50,
      dy: 0,
      startW: 460,
      startH: 600,
      startRight: 28,
      startBottom: 28,
    });
    expect(west.w).toBe(510);
    expect(west.right).toBe(28);
    expect(west.bottom).toBe(28);

    // Drag north (top edge): bottom stays fixed.
    const north = computeBottomRightAnchoredResize({
      edge: 'n',
      dx: 0,
      dy: -40,
      startW: 460,
      startH: 600,
      startRight: 28,
      startBottom: 28,
    });
    expect(north.h).toBe(640);
    expect(north.bottom).toBe(28);
    expect(north.right).toBe(28);
  });
});
