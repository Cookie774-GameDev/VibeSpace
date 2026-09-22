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
  'open-chatgpt': 'https://chatgpt.com/#settings/Connectors',
} as const;
export type SetupLink = keyof typeof setupLinks;
export const readWebMcpStatus = () => invoke<WebMcpStatus>('desktop_connector_status');
export const setupAction = (action: string) => invoke<void>('desktop_connector_setup', { action });
export function draftFromStatus(status?: WebMcpStatus): SetupDraft {
  return {
    displayName: status?.displayName || 'VibeSpace Desktop',
    tunnelId: status?.tunnelId || '',
    guideTab: status?.guideTab === 'api' ? 'api' : 'tunnel',
    step: status?.step === 3 ? 3 : 1,
  };
}
export function validateSetupDraft(draft: SetupDraft, apiKey: string): string | undefined {
  if (
    !draft.displayName.trim() ||
    draft.displayName.trim().length > 64 ||
    /[\u0000-\u001f\u007f]/.test(draft.displayName)
  )
    return 'Use an app name between 1 and 64 characters.';
  if (draft.tunnelId.trim() && !/^tunnel_[a-zA-Z0-9_-]{8,128}$/.test(draft.tunnelId.trim()))
    return 'Paste the complete tunnel ID from OpenAI.';
  if (
    apiKey &&
    (apiKey.length < 20 ||
      apiKey.length > 4096 ||
      /\s/.test(apiKey) ||
      apiKey.startsWith('sk-admin-'))
  )
    return 'Use a restricted runtime API key, not an admin key.';
  return undefined;
}
export async function saveWebMcpDraft(draft: SetupDraft, apiKey: string): Promise<WebMcpStatus> {
  const problem = validateSetupDraft(draft, apiKey);
  if (problem) throw new Error(problem);
  await invoke('desktop_connector_setup', {
    action: 'save',
    draft: {
      displayName: draft.displayName.trim(),
      tunnelId: draft.tunnelId.trim(),
      guideTab: draft.guideTab,
      step: draft.step,
      ...(apiKey ? { apiKey } : {}),
    },
  });
  const confirmed = await readWebMcpStatus();
  if (
    confirmed.displayName !== draft.displayName.trim() ||
    confirmed.tunnelId !== draft.tunnelId.trim() ||
    confirmed.guideTab !== draft.guideTab ||
    (apiKey && !confirmed.hasKey)
  )
    throw new Error('The saved progress could not be confirmed. Please retry.');
  return confirmed;
}
