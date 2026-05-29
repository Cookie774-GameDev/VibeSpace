/**
 * V2 — Quick Launch dialog.
 *
 * A keyboard-first launcher: filter chips at the top (one per group), tile
 * grid below, "+ New link" tile, hover actions per tile, search input.
 *
 * UX:
 *   - Click a tile  → launchLink (window.open or jarvis:// action)
 *   - Cmd/Ctrl+click → edit
 *   - Right-click → contextual menu (V3); for V2 we expose Edit + Delete
 *     buttons on hover instead.
 *   - Empty state: 1-tap "Add starter links" button that fans out the
 *     QUICK_PRESETS into the user's workspace.
 */
import * as React from 'react';
import { Plus, Search, Edit3, Trash2, ExternalLink, Sparkles, FolderPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { quickLinkGroupRepo, quickLinkRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type { QuickLinkGroupId, WorkspaceId } from '@/types/common';
import { useQuickLinks, useQuickLinkGroups, filterByGroup } from './hooks';
import { launchLink, QUICK_PRESETS } from './launch';
import { LinkEditDialog } from './LinkEditDialog';

interface LauncherDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type GroupFilter = QuickLinkGroupId | 'all' | 'ungrouped';

export function LauncherDialog({ open, onOpenChange }: LauncherDialogProps) {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const links = useQuickLinks(workspaceId);
  const groups = useQuickLinkGroups(workspaceId);

  const [filter, setFilter] = React.useState<GroupFilter>('all');
  const [search, setSearch] = React.useState('');

  // Edit state
  const [editing, setEditing] = React.useState<QuickLink | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);

  // Reset on open.
  React.useEffect(() => {
    if (open) {
      setFilter('all');
      setSearch('');
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    let rows = filterByGroup(links, filter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (l) =>
          l.label.toLowerCase().includes(q) ||
          l.url.toLowerCase().includes(q) ||
          (l.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [links, filter, search]);

  const onLaunch = async (link: QuickLink) => {
    const res = await launchLink(link);
    if (res.ok) onOpenChange(false);
  };

  const onAddStarters = async () => {
    if (!workspaceId) return;
    try {
      let pos = Date.now();
      for (const preset of QUICK_PRESETS) {
        await quickLinkRepo.create({
          workspace_id: workspaceId,
          label: preset.label,
          url: preset.url,
          kind: preset.kind,
          icon: preset.icon,
          color_hue: preset.color_hue,
          behavior: preset.behavior,
          position: pos++,
        });
      }
      toast.success('Starter links added', `${QUICK_PRESETS.length} pinned to your launcher.`);
    } catch (err) {
      toast.error('Could not add starter links', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const onAddGroup = async () => {
    if (!workspaceId) return;
    const name = window.prompt('New group name?', 'Daily');
    if (!name?.trim()) return;
    try {
      const grp = await quickLinkGroupRepo.create({
        workspace_id: workspaceId,
        name: name.trim(),
        position: Date.now(),
      });
      setFilter(grp.id);
      toast.success('Group added', `“${grp.name}” is ready for links.`);
    } catch (err) {
      toast.error('Could not create group', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const onDelete = async (link: QuickLink) => {
    if (!window.confirm(`Remove "${link.label}"?`)) return;
    try {
      await quickLinkRepo.delete(link.id);
      toast.success('Link removed', `“${link.label}” is gone.`);
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const startNewLink = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const startEdit = (link: QuickLink) => {
    setEditing(link);
    setEditorOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl w-[min(820px,92vw)] h-[min(640px,85vh)] p-0 flex flex-col overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-accent-cyan" /> Quick Launch
            </DialogTitle>
            <DialogDescription>
              One click to whatever you need next. Pin URLs, apps, and Jarvis actions.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 px-5 pb-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search links..."
                className="pl-8"
                aria-label="Search links"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={links.length}>
                All
              </FilterChip>
              {groups.map((g) => (
                <FilterChip
                  key={g.id}
                  active={filter === g.id}
                  onClick={() => setFilter(g.id)}
                  count={links.filter((l) => l.group_id === g.id).length}
                  hue={g.color_hue}
                >
                  {g.name}
                </FilterChip>
              ))}
              <FilterChip
                active={filter === 'ungrouped'}
                onClick={() => setFilter('ungrouped')}
                count={links.filter((l) => !l.group_id).length}
              >
                Ungrouped
              </FilterChip>
              <Button
                variant="ghost"
                size="sm"
                onClick={onAddGroup}
                aria-label="Add group"
                className="ml-auto"
              >
                <FolderPlus className="h-3.5 w-3.5" /> Add group
              </Button>
            </div>
          </div>

          <main className="flex-1 overflow-y-auto px-5 py-4">
            {links.length === 0 ? (
              <EmptyState onAddStarters={onAddStarters} onAddCustom={startNewLink} />
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-secondary text-muted-foreground">
                No links match your filter.
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {filtered.map((link) => (
                  <LinkTile
                    key={link.id}
                    link={link}
                    onLaunch={() => void onLaunch(link)}
                    onEdit={() => startEdit(link)}
                    onDelete={() => void onDelete(link)}
                  />
                ))}
                <button
                  type="button"
                  onClick={startNewLink}
                  className="flex h-[110px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-panel/50 text-muted-foreground hover:bg-panel hover:text-foreground transition-colors"
                  aria-label="Add a new link"
                >
                  <Plus className="h-5 w-5" />
                  <span className="text-metadata">New link</span>
                </button>
              </div>
            )}
          </main>
        </DialogContent>
      </Dialog>

      <LinkEditDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        link={editing}
        defaultGroupId={filter !== 'all' && filter !== 'ungrouped' ? (filter as QuickLinkGroupId) : undefined}
        groups={groups}
      />
    </>
  );
}

interface FilterChipProps {
  active: boolean;
  count: number;
  hue?: number;
  onClick: () => void;
  children: React.ReactNode;
}

function FilterChip({ active, count, hue, onClick, children }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-metadata transition-colors',
        active
          ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
          : 'border-border bg-panel text-muted-foreground hover:border-border-mid hover:text-foreground',
      )}
      style={hue !== undefined ? { borderLeftColor: `hsl(${hue} 70% 55%)`, borderLeftWidth: '2px' } : undefined}
    >
      <span>{children}</span>
      <span className="text-[10px] opacity-60">{count}</span>
    </button>
  );
}

interface LinkTileProps {
  link: QuickLink;
  onLaunch: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function LinkTile({ link, onLaunch, onEdit, onDelete }: LinkTileProps) {
  const hue = link.color_hue ?? 200;
  // Try to read a hostname for the subtitle.
  const hostname = React.useMemo(() => {
    try {
      if (link.url.startsWith('jarvis://')) return 'jarvis action';
      const u = new URL(link.url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return link.url.slice(0, 30);
    }
  }, [link.url]);

  return (
    <div
      className="group relative h-[110px] overflow-hidden rounded-md border border-border bg-panel transition-colors hover:border-border-mid"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 14% / 0.85), hsl(${hue + 30} 60% 9% / 0.85))` }}
    >
      <button
        type="button"
        onClick={onLaunch}
        onAuxClick={onEdit}
        className="flex h-full w-full flex-col items-start justify-between p-3 text-left focus:outline-none focus:ring-1 focus:ring-ring focus:ring-inset"
        aria-label={`Launch ${link.label}`}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-md text-lg"
          style={{ background: `hsl(${hue} 70% 30% / 0.6)`, color: `hsl(${hue} 90% 88%)` }}
        >
          {link.icon || link.label.charAt(0).toUpperCase()}
        </div>
        <div className="w-full min-w-0">
          <div className="truncate text-secondary text-foreground/95">{link.label}</div>
          <div className="truncate text-metadata text-muted-foreground">{hostname}</div>
        </div>
      </button>

      <div className="pointer-events-none absolute inset-x-1 top-1 flex justify-end gap-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-sm bg-elevated/80 backdrop-blur p-1 text-muted-foreground hover:text-foreground"
          aria-label={`Edit ${link.label}`}
        >
          <Edit3 className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-sm bg-elevated/80 backdrop-blur p-1 text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${link.label}`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ onAddStarters, onAddCustom }: { onAddStarters: () => void; onAddCustom: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-cyan/10 text-accent-cyan">
        <ExternalLink className="h-6 w-6" />
      </div>
      <div>
        <Label className="text-page-title text-foreground">Pin your launchpad</Label>
        <p className="text-secondary text-muted-foreground mt-1 max-w-sm">
          One click to YouTube, Spotify, your repo, your favorite chat. Add starter links or build your own.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="accent" onClick={onAddStarters}>
          <Sparkles className="h-3.5 w-3.5 mr-1" /> Add starter set
        </Button>
        <Button variant="secondary" onClick={onAddCustom}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add custom link
        </Button>
      </div>
    </div>
  );
}
