import * as React from 'react';
import { Eye, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { describeFsError, readTextFile, writeTextFile } from '@/lib/fs';
import { useAuthStore } from '@/stores/auth';
import {
  basename,
  extension,
  getStoredProjectRoot,
  isPopularTextFile,
} from '@/features/files/projectFiles';
import {
  WORKBENCH_DEVICE_PRESETS,
  defaultOrientationForPreset,
  getDevicePreset,
} from '@/features/preview/previewDevices';
import type { WorkbenchPanel } from './types';
import { EDITOR_LANGUAGES } from './editorLanguages';
import { buildDevicePreviewDocument } from './editorPreview';
import { useWorkbenchStore } from './store';
import { WorkbenchSaveControls } from './WorkbenchSaveControls';
import {
  extensionForLanguage,
  fsOptionsForWorkbenchPath,
  isWorkbenchDesktopSavePath,
  loadWorkbenchDocument,
  overwriteWorkbenchDocument,
  saveWorkbenchDocument,
  type WorkbenchSavedFile,
} from './workbenchLocalFiles';

interface EditorPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

/**
 * Editor stays code-only. Choosing a device + Preview opens a **separate**
 * Workbench panel tab that renders exact CSS viewport sizes for that device.
 */
export function EditorPanel({ panel, onUpdate }: EditorPanelProps) {
  const projectId = useAuthStore((state) => state.projectId);
  const rootDir = getStoredProjectRoot(projectId);
  const openDevicePreview = useWorkbenchStore((s) => s.openDevicePreview);
  const filePath = panel.settings.filePath;
  const [content, setContent] = React.useState(panel.settings.note ?? '');
  const [savedContent, setSavedContent] = React.useState(panel.settings.note ?? '');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const lang = (
    panel.settings.language ||
    (filePath ? extension(filePath) : 'html') ||
    'html'
  ).toLowerCase();
  const deviceId = String(panel.settings.previewDeviceId || 'iphone-15');
  const dirty = content !== savedContent;
  const preset = getDevicePreset(deviceId);
  const suggestedSaveName =
    (filePath ? basename(filePath) : panel.title || 'untitled').replace(/\.[^.]+$/, '').trim() ||
    'untitled';

  React.useEffect(() => {
    if (!filePath) {
      setContent(panel.settings.note ?? '');
      setSavedContent(panel.settings.note ?? '');
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Desktop/VibeSpace saves must not pass project root (outside_root).
    void readTextFile(filePath, fsOptionsForWorkbenchPath(filePath, rootDir)).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(describeFsError(result.error));
        onUpdate({ status: 'error' });
        return;
      }
      setContent(result.content);
      setSavedContent(result.content);
      onUpdate({ status: 'ready' });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, rootDir]);

  // Keep open device-preview tabs for this editor in sync while typing (no history spam).
  React.useEffect(() => {
    const store = useWorkbenchStore.getState();
    const previews = store.panels.filter(
      (p) => p.kind === 'device-preview' && p.settings.sourcePanelId === panel.id,
    );
    if (!previews.length) return;
    const doc = buildDevicePreviewDocument(lang, content);
    for (const preview of previews) {
      store.updatePanel(
        preview.id,
        {
          settings: {
            ...preview.settings,
            previewDocument: doc,
            language: lang,
            previewLabel: filePath ? basename(filePath) : 'draft',
          },
        },
        { recordHistory: false },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, lang]);

  const hasExistingFile = Boolean(filePath && !filePath.startsWith('download://'));

  /** Overwrite the currently open file (Save). */
  const saveExisting = async () => {
    if (!filePath || filePath.startsWith('download://')) {
      return;
    }
    setSaving(true);
    try {
      onUpdate({
        settings: { ...panel.settings, note: content.slice(0, 40_000), language: lang },
      });
      // Desktop VibeSpace path or project path — never create a second file.
      if (isWorkbenchDesktopSavePath(filePath)) {
        const result = await overwriteWorkbenchDocument(filePath, content);
        if (!result.ok) {
          toast.warning('Save failed', result.reason);
          return;
        }
      } else {
        if (!isPopularTextFile(filePath)) {
          toast.warning('Cannot save this file type from Workbench');
          return;
        }
        const result = await writeTextFile(
          filePath,
          content,
          fsOptionsForWorkbenchPath(filePath, rootDir),
        );
        if (!result.ok) {
          toast.warning('Save blocked', result.error.raw || describeFsError(result.error));
          return;
        }
      }
      setSavedContent(content);
      onUpdate({ status: 'ready' });
      toast.success('Saved', basename(filePath));
    } finally {
      setSaving(false);
    }
  };

  /** Save As — always a named Desktop copy (may create a new file). */
  const saveAsDesktop = async (name: string) => {
    setSaving(true);
    try {
      onUpdate({
        settings: { ...panel.settings, note: content.slice(0, 40_000), language: lang },
      });
      const result = await saveWorkbenchDocument({
        kind: 'editor',
        displayName: name,
        content,
        extension: extensionForLanguage(lang),
      });
      if (!result.ok) {
        toast.warning('Save failed', result.reason);
        return;
      }
      setSavedContent(content);
      onUpdate({
        title: result.entry.name.slice(0, 80),
        status: 'ready',
        settings: {
          ...panel.settings,
          note: content.slice(0, 40_000),
          language: lang,
          filePath: result.path.startsWith('download://') ? panel.settings.filePath : result.path,
        },
      });
      toast.success(
        'Saved as',
        result.path.startsWith('download://')
          ? result.entry.fileName
          : `Desktop\\VibeSpace\\editor\\${result.entry.fileName}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const openSaved = async (entry: WorkbenchSavedFile) => {
    const loaded = await loadWorkbenchDocument(entry.path);
    if (!loaded.ok) {
      toast.warning('Could not open', loaded.reason);
      return;
    }
    setContent(loaded.content);
    setSavedContent(loaded.content);
    onUpdate({
      title: entry.name.slice(0, 80),
      status: 'ready',
      settings: {
        ...panel.settings,
        filePath: entry.path,
        note: loaded.content.slice(0, 40_000),
        language: entry.extension || lang,
      },
    });
    toast.success('Opened', entry.fileName);
  };

  const onChange = (value: string) => {
    setContent(value);
    if (!filePath) {
      onUpdate({
        settings: { ...panel.settings, note: value.slice(0, 40_000) },
        status: 'busy',
      });
    } else {
      onUpdate({ status: 'busy' });
    }
  };

  const openPreviewTab = () => {
    const id = openDevicePreview({
      sourcePanelId: panel.id,
      deviceId,
      language: lang,
      content,
      label: filePath ? basename(filePath) : 'draft',
      orientation: defaultOrientationForPreset(preset),
      zoom: preset.category === 'phone' ? 0.55 : preset.category === 'tablet' ? 0.4 : 0.35,
    });
    if (!id) {
      toast.warning('Could not open device preview');
      return;
    }
    onUpdate({ settings: { ...panel.settings, previewDeviceId: deviceId, language: lang } });
    toast.success('Device preview opened', `${preset.name} · ${preset.width}×${preset.height}`);
  };

  return (
    <div className="workbench-editor" data-testid="workbench-editor-panel">
      <div className="workbench-editor-toolbar">
        <span className="workbench-editor-path" title={filePath || 'Untitled draft'}>
          {filePath ? basename(filePath) : 'Untitled draft'}
          {dirty ? ' •' : ''}
        </span>

        <label className="workbench-editor-field">
          <span className="sr-only">File type</span>
          <select
            aria-label="File type"
            value={lang}
            onChange={(e) =>
              onUpdate({ settings: { ...panel.settings, language: e.target.value } })
            }
          >
            {EDITOR_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
            {!EDITOR_LANGUAGES.some((l) => l.id === lang) ? (
              <option value={lang}>{lang}</option>
            ) : null}
          </select>
        </label>

        <label className="workbench-editor-field">
          <span className="sr-only">Device</span>
          <select
            aria-label="Preview device"
            value={deviceId}
            onChange={(e) =>
              onUpdate({ settings: { ...panel.settings, previewDeviceId: e.target.value } })
            }
          >
            {WORKBENCH_DEVICE_PRESETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.width}×{d.height})
              </option>
            ))}
          </select>
        </label>

        <Button type="button" size="sm" variant="accent" onClick={openPreviewTab}>
          <Eye />
          <Smartphone />
          Open {preset.name} preview
        </Button>

        <WorkbenchSaveControls
          kind="editor"
          suggestedName={suggestedSaveName}
          hasExistingFile={hasExistingFile}
          dirty={dirty}
          saving={saving}
          onSave={saveExisting}
          onSaveAs={saveAsDesktop}
          onOpenSaved={openSaved}
        />
      </div>

      {loading ? <p className="workbench-files-muted">Loading file…</p> : null}
      {error ? (
        <div className="workbench-panel-empty" role="alert">
          <strong>Could not open file</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {!loading && !error ? (
        <div className="workbench-editor-single">
          <textarea
            aria-label="Editor content"
            value={content}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            placeholder="Write HTML, CSS, Markdown… then pick a device and Open preview (separate tab)."
          />
        </div>
      ) : null}
    </div>
  );
}
