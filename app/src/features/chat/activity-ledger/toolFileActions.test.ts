import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { accountId: 'a', workspaceId: 'w', projectId: 'p' },
  root: 'C:/workspace',
  stat: vi.fn(),
  invoke: vi.fn(),
  select: vi.fn(),
  route: vi.fn(),
  chat: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => mocks.auth } }));
vi.mock('@/lib/accountIdentity', () => ({
  resolveAccountIdentity: (state: { accountId: string }) => ({ accountId: state.accountId }),
}));
vi.mock('@/stores/ui', () => ({ useUIStore: { getState: () => ({ setRoute: mocks.route }) } }));
vi.mock('@/features/files/projectFiles', () => ({
  getStoredProjectRoot: () => mocks.root,
  setStoredOpenFile: mocks.select,
}));
vi.mock('@/lib/fs', () => ({ statProjectPath: mocks.stat }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/db', () => ({ chatRepo: { getById: mocks.chat } }));
import {
  captureToolFileScope,
  openToolFile,
  resolveToolFilePath,
  resolveToolChatRoot,
} from './toolFileActions';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.accountId = 'a';
  mocks.auth.projectId = 'p';
  mocks.root = 'C:/workspace';
  mocks.stat.mockResolvedValue({ ok: true, kind: 'file' });
  mocks.invoke.mockResolvedValue('C:/workspace/invoice.cjs');
  mocks.chat.mockResolvedValue({ project_id: 'p', workspace_id: 'w' });
});
it('resolves persisted receipt authority from its own chat, never a tool path', async () => {
  expect(await resolveToolChatRoot('chat-1')).toBe('C:/workspace');
  mocks.chat.mockResolvedValue({ project_id: 'other', workspace_id: 'w' });
  expect(await resolveToolChatRoot('chat-2')).toBeUndefined();
});
it('rejects a workspace switch during chat lookup', async () => {
  mocks.chat.mockImplementation(async () => {
    mocks.auth.workspaceId = 'other';
    return { project_id: 'p', workspace_id: 'w' };
  });
  expect(await resolveToolChatRoot('chat-1')).toBeUndefined();
  mocks.auth.workspaceId = 'w';
});
it.each([
  '../escape.txt',
  'C:/other/file.txt',
  'https://bad/file',
  'C:/workspace2/file',
  '\\\\server\\share\\x',
  'src/../file',
  'file\u0000.txt',
])('rejects an untrusted tool path %s', (path) => {
  expect(() => resolveToolFilePath('C:/workspace', path)).toThrow();
});
it('accepts a bounded project-relative path, preserving Unicode and spaces', () => {
  expect(resolveToolFilePath('C:/workspace', 'src/hello world-λ.ts')).toBe(
    'C:/workspace/src/hello world-λ.ts',
  );
  expect(resolveToolFilePath('/Users/me/project', 'src/a.ts')).toBe('/Users/me/project/src/a.ts');
});
it('opens the existing editor only after native validation in the captured project', async () => {
  const scope = captureToolFileScope('C:/workspace')!;
  await openToolFile('invoice.cjs', 'editor', scope);
  expect(mocks.stat).toHaveBeenCalledWith('C:/workspace/invoice.cjs', false, {
    root: 'C:/workspace',
  });
  expect(mocks.select).toHaveBeenCalledWith('p', 'C:/workspace/invoice.cjs');
  expect(mocks.route).toHaveBeenCalledWith('files');
});
it('uses the scoped native reveal command, never a tool-provided shell command', async () => {
  await openToolFile('invoice.cjs', 'reveal', captureToolFileScope('C:/workspace')!);
  expect(mocks.invoke).toHaveBeenCalledWith('fs_reveal_project_file', {
    path: 'C:/workspace/invoice.cjs',
    root: 'C:/workspace',
  });
});
it('rejects a changed account while the native validation is pending', async () => {
  let release!: (value: unknown) => void;
  mocks.stat.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = openToolFile('invoice.cjs', 'editor', captureToolFileScope('C:/workspace')!);
  mocks.auth.accountId = 'b';
  release({ ok: true, kind: 'file' });
  await expect(pending).rejects.toThrow(/scope/i);
  expect(mocks.select).not.toHaveBeenCalled();
});
it('does not open a deleted file or a path from a different project root', async () => {
  expect(captureToolFileScope('C:/other')).toBeNull();
  mocks.stat.mockResolvedValue({ ok: false, error: { code: 'not_found' } });
  await expect(
    openToolFile('invoice.cjs', 'editor', captureToolFileScope('C:/workspace')!),
  ).rejects.toThrow(/not_found/);
  expect(mocks.select).not.toHaveBeenCalled();
});
