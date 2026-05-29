/**
 * SkillsPage — the library route. Two panes: a 320px card rail on the left
 * and the SkillDetail on the right. Below md, collapses to a single column
 * with a back button on the detail.
 *
 * This component owns selection, search, and tab filter state. The skill
 * data and persistence live in Slice 5's `skillRegistry`; we only consume
 * its exports.
 */
import * as React from 'react';
import { ArrowLeft, Copy, FolderOpen, Search } from 'lucide-react';
import type { SkillManifest } from '@/features/skills/loader';
import { skillRegistry } from '@/features/skills/registry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { SkillCard } from './SkillCard';
import { SkillDetail } from './SkillDetail';

type FilterTab = 'all' | 'skill' | 'agent';

const SKILLS_HOME_HINT = '~/.jarvis/skills/';

/** Substring match across the manifest's user-facing fields and body. */
function manifestMatchesQuery(m: SkillManifest, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (m.title.toLowerCase().includes(needle)) return true;
  if (m.name.toLowerCase().includes(needle)) return true;
  if (m.tags?.some((t: string) => t.toLowerCase().includes(needle))) return true;
  if (m.body.toLowerCase().includes(needle)) return true;
  return false;
}

export function SkillsPage() {
  const [manifests, setManifests] = React.useState<SkillManifest[]>([]);
  const [tab, setTab] = React.useState<FilterTab>('all');
  const [query, setQuery] = React.useState('');
  const [selectedName, setSelectedName] = React.useState<string | null>(null);
  const [bootError, setBootError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Boot: load once, subscribe to registry updates, refresh local state.
  React.useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    const refresh = () => {
      if (cancelled) return;
      try {
        setManifests([...skillRegistry.getAll()]);
      } catch (err) {
        // getAll() may not exist if Slice 5's API differs; integrator will
        // reconcile. Surface to console but don't crash the page.
        // eslint-disable-next-line no-console
        console.error('skillRegistry.getAll failed:', err);
      }
    };

    (async () => {
      try {
        await skillRegistry.loadFromDisk();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('skillRegistry.loadFromDisk failed:', err);
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          refresh();
          setLoading(false);
        }
      }
    })();

    try {
      unsub = skillRegistry.subscribe(refresh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('skillRegistry.subscribe failed:', err);
    }

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Counts for the header eyebrow (computed pre-filter).
  const counts = React.useMemo(() => {
    let skills = 0;
    let agents = 0;
    for (const m of manifests) {
      if (m.kind === 'agent') agents++;
      else skills++;
    }
    return { skills, agents };
  }, [manifests]);

  // Visible cards = tab filter ∩ search filter.
  const filtered = React.useMemo(() => {
    return manifests.filter((m) => {
      if (tab === 'skill' && m.kind !== 'skill') return false;
      if (tab === 'agent' && m.kind !== 'agent') return false;
      return manifestMatchesQuery(m, query);
    });
  }, [manifests, tab, query]);

  const selected = React.useMemo(
    () => manifests.find((m) => m.name === selectedName) ?? null,
    [manifests, selectedName],
  );

  const handleToggleEnabled = (name: string, next: boolean) => {
    try {
      skillRegistry.setEnabled(name, next);
      // Optimistic update so the UI reflects the toggle even if the registry
      // doesn't broadcast synchronously.
      setManifests((prev) =>
        prev.map((m) => (m.name === name ? { ...m, enabled: next } : m)),
      );
    } catch (err) {
      toast.error('Toggle failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyHome = async () => {
    try {
      await navigator.clipboard.writeText(SKILLS_HOME_HINT);
      toast.success('Copied', `${SKILLS_HOME_HINT} → clipboard`);
    } catch {
      toast.error('Copy failed', 'Clipboard access denied.');
    }
  };

  const showDetailMobile = !!selected;

  return (
    <div className="h-full w-full flex bg-background overflow-hidden">
      {/* ---------------- Left rail ---------------- */}
      <aside
        className={cn(
          'w-full flex-col border-border bg-panel/60',
          'md:w-80 md:shrink-0 md:border-r',
          showDetailMobile ? 'hidden md:flex' : 'flex',
        )}
      >
        {/* Header eyebrow */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <div className="eyebrow">
            {counts.skills} skill{counts.skills === 1 ? '' : 's'} ·{' '}
            {counts.agents} agent{counts.agents === 1 ? '' : 's'}
          </div>
        </div>

        {/* Tab strip */}
        <div className="px-4 pb-2 shrink-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as FilterTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="all" className="flex-1">
                All
              </TabsTrigger>
              <TabsTrigger value="skill" className="flex-1">
                Skills
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex-1">
                Agents
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Search */}
        <div className="px-4 pb-3 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, tag, or body…"
              className="pl-7"
              aria-label="Search skills"
            />
          </div>
        </div>

        <Separator />

        {/* Card grid (1 column) */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-hidden">
          {loading ? (
            <div className="text-secondary text-muted-foreground text-center py-8">
              Loading…
            </div>
          ) : manifests.length === 0 ? (
            <div className="rounded-xl bg-paper border border-border shadow-soft p-5 space-y-3">
              <div className="eyebrow">Empty library</div>
              <div className="font-display text-lg font-semibold text-foreground leading-snug">
                No skills loaded yet
              </div>
              <p className="text-secondary text-muted-foreground leading-relaxed">
                Drop{' '}
                <code className="px-1 py-0.5 rounded bg-paper-soft border border-border font-mono text-[0.9em]">
                  .md
                </code>{' '}
                files into{' '}
                <code className="px-1 py-0.5 rounded bg-paper-soft border border-border font-mono text-[0.9em]">
                  {SKILLS_HOME_HINT}
                </code>{' '}
                and use Reload from disk.
              </p>
              <Button variant="secondary" size="sm" onClick={handleCopyHome}>
                <Copy className="h-3.5 w-3.5" />
                Copy path
              </Button>
              {bootError && (
                <div className="text-metadata text-destructive font-mono pt-1 break-words">
                  {bootError}
                </div>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-secondary text-muted-foreground text-center py-8">
              No matches.
            </div>
          ) : (
            filtered.map((m) => (
              <SkillCard
                key={m.name}
                manifest={m}
                selected={selectedName === m.name}
                onSelect={setSelectedName}
                onToggleEnabled={handleToggleEnabled}
              />
            ))
          )}
        </div>
      </aside>

      {/* ---------------- Right pane ---------------- */}
      <section
        className={cn(
          'flex-1 min-w-0 flex-col',
          showDetailMobile ? 'flex' : 'hidden md:flex',
        )}
      >
        {selected && (
          <div className="md:hidden px-3 py-2 border-b border-border shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setSelectedName(null)}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          </div>
        )}

        {selected ? (
          <SkillDetail manifest={selected} onToggleEnabled={handleToggleEnabled} />
        ) : (
          <div className="flex-1 flex items-center justify-center p-10">
            <div className="rounded-xl bg-paper border border-border shadow-soft p-8 max-w-md text-center space-y-3">
              <FolderOpen className="h-8 w-8 mx-auto text-accent-honey" />
              <div className="eyebrow">Pick a skill</div>
              <h1 className="font-display text-3xl font-semibold text-foreground leading-tight tracking-tight">
                Library of habits
              </h1>
              <p className="text-secondary text-muted-foreground leading-relaxed">
                Each card is a reusable instruction set Jarvis can follow. Select one to
                read its body, see the providers it applies to, and toggle it on or off.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default SkillsPage;
