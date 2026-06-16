/**
 * faster-whisper model download + status bridge (Tauri).
 * Mirrors the Kokoro ModelManager pattern.
 */

import type { FasterWhisperModelId } from '@/types/common';
import { FASTER_WHISPER_MODELS } from './catalog';

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
  const def = FASTER_WHISPER_MODELS.find((m) => m.id === modelId)!;
  const base = `https://huggingface.co/${def.hfRepo}/resolve/main`;
  return {
    model: modelId,
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
    try {
      return await invoke<string>('faster_whisper_model_path', { model: modelId });
    } catch {
      return null;
    }
  }

  async checkInstalled(modelId: FasterWhisperModelId): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      const res = await invoke<{ installed: boolean }>('faster_whisper_check_installed', {
        model: modelId,
      });
      return Boolean(res?.installed);
    } catch {
      return false;
    }
  }

  async getStatus(modelId: FasterWhisperModelId): Promise<FasterWhisperModelStatus | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    try {
      return await invoke<FasterWhisperModelStatus>('faster_whisper_status', { model: modelId });
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

    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<FasterWhisperDownloadProgress>('faster-whisper:progress', (event) => {
        if (event.payload.model === modelId) onProgress?.(event.payload);
      });
      await invoke('faster_whisper_download', {
        model: modelId,
        manifest: buildManifest(modelId),
      });
      return true;
    } catch {
      return false;
    } finally {
      unlisten?.();
    }
  }

  async transcribe(modelId: FasterWhisperModelId, wavBlob: Blob): Promise<string> {
    const invoke = await getInvoke();
    if (!invoke) {
      throw new Error('faster-whisper is only available in the desktop app.');
    }
    const buffer = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audioBase64 = btoa(binary);
    return invoke<string>('faster_whisper_transcribe', {
      model: modelId,
      audioBase64,
    });
  }
}

export const FasterWhisperManager = new FasterWhisperManagerImpl();
