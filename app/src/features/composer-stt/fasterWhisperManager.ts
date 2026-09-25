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
  const vocabularyUrl = `${base}/vocabulary.txt`;
  return {
    model: normalized,
    files: [
      { name: 'config.json', url: `${base}/config.json`, size_bytes: 2_000, required: true },
      { name: 'tokenizer.json', url: `${base}/tokenizer.json`, size_bytes: 2_200_000, required: true },
      { name: 'vocabulary.txt', url: vocabularyUrl, size_bytes: 1_100_000, required: true },
      // Older native binaries still check for vocabulary.json. Convert the real text
      // vocabulary under that legacy filename until those binaries are replaced.
      { name: 'vocabulary.json', url: vocabularyUrl, size_bytes: 1_100_000, required: true },
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
      await this.writeLegacyVocabularyJson(invoke, model);
      return true;
    } catch {
      return false;
    } finally {
      unlisten?.();
    }
  }

  private async writeLegacyVocabularyJson(invoke: TauriInvoke, model: string): Promise<void> {
    const modelPath = await invoke<string>('faster_whisper_model_path', { model });
    const modelRoot = modelPath.replace(/[\\/]+$/u, '');
    const vocabularyPath = `${modelRoot}/vocabulary.txt`;
    const vocabularyText = await invoke<string>('fs_read_text', { path: vocabularyPath });
    const tokens = vocabularyText.split(/\r?\n/u);
    if (tokens[tokens.length - 1] === '') tokens.pop();
    if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
      throw new Error('The local Whisper vocabulary must contain one non-empty token per line.');
    }

    const content = JSON.stringify(tokens);
    if (new TextEncoder().encode(content).byteLength > 1_000_000) {
      throw new Error('The local Whisper vocabulary is too large for the compatibility file.');
    }
    await invoke('fs_write_text', {
      path: `${modelRoot}/vocabulary.json`,
      content,
    });
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
