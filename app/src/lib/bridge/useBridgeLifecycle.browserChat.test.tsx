import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBridgeLifecycle } from './useBridgeLifecycle';

const lifecycleMocks = vi.hoisted(() => ({
  authState: {
    cloudSession: { user_id: 'account-a' },
    workspaceId: 'workspace-a',
    projectId: 'project-a',
  },
  useBrowserChatRelay: vi.fn(() => 'connected'),
  resetBridgeClient: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: typeof lifecycleMocks.authState) => unknown) =>
    selector(lifecycleMocks.authState),
}));

vi.mock('@/lib/supabase/env', () => ({
  isSupabaseConfigured: () => false,
}));

vi.mock('./useBrowserChatRelay', () => ({
  useBrowserChatRelay: lifecycleMocks.useBrowserChatRelay,
}));

vi.mock('./BridgeClient', () => ({
  getBridgeClient: vi.fn(),
  resetBridgeClient: lifecycleMocks.resetBridgeClient,
}));

describe('global bridge lifecycle host', () => {
  afterEach(() => {
    lifecycleMocks.useBrowserChatRelay.mockClear();
    lifecycleMocks.resetBridgeClient.mockClear();
    lifecycleMocks.authState.workspaceId = 'workspace-a';
    vi.unstubAllEnvs();
  });

  it('mounts the Browser Chat relay without mounting BrowserChatHub', () => {
    vi.stubEnv('VITE_PHONE_JARVIS_CLOUD_URL', '');
    const rendered = renderHook(() => useBridgeLifecycle());

    expect(lifecycleMocks.useBrowserChatRelay).toHaveBeenCalledWith(true, {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });

    rendered.unmount();
  });

  it('fails closed when a signed-in cloud account has no authoritative workspace', () => {
    vi.stubEnv('VITE_PHONE_JARVIS_CLOUD_URL', '');
    lifecycleMocks.authState.workspaceId = '';
    const rendered = renderHook(() => useBridgeLifecycle());

    expect(lifecycleMocks.useBrowserChatRelay).toHaveBeenCalledWith(false, {
      accountId: 'account-a',
      workspaceId: null,
      projectId: 'project-a',
    });

    rendered.unmount();
  });
});
