export type PetPanelDensity = 'comfortable' | 'compact' | 'minimum';

export const PET_PANEL_HEADER_COLLAPSED_KEY = 'vibespace-pet-panel-header-collapsed';
/** In-app floating mini-panel outer size + bottom-right anchor (not Tauri window). */
export const PET_PANEL_FLOAT_GEOMETRY_KEY = 'vibespace-pet-panel-float-geometry';

export type PetPanelFloatGeometry = {
  w: number;
  h: number;
  right: number;
  bottom: number;
};

export function loadPetPanelFloatGeometry(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): PetPanelFloatGeometry | null {
  try {
    const raw = storage?.getItem(PET_PANEL_FLOAT_GEOMETRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PetPanelFloatGeometry>;
    if (
      typeof parsed.w !== 'number' ||
      typeof parsed.h !== 'number' ||
      typeof parsed.right !== 'number' ||
      typeof parsed.bottom !== 'number'
    ) {
      return null;
    }
    const size = clampPetPanelSize(parsed.w, parsed.h);
    return {
      w: size.w,
      h: size.h,
      right: Math.max(8, Math.round(parsed.right)),
      bottom: Math.max(8, Math.round(parsed.bottom)),
    };
  } catch {
    return null;
  }
}

export function savePetPanelFloatGeometry(
  geo: PetPanelFloatGeometry,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): void {
  try {
    const size = clampPetPanelSize(geo.w, geo.h);
    storage?.setItem(
      PET_PANEL_FLOAT_GEOMETRY_KEY,
      JSON.stringify({
        w: size.w,
        h: size.h,
        right: Math.max(8, Math.round(geo.right)),
        bottom: Math.max(8, Math.round(geo.bottom)),
      }),
    );
  } catch {
    // Panel remains usable when storage is unavailable.
  }
}

export function loadPetPanelHeaderCollapsed(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): boolean {
  try {
    return storage?.getItem(PET_PANEL_HEADER_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function savePetPanelHeaderCollapsed(
  collapsed: boolean,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): void {
  try {
    storage?.setItem(PET_PANEL_HEADER_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // The panel remains usable when storage is unavailable.
  }
}

export function petPanelDensityForSize(width: number, height: number): PetPanelDensity {
  if (width < 440 || height < 500) return 'minimum';
  if (width < 720 || height < 720) return 'compact';
  return 'comfortable';
}

/**
 * Continuous UI scale for the mini panel. Reference size is the default
 * ~460×600 panel; shrinks as the user resizes down (never below 0.62).
 * Uses the smaller axis so both narrow and short panels densify.
 */
export function petPanelUiScale(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 460;
  const h = Number.isFinite(height) && height > 0 ? height : 600;
  const byW = w / 460;
  const byH = h / 560;
  const raw = Math.min(byW, byH);
  return Math.max(0.62, Math.min(1, Number(raw.toFixed(3))));
}

/** Clamp size for the floating mini panel. */
export function clampPetPanelSize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.max(320, Math.min(1200, Math.round(w))),
    h: Math.max(320, Math.min(1000, Math.round(h))),
  };
}

/**
 * Resize a bottom-right anchored panel from an edge/corner without drifting.
 * Only the dragged edge(s) move; the opposite corner stays fixed in the viewport.
 */
export function computeBottomRightAnchoredResize(input: {
  edge: 'se' | 'e' | 's' | 'sw' | 'ne' | 'n' | 'w' | 'nw';
  dx: number;
  dy: number;
  startW: number;
  startH: number;
  startRight: number;
  startBottom: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  minInset?: number;
}): { w: number; h: number; right: number; bottom: number } {
  const minW = input.minW ?? 320;
  const minH = input.minH ?? 320;
  const maxW = input.maxW ?? 1200;
  const maxH = input.maxH ?? 1000;
  const minInset = input.minInset ?? 8;
  const edge = input.edge;
  let w = input.startW;
  let h = input.startH;
  let right = input.startRight;
  let bottom = input.startBottom;

  // Right edge follows cursor: grow/shrink width and adjust `right` so left edge is fixed.
  if (edge === 'e' || edge === 'se' || edge === 'ne') {
    const desiredW = input.startW + input.dx;
    const clampedW = Math.max(minW, Math.min(maxW, desiredW));
    const appliedDx = clampedW - input.startW;
    w = clampedW;
    right = input.startRight - appliedDx;
  } else if (edge === 'w' || edge === 'sw' || edge === 'nw') {
    // Left edge follows cursor: right edge stays fixed.
    w = Math.max(minW, Math.min(maxW, input.startW - input.dx));
  }

  // Bottom edge follows cursor: grow/shrink height and adjust `bottom` so top edge is fixed.
  if (edge === 's' || edge === 'se' || edge === 'sw') {
    const desiredH = input.startH + input.dy;
    const clampedH = Math.max(minH, Math.min(maxH, desiredH));
    const appliedDy = clampedH - input.startH;
    h = clampedH;
    bottom = input.startBottom - appliedDy;
  } else if (edge === 'n' || edge === 'ne' || edge === 'nw') {
    // Top edge follows cursor: bottom edge stays fixed.
    h = Math.max(minH, Math.min(maxH, input.startH - input.dy));
  }

  return {
    w: Math.round(w),
    h: Math.round(h),
    right: Math.max(minInset, Math.round(right)),
    bottom: Math.max(minInset, Math.round(bottom)),
  };
}
