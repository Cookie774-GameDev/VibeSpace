import { isTauri } from '@/lib/utils';

export const AUTO_UPDATE_KEY = 'jarvis-auto-update';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'none'
  | 'error';

export interface UpdateProgress {
  phase: UpdatePhase;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface UpdateResult {
  available: boolean;
  installed: boolean;
  version?: string;
  notes?: string;
}

export function getAutoUpdateEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(AUTO_UPDATE_KEY) !== '0';
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AUTO_UPDATE_KEY, enabled ? '1' : '0');
}

export async function checkForAppUpdate(options: {
  install?: boolean;
  onProgress?: (progress: UpdateProgress) => void;
} = {}): Promise<UpdateResult> {
  if (!isTauri) {
    throw new Error('Updates are only available in the installed desktop app.');
  }

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();

  if (!update) {
    options.onProgress?.({ phase: 'none' });
    return { available: false, installed: false };
  }

  const version = update.version;
  const notes = update.body;

  if (!options.install) {
    options.onProgress?.({ phase: 'available' });
    return { available: true, installed: false, version, notes };
  }

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  options.onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength ?? undefined;
      options.onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });
      return;
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength;
      options.onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });
      return;
    }
    if (event.event === 'Finished') {
      options.onProgress?.({ phase: 'installing', downloadedBytes, totalBytes });
    }
  });

  options.onProgress?.({ phase: 'installed', downloadedBytes, totalBytes });

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    console.warn('[updates] relaunch failed after install', err);
  }

  return { available: true, installed: true, version, notes };
}
