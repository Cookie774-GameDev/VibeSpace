/**
 * Add / edit a single QuickLink.
 *
 * Open in two modes:
 *   - new link: pass `link={undefined}` and a `defaultGroupId` if creating
 *     in a specific group's tab
 *   - edit link: pass an existing `QuickLink`. The form prefills.
 */
import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { quickLinkRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { renderHotkey } from '@/lib/utils';
import type { LinkBehavior, LinkKind, QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type { QuickLinkGroupId, WorkspaceId } from '@/types/common';
import { useQuickLinks } from './hooks';
import { isValidHotkey } from './useLinkHotkeys';

interface LinkEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** When set, the dialog edits this link. When undefined, creates new. */
  link?: QuickLink | null;
  /** Pre-select a group when creating a new link. */
  defaultGroupId?: QuickLinkGroupId;
  groups: QuickLinkGroup[];
}

const KINDS: { id: LinkKind; label: string; hint: string }[] = [
  { id: 'web', label: 'Web', hint: 'Any URL' },
  { id: 'youtube', label: 'YouTube', hint: 'Video or channel' },
  { id: 'youtube-playlist', label: 'YouTube playlist', hint: 'Playlist URL' },
  { id: 'spotify', label: 'Spotify', hint: 'Track / playlist / album' },
  { id: 'soundcloud', label: 'SoundCloud', hint: 'Track or set' },
  { id: 'app', label: 'App', hint: 'Native or PWA' },
  { id: 'file', label: 'File', hint: 'Local path (Tauri)' },
  { id: 'jarvis-action', label: 'Jarvis action', hint: 'jarvis://schedule, jarvis://ambient, ...' },
];

const BEHAVIORS: { id: LinkBehavior; label: string }[] = [
  { id: 'external_browser', label: 'External browser' },
  { id: 'in_app_player', label: 'In-app player (V3)' },
  { id: 'pip_window', label: 'Picture-in-picture (V3)' },
  { id: 'side_panel', label: 'Side panel' },
];

/** Suggest a kind based on the URL. */
function inferKind(url: string): LinkKind {
  const u = url.trim().toLowerCase();
  if (u.startsWith('jarvis://')) return 'jarvis-action';
  if (u.startsWith('file://')) return 'file';
  if (u.includes('youtube.com/playlist') || u.includes('list=')) return 'youtube-playlist';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('open.spotify.com')) return 'spotify';
  if (u.includes('soundcloud.com')) return 'soundcloud';
  return 'web';
}

