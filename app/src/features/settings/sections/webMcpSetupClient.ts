import { invoke } from '@tauri-apps/api/core';
export type GuideTab = 'tunnel' | 'api';
export type WebMcpStatus = {
  packaged: boolean;
  connectionDetected: boolean;
  connectionFile?: string;
  status: string;
  toolCount: number;
  hasKey: boolean;
  displayName?: string;
  tunnelId?: string;
  guideTab?: GuideTab;
  step?: number;
  setupComplete?: boolean;
  enabled?: boolean;
  watchdog?: boolean;
  startOnComputer?: boolean | null;
  errorCode?: string;
};
export type SetupDraft = {
  displayName: string;
  tunnelId: string;
  guideTab: GuideTab;
  step: number;
};
export const setupLinks = {
  'open-tunnels': 'https://platform.openai.com/settings/organization/tunnels',
  'open-api-keys': 'https://platform.openai.com/settings/organization/api-keys',
  'open-chatgpt': 'https://chatgpt.com/plugins',
} as const;
export type SetupLink = keyof typeof setupLinks;
export const setupErrorMessages: Record<string, string> = {
  CONNECTOR_LOCK_INVALID:
    'An interrupted local startup is blocking the connector. Repair interrupted setup to preserve the old marker and try again.',
  CONNECTOR_LOCK_IN_USE:
    'Another connector process still owns this setup. Wait for that process; its files have been preserved.',
  CONNECTOR_START_TIMEOUT:
    'The packaged connector did not become ready in time. Retry preparation to check it again.',
  CONNECTOR_STORAGE_UNAVAILABLE:
    'The packaged tools could not be installed. Check available disk space and retry preparation.',
  CONNECTOR_PACKAGE_INVALID:
    'The connector package is missing or could not be verified. Update VibeSpace and retry preparation.',
  WINDOWS_STARTUP_UNAVAILABLE:
    'Windows could not verify the startup setting. Check Windows startup permissions. Your tunnel connection is separate.',
  CONNECTOR_REQUEST_TIMEOUT:
    'The native connector request timed out. Retry preparation to check it again.',
  CREDENTIAL_STORAGE_UNAVAILABLE:
    'Windows secure storage could not save or unlock your API key. The tunnel has not been authenticated.',
  INVALID_PLUGIN_NAME: 'Use a plugin name of at most 64 characters without control characters.',
  INVALID_TUNNEL_ID: 'Paste the complete tunnel ID from OpenAI.',
  INVALID_RUNTIME_KEY: 'Use a restricted runtime API key, not an admin key.',
  TUNNEL_CONFIGURATION_REQUIRED: 'Add your tunnel ID and runtime API key first.',
  TUNNEL_CREDENTIALS_IN_USE: 'Disconnect before replacing active tunnel credentials.',
  TUNNEL_START_FAILED:
    'The local tunnel client could not start. Check its packaged runtime and retry.',
  TUNNEL_AUTHENTICATION_FAILED:
    'OpenAI rejected this runtime API key. Replace it with a valid key.',
  TUNNEL_PERMISSION_DENIED:
    'OpenAI denied access. The runtime key needs Tunnels Read and Use for this tunnel.',
  TUNNEL_CONNECTION_FAILED:
    'The tunnel is not ready. Automatic recovery is retrying; you can stop and check setup.',
};
export function describeSetupError(error: unknown, fallback: string): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const code = text.split(':', 1)[0].trim();
  if (Object.hasOwn(setupErrorMessages, code)) return setupErrorMessages[code];
  if (Object.values(setupErrorMessages).includes(text)) return text;
  return fallback;
}
export const pluginName = (name: string) => name.trim() || 'VibeSpace Desktop';
async function boundedNative<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(setupErrorMessages.CONNECTOR_REQUEST_TIMEOUT)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const readWebMcpStatus = () =>
  boundedNative(invoke<WebMcpStatus>('desktop_connector_status'), 8000);
export async function setupAction(action: string): Promise<void> {
  try {
    await boundedNative(
      invoke('desktop_connector_setup', { action }),
      action === 'prepare' || action === 'repair' ? 90000 : 65000,
    );
  } catch (error) {
    throw new Error(
      describeSetupError(error, 'The local connector action could not be confirmed. Please retry.'),
    );
  }
}
export function draftFromStatus(status?: WebMcpStatus): SetupDraft {
  return {
    displayName: status?.displayName || 'VibeSpace Desktop',
    tunnelId: status?.tunnelId || '',
    guideTab: status?.guideTab === 'api' ? 'api' : 'tunnel',
    step: status?.step === 3 ? 3 : 1,
  };
}
export function validateSetupDraft(draft: SetupDraft, apiKey: string): string | undefined {
  if (draft.displayName.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(draft.displayName))
    return setupErrorMessages.INVALID_PLUGIN_NAME;
  if (draft.tunnelId.trim() && !/^tunnel_[a-zA-Z0-9_-]{8,128}$/.test(draft.tunnelId.trim()))
    return setupErrorMessages.INVALID_TUNNEL_ID;
  if (
    apiKey &&
    (apiKey.length < 20 ||
      apiKey.length > 4096 ||
      /\s/.test(apiKey) ||
      apiKey.startsWith('sk-admin-'))
  )
    return setupErrorMessages.INVALID_RUNTIME_KEY;
  return undefined;
}
export async function saveWebMcpDraft(draft: SetupDraft, apiKey: string): Promise<WebMcpStatus> {
  const problem = validateSetupDraft(draft, apiKey);
  if (problem) throw new Error(problem);
  try {
    await boundedNative(
      invoke('desktop_connector_setup', {
        action: 'save',
        draft: {
          displayName: pluginName(draft.displayName),
          tunnelId: draft.tunnelId.trim(),
          guideTab: draft.guideTab,
          step: draft.step,
          ...(apiKey ? { apiKey } : {}),
        },
      }),
      65000,
    );
    const confirmed = await readWebMcpStatus();
    if (
      confirmed.displayName !== pluginName(draft.displayName) ||
      confirmed.tunnelId !== draft.tunnelId.trim() ||
      confirmed.guideTab !== draft.guideTab ||
      confirmed.step !== draft.step ||
      (apiKey && !confirmed.hasKey)
    )
      throw new Error('Setup readback mismatch');
    return confirmed;
  } catch (error) {
    throw new Error(
      describeSetupError(error, 'Setup progress could not be saved and verified. Please retry.'),
    );
  }
}

/** A saved setup or last ready snapshot does not verify a current connection. */
export function webMcpConnectionReady(
  status: WebMcpStatus | undefined,
  statusAvailable: boolean,
): boolean {
  return (
    statusAvailable &&
    status?.connectionDetected === true &&
    status.enabled !== false &&
    status.status === 'ready' &&
    Number.isSafeInteger(status.toolCount) &&
    status.toolCount > 0
  );
}
