import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseProjectFiles } from '@/features/files/projectFiles';
import { ConnectedFilesButton } from './ConnectedFilesButton';
vi.mock('@/features/files/projectFiles', () => ({ chooseProjectFiles: vi.fn() }));
afterEach(cleanup);

it('keeps cancellation quiet and preserves the existing connected files', async () => {
  vi.mocked(chooseProjectFiles).mockResolvedValue([]);
  const onChange = vi.fn();
  render(<ConnectedFilesButton files={['C:\\fixture\\existing.txt']} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /connected files/i }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
  });
  expect(screen.queryByText(/run the desktop app/i)).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it('hands off exactly the selected Unicode and space-containing paths', async () => {
  vi.mocked(chooseProjectFiles).mockResolvedValue([
    'C:\\fixture\\日本語.txt',
    'C:\\fixture\\with spaces.txt',
  ]);
  const onChange = vi.fn();
  render(<ConnectedFilesButton files={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /attach files to this pane/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
  await vi.waitFor(() =>
    expect(onChange).toHaveBeenCalledWith([
      'C:\\fixture\\日本語.txt',
      'C:\\fixture\\with spaces.txt',
    ]),
  );
});
