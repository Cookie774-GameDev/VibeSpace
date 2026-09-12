import * as React from 'react';
import { Download, Edit3, History, Save, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { useJarvisLearningStore } from './learningStore';

export interface JarvisLearningControlsProps {
  onExport?: (markdown: string) => void;
}

function downloadMarkdown(markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'learning.md';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function JarvisLearningControls({ onExport = downloadMarkdown }: JarvisLearningControlsProps) {
  const activeAccountId = useJarvisLearningStore((state) => state.activeAccountId);
  const profile = useJarvisLearningStore((state) => state.profiles[activeAccountId]);
  const setEnabled = useJarvisLearningStore((state) => state.setEnabled);
  const edit = useJarvisLearningStore((state) => state.edit);
  const remove = useJarvisLearningStore((state) => state.remove);
  const clear = useJarvisLearningStore((state) => state.clear);
  const undo = useJarvisLearningStore((state) => state.undo);
  const exportMarkdown = useJarvisLearningStore((state) => state.exportMarkdown);
  const historyCount = useJarvisLearningStore((state) => state.history[activeAccountId]?.length ?? 0);
  const [editingId, setEditingId] = React.useState<string>();
  const [draft, setDraft] = React.useState('');
  const [clearArmed, setClearArmed] = React.useState(false);

  if (!profile) return null;
  const recent = [...profile.items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);

  const beginEdit = (id: string, value: string) => {
    setEditingId(id);
    setDraft(value);
  };
  const saveEdit = () => {
    if (!editingId || !edit(editingId, { value: draft })) return;
    setEditingId(undefined);
    setDraft('');
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-panel" aria-labelledby="jarvis-learning-title">
      <header className="flex items-start justify-between gap-4 border-b border-border/70 p-4">
        <div>
          <h3 id="jarvis-learning-title" className="text-ui-strong text-foreground">Jarvis learning.md</h3>
          <p className="mt-1 max-w-2xl text-metadata text-muted-foreground">
            Account-scoped preferences kept separately from AllAboutMe.md. Credentials and raw chat are never stored.
          </p>
        </div>
        <Switch
          aria-label="Jarvis learning enabled"
          checked={profile.enabled}
          onCheckedChange={setEnabled}
        />
      </header>

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="default" onClick={() => onExport(exportMarkdown())} aria-label="Export learning.md">
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          <Button size="sm" variant="ghost" onClick={() => undo()} disabled={historyCount === 0} aria-label="Undo memory change">
            <History className="h-3.5 w-3.5" /> Undo
          </Button>
          {!clearArmed ? (
            <Button size="sm" variant="ghost" onClick={() => setClearArmed(true)} disabled={!recent.length} aria-label="Clear all learning">
              <Trash2 className="h-3.5 w-3.5" /> Clear all
            </Button>
          ) : (
            <div className="flex items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-1">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => { clear(); setClearArmed(false); }}
                aria-label="Confirm clear learning"
              >
                Confirm clear
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setClearArmed(false)} aria-label="Cancel clear learning">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <span className="ml-auto text-metadata text-muted-foreground">
            {profile.meaningfulMessageCount % 20}/20 until review
          </span>
        </div>

        {recent.length ? (
          <ul className="divide-y divide-border/60 rounded-md border border-border bg-background/35">
            {recent.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
                <span className="mt-0.5 rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.category}
                </span>
                <div className="min-w-0 flex-1">
                  {editingId === item.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        aria-label="Memory value"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-secondary text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <Button size="icon" variant="default" className="h-8 w-8" onClick={saveEdit} aria-label="Save memory">
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-secondary text-foreground">{item.value}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {item.source.kind} · confidence {Math.round(item.confidence * 100)}%
                      </p>
                    </>
                  )}
                </div>
                {editingId !== item.id && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => beginEdit(item.id, item.value)} aria-label={`Edit memory ${item.id}`}>
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(item.id)} aria-label={`Remove memory ${item.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-md border border-dashed border-border px-4 py-5 text-secondary text-muted-foreground">
            No learned preferences yet. Say “Remember that…” for an immediate, visible entry.
          </div>
        )}
      </div>
    </section>
  );
}
