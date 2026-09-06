import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReferencePanel } from './ReferencePanel';
import type { WorkbenchPanel } from './types';

vi.mock('@/features/notes/notesRuntime', () => ({
  useNoteScope: () => null,
  useNotesWorkspace: () => ({ workspace: null }),
}));

const panel: WorkbenchPanel = {
  id: 'notes-test',
  kind: 'notes',
  title: 'Notes',
  x: 0,
  y: 0,
  width: 360,
  height: 330,
  z: 1,
  minimized: false,
  status: 'ready',
  settings: {},
};

describe('Canvas Notes integration', () => {
  it('opens the project-scoped Notes page for a new Notes panel', async () => {
    render(<ReferencePanel panel={panel} onUpdate={vi.fn()} />);
    expect(
      await screen.findByText(
        'Choose a project to start writing. Notes are isolated by account and project.',
      ),
    ).toBeTruthy();
  });

  it('preserves existing scratchpad content instead of hiding it', async () => {
    render(
      <ReferencePanel
        panel={{ ...panel, settings: { note: 'Keep this draft' } }}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
    await act(async () => Promise.resolve());
  });
});
