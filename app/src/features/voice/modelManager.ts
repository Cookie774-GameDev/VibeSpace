/**
 * Kokoro ModelManager (frontend).
 *
 * Pure path-resolution logic lives here and is unit-tested. The heavy lifting
 * (download with progress, checksum verification, resume, repair) is delegated
 * to Tauri commands implemented in Rust (kokoro.rs), so it runs off the UI
 * thread and survives partial downloads. When the Tauri bridge is unavailable
 * (e.g. running in a plain browser/test), every method degrades gracefully
 * instead of throwing, and the TtsService falls back to system TTS.
 *
 * Expected Rust command contract (added separately to src-tauri to avoid
 * clobbering another agent's in-flight changes):
 *   kokoro_model_path() -> string
 *   kokoro_check_installed() -> { installed: boolean, files: string[] }
 *   kokoro_verify_checksums() -> { ok: boolean, corrupt: string[] }
 *   kokoro_download(manifest) -> emits "kokoro:progress" events
 *   kokoro_resume_download()
 *   kokoro_repair()
 *   kokoro_delete_corrupt()
 *   kokoro_warmup()
 *   kokoro_status() -> { installed, ready }
 */

export type OS = 'windows' | 'macos' | 'linux';

export interface ModelFile {
  name: string;
  url: string;
  sha256: string;
  size_bytes: number;
  required: boolean;
}

export interface ModelManifest {
  model: string;
  version: string;
  runtime: string;
  files: ModelFile[];
  voices: string[];
}

export interface ModelStatus {
  installed: boolean;
  ready: boolean;
}

export interface DownloadProgress {
  file: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Resolve the OS-specific Kokoro model directory. Pure function — the env
 * values are injected so this is fully testable for all three platforms.
 */
export function resolveModelPath(
  os: OS,
  env: { APPDATA?: string; HOME?: string } = {},
): string {
  const sep = os === 'windows' ? '\\' : '/';
  const join = (...parts: string[]) => parts.join(sep);
  switch (os) {
    case 'windows': {
      const base = env.APPDATA ?? `${env.HOME ?? 'C:\\Users\\Default'}\\AppData\\Roaming`;
      return join(base, 'Jarvis-One', 'models', 'kokoro');
    }
    case 'macos': {
      const home = env.HOME ?? '/Users/Shared';
      return join(home, 'Library', 'Application Support', 'Jarvis-One', 'models', 'kokoro');
    }
    case 'linux':
    default: {
      const home = env.HOME ?? '/root';
      return join(home, '.local', 'share', 'Jarvis-One', 'models', 'kokoro');
    }
  }
}

/** Detect the current OS from the navigator/Tauri platform string. */
export function detectOS(platform: string): OS {
  const p = platform.toLowerCase();
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('win')) return 'windows';
  return 'linux';
}

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function getInvoke(): Promise<TauriInvoke | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke as TauriInvoke;
  } catch {
    return null;
  }
}

class ModelManagerImpl {
  private manifestCache: ModelManifest | null = null;

  async getModelPath(): Promise<string | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    try {
      return await invoke<string>('kokoro_model_path');
    } catch {
      return null;
    }
  }

  async checkModelInstalled(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      const res = await invoke<{ installed: boolean }>('kokoro_check_installed');
      return Boolean(res?.installed);
    } catch {
      return false;
    }
  }

  async verifyChecksums(): Promise<{ ok: boolean; corrupt: string[] }> {
    const invoke = await getInvoke();
    if (!invoke) return { ok: false, corrupt: [] };
    try {
      return await invoke<{ ok: boolean; corrupt: string[] }>('kokoro_verify_checksums');
    } catch {
      return { ok: false, corrupt: [] };
    }
  }

  /** Fetch the public model manifest from the model-manifest Edge Function. */
  async getModelManifest(): Promise<ModelManifest | null> {
    if (this.manifestCache) return this.manifestCache;
    try {
      const base = import.meta.env.VITE_SUPABASE_URL;
      if (!base) return null;
      const res = await fetch(`${base}/functions/v1/model-manifest`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const manifest = (await res.json()) as ModelManifest & { status?: string };
      // The server reports status:'unavailable' until a real model asset is
      // published. Treat that as "no model" so we fall back to system TTS
      // instead of trying to download placeholder files.
      if (manifest.status === 'unavailable' || !manifest.files || manifest.files.length === 0) {
        return null;
      }
      this.manifestCache = manifest;
      return this.manifestCache;
    } catch {
      return null;
    }
  }

  async downloadModelWithProgress(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    const manifest = await this.getModelManifest();
    if (!manifest) return false;

    let unlisten: (() => void) | null = null;
    if (onProgress) {
      try {
        const ev = await import('@tauri-apps/api/event');
        unlisten = await ev.listen<DownloadProgress>('kokoro:progress', (e) => onProgress(e.payload));
      } catch {
        /* progress events optional */
      }
    }
    try {
      await invoke<void>('kokoro_download', { manifest });
      return true;
    } catch {
      return false;
    } finally {
      unlisten?.();
    }
  }

  async resumeDownload(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      await invoke<void>('kokoro_resume_download');
      return true;
    } catch {
      return false;
    }
  }

  async repairModel(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      await invoke<void>('kokoro_delete_corrupt');
      await invoke<void>('kokoro_repair');
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<ModelStatus> {
    const invoke = await getInvoke();
    if (!invoke) return { installed: false, ready: false };
    try {
      return await invoke<ModelStatus>('kokoro_status');
    } catch {
      return { installed: false, ready: false };
    }
  }

  /** Ensure the model is present + verified; download if missing. Non-throwing. */
  async ensureKokoroReady(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
    const installed = await this.checkModelInstalled();
    if (installed) {
      const { ok } = await this.verifyChecksums();
      if (ok) return true;
      await this.repairModel();
      return (await this.verifyChecksums()).ok;
    }
    return this.downloadModelWithProgress(onProgress);
  }

  async warmupKokoro(): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    try {
      await invoke<void>('kokoro_warmup');
    } catch {
      /* best effort */
    }
  }
}

export const ModelManager = new ModelManagerImpl();
export type { ModelManagerImpl };
