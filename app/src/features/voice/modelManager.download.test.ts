import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadProgress } from './modelManager';

/**
 * First-run Jarvis High model handling: the verified model is NOT bundled - it is
 * downloaded on demand by the Rust side with progress events and checksum
 * verification. These tests cover the JS orchestration for every state the
 * user can hit: already installed, fresh download with progress, failed
 * download, corrupt-then-repaired, and no Tauri bridge at all.
 */

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  bridgeAvailable: true,
  progressHandlers: [] as Array<(event: { payload: DownloadProgress }) => void>,
}));

vi.mock('@tauri-apps/api/core', () => {
  if (!tauriMocks.bridgeAvailable) throw new Error('no tauri');
  return { invoke: tauriMocks.invoke };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: DownloadProgress }) => void) => {
    tauriMocks.progressHandlers.push(handler);
    return () => {
      tauriMocks.progressHandlers = tauriMocks.progressHandlers.filter((h) => h !== handler);
    };
  }),
}));

import { ModelManager } from './modelManager';

function emitProgress(payload: DownloadProgress) {
  for (const handler of tauriMocks.progressHandlers) handler({ payload });
}

describe('Jarvis High first-run model handling', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.bridgeAvailable = true;
    tauriMocks.progressHandlers = [];
  });

  it('returns ready without downloading when installed and checksums pass', async () => {
    tauriMocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_voice_check_installed') return { installed: true };
      if (cmd === 'jarvis_voice_verify_checksums') return { ok: true, corrupt: [] };
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(ModelManager.ensureJarvisReady()).resolves.toBe(true);
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('jarvis_voice_download', expect.anything());
  });

  it('downloads on first run and reports progress percentages', async () => {
    const seen: number[] = [];
    tauriMocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_voice_check_installed') return { installed: false };
      if (cmd === 'jarvis_voice_download') {
        emitProgress({
          file: 'jarvis-high.onnx',
          receivedBytes: 57_099_505,
          totalBytes: 114_199_011,
          percent: 50,
        });
        emitProgress({
          file: 'jarvis-high.onnx',
          receivedBytes: 114_199_011,
          totalBytes: 114_199_011,
          percent: 100,
        });
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ModelManager.ensureJarvisReady((p) => seen.push(p.percent));

    expect(ok).toBe(true);
    expect(seen).toEqual([50, 100]);
    // The download command received a real manifest with checksums.
    const downloadCall = tauriMocks.invoke.mock.calls.find((c) => c[0] === 'jarvis_voice_download');
    const manifest = (downloadCall?.[1] as { manifest: { files: Array<{ sha256: string }> } })
      .manifest;
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  });

  it('returns false (not a silent success) when the download fails', async () => {
    tauriMocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_voice_check_installed') return { installed: false };
      if (cmd === 'jarvis_voice_download') throw new Error('network unreachable');
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(ModelManager.ensureJarvisReady()).resolves.toBe(false);
  });

  it('re-downloads and repairs when installed files fail checksum verification', async () => {
    let verifyCalls = 0;
    tauriMocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'jarvis_voice_check_installed') return { installed: true };
      if (cmd === 'jarvis_voice_verify_checksums') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, corrupt: ['model_quantized.onnx'] }
          : { ok: true, corrupt: [] };
      }
      if (cmd === 'jarvis_voice_download') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(ModelManager.ensureJarvisReady()).resolves.toBe(true);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('jarvis_voice_download', expect.anything());
  });

  it('degrades gracefully to not-ready when every command fails (web preview)', async () => {
    tauriMocks.invoke.mockRejectedValue(new Error('command not found'));

    await expect(ModelManager.ensureJarvisReady()).resolves.toBe(false);
    await expect(ModelManager.status()).resolves.toEqual({ installed: false, ready: false });
    await expect(ModelManager.checkModelInstalled()).resolves.toBe(false);
  });
});
