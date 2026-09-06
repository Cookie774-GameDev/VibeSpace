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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { useFullscreenStore } from '@/features/fullscreen';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import {
  PLUGIN_CATALOG,
  isPluginActive,
  selectPinnedPluginIdsForAccount,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from '@/features/plugins';
import { HoldExitButton } from './HoldExitButton';
import { NativeAppPickerDialog } from './NativeAppPickerDialog';
import { PanelPalette } from './PanelPalette';
import { TemplatePicker } from './TemplatePicker';
import { WallpaperHost } from './WallpaperHost';
import { WallpaperPicker } from './WallpaperPicker';
import { WorkbenchCanvas } from './WorkbenchCanvas';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { ArtifactReferenceResolverProvider } from './ReferencePanel';
import { useWorkbenchStore } from './store';
import { listNativeApps, pickNativeAppExecutable, type NativeAppDescriptor } from './nativeApps';
import { openNativeAppPanel } from './nativeAppPanels';
import { mergeNativeAppPins, readNativeAppPins, updateNativeAppPin } from './nativeAppPins';
import { setWorkbenchNativeWindowTitle } from './window';
import type { WorkbenchPanelKind } from './types';
import type { PluginManifest } from '@/features/plugins';
import { DEFAULT_WORKBENCH_NAME } from './workbenchName';
import { jarvisArtifactRepo } from '@/lib/db/jarvisRepositories';
import { projectJarvisArtifactReference } from '@/features/jarvis-command-center/artifactAccess';
import './workbench.css';

const WORKBENCH_PALETTE_REVEAL_PX = 72;
const ARTIFACT_DIGEST = /^[a-f0-9]{64}$/u;

type ArtifactChoice = Readonly<{
  artifactId: string;
  artifactDigest: string;
  title: string;
}>;

export function WorkbenchPage() {
  const setRoute = useUIStore((state) => state.setRoute);
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const projectId = useAuthStore((state) => state.projectId);
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
            plugin !== undefined && isPluginActive(accountId, plugin.id, projectId),
        ),
    [accountId, pinnedPluginIds, pluginConnections, projectId],
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
  const [artifactPickerOpen, setArtifactPickerOpen] = React.useState(false);
  const [artifactChoices, setArtifactChoices] = React.useState<readonly ArtifactChoice[]>([]);
  const [nativeApps, setNativeApps] = React.useState<readonly NativeAppDescriptor[]>([]);
  const pinStorageKey = `vibespace.workbench.app-pins.v1:${accountId}`;
  const [pinState, setPinState] = React.useState<{ key: string; apps: NativeAppDescriptor[] }>(
    () => {
      try {
        return { key: pinStorageKey, apps: readNativeAppPins(localStorage.getItem(pinStorageKey)) };
      } catch {
        return { key: pinStorageKey, apps: [] };
      }
    },
  );
  React.useEffect(() => {
    const reload = () => {
      try {
        setPinState({
          key: pinStorageKey,
          apps: readNativeAppPins(localStorage.getItem(pinStorageKey)),
        });
      } catch {
        setPinState({ key: pinStorageKey, apps: [] });
      }
    };
    reload();
    const sync = (event: StorageEvent) => {
      if (event.key === pinStorageKey || event.key === null) reload();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [pinStorageKey]);
  const appsWithPins = React.useMemo(
    () => mergeNativeAppPins(nativeApps, pinState.key === pinStorageKey ? pinState.apps : []),
    [nativeApps, pinState, pinStorageKey],
  );
  const toggleNativeAppPin = (app: NativeAppDescriptor) => {
    try {
      const next = updateNativeAppPin(readNativeAppPins(localStorage.getItem(pinStorageKey)), app);
      localStorage.setItem(pinStorageKey, JSON.stringify(next));
      setPinState({ key: pinStorageKey, apps: next });
    } catch {
      toast.error('Could not save app pins', 'Storage is unavailable. Try again.');
    }
  };
  const [nativeAppPickerOpen, setNativeAppPickerOpen] = React.useState(false);
  const [nativeAppsLoading, setNativeAppsLoading] = React.useState(true);
  const [nativeAppCatalogError, setNativeAppCatalogError] = React.useState<string | null>(null);
  const [artifactPickerState, setArtifactPickerState] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const artifactRequestGeneration = React.useRef(0);

  React.useEffect(() => {
    let current = true;
    setNativeAppsLoading(true);
    void listNativeApps()
      .then((apps) => {
        if (!current) return;
        setNativeApps(apps);
        setNativeAppCatalogError(null);
      })
      .catch((cause) => {
        if (!current) return;
        setNativeApps([]);
        setNativeAppCatalogError(
          cause instanceof Error ? cause.message : 'Native app catalog unavailable.',
        );
      })
      .finally(() => {
        if (current) setNativeAppsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [nativeAppPickerOpen]);

  React.useEffect(() => {
    artifactRequestGeneration.current += 1;
    setArtifactPickerOpen(false);
    setArtifactChoices([]);
    setArtifactPickerState('idle');
  }, [accountId]);

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

  const openArtifactPicker = () => {
    const generation = ++artifactRequestGeneration.current;
    setArtifactPickerOpen(true);
    setArtifactChoices([]);
    if (!accountId) {
      setArtifactPickerState('error');
      return;
    }
    setArtifactPickerState('loading');
    void jarvisArtifactRepo
      .listByAccount(accountId, 100)
      .then((artifacts) => {
        if (generation !== artifactRequestGeneration.current) return;
        const choices = artifacts.flatMap((artifact): ArtifactChoice[] => {
          const reference = projectJarvisArtifactReference(artifact);
          return reference &&
            typeof artifact.contentHash === 'string' &&
            ARTIFACT_DIGEST.test(artifact.contentHash)
            ? [
                {
                  artifactId: reference.artifactId,
                  artifactDigest: artifact.contentHash,
                  title: reference.title,
                },
              ]
            : [];
        });
        setArtifactChoices(choices);
        setArtifactPickerState('ready');
      })
      .catch(() => {
        if (generation !== artifactRequestGeneration.current) return;
        setArtifactPickerState('error');
      });
  };

  const addArtifact = (choice: ArtifactChoice) => {
    const id = addPanel('artifact-reference', undefined, {
      artifactId: choice.artifactId,
      artifactDigest: choice.artifactDigest,
    });
    if (!id) {
      toast.warning('Could not add artifact', 'Panel limit reached.');
      return;
    }
    flushPersistence();
    setArtifactPickerOpen(false);
  };

  const add = (kind: WorkbenchPanelKind, pluginId?: string) => {
    if (kind === 'artifact-reference') {
      openArtifactPicker();
      return;
    }
    const id = addPanel(kind, undefined, pluginId ? { pluginId } : undefined);
    if (!id) toast.warning('Could not add panel', 'Panel limit reached.');
  };

  const openNativeApp = (app: NativeAppDescriptor) => {
    const id = openNativeAppPanel(app);
    if (!id) {
      toast.warning('Could not open app', 'The Workbench panel limit was reached.');
      return;
    }
    flushPersistence();
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
          detectedApps={appsWithPins}
          onOpenNativeApp={openNativeApp}
          onOpenNativeAppPicker={() => setNativeAppPickerOpen(true)}
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpen={() => setPaletteOpen(true)}
        />
        <ArtifactReferenceResolverProvider accountId={accountId} repository={jarvisArtifactRepo}>
          <WorkbenchCanvas />
        </ArtifactReferenceResolverProvider>
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
      <NativeAppPickerDialog
        open={nativeAppPickerOpen}
        apps={appsWithPins}
        loading={nativeAppsLoading}
        onTogglePin={toggleNativeAppPin}
        error={nativeAppCatalogError}
        onOpenChange={setNativeAppPickerOpen}
        onChoose={openNativeApp}
        onPickExecutable={pickNativeAppExecutable}
      />
      <TemplatePicker open={templatesOpen} focusSave={saveFocus} onClose={closeTemplates} />
      <WallpaperPicker open={wallpapersOpen} onClose={() => setWallpapersOpen(false)} />
      <Dialog
        open={artifactPickerOpen}
        onOpenChange={(open) => {
          if (!open) artifactRequestGeneration.current += 1;
          setArtifactPickerOpen(open);
        }}
      >
        <DialogContent aria-label="Open artifact">
          <DialogHeader>
            <DialogTitle>Open artifact</DialogTitle>
            <DialogDescription>
              Choose a canonical account artifact. Workbench stores only its opaque identity and
              digest, then revalidates the preview whenever it opens.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto" role="list">
            {artifactPickerState === 'loading' ? <p role="status">Loading artifacts…</p> : null}
            {artifactPickerState === 'error' ? (
              <p role="alert">Artifact catalog unavailable for this account.</p>
            ) : null}
            {artifactPickerState === 'ready' && artifactChoices.length === 0 ? (
              <p role="status">No verified artifacts are available yet.</p>
            ) : null}
            {artifactChoices.map((choice) => (
              <Button
                key={choice.artifactId}
                type="button"
                variant="outline"
                className="w-full justify-start"
                aria-label={`Open ${choice.title}`}
                onClick={() => addArtifact(choice)}
              >
                {choice.title}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export default WorkbenchPage;
