import type { ChatId, ProjectId, TerminalSessionId, WorkspaceId } from '@/types/common';
import type { PromptForgeJob } from './contracts';

type ScopeJob = Pick<PromptForgeJob, 'accountId' | 'chatId' | 'projectId'>;
type ScopeSubject = Readonly<{ workspace_id: string; project_id?: string }>;
export type PromptForgeRequestScope = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId?: string;
}>;
export interface PromptForgeScopeRepository {
  subject(id: string): Promise<ScopeSubject | undefined>;
  workspace(id: string): Promise<Readonly<{ owner_id: string }> | undefined>;
  project(id: string): Promise<Readonly<{ workspace_id: string }> | undefined>;
}
const nativeRepository: PromptForgeScopeRepository = {
  async subject(id) {
    const { db } = await import('@/lib/db/database');
    return (
      (await db.chats.get(id as ChatId)) ??
      (await db.terminal_sessions.get(id as TerminalSessionId))
    );
  },
  async workspace(id) {
    const { db } = await import('@/lib/db/database');
    return db.workspaces.get(id as WorkspaceId);
  },
  async project(id) {
    const { db } = await import('@/lib/db/database');
    return db.projects.get(id as ProjectId);
  },
};

/** Resolve the original owner, never the currently focused workspace or main chat session. */
export async function resolvePromptForgeExecutionScope(
  job: ScopeJob,
  repository: PromptForgeScopeRepository = nativeRepository,
): Promise<PromptForgeRequestScope> {
  const unavailable = () =>
    new Error('Prompt Forge requires the original owned chat or terminal workspace.');
  if (!job.accountId.trim() || !job.chatId.trim()) throw unavailable();
  // Terminal jobs use terminal:<safe project>:<session or pane>, not a Chat row ID.
  const safeProject = (job.projectId?.trim() || 'none')
    .replace(/[^A-Za-z0-9._:/@-]/g, '_')
    .slice(0, 80);
  const terminalPrefix = `terminal:${safeProject}:`;
  const terminalSource = job.chatId.startsWith(terminalPrefix);
  const sourceId = terminalSource ? job.chatId.slice(terminalPrefix.length) : job.chatId;
  if (!sourceId.trim()) throw unavailable();
  const [savedSubject, project] = await Promise.all([
    repository.subject(sourceId),
    job.projectId === null ? undefined : repository.project(job.projectId),
  ]);
  // An unbound pane still has an exact persisted project, never a global-workspace fallback.
  const subject =
    savedSubject ??
    (terminalSource && project && job.projectId !== null
      ? { workspace_id: project.workspace_id, project_id: job.projectId }
      : undefined);
  if (!subject?.workspace_id.trim() || (subject.project_id ?? null) !== job.projectId) {
    throw unavailable();
  }
  const workspace = await repository.workspace(subject.workspace_id);
  if (
    workspace?.owner_id !== job.accountId ||
    (job.projectId !== null && project?.workspace_id !== subject.workspace_id)
  )
    throw unavailable();
  return Object.freeze({
    accountId: job.accountId,
    workspaceId: subject.workspace_id,
    ...(job.projectId === null ? {} : { projectId: job.projectId }),
  });
}
