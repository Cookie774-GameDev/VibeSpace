import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { BrowserChatRelayStatus } from './browserChatRelayStatus';
import { browserChatRelayStatusStore, resetBrowserChatRelayStatus } from './browserChatRelayStatus';
import { VibeSpaceMcpRuntimeHost } from './VibeSpaceMcpRuntimeHost';

const mocks = vi.hoisted(() => ({
  reconnect: vi.fn(),
  status: 'connected' as BrowserChatRelayStatus,
  useRelay: vi.fn(() => mocks.status),
}));

vi.mock('./BridgeClient', () => ({
  requestBrowserChatBridgeReconnect: mocks.reconnect,
}));

vi.mock('./useBrowserChatRelay', () => ({
  useBrowserChatRelay: mocks.useRelay,
}));

describe('VibeSpaceMcpRuntimeHost', () => {
  beforeEach(() => {
    mocks.reconnect.mockClear();
    mocks.useRelay.mockClear();
    mocks.status = 'connected';
    resetBrowserChatRelayStatus();
    useAuthStore.setState({
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
      cloudSession: {
        user_id: 'account-a',
        email: 'account-a@example.test',
        expires_at: 4_102_444_800,
      },
    });
  });

  it('owns the relay outside Browser Chat and publishes its status', () => {
    render(<VibeSpaceMcpRuntimeHost />);

    expect(mocks.useRelay).toHaveBeenCalledWith(true, {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
    expect(browserChatRelayStatusStore.getSnapshot()).toBe('connected');
  });

  it('requests recovery when connectivity returns or the app becomes visible', () => {
    render(<VibeSpaceMcpRuntimeHost />);

    act(() => window.dispatchEvent(new Event('online')));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
  });
});
