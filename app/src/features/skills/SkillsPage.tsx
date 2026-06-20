/**
 * SkillsPage — unified library: 16 built-in presets + user custom skills.
 * Inline SkillEditor on the right (no Files route navigation).
 */
import * as React from 'react';
import { ArrowLeft, Plus, RotateCcw, Search } from 'lucide-react';
import type { SkillManifest } from '@/features/skills/loader';
import { skillRegistry } from '@/features/skills/registry';
import { readSkillsStore } from '@/features/skills/skillsStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { SkillCard } from './SkillCard';
import { SkillEditor } from './SkillEditor';

type FilterTab = 'all' | 'preset' | 'custom';

function manifestMatchesQuery(m: SkillManifest, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (m.title.toLowerCase().includes(needle)) return true;
  if (m.name.toLowerCase().includes(needle)) return true;
  if (m.description?.toLowerCase().includes(needle)) return true;
  if (m.tags?.some((t: string) => t.toLowerCase().includes(needle))) return true;
  if (m.body.toLowerCase().includes(needle)) return true;
  return false;
}

export function SkillsPage() {
  const [manifests, setManifests] = React.useState<SkillManifest[]>([]);
  const [tab, setTab] = React.useState<FilterTab>('all');
  const [query, setQuery] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(() => {
    setManifests(skillRegistry.list('skill'));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    (async () => {
      try {
        await skillRegistry.loadFromDisk();
      } catch (err) {
        console.error('skillRegistry.loadFromDisk failed:', err);
      } finally {
        if (!cancelled) {
          refresh();
          setLoading(false);
        }
      }
    })();

    try {
      unsub = skillRegistry.subscribe(() => {
        if (!cancelled) refresh();
      });
    } catch (err) {
      console.error('skillRegistry.subscribe failed:', err);
    }

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [refresh]);

  const counts = React.useMemo(() => {
    let presets = 0;
    let custom = 0;
    for (const m of manifests) {
      if (m.isPreset) presets++;
      else custom++;
    }
    return { presets, custom, total: manifests.length };
  }, [manifests]);

  const filtered = React.useMemo(() => {
    return manifests.filter((m) => {
      if (tab === 'preset' && !m.isPreset) return false;
      if (tab === 'custom' && m.isPreset) return false;
      return manifestMatchesQuery(m, query);
    });
  }, [manifests, tab, query]);

  const selected = React.useMemo(
    () => manifests.find((m) => (m.catalogId ?? m.name) === selectedId) ?? null,
    [manifests, selectedId],
  );

  const handleToggleEnabled = (id: string, next: boolean) => {
    try {
      skillRegistry.setEnabled(id, next);
    } catch (err) {
      toast.error('Toggle failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreate = () => {
    const id = readSkillsStore().addCustomSkill();
    skillRegistry.refresh();
    setSelectedId(id);
    setTab('custom');
    toast.success('New skill', 'Edit and save your custom instructions.');
  };

  const handleRestoreAllPresets = () => {
    const deleted = readSkillsStore().deletedPresets.length;
    const overrides = Object.keys(readSkillsStore().presetOverrides).length;
    if (deleted === 0 && overrides === 0) {
      toast.info('Already default', 'All presets match factory values.');
      return;
    }
    if (!window.confirm('Restore all presets to factory defaults? Custom skills are kept.')) return;
    readSkillsStore().restoreAllPresets();
    skillRegistry.refresh();
    toast.success('Restored', 'All presets reset.');
  };

  const showDetailMobile = !!selected;

  return (
    <div className="h-full w-full flex bg-background overflow-hidden">
      <aside
        className={cn(
          'w-full flex-col border-border bg-panel/60',
          'md:w-80 md:shrink-0 md:border-r',
          showDetailMobile ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="px-4 pt-4 pb-2 shrink-0 flex items-center justify-between gap-2">
          <div className="eyebrow">
            {counts.presets} presets · {counts.custom} custom
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" onClick={handleRestoreAllPresets} title="Restore all presets">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button variant="accent" size="icon-sm" onClick={handleCreate} title="New custom skill">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="px-4 pb-2 shrink-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as FilterTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="all" className="flex-1">
                All
              </TabsTrigger>
              <TabsTrigger value="preset" className="flex-1">
                Presets
              </TabsTrigger>
              <TabsTrigger value="custom" className="flex-1">
                Custom
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="px-4 pb-3 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="pl-7"
              aria-label="Search skills"
            />
          </div>
        </div>

        <Separator />

        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-hidden">
          {loading ? (
            <div className="text-secondary text-muted-foreground text-center py-8">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-secondary text-muted-foreground text-center py-8 space-y-3">
              <p>No matches.</p>
              {tab !== 'preset' ? (
                <Button variant="secondary" size="sm" onClick={handleCreate}>
                  <Plus className="h-3.5 w-3.5" />
                  Create skill
                </Button>
              ) : null}
            </div>
          ) : (
            filtered.map((m) => {
              const id = m.catalogId ?? m.name;
              return (
                <SkillCard
                  key={id}
                  manifest={m}
                  selected={selectedId === id}
                  onSelect={setSelectedId}
                  onToggleEnabled={handleToggleEnabled}
                />
              );
            })
          )}
        </div>
      </aside>

      <section
        className={cn(
          'flex-1 min-w-0 flex-col',
          showDetailMobile ? 'flex' : 'hidden md:flex',
        )}
      >
        {selected && (
          <div className="md:hidden px-3 py-2 border-b border-border shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          </div>
        )}

        {selected ? (
          <SkillEditor
            key={selected.catalogId ?? selected.name}
            manifest={selected}
            onSaved={refresh}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center p-10">
            <div className="rounded-xl bg-paper border border-border shadow-soft p-8 max-w-md text-center space-y-3">
              <div className="text-4xl">✨</div>
              <div className="eyebrow">16 presets + yours</div>
              <h1 className="font-display text-3xl font-semibold text-foreground leading-tight tracking-tight">
                Skill library
              </h1>
              <p className="text-secondary text-muted-foreground leading-relaxed">
                Pick a card to edit instructions inline, or press <strong>+</strong> to create a
                custom skill. Skills selected via <code className="kbd">/skills</code> in chat inject
                runtime instructions into the next message.
              </p>
              <Button variant="accent" size="sm" onClick={handleCreate}>
                <Plus className="h-3.5 w-3.5" />
                New custom skill
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default SkillsPage;
