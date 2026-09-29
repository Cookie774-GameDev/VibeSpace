import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickLink } from '@/types/quick-link';

const { updateLink } = vi.hoisted(() => ({ updateLink: vi.fn() }));

const link: QuickLink = {
  id: 'ql_editor_qa' as QuickLink['id'],
  workspace_id: 'wsp_editor_qa' as QuickLink['workspace_id'],
  label: 'QA Settings',
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
    selector({ workspaceId: link.workspace_id }),
}));

vi.mock('./hooks', () => ({
  useQuickLinkGroups: () => [],
  useQuickLinks: () => [link],
  filterByGroup: (rows: QuickLink[]) => rows,
}));

vi.mock('@/lib/db', () => ({
  quickLinkGroupRepo: {},
  quickLinkRepo: { update: updateLink },
}));

vi.mock('./launch', () => ({ launchLink: vi.fn(), QUICK_PRESETS: [] }));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { LauncherDialog } from './LauncherDialog';

function LauncherHarness() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen launcher
      </button>
      <LauncherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('Quick Launch nested editor lifecycle', () => {
  beforeEach(() => {
    updateLink.mockReset();
    updateLink.mockResolvedValue(undefined);
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    // A background native WebView can defer or omit the editor's exit animationend.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = realGetComputedStyle(element);
      if (!(element instanceof HTMLElement) || element.dataset.launcherSurface !== 'link-editor') {
        return style;
      }
      return new Proxy(style, {
        get(target, property) {
          if (property === 'animationName') {
            return element.dataset.state === 'closed' ? 'fade-out' : 'scale-in';
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('restores the parent dialog after cancel, then closes and reopens it', async () => {
    render(<LauncherHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit QA Settings' }));
    const editor = screen.getByRole('dialog', { name: 'Edit link' });
    const parent = document.querySelector('[data-warm-surface="quick-launch-dialog"]');
    expect(parent?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(parent?.getAttribute('aria-hidden')).not.toBe('true'));
    expect(screen.getByRole('dialog', { name: 'Quick Launch' })).toBe(parent);

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick Launch' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reopen launcher' }));
    expect(screen.getByRole('dialog', { name: 'Quick Launch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a new link' }));
    const newEditor = screen.getByRole('dialog', { name: 'New link' });
    expect(within(newEditor).getByRole('textbox', { name: 'Label' })).toHaveProperty('value', '');
    fireEvent.click(within(newEditor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Quick Launch' })).toBeTruthy());
  });

  it('restores the parent after saving an edit without waiting for animationend', async () => {
    render(<LauncherHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit QA Settings' }));
    const editor = screen.getByRole('dialog', { name: 'Edit link' });
    const parent = document.querySelector('[data-warm-surface="quick-launch-dialog"]');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateLink).toHaveBeenCalledExactlyOnceWith(link.id, expect.any(Object)),
    );
    await waitFor(() => expect(parent?.getAttribute('aria-hidden')).not.toBe('true'));
    expect(screen.getByRole('dialog', { name: 'Quick Launch' })).toBe(parent);
  });
});
