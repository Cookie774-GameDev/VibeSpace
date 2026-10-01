/**
 * Default folder for Jarvis file writes when the user does not specify a
 * path. Native writes use the same app-data/Projects root already admitted
 * by the canonical file-action path policy.
 */
import { isTauri } from '@/lib/utils';

let cachedDefaultDir: string | null = null;

function stripSlash(path: string): string {
  return path.replace(/[\\/]+$/, '') || path;
}

function joinSeg(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${stripSlash(base)}${sep}${name}`;
}

/** Sync browser / offline fallback (no Tauri path APIs). */
export function browserFallbackWriteDir(): string {
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)) {
    return 'C:\\Users\\Public\\Documents\\VibeSpace';
  }
  return '/tmp/vibespace';
}

/** Last resolved dir (may be null before first async resolve). */
export function getCachedDefaultWriteDir(): string | null {
  return cachedDefaultDir;
}

/** For tests only. */
export function __setCachedDefaultWriteDirForTests(path: string | null): void {
  cachedDefaultDir = path;
}

/**
 * Resolve the preferred general write directory once and cache it.
 * Safe to call repeatedly; failures fall back to a public Documents path.
 */
export async function resolveDefaultWriteDir(): Promise<string> {
  if (cachedDefaultDir) return cachedDefaultDir;

  if (isTauri) {
    try {
      const pathApi = await import('@tauri-apps/api/path');
      const tryDir = async (fn: () => Promise<string>): Promise<string | null> => {
        try {
          const value = await fn();
          return value ? stripSlash(value) : null;
        } catch {
          return null;
        }
      };
      const appData = await tryDir(() => pathApi.appDataDir());
      if (appData) {
        const projects = joinSeg(appData, 'Projects');
        cachedDefaultDir = projects;
        return projects;
      }
      const downloads = await tryDir(() => pathApi.downloadDir());
      if (downloads) {
        cachedDefaultDir = downloads;
        return downloads;
      }
      const documents = await tryDir(() => pathApi.documentDir());
      if (documents) {
        cachedDefaultDir = documents;
        return documents;
      }
      const home = await tryDir(() => pathApi.homeDir());
      if (home) {
        const dir = joinSeg(home, 'Downloads');
        cachedDefaultDir = dir;
        return dir;
      }
    } catch {
      // fall through
    }
  }

  cachedDefaultDir = browserFallbackWriteDir();
  return cachedDefaultDir;
}

/** Absolute path for a new general-purpose file under the default dir. */
export function defaultWriteFilePath(
  fileName: string,
  dir: string | null | undefined = cachedDefaultDir ?? browserFallbackWriteDir(),
): string {
  const safeName = (fileName || 'jarvis-note.txt').replace(/[<>:"|?*]/g, '_').trim() || 'jarvis-note.txt';
  const base = (dir && dir.trim()) || browserFallbackWriteDir();
  return joinSeg(base, safeName);
}
