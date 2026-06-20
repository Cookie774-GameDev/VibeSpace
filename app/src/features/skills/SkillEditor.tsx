/**
 * Inline skill editor — lives inside SkillsPage (not the Files route).
 * Persists preset overrides and custom skills via skillsStore.
 */
import * as React from 'react';
import { RotateCcw, Save, Trash2 } from 'lucide-react';
import type { SkillManifest } from './loader';
import { SKILL_EMOJI_PRESETS, renderSkillMarkdown } from './markdownPreview';
import {
  manifestToCustomPatch,
  manifestToPresetOverride,
} from './skillCatalog';
import { skillRegistry } from './registry';
import { readSkillsStore } from './skillsStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export interface SkillEditorProps {
  manifest: SkillManifest;
  onSaved?: () => void;
  onDeleted?: () => void;
}

function parseTools(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function SkillEditor({ manifest, onSaved, onDeleted }: SkillEditorProps) {
  const id = manifest.catalogId ?? manifest.name;
  const [emoji, setEmoji] = React.useState(manifest.emoji ?? '✨');
  const [title, setTitle] = React.useState(manifest.title);
  const [description, setDescription] = React.useState(manifest.description ?? '');
  const [toolsRaw, setToolsRaw] = React.useState((manifest.tools ?? []).join(', '));
  const [addendum, setAddendum] = React.useState(manifest.systemPromptAddendum ?? '');
  const [body, setBody] = React.useState(manifest.body);
  const [hue, setHue] = React.useState(manifest.colorHue ?? 35);
  const [tab, setTab] = React.useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setEmoji(manifest.emoji ?? '✨');
    setTitle(manifest.title);
    setDescription(manifest.description ?? '');
    setToolsRaw((manifest.tools ?? []).join(', '));
    setAddendum(manifest.systemPromptAddendum ?? '');
    setBody(manifest.body);
    setHue(manifest.colorHue ?? 35);
  }, [manifest]);

  const previewHtml = React.useMemo(() => renderSkillMarkdown(body), [body]);

  const buildDraftManifest = (): SkillManifest => ({
    ...manifest,
    title,
    description,
    emoji,
    tools: parseTools(toolsRaw),
    systemPromptAddendum: addendum,
    body,
    colorHue: hue,
  });

  const onSave = () => {
    setSaving(true);
    try {
      const store = readSkillsStore();
      const draft = buildDraftManifest();
      if (manifest.isPreset) {
        store.setPresetOverride(id, manifestToPresetOverride(draft));
      } else {
        store.updateCustomSkill(id, manifestToCustomPatch(draft));
      }
      skillRegistry.refresh();
      toast.success('Saved', draft.title);
      onSaved?.();
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = () => {
    const label = manifest.isPreset ? `preset "${title}"` : `custom skill "${title}"`;
    if (!window.confirm(`Delete ${label}? You can restore presets from the library header.`)) return;
    const store = readSkillsStore();
    if (manifest.isPreset) {
      store.deletePreset(id);
    } else {
      store.removeCustomSkill(id);
    }
    skillRegistry.refresh();
    toast.success('Deleted', title);
    onDeleted?.();
  };

  const onRestoreDefault = () => {
    if (!manifest.isPreset) return;
    if (!window.confirm(`Restore "${title}" to the factory preset?`)) return;
    readSkillsStore().clearPresetOverride(id);
    skillRegistry.refresh();
    toast.success('Restored', 'Factory preset values');
    onSaved?.();
  };

  const insertMarkdown = (snippet: string) => {
    setBody((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${snippet}` : snippet));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header
        className="px-6 pt-5 pb-4 shrink-0 border-b border-border"
        style={{ borderLeftWidth: 4, borderLeftColor: `hsl(${hue}, 55%, 48%)` }}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex items-center gap-2">
            <Input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              className="w-14 text-center text-xl px-1"
              aria-label="Skill emoji"
            />
            <div className="flex flex-wrap gap-1 max-w-[200px]">
              {SKILL_EMOJI_PRESETS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={cn(
                    'h-7 w-7 rounded-md border border-border text-sm hover:border-accent-copper/60',
                    emoji === e && 'ring-1 ring-accent-copper border-accent-copper/60',
                  )}
                  onClick={() => setEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-[200px] space-y-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="font-display text-lg font-semibold"
              placeholder="Skill name"
            />
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description for /skills picker"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-metadata text-muted-foreground">
          <span className="font-mono">{id}</span>
          <span>·</span>
          <span>{manifest.isPreset ? 'preset' : 'custom'}</span>
          <label className="flex items-center gap-2 ml-auto">
            Hue
            <input
              type="range"
              min={0}
              max={359}
              value={hue}
              onChange={(e) => setHue(Number(e.target.value))}
              className="w-24 accent-[hsl(var(--accent-copper))]"
            />
          </label>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'edit' | 'preview')} className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-3 shrink-0">
          <TabsList>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="edit" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 m-0 scrollbar-hidden">
          <div>
            <div className="eyebrow mb-1.5">Tools (comma-separated)</div>
            <Input
              value={toolsRaw}
              onChange={(e) => setToolsRaw(e.target.value)}
              placeholder="files, terminal, web"
              className="font-mono text-sm"
            />
          </div>
          <div>
            <div className="eyebrow mb-1.5">Runtime instructions</div>
            <Textarea
              value={addendum}
              onChange={(e) => setAddendum(e.target.value)}
              className="min-h-[100px] text-sm leading-relaxed"
              placeholder="Injected into chat when user picks this skill via /skills"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="eyebrow">Library body (markdown)</div>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => insertMarkdown('## Section\n\n')}>
                  Heading
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => insertMarkdown('![caption](https://example.com/image.png)')}
                >
                  Image
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => insertMarkdown('- Item one\n- Item two')}>
                  List
                </Button>
              </div>
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[220px] max-h-[50vh] font-mono text-[12px] leading-relaxed resize-y"
              spellCheck={false}
            />
          </div>
        </TabsContent>

        <TabsContent value="preview" className="flex-1 overflow-y-auto px-6 py-4 m-0 scrollbar-hidden">
          <div
            className="text-body text-foreground rounded-xl border border-border bg-paper/40 p-5 shadow-soft"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </TabsContent>
      </Tabs>

      <Separator />

      <footer className="px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-2 bg-elevated">
        <div className="text-metadata text-muted-foreground truncate font-mono">{manifest.filePath}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {manifest.isPreset ? (
            <Button variant="ghost" size="sm" onClick={onRestoreDefault}>
              <RotateCcw className="h-3.5 w-3.5" />
              Restore default
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
            Delete
          </Button>
          <Button variant="accent" size="sm" onClick={onSave} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </footer>
    </div>
  );
}

export default SkillEditor;
