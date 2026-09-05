import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgenticConsole } from '../chat/agentic-console/AgenticConsole';
import type { Message } from '@/types';
import { noteDigest, noteScopeKey } from './notesContracts';
import { NotesSessionReferences } from './NotesSessionReferences';
import { openNoteReference } from './notesRuntime';
vi.mock('./notesRuntime', () => ({
  currentNoteScope: () => ({ accountId: 'a', projectId: 'project-a' }),
  openNoteReference: vi.fn(),
  getNotesWorkspace: () => ({ resolve: () => new Promise(() => {}) }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('navigates immediately without waiting for a saved note body', async () => {
  const scope = { accountId: 'a', projectId: 'project-a' };
  const hash = (await noteDigest(noteScopeKey(scope))).slice(0, 24);
  const map = `notes:${hash}:note-a`,
    node = 'note:note-a';
  const message = {
    id: 'navigation',
    role: 'user',
    parts: [
      {
        kind: 'file_ref',
        ref: {
          kind: 'memory',
          id: `context:p${scope.projectId.length}:${scope.projectId}${map.length}:${map}${node.length}:${node}note`,
          excerpt: 'Context: Open now',
        },
      },
    ],
  } as Message;
  render(<NotesSessionReferences messages={[message]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open now' }));
  await waitFor(() => expect(openNoteReference).toHaveBeenCalledWith({ ...scope, id: 'note-a' }));
});
it('shows sent notes only in existing session details and preserves other attachment cards', () => {
  const project = 'project-a',
    map = 'notes:0123456789abcdef01234567:note-a',
    node = 'note:note-a';
  const message: Message = {
    id: 'notes-ui' as Message['id'],
    chat_id: 'chat-notes' as Message['chat_id'],
    role: 'user',
    created_at: 1,
    updated_at: 1,
    parts: [
      { kind: 'text', text: 'Use my notes' },
      {
        kind: 'file_ref',
        ref: {
          kind: 'memory',
          id: `context:p${project.length}:${project}${map.length}:${map}${node.length}:${node}note`,
          excerpt: 'Context: Design notes',
        },
      },
      { kind: 'file_ref', ref: { kind: 'file', id: 'src/example.ts' } },
    ],
  };
  render(
    <TooltipProvider>
      <AgenticConsole chatId="chat-notes" messages={[message]} activity={[]} />
    </TooltipProvider>,
  );
  expect(screen.queryByText(/Design notes/)).toBeNull();
  expect(screen.getByText(/src\/example.ts/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open session details' }));
  expect(screen.getByRole('region', { name: 'Referenced notes' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Design notes' })).toBeTruthy();
});
