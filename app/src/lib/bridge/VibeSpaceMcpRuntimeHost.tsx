import * as React from 'react';

import { useAuthStore } from '@/stores/auth';
import { publishBrowserChatRelayStatus } from './browserChatRelayStatus';
import { requestBrowserChatBridgeReconnect } from './BridgeClient';
import { useBrowserChatRelay } from './useBrowserChatRelay';

export function VibeSpaceMcpRuntimeHost() {
  const cloudAccountId = useAuthStore((state) => state.cloudSession?.user_id.trim() ?? '');
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const relayStatus = useBrowserChatRelay(Boolean(cloudAccountId), {
    accountId: cloudAccountId,
    workspaceId: workspaceId ? String(workspaceId) : null,
    projectId: projectId ? String(projectId) : null,
  });

  React.useEffect(() => {
    publishBrowserChatRelayStatus(relayStatus);
  }, [relayStatus]);

  React.useEffect(() => {
    const reconnect = () => requestBrowserChatBridgeReconnect();
    window.addEventListener('online', reconnect);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnect();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return null;
}
