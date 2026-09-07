interface DirectoryDependencies {
  appData(): Promise<string>;
  join(...paths: string[]): Promise<string>;
  create(path: string, options: { root: string }): Promise<{ ok: boolean }>;
}

const nativeDependencies: DirectoryDependencies = {
  appData: async () => (await import('@tauri-apps/api/path')).appLocalDataDir(),
  join: async (...paths) => (await import('@tauri-apps/api/path')).join(...paths),
  create: async (path, options) => (await import('@/lib/fs')).createDirectory(path, options),
};

/** Projectless chats get a bounded app-owned workspace, never the process cwd. */
export async function resolveCodexWorkingDirectory(
  selected: string | undefined,
  dependencies: DirectoryDependencies = nativeDependencies,
): Promise<string> {
  if (selected?.trim()) return selected.trim();
  const root = await dependencies.appData();
  const directory = await dependencies.join(root, 'harness', 'codex-server', 'workspace');
  if (!(await dependencies.create(directory, { root })).ok) {
    throw new Error('The Codex chat working directory could not be prepared.');
  }
  return directory;
}
