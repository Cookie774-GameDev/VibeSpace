/**
 * Reactive subscriptions to the quick-links + groups tables.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type { QuickLinkGroupId, WorkspaceId } from '@/types/common';

export function useQuickLinks(workspaceId: WorkspaceId | null): QuickLink[] {
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as QuickLink[];
      const rows = await db.quick_links.where('workspace_id').equals(workspaceId).toArray();
      rows.sort((a, b) => a.position - b.position);
      return rows;
    }, [workspaceId]) ?? []
  );
}

export function useQuickLinkGroups(workspaceId: WorkspaceId | null): QuickLinkGroup[] {
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as QuickLinkGroup[];
      const rows = await db.quick_link_groups.where('workspace_id').equals(workspaceId).toArray();
      rows.sort((a, b) => a.position - b.position);
      return rows;
    }, [workspaceId]) ?? []
  );
}

/**
 * Convenience — links not used in the last `cutoffDays` days. Used by the
 * AmbientHome (and a future "stale links" hint) to surface neglected entries.
 */
export function useStaleLinks(workspaceId: WorkspaceId | null, cutoffDays = 30): QuickLink[] {
  const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as QuickLink[];
      const rows = await db.quick_links.where('workspace_id').equals(workspaceId).toArray();
      return rows
        .filter((l) => (l.last_used_at ?? 0) < cutoff)
        .sort((a, b) => (a.last_used_at ?? 0) - (b.last_used_at ?? 0));
    }, [workspaceId, cutoff]) ?? []
  );
}

/** Helper: filter links by group id (or "ungrouped" sentinel). */
export function filterByGroup(
  links: QuickLink[],
  groupId: QuickLinkGroupId | 'all' | 'ungrouped',
): QuickLink[] {
  if (groupId === 'all') return links;
  if (groupId === 'ungrouped') return links.filter((l) => !l.group_id);
  return links.filter((l) => l.group_id === groupId);
}
