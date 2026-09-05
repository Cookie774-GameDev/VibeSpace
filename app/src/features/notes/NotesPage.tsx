import { NotesWorkspaceView } from './NotesWorkspaceView';
import { useNoteScope, useNotesWorkspace } from './notesRuntime';
export { NotesWorkspaceView } from './NotesWorkspaceView';

export function NotesPage() {
  const scope = useNoteScope();
  const { workspace } = useNotesWorkspace(scope);
  if (!scope || !workspace)
    return (
      <div className="vs-notes-empty">
        <h1>Notes</h1>
        <p>Choose a project to start writing. Notes are isolated by account and project.</p>
      </div>
    );
  return <NotesWorkspaceView key={`${scope.accountId}:${scope.projectId}`} workspace={workspace} />;
}
