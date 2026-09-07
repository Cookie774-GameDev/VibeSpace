/**
 * Dedicated entry for Tauri window label `pet-mini-panel`.
 * Boots local auth/DB (AuthGate) then mounts the real mini-panel surfaces.
 */
import * as React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AuthGate } from '@/features/auth/AuthGate';
import { PetMiniPanel } from './PetMiniPanel';
import { applyThemeToDocument, useUIStore } from '@/stores/ui';
import { installPetPresentationStorageSync } from './petPresentationStore';
import { installPetSettingsStorageSync, usePetSettingsStore } from './petSettingsStore';
import { reassertPetOverlayTopmost } from './petTauriBridge';

export interface PetMiniPanelWindowProps {
  runtimeEffectsEnabled?: boolean;
}

export function PetMiniPanelWindow({ runtimeEffectsEnabled = true }: PetMiniPanelWindowProps = {}) {
  const [open, setOpen] = React.useState(true);
  const theme = useUIStore((s) => s.theme);
  const enabled = usePetSettingsStore((s) => s.enabled) ?? true;

  React.useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    const uninstallPresentation = installPetPresentationStorageSync();
    const uninstallSettings = installPetSettingsStorageSync();
    if (!enabled) {
      // This detached WebView owns the panel window. Hide it directly so a
      // disabled boot never enters the native panel path that restores the Pet.
      void getCurrentWindow()
        .hide()
        .catch(() => undefined);
      return () => {
        uninstallPresentation();
        uninstallSettings();
      };
    }
    const recoverTopmost = () => {
      void reassertPetOverlayTopmost().catch(() => undefined);
    };
    recoverTopmost();
    const boot = window.setTimeout(recoverTopmost, 400);
    return () => {
      window.clearTimeout(boot);
      uninstallPresentation();
      uninstallSettings();
    };
  }, [enabled, runtimeEffectsEnabled]);

  const panel =
    !runtimeEffectsEnabled || enabled ? (
      <PetMiniPanel open={open} windowMode onClose={() => setOpen(false)} animLabel="idlePrimary" />
    ) : null;

  return (
    <div
      data-pet-window="pet-mini-panel"
      data-monochrome-surface="pet-mini-panel-window"
      className="h-screen w-screen overflow-hidden bg-transparent [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&_*]:shadow-none"
    >
      {runtimeEffectsEnabled ? <AuthGate>{panel}</AuthGate> : panel}
    </div>
  );
}
