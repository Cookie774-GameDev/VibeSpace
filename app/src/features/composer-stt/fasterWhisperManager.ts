/**
 * faster-whisper model download + status bridge (Tauri).
 * Mirrors the Kokoro ModelManager pattern.
 */

import type { FasterWhisperModelId } from '@/types/common';
import { fasterWhisperModelDef, normalizeFasterWhisperModelId } from './catalog';

export interface FasterWhisperDownloadProgress {
  model: string;
  file: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface FasterWhisperModelStatus {
  model: string;
  installed: boolean;
  ready: boolean;
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

function buildManifest(modelId: FasterWhisperModelId) {
  const normalized = normalizeFasterWhisperModelId(modelId);
  const def = fasterWhisperModelDef(normalized);
  const base = `https://huggingface.co/${def.hfRepo}/resolve/main`;
  return {
    model: normalized,
    files: [
      { name: 'config.json', url: `${base}/config.json`, size_bytes: 2_000, required: true },
      { name: 'tokenizer.json', url: `${base}/tokenizer.json`, size_bytes: 2_200_000, required: true },
      { name: 'vocabulary.json', url: `${base}/vocabulary.json`, size_bytes: 1_100_000, required: true },
      { name: 'model.bin', url: `${base}/model.bin`, size_bytes: def.sizeBytes, required: true },
    ],
  };
}

class FasterWhisperManagerImpl {
  async getModelPath(modelId: FasterWhisperModelId): Promise<string | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    const model = normalizeFasterWhisperModelId(modelId);
    try {
      return await invoke<string>('faster_whisper_model_path', { model });
    } catch {
      return null;
    }
  }

  async checkInstalled(modelId: FasterWhisperModelId): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    const model = normalizeFasterWhisperModelId(modelId);
    try {
      const res = await invoke<{ installed: boolean }>('faster_whisper_check_installed', {
        model,
      });
      return Boolean(res?.installed);
    } catch {
      return false;
    }
  }

  async getStatus(modelId: FasterWhisperModelId): Promise<FasterWhisperModelStatus | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    const model = normalizeFasterWhisperModelId(modelId);
    try {
      return await invoke<FasterWhisperModelStatus>('faster_whisper_status', { model });
    } catch {
      return null;
    }
  }

  async downloadModel(
    modelId: FasterWhisperModelId,
    onProgress?: (p: FasterWhisperDownloadProgress) => void,
  ): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    const model = normalizeFasterWhisperModelId(modelId);

    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<FasterWhisperDownloadProgress>('faster-whisper:progress', (event) => {
        if (
          event.payload.model === model ||
          event.payload.model === modelId ||
          normalizeFasterWhisperModelId(event.payload.model) === model
        ) {
          onProgress?.(event.payload);
        }
      });
      await invoke('faster_whisper_download', {
        model,
        manifest: buildManifest(model),
      });
      return true;
    } catch {
      return false;
    } finally {
      unlisten?.();
    }
  }

  async removeModel(modelId: FasterWhisperModelId): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    const model = normalizeFasterWhisperModelId(modelId);
    try {
      await invoke('faster_whisper_remove', { model });
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(modelId: FasterWhisperModelId, wavBlob: Blob): Promise<string> {
    const invoke = await getInvoke();
    if (!invoke) {
      throw new Error('faster-whisper is only available in the desktop app.');
    }
    const model = normalizeFasterWhisperModelId(modelId);
    const buffer = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audioBase64 = btoa(binary);
    return invoke<string>('faster_whisper_transcribe', {
      model,
      audioBase64,
    });
  }
}

export const FasterWhisperManager = new FasterWhisperManagerImpl();
