import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickLink } from '@/types/quick-link';
import { LauncherDialog } from './LauncherDialog';
import { launchLink } from './launch';
import { toast } from '@/components/ui/toast';

function link(id: string, label: string): QuickLink {
  return {
    id: id as QuickLink['id'],
    workspace_id: 'qa-workspace' as QuickLink['workspace_id'],
    label,
    url: `jarvis://${id}`,
    kind: 'jarvis-action',
    behavior: 'side_panel',
    position: 1,
    tags: [],
    created_at: 1,
    updated_at: 1,
  };
}

vi.mock('./hooks', () => ({
  filterByGroup: (rows: QuickLink[]) => rows,
  useQuickLinkGroups: () => [],
  useQuickLinks: () => [
    link('qa-one', 'QA One'),
    link('personal', 'Personal'),
    link('qa-two', 'QA Two'),
  ],
}));

vi.mock('./launch', () => ({
  launchLink: vi.fn(),
  QUICK_PRESETS: [],
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

describe('Quick Launch bulk action', () => {
  beforeEach(() => {
    vi.mocked(launchLink).mockReset();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('confirms and launches only searched links, continuing after one failure', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(launchLink)
      .mockResolvedValueOnce({ ok: false, reason: 'Unavailable' })
      .mockResolvedValueOnce({ ok: true });
    const onOpenChange = vi.fn();
    render(<LauncherDialog open onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search links' }), {
      target: { value: 'QA' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Launch All/i }));

    await waitFor(() => expect(launchLink).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2'));
    expect(vi.mocked(launchLink).mock.calls.map(([row]) => row.label)).toEqual([
      'QA One',
      'QA Two',
    ]);
    expect(toast.warning).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('does not launch any link when the bulk confirmation is canceled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LauncherDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Launch All/i }));

    expect(launchLink).not.toHaveBeenCalled();
  });
});
