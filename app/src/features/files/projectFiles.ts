import { isTauri } from '@/lib/utils';

export const ROOT_PREFIX = 'jarvis-files-root-v2';
export const OPEN_FILE_PREFIX = 'jarvis-files-open-file-v1';

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass',
  'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'env', 'gitignore', 'rs',
  'py', 'rb', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'vue',
  'svelte', 'astro', 'lua', 'dart', 'ex', 'exs', 'erl', 'hrl', 'r', 'jl', 'scala',
  'clj', 'cljs', 'dockerfile', 'gradle', 'properties', 'lock', 'log', 'csv', 'tsv',
]);

export function projectStorageKey(prefix: string, projectId: string | null): string {
  return `${prefix}:${projectId ?? '__default__'}`;
}

export function getStoredProjectRoot(projectId: string | null): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(projectStorageKey(ROOT_PREFIX, projectId)) ?? '';
}

export function setStoredProjectRoot(projectId: string | null, path: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(projectStorageKey(ROOT_PREFIX, projectId), path);
  window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', {
    detail: { projectId, path },
  }));
}

export function getStoredOpenFile(projectId: string | null): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(projectStorageKey(OPEN_FILE_PREFIX, projectId)) ?? '';
}

export function setStoredOpenFile(projectId: string | null, path: string, emit = true): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(projectStorageKey(OPEN_FILE_PREFIX, projectId), path);
  if (!emit) return;
  window.dispatchEvent(new CustomEvent('jarvis:files:open-path', {
    detail: { projectId, path },
  }));
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/g).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i <= 0) return path;
  return path.slice(0, i) || sep;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]$/g, '')}${sep}${name}`;
}

export function extension(path: string): string {
  const base = basename(path).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('.env')) return base.replace(/^\./, '');
  const i = base.lastIndexOf('.');
  return i === -1 ? base.replace(/^\./, '') : base.slice(i + 1);
}

export function isPopularTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extension(path));
}

export async function chooseProjectFolder(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected: string | string[] | null = await open({
      directory: true,
      multiple: false,
      title: 'Choose project folder',
    });
    if (typeof selected === 'string') return selected;
    if (Array.isArray(selected)) return (selected as string[]).find((item: string) => typeof item === 'string') ?? null;
  } catch {
    // The typed path fallback remains available when the native dialog is unavailable.
  }
  return null;
}

export async function chooseProjectFiles(multiple = true): Promise<string[]> {
  if (!isTauri) return [];
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected: unknown = await open({
      directory: false,
      multiple,
      title: 'Choose project files',
    });
    if (typeof selected === 'string') return [selected];
    if (Array.isArray(selected)) return selected.filter((item): item is string => typeof item === 'string');
  } catch {
    // Manual path input remains available.
  }
  return [];
}
