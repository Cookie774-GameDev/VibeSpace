import * as React from 'react';
import {
  LayoutTemplate,
  LocateFixed,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Redo2,
  Save,
  Sparkles,
  Undo2,
  Wallpaper,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { useFullscreenStore } from '@/features/fullscreen';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import {
  PLUGIN_CATALOG,
  selectPinnedPluginIdsForAccount,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from '@/features/plugins';
import { HoldExitButton } from './HoldExitButton';
import { PanelPalette } from './PanelPalette';
import { TemplatePicker } from './TemplatePicker';
import { WallpaperHost } from './WallpaperHost';
import { WallpaperPicker } from './WallpaperPicker';
import { WorkbenchCanvas } from './WorkbenchCanvas';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { useWorkbenchStore } from './store';
import { setWorkbenchNativeWindowTitle } from './window';
import type { WorkbenchPanelKind } from './types';
import type { PluginManifest } from '@/features/plugins';
import { DEFAULT_WORKBENCH_NAME } from './workbenchName';
import './workbench.css';

const WORKBENCH_PALETTE_REVEAL_PX = 72;

export function WorkbenchPage() {
  const setRoute = useUIStore((state) => state.setRoute);
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const pinnedPluginIds = usePluginStore((state) =>
    selectPinnedPluginIdsForAccount(state, accountId),
  );
  const pluginConnections = usePluginStore((state) =>
    selectPluginConnectionsForAccount(state, accountId),
  );
  const pinnedPlugins = React.useMemo(
    () =>
      pinnedPluginIds
        .map((id) => PLUGIN_CATALOG.find((plugin) => plugin.id === id))
        .filter(
          (plugin): plugin is PluginManifest =>
            plugin !== undefined &&
            pluginConnections[plugin.id]?.state === 'connected' &&
            pluginConnections[plugin.id]?.enabled,
        ),
    [pinnedPluginIds, pluginConnections],
  );
  const systemActive = useFullscreenStore((state) => state.systemActive);
  const nativePending = useFullscreenStore((state) => state.nativePending);
  const nativeAvailability = useFullscreenStore((state) => state.nativeAvailability);
  const toggleSystem = useFullscreenStore((state) => state.toggleSystem);
  const wallpaper = useWorkbenchStore((state) => state.wallpaper);
  const configureWallpaper = useWorkbenchStore((state) => state.configureWallpaper);
  const addPanel = useWorkbenchStore((state) => state.addPanel);
  const fitView = useWorkbenchStore((state) => state.fitView);
  const undo = useWorkbenchStore((state) => state.undo);
  const redo = useWorkbenchStore((state) => state.redo);
  const history = useWorkbenchStore((state) => state.history);
  const future = useWorkbenchStore((state) => state.future);
  const warning = useWorkbenchStore((state) => state.persistenceWarning);
  const persistenceError = useWorkbenchStore((state) => state.persistenceError);
  const name = useWorkbenchStore((state) => state.name);
  const setName = useWorkbenchStore((state) => state.setName);
  const flushPersistence = useWorkbenchStore((state) => state.flushPersistence);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [saveFocus, setSaveFocus] = React.useState(false);
  const [wallpapersOpen, setWallpapersOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(true);
  const [paletteReveal, setPaletteReveal] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState(name);

  React.useEffect(() => {
    setNameDraft(name);
  }, [name]);

  React.useEffect(() => {
    void setWorkbenchNativeWindowTitle(name);
  }, [name]);

  React.useEffect(() => {
    if (warning) toast.warning('Workbench recovered', warning);
  }, [warning]);

  React.useEffect(() => {
    if (persistenceError) toast.warning('Workbench save issue', persistenceError);
  }, [persistenceError]);

  React.useEffect(() => {
    const onHide = () => {
      flushPersistence();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [flushPersistence]);

  const openTemplates = (focusSave = false) => {
    setSaveFocus(focusSave);
    setTemplatesOpen(true);
  };

  const closeTemplates = () => {
    setTemplatesOpen(false);
    setSaveFocus(false);
  };

  const commitName = () => {
    if (!setName(nameDraft)) {
      setNameDraft(name || DEFAULT_WORKBENCH_NAME);
      toast.warning('Invalid name', 'Workbench name cannot be empty.');
      return;
    }
    flushPersistence();
  };

  const add = (kind: WorkbenchPanelKind, pluginId?: string) => {
    const id = addPanel(kind, undefined, pluginId ? { pluginId } : undefined);
    if (!id) toast.warning('Could not add panel', 'Panel limit reached.');
  };

  const toggleSystemFullscreen = async () => {
    const previous = systemActive;
    const observed = await toggleSystem();
    if (observed === previous) {
      const message = useFullscreenStore.getState().error;
      if (message) toast.warning('Fullscreen unavailable', message);
    }
  };

  const exitWorkbench = () => {
    const saved = flushPersistence();
    if (saved.ok === false && !saved.skipped) {
      toast.warning(
        'Save issue on exit',
        'Workbench could not fully persist — check storage space. Leaving Workbench anyway.',
      );
    } else {
      toast.success('Workbench saved', 'Layout and preferences were stored.');
    }
    setRoute('chat');
  };

  return (
    <main
      className="workbench-shell workbench-shell--fullscreen [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans"
      aria-label="VibeSpace Workbench"
      data-monochrome-route="workbench"
      data-sakura-route="workbench"
      data-sakura-intensity="standard"
      data-jarvis-suppress-context-menu
      data-system-fullscreen={systemActive ? 'true' : 'false'}
    >
      <WallpaperHost config={wallpaper} />
      <WorkbenchContextMenu />
      <header
        data-monochrome-surface="workbench-toolbar"
        data-sakura-surface="workbench-toolbar"
        className="workbench-toolbar [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-b [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none"
      >
        <div className="workbench-wordmark">
          <span>
            <Sparkles />
          </span>
          <div className="workbench-title-block">
            <p>Spatial runtime</p>
            <label className="workbench-name-label" htmlFor="workbench-name-input">
              <span className="sr-only">Workbench name</span>
              <input
                id="workbench-name-input"
                className="workbench-name-input"
                value={nameDraft}
                maxLength={80}
                aria-label="Workbench name"
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
            </label>
          </div>
        </div>
        <div className="workbench-toolbar-actions">
          <Button
            type="button"
            size="sm"
            variant="accent"
            aria-label="Save Workbench"
            onClick={() => openTemplates(true)}
          >
            <Save /> Save layout
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Templates"
            onClick={() => openTemplates(false)}
          >
            <LayoutTemplate /> Templates
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Wallpapers"
            onClick={() => setWallpapersOpen(true)}
          >
            <Wallpaper /> Wallpapers
          </Button>
          <span className="workbench-toolbar-divider" />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Undo"
            disabled={!history.length}
            onClick={undo}
          >
            <Undo2 />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Redo"
            disabled={!future.length}
            onClick={redo}
          >
            <Redo2 />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Recenter workspace"
            title="Recenter view — does not move your panels"
            onClick={() => fitView()}
          >
            <LocateFixed />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={wallpaper.paused ? 'Resume wallpaper' : 'Pause wallpaper'}
            onClick={() => configureWallpaper({ paused: !wallpaper.paused })}
          >
            {wallpaper.paused ? <Play /> : <Pause />}
          </Button>
          <span className="workbench-toolbar-divider" />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle system fullscreen"
            title={systemActive ? 'Exit system fullscreen' : 'Enter system fullscreen'}
            disabled={nativePending || nativeAvailability !== 'available'}
            onClick={() => void toggleSystemFullscreen()}
          >
            {systemActive ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <HoldExitButton onConfirmExit={exitWorkbench} />
        </div>
      </header>
      <div
        data-monochrome-surface="workbench-canvas"
        data-sakura-content="workbench-canvas"
        className="workbench-content [html[data-theme=monochrome]_&]:bg-background"
        data-palette-revealed={paletteReveal ? 'true' : 'false'}
        onPointerMove={(event) => {
          if (!systemActive) return;
          setPaletteReveal(event.clientX <= WORKBENCH_PALETTE_REVEAL_PX);
        }}
        onPointerLeave={() => setPaletteReveal(false)}
      >
        <PanelPalette
          onAdd={add}
          pinnedPlugins={pinnedPlugins}
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpen={() => setPaletteOpen(true)}
        />
        <WorkbenchCanvas />
      </div>
      {systemActive && (
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="workbench-system-fullscreen-exit"
          aria-label="Toggle system fullscreen"
          title="Exit system fullscreen"
          onClick={() => void toggleSystemFullscreen()}
        >
          <Minimize2 />
        </Button>
      )}
      <TemplatePicker open={templatesOpen} focusSave={saveFocus} onClose={closeTemplates} />
      <WallpaperPicker open={wallpapersOpen} onClose={() => setWallpapersOpen(false)} />
    </main>
  );
}

export default WorkbenchPage;
