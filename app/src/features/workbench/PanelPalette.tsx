import * as React from 'react';
import {
  Activity,
  AppWindow,
  Bot,
  Boxes,
  Code2,
  FileText,
  FileStack,
  Globe2,
  KanbanSquare,
  Network,
  NotebookPen,
  PanelLeft,
  PlugZap,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { WorkbenchPanelKind } from './types';
import type { NativeAppDescriptor } from './nativeApps';
import type { PluginManifest } from '@/features/plugins';
import { PluginLogo } from '@/features/plugins';
import { CreativeTools } from './CreativeTools';

const palette: Array<{
  kind: WorkbenchPanelKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { kind: 'terminal', label: 'Terminal', icon: Terminal },
  { kind: 'browser', label: 'Browser', icon: Globe2 },
  { kind: 'jarvis', label: 'Jarvis', icon: Bot },
  { kind: 'agent', label: 'Agent', icon: Sparkles },
  { kind: 'files', label: 'Files', icon: FileText },
  { kind: 'editor', label: 'Editor', icon: Code2 },
  { kind: 'artifact-reference', label: 'Artifact', icon: FileStack },
  { kind: 'kanban', label: 'Kanban', icon: KanbanSquare },
  { kind: 'actions', label: 'Actions', icon: Boxes },
  { kind: 'notes', label: 'Notes', icon: NotebookPen },
  { kind: 'diagram', label: 'Diagram', icon: Network },
  { kind: 'plugins', label: 'Plugins', icon: PlugZap },
  { kind: 'tools', label: 'Tools', icon: Wrench },
  { kind: 'activity', label: 'Activity', icon: Activity },
];

export const WORKBENCH_DRAG_MIME = 'application/x-vibespace-workbench-panel';

interface PanelPaletteProps {
  onAdd: (kind: WorkbenchPanelKind, pluginId?: string) => void;
  pinnedPlugins?: readonly PluginManifest[];
  detectedApps?: readonly NativeAppDescriptor[];
  onOpenNativeApp?: (app: NativeAppDescriptor) => void;
  onOpenNativeAppPicker?: () => void;
  open?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
}

export function PanelPalette({
  onAdd,
  pinnedPlugins = [],
  detectedApps = [],
  onOpenNativeApp,
  onOpenNativeAppPicker,
  open = true,
  onClose,
  onOpen,
}: PanelPaletteProps) {
  if (!open) {
    return (
      <div className="workbench-palette-collapsed" aria-label="Workbench panels collapsed">
        <button
          type="button"
          className="workbench-palette-reopen [html[data-theme=monochrome]_&]:focus-visible:outline [html[data-theme=monochrome]_&]:focus-visible:outline-2 [html[data-theme=monochrome]_&]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&]:focus-visible:outline-ring"
          aria-label="Open panels"
          title="Open panels"
          onClick={() => onOpen?.()}
        >
          <PanelLeft aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <aside className="workbench-palette" aria-label="Workbench panels">
      <div className="workbench-palette-head">
        <p>Panels</p>
      </div>
      <div className="workbench-palette-items">
        <CreativeTools />
        {detectedApps
          .filter((app) => app.pinned)
          .map((app) => (
            <button
              key={`native:${app.id}:${app.path ?? ''}`}
              type="button"
              disabled={!app.launchable}
              aria-label={`Open ${app.name}`}
              title={app.running ? `${app.name} · running` : app.name}
              onClick={() => onOpenNativeApp?.(app)}
            >
              <AppWindow aria-hidden="true" />
              <span>{app.name}</span>
            </button>
          ))}
        <button
          type="button"
          aria-label="Open app"
          title="Open app"
          onClick={onOpenNativeAppPicker}
        >
          <AppWindow aria-hidden="true" />
          <span>Apps</span>
        </button>
        {palette.map(({ kind, label, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            className="[html[data-theme=monochrome]_&]:focus-visible:outline [html[data-theme=monochrome]_&]:focus-visible:outline-2 [html[data-theme=monochrome]_&]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&]:focus-visible:outline-ring"
            aria-label={`Add ${label}`}
            draggable
            onClick={() => onAdd(kind)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(WORKBENCH_DRAG_MIME, JSON.stringify({ version: 1, kind }));
            }}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
        {pinnedPlugins.map((plugin) => (
          <button
            key={`plugin:${plugin.id}`}
            type="button"
            aria-label={`Add ${plugin.name}`}
            title={plugin.name}
            onClick={() => onAdd('plugin', plugin.id)}
          >
            <PluginLogo plugin={plugin} />
            <span>{plugin.name}</span>
          </button>
        ))}
      </div>
      <div className="workbench-palette-foot">
        <button
          type="button"
          className="workbench-palette-close [html[data-theme=monochrome]_&]:focus-visible:outline [html[data-theme=monochrome]_&]:focus-visible:outline-2 [html[data-theme=monochrome]_&]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&]:focus-visible:outline-ring"
          aria-label="Close panels"
          title="Close panels"
          onClick={() => onClose?.()}
        >
          <X aria-hidden="true" strokeWidth={2.25} />
        </button>
      </div>
    </aside>
  );
}
