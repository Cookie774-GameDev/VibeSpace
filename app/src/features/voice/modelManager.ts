/**
 * Jarvis High model manager (frontend).
 *
 * Pure path-resolution logic lives here and is unit-tested. The heavy lifting
 * (download with progress, checksum verification, resume, repair) is delegated
 * to Tauri commands implemented in Rust, so it runs off the UI
 * thread and survives partial downloads. When the Tauri bridge is unavailable
 * (e.g. running in a plain browser/test), every method degrades gracefully
 * instead of throwing, and the TtsService falls back to system TTS.
 *
 * Expected Rust command contract (added separately to src-tauri to avoid
 * clobbering another agent's in-flight changes):
 *   jarvis_voice_model_path() -> string
 *   jarvis_voice_check_installed() -> { installed: boolean, files: string[] }
 *   jarvis_voice_verify_checksums() -> { ok: boolean, corrupt: string[] }
 *   jarvis_voice_download(manifest) -> emits "jarvis-voice:progress" events
 *   jarvis_voice_resume_download()
 *   jarvis_voice_repair()
 *   jarvis_voice_delete_corrupt()
 *   jarvis_voice_warmup()
 *   jarvis_voice_status() -> { installed, ready }
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
  sourceUrl: string;
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
 * Resolve the OS-specific Jarvis High model directory. Pure function — the env
 * values are injected so this is fully testable for all three platforms.
 */
export function resolveModelPath(os: OS, env: { APPDATA?: string; HOME?: string } = {}): string {
  const sep = os === 'windows' ? '\\' : '/';
  const join = (...parts: string[]) => parts.join(sep);
  switch (os) {
    case 'windows': {
      const base = env.APPDATA ?? `${env.HOME ?? 'C:\\Users\\Default'}\\AppData\\Roaming`;
      return join(base, 'VibeSpace', 'models', 'jarvis-high');
    }
    case 'macos': {
      const home = env.HOME ?? '/Users/Shared';
      return join(home, 'Library', 'Application Support', 'VibeSpace', 'models', 'jarvis-high');
    }
    case 'linux':
    default: {
      const home = env.HOME ?? '/root';
      return join(home, '.local', 'share', 'VibeSpace', 'models', 'jarvis-high');
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

/**
 * Authoritative Jarvis High Piper artifacts. Sizes and SHA-256 values are
 * verified against the upstream files; this manifest is intentionally pinned
 * so a remote configuration cannot silently replace executable model input.
 */
export const JARVIS_HIGH_SOURCE_URL =
  'https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high';
const JARVIS_HIGH_HF = 'https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high';
export const JARVIS_HIGH_MANIFEST: ModelManifest = {
  model: 'jarvis-high',
  version: '1.0.0',
  runtime: 'piper',
  sourceUrl: JARVIS_HIGH_SOURCE_URL,
  files: [
    {
      name: 'jarvis-high.onnx',
      url: `${JARVIS_HIGH_HF}/jarvis-high.onnx`,
      sha256: '9791877d9c099fabbf30be2825e011451c39b3431e21e81e866f5b6507e72993',
      size_bytes: 114_199_011,
      required: true,
    },
    {
      name: 'jarvis-high.onnx.json',
      url: `${JARVIS_HIGH_HF}/jarvis-high.onnx.json`,
      sha256: 'd0b8772d81c1da2fcdfd79e90bff027f46f040450e1deb89b43a9f6b1946c5a7',
      size_bytes: 7_262,
      required: true,
    },
  ],
  voices: ['jarvis', 'friday'],
};

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
      return await invoke<string>('jarvis_voice_model_path');
    } catch {
      return null;
    }
  }

  async checkModelInstalled(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      const res = await invoke<{ installed: boolean }>('jarvis_voice_check_installed');
      return Boolean(res?.installed);
    } catch {
      return false;
    }
  }

  async verifyChecksums(): Promise<{ ok: boolean; corrupt: string[] }> {
    const invoke = await getInvoke();
    if (!invoke) return { ok: false, corrupt: [] };
    try {
      return await invoke<{ ok: boolean; corrupt: string[] }>('jarvis_voice_verify_checksums');
    } catch {
      return { ok: false, corrupt: [] };
    }
  }

  /** Return the checksum-pinned authoritative model manifest. */
  async getModelManifest(): Promise<ModelManifest | null> {
    if (this.manifestCache) return this.manifestCache;
    this.manifestCache = JARVIS_HIGH_MANIFEST;
    return this.manifestCache;
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
        unlisten = await ev.listen<DownloadProgress>('jarvis-voice:progress', (e) =>
          onProgress(e.payload),
        );
      } catch {
        /* progress events optional */
      }
    }
    try {
      await invoke<void>('jarvis_voice_download', { manifest });
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
      await invoke<void>('jarvis_voice_resume_download');
      return true;
    } catch {
      return false;
    }
  }

  async repairModel(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      await invoke<void>('jarvis_voice_delete_corrupt');
      await invoke<void>('jarvis_voice_repair');
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<ModelStatus> {
    const invoke = await getInvoke();
    if (!invoke) return { installed: false, ready: false };
    try {
      return await invoke<ModelStatus>('jarvis_voice_status');
    } catch {
      return { installed: false, ready: false };
    }
  }

  /** Ensure the model is present + verified; download if missing. Non-throwing. */
  async ensureJarvisReady(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
    const installed = await this.checkModelInstalled();
    if (installed) {
      const { ok } = await this.verifyChecksums();
      if (ok) return true;
      const manifest = await this.getModelManifest();
      const invoke = await getInvoke();
      if (manifest && invoke) {
        try {
          await invoke<void>('jarvis_voice_download', { manifest });
          if ((await this.verifyChecksums()).ok) return true;
        } catch {
          /* fall through to repair */
        }
      }
      await this.repairModel();
      return (await this.verifyChecksums()).ok;
    }
    return this.downloadModelWithProgress(onProgress);
  }

  async warmupJarvis(): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    try {
      await invoke<void>('jarvis_voice_warmup');
    } catch {
      /* best effort */
    }
  }
}

export const ModelManager = new ModelManagerImpl();
export type { ModelManagerImpl };
