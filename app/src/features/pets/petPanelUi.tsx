/**
 * Pet mini-panel UI scale context — children (composer, pickers) densify and
 * scale with the live panel size. Token optimization is not offered in-panel.
 */
import * as React from 'react';
import type { PetPanelDensity } from './petPanelPreferences';
import { petPanelUiScale } from './petPanelPreferences';

export type PetPanelUiValue = Readonly<{
  density: PetPanelDensity;
  /** Continuous UI scale in [0.65, 1]. */
  scale: number;
  width: number;
  height: number;
}>;

const PetPanelUiContext = React.createContext<PetPanelUiValue | null>(null);

export function PetPanelUiProvider({
  density,
  width,
  height,
  children,
}: {
  density: PetPanelDensity;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  const value = React.useMemo<PetPanelUiValue>(
    () => ({
      density,
      scale: petPanelUiScale(width, height),
      width,
      height,
    }),
    [density, width, height],
  );
  return <PetPanelUiContext.Provider value={value}>{children}</PetPanelUiContext.Provider>;
}

/** Null when not inside the pet mini panel. */
export function usePetPanelUi(): PetPanelUiValue | null {
  return React.useContext(PetPanelUiContext);
}

export function useIsPetMiniPanel(): boolean {
  return React.useContext(PetPanelUiContext) !== null;
}
