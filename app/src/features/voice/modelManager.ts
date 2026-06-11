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

/**
 * Minimal Kokoro-82M v1.0 asset set: the int8 dynamic-quantized ONNX model
 * (~88 MB — the smallest variant that is stable on the static CPU onnxruntime;
 * the q8f16 variant crashes there) plus ONLY the two voices Jarvis-One ships
 * (bm_george, bf_emma — ~0.5 MB each, raw float32). SHA-256 values were
 * computed locally from the real files. Total download ≈ 89 MB.
 */
const KOKORO_HF = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const DEFAULT_KOKORO_MANIFEST: ModelManifest = {
  model: 'kokoro-82m',
  version: '1.0-q8',
  runtime: 'onnx',
  files: [
    {
      name: 'model_quantized.onnx',
      url: `${KOKORO_HF}/onnx/model_quantized.onnx`,
      sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      size_bytes: 92361116,
      required: true,
    },
    {
      name: 'bm_george.bin',
      url: `${KOKORO_HF}/voices/bm_george.bin`,
      sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
      size_bytes: 522240,
      required: true,
    },
    {
      name: 'bf_emma.bin',
      url: `${KOKORO_HF}/voices/bf_emma.bin`,
      sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
      size_bytes: 522240,
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
      if (base) {
        const res = await fetch(`${base}/functions/v1/model-manifest`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const manifest = (await res.json()) as ModelManifest & { status?: string };
          if (
            manifest.status !== 'unavailable' &&
            Array.isArray(manifest.files) &&
            manifest.files.length > 0
          ) {
            this.manifestCache = manifest;
            return this.manifestCache;
          }
        }
      }
    } catch {
      /* fall through to the built-in manifest */
    }
    // Built-in manifest: the canonical Kokoro-82M v1.0 ONNX assets with real,
    // locally-verified SHA-256 checksums. Used when the server has no override
    // configured, so the local neural voice works out of the box.
    this.manifestCache = DEFAULT_KOKORO_MANIFEST;
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
