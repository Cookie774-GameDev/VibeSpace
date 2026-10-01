import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecycleBinConfirmDialog } from './RecycleBinConfirmDialog';

describe('RecycleBinConfirmDialog', () => {
  it('opens as an alert dialog with Cancel focused and only confirms explicitly', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <RecycleBinConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Move Researcher to Recycle Bin?"
        description="You can restore it for 90 days."
        confirmLabel="Move to Recycle Bin"
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByRole('alertdialog', { name: 'Move Researcher to Recycle Bin?' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and exposes a bounded error when confirmation fails', async () => {
    render(
      <RecycleBinConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete permanently?"
        description="This cannot be undone."
        confirmLabel="Delete permanently"
        onConfirm={vi.fn(async () => {
          throw new Error('Storage is unavailable.');
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Storage is unavailable.');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
