import * as React from 'react';
import { NotebookPen } from 'lucide-react';
import { DevicePreviewPanel } from './DevicePreviewPanel';
import { EditorPanel } from './EditorPanel';
import { EmbeddedSurface, isEmbeddedSurfaceKind } from './EmbeddedSurface';
import { FilesPanel } from './FilesPanel';
import { JarvisPanel } from './JarvisPanel';
import { NotesPanel } from './NotesPanel';
import type { WorkbenchPanel } from './types';

interface ReferencePanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

export function ReferencePanel({ panel, onUpdate }: ReferencePanelProps) {
  if (panel.kind === 'notes') {
    return <NotesPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'editor') {
    return <EditorPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'device-preview') {
    return <DevicePreviewPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'files') {
    return <FilesPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'jarvis') {
    return <JarvisPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (isEmbeddedSurfaceKind(panel.kind)) {
    return <EmbeddedSurface panel={panel} />;
  }

  return (
    <div className="workbench-reference-panel" data-workbench-reference={panel.kind}>
      <div className="workbench-reference-orbit" aria-hidden="true">
        <NotebookPen className="h-7 w-7" />
      </div>
      <div>
        <p className="workbench-reference-kicker">Workbench panel</p>
        <h3>{panel.title}</h3>
        <p>This panel type is not mapped to a live surface yet.</p>
      </div>
    </div>
  );
}
