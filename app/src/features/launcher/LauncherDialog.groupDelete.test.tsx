import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';

const { deleteGroup } = vi.hoisted(() => ({ deleteGroup: vi.fn() }));

const group: QuickLinkGroup = {
  id: 'qlg_qa' as QuickLinkGroup['id'],
  workspace_id: 'wsp_qa' as QuickLinkGroup['workspace_id'],
  name: 'QA Group',
  position: 1,
  created_at: 1,
  updated_at: 1,
};

const groupedLink: QuickLink = {
  id: 'ql_qa' as QuickLink['id'],
  workspace_id: group.workspace_id,
  group_id: group.id,
  label: 'QA Link',
  url: 'jarvis://settings',
  kind: 'jarvis-action',
  behavior: 'side_panel',
  position: 1,
  tags: [],
  created_at: 1,
  updated_at: 1,
};

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ workspaceId: group.workspace_id }),
}));

vi.mock('./hooks', () => ({
  useQuickLinkGroups: () => [group],
  useQuickLinks: () => [groupedLink],
  filterByGroup: (rows: QuickLink[], id: string) =>
    id === 'all' ? rows : rows.filter((row) => row.group_id === id),
}));

vi.mock('@/lib/db', () => ({
  quickLinkGroupRepo: { delete: deleteGroup },
  quickLinkRepo: {},
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { LauncherDialog } from './LauncherDialog';

describe('Quick Launch group deletion', () => {
  beforeEach(() => {
    deleteGroup.mockReset();
    deleteGroup.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('explains link detachment and cancels without deleting', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LauncherDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /QA Group/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete group QA Group' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Ungrouped'));
    expect(deleteGroup).not.toHaveBeenCalled();
  });

  it('deletes only the selected group after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LauncherDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /QA Group/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete group QA Group' }));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledExactlyOnceWith(group.id));
  });
});
