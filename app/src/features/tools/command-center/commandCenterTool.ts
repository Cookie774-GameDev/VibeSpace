import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '@/lib/utils';

export interface CommandCenterReleaseAuthority {
  url: string;
  sha256: string;
  version: string;
}

export interface CommandCenterToolState {
  installed: boolean;
  executablePath: string | null;
  installerReady: boolean;
  phase: 'idle' | 'downloaded' | 'installing' | 'launched';
  detail: string | null;
}

export interface CommandCenterDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

type Env = Record<string, string | undefined>;

export function readCommandCenterReleaseAuthority(
  env: Env = import.meta.env as Env,
): CommandCenterReleaseAuthority | null {
  const url = env.VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL?.trim() ?? '';
  const sha256 = env.VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256?.trim() ?? '';
  const version = env.VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION?.trim() ?? '';
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      !/^[a-f0-9]{64}$/iu.test(sha256) ||
      !/^[a-z0-9._-]{1,64}$/iu.test(version)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { url, sha256, version };
}

async function operate(request: Record<string, unknown>): Promise<CommandCenterToolState> {
  if (!isTauri) {
    return {
      installed: false,
      executablePath: null,
      installerReady: false,
      phase: 'idle',
      detail: 'Available in the installed VibeSpace desktop app.',
    };
  }
  return invoke<CommandCenterToolState>('command_center_tool', { request });
}

export const inspectCommandCenterTool = () => operate({ action: 'inspect' });

export const downloadCommandCenterTool = (release: CommandCenterReleaseAuthority) =>
  operate({ action: 'download', ...release });

export const installCommandCenterTool = (release: CommandCenterReleaseAuthority) =>
  operate({ action: 'install', sha256: release.sha256, version: release.version });

export const launchCommandCenterTool = () => operate({ action: 'launch' });

export const cancelCommandCenterToolDownload = () => operate({ action: 'cancel_download' });

export function onCommandCenterDownloadProgress(
  listener: (progress: CommandCenterDownloadProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return listen<CommandCenterDownloadProgress>('command-center-tool-progress', (event) =>
    listener(event.payload),
  );
}
