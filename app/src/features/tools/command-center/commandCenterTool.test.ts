import { describe, expect, it } from 'vitest';
import { inspectCommandCenterTool, readCommandCenterReleaseAuthority } from './commandCenterTool';

describe('Codex Command Center release authority', () => {
  it('accepts only a complete HTTPS release with a pinned checksum', () => {
    expect(
      readCommandCenterReleaseAuthority({
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL:
          'https://github.com/vibespace/releases/download/v1/command-center.exe',
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256: 'a'.repeat(64),
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION: '1.0.0',
      }),
    ).toEqual({
      url: 'https://github.com/vibespace/releases/download/v1/command-center.exe',
      sha256: 'a'.repeat(64),
      version: '1.0.0',
    });
  });

  it('fails closed for incomplete, insecure, or unpinned metadata', () => {
    expect(readCommandCenterReleaseAuthority({})).toBeNull();
    expect(
      readCommandCenterReleaseAuthority({
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL: 'http://example.com/tool.exe',
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256: 'a'.repeat(64),
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION: '1.0.0',
      }),
    ).toBeNull();
    expect(
      readCommandCenterReleaseAuthority({
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL: 'https://example.com/tool.exe',
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256: 'not-a-checksum',
        VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION: '1.0.0',
      }),
    ).toBeNull();
  });

  it('reports a truthful desktop-only state without calling native IPC in web preview', async () => {
    await expect(inspectCommandCenterTool()).resolves.toMatchObject({
      installed: false,
      installerReady: false,
      phase: 'idle',
      detail: 'Available in the installed VibeSpace desktop app.',
    });
  });
});
