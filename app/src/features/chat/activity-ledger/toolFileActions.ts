import { invoke } from '@tauri-apps/api/core';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { statProjectPath } from '@/lib/fs';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { getStoredProjectRoot, setStoredOpenFile } from '@/features/files/projectFiles';
import { chatRepo } from '@/lib/db';
import type { Message } from '@/types';

export interface ToolFileScope {
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  root: string;
}
export type ToolFileAction = 'editor' | 'reveal' | 'vscode' | 'vscode-insiders';
export interface ToolEditor {
  id: 'vscode' | 'vscode-insiders';
  name: string;
}
const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/u, '');
const comparable = (path: string) => (/^[A-Za-z]:\//u.test(path) ? path.toLowerCase() : path);

/** Lexical containment is checked here; the native strict-root check rejects links. */
export function resolveToolFilePath(root: string, filePath: string): string {
  if (
    !root ||
    !filePath ||
    root.length > 8192 ||
    filePath.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(root + filePath)
  )
    throw new Error('Invalid tool file path');
  const base = normalize(root);
  const path = normalize(filePath);
  if (
    base.startsWith('//') ||
    path.startsWith('//') ||
    path.includes('://') ||
    !/^(?:[A-Za-z]:\/|\/)/u.test(base) ||
    [...base.split('/'), ...path.split('/')].some((part) => part === '..')
  )
    throw new Error('Tool file outside project scope');
  const absolute = /^(?:[A-Za-z]:\/|\/)/u.test(path) ? path : base + '/' + path;
  const normalized = absolute
    .split('/')
    .filter((part) => part !== '.')
    .join('/');
  if (!comparable(normalized).startsWith(comparable(base) + '/'))
    throw new Error('Tool file outside project scope');
  return normalized;
}

export function captureToolFileScope(root: string): Readonly<ToolFileScope> | null {
  const auth = useAuthStore.getState();
  const account = resolveAccountIdentity(auth);
  const projectId = auth.projectId ? String(auth.projectId) : null;
  if (
    !account?.accountId ||
    !auth.workspaceId ||
    !root ||
    comparable(normalize(getStoredProjectRoot(projectId))) !== comparable(normalize(root))
  )
    return null;
  return Object.freeze({
    accountId: account.accountId,
    workspaceId: String(auth.workspaceId),
    projectId,
    root,
  });
}
function assertCurrent(scope: Readonly<ToolFileScope>): void {
  const current = captureToolFileScope(scope.root);
  if (
    !current ||
    current.accountId !== scope.accountId ||
    current.workspaceId !== scope.workspaceId ||
    current.projectId !== scope.projectId
  )
    throw new Error('Tool file scope changed; reopen this conversation in its original project');
}

/** Historical receipts derive authority from their stored chat, never provider output. */
export async function resolveToolChatRoot(chatId: string): Promise<string | undefined> {
  const auth = useAuthStore.getState();
  const scope = captureToolFileScope(getStoredProjectRoot(auth.projectId));
  if (!scope) return undefined;
  const chat = await chatRepo.getById(chatId as Message['chat_id']);
  try {
    assertCurrent(scope);
  } catch {
    return undefined;
  }
  return chat &&
    String(chat.workspace_id) === scope.workspaceId &&
    (chat.project_id ? String(chat.project_id) : null) === scope.projectId
    ? scope.root
    : undefined;
}

export async function listToolEditors(scope: Readonly<ToolFileScope>): Promise<ToolEditor[]> {
  assertCurrent(scope);
  const editors = await invoke<ToolEditor[]>('fs_tool_editors', { root: scope.root });
  assertCurrent(scope);
  return editors.filter((editor) => ['vscode', 'vscode-insiders'].includes(editor.id));
}

export async function openToolFile(
  filePath: string,
  action: ToolFileAction,
  scope: Readonly<ToolFileScope>,
): Promise<void> {
  assertCurrent(scope);
  const path = resolveToolFilePath(scope.root, filePath);
  const checked = await statProjectPath(path, false, { root: scope.root });
  assertCurrent(scope);
  if (!checked.ok) throw new Error('File unavailable: ' + checked.error.code);
  if (checked.kind !== 'file') throw new Error('File unavailable: not_a_file');
  if (action === 'reveal') {
    await invoke('fs_reveal_project_file', { path, root: scope.root });
  } else if (action === 'editor') {
    setStoredOpenFile(scope.projectId, path);
    useUIStore.getState().setRoute('files');
  } else {
    await invoke('fs_open_project_file_in_editor', { path, root: scope.root, editorId: action });
  }
}