export function LinkEditDialog({ open, onOpenChange, link, defaultGroupId, groups }: LinkEditDialogProps) {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const allLinks = useQuickLinks(workspaceId);
  const isEdit = !!link;

  // Form state
  const [label, setLabel] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [kind, setKind] = React.useState<LinkKind>('web');
  const [groupId, setGroupId] = React.useState<QuickLinkGroupId | ''>('');
  const [icon, setIcon] = React.useState('');
  const [colorHue, setColorHue] = React.useState<number>(200);
  const [behavior, setBehavior] = React.useState<LinkBehavior>('external_browser');
  const [hotkey, setHotkey] = React.useState('');
  const [tagsRaw, setTagsRaw] = React.useState('');

  // Reset on open/link change.
  React.useEffect(() => {
    if (!open) return;
    if (link) {
      setLabel(link.label);
      setUrl(link.url);
      setKind(link.kind);
      setGroupId((link.group_id as QuickLinkGroupId | undefined) ?? '');
      setIcon(link.icon ?? '');
      setColorHue(link.color_hue ?? 200);
      setBehavior(link.behavior);
      setHotkey(link.hotkey ?? '');
      setTagsRaw((link.tags ?? []).join(', '));
    } else {
      setLabel('');
      setUrl('');
      setKind('web');
      setGroupId(defaultGroupId ?? '');
      setIcon('');
      setColorHue(200);
      setBehavior('external_browser');
      setHotkey('');
      setTagsRaw('');
    }
  }, [open, link, defaultGroupId]);

  // Auto-suggest kind when URL changes.
  React.useEffect(() => {
    if (!open || isEdit) return;
    if (!url.trim()) return;
    setKind(inferKind(url));
  }, [url, open, isEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) {
      toast.error('No workspace', 'Sign in or finish onboarding first.');
      return;
    }
    if (!label.trim()) {
      toast.warning('Add a label', 'Links need a name.');
      return;
    }
    if (!url.trim()) {
      toast.warning('Add a URL', 'Where should this open?');
      return;
    }

    const tags = tagsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const trimmedHotkey = hotkey.trim();
    if (trimmedHotkey && !isValidHotkey(trimmedHotkey)) {
      toast.warning('Hotkey looks off', 'Try a combo like Mod+Shift+1.');
      return;
    }
    // Best-effort conflict detection — surface a warning, don't block.
    if (trimmedHotkey) {
      const conflict = allLinks.find(
        (l) => l.id !== link?.id && (l.hotkey ?? '').trim().toLowerCase() === trimmedHotkey.toLowerCase(),
      );
      if (conflict) {
        toast.warning(
          'Hotkey already in use',
          `“${conflict.label}” also uses ${renderHotkey(trimmedHotkey)}. Yours will win since it was saved last.`,
        );
      }
    }

    try {
      if (isEdit && link) {
        await quickLinkRepo.update(link.id, {
          label: label.trim(),
          url: url.trim(),
          kind,
          group_id: groupId || undefined,
          icon: icon.trim() || undefined,
          color_hue: colorHue,
          behavior,
          hotkey: trimmedHotkey || undefined,
          tags,
        });
        toast.success('Link saved', `“${label.trim()}” updated.`);
      } else {
        await quickLinkRepo.create({
          workspace_id: workspaceId,
          label: label.trim(),
          url: url.trim(),
          kind,
          group_id: groupId || undefined,
          icon: icon.trim() || undefined,
          color_hue: colorHue,
          behavior,
          hotkey: trimmedHotkey || undefined,
          tags,
          position: Date.now(), // stamp insertion time so newest is last by default
        });
        toast.success('Link added', `“${label.trim()}” pinned to your launcher.`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not save link', err instanceof Error ? err.message : 'Try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit link' : 'New link'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update this link\u2019s details.' : 'Add a one-click target to your launcher.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <Label htmlFor="link-label">Label</Label>
            <Input
              id="link-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="GitHub"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com or jarvis://schedule"
            />
            <div className="text-metadata text-muted-foreground mt-1">
              Web URLs open externally. <span className="font-mono">jarvis://</span> URLs run a built-in action.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="link-kind">Kind</Label>
              <select
                id="link-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as LinkKind)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="link-group">Group</Label>
              <select
                id="link-group"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value as QuickLinkGroupId | '')}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="link-icon">Icon (emoji or text)</Label>
              <Input
                id="link-icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="\u2728"
                maxLength={6}
              />
            </div>

            <div>
              <Label htmlFor="link-hue">Color</Label>
              <div className="flex items-center gap-2">
                <input
                  id="link-hue"
                  type="range"
                  min={0}
                  max={359}
                  value={colorHue}
                  onChange={(e) => setColorHue(Number(e.target.value))}
                  className="w-full"
                />
                <span
                  aria-hidden
                  className="h-5 w-5 rounded-full border border-border shrink-0"
                  style={{ background: `hsl(${colorHue} 70% 50%)` }}
                />
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="link-behavior">Open as</Label>
            <select
              id="link-behavior"
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as LinkBehavior)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {BEHAVIORS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="link-hotkey">Hotkey</Label>
            <Input
              id="link-hotkey"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              placeholder="e.g. Mod+Shift+1"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="mt-1 flex min-h-[18px] items-center gap-1.5 text-metadata">
              {hotkey.trim() ? (
                isValidHotkey(hotkey) ? (
                  <>
                    <span className="text-muted-foreground">Launches with</span>
                    <span className="kbd">{renderHotkey(hotkey.trim())}</span>
                  </>
                ) : (
                  <span className="text-warning">Use a combo like Mod+Shift+1.</span>
                )
              ) : (
                <span className="text-muted-foreground">Optional. Mod = {`\u2318`} on macOS, Ctrl elsewhere.</span>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="link-tags">Tags (comma-separated)</Label>
            <Textarea
              id="link-tags"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="work, focus, daily"
              rows={2}
            />
          </div>

          {isEdit && link?.last_used_at ? (
            <div className="text-metadata text-muted-foreground">
              Last used {formatDistanceToNow(link.last_used_at, { addSuffix: true })}.
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent">
              {isEdit ? 'Save changes' : 'Add link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
