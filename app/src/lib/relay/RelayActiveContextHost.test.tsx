import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { RelayActiveContextHost } from './RelayActiveContextHost';

const native = vi.hoisted(() => ({
  open: vi.fn(async () => ({ ownerHandle: 'global-native-owner' })),
  update: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock('@/lib/tauri', () => ({
  openRelayActiveContext: native.open,
  updateRelayActiveContext: native.update,
  closeRelayActiveContext: native.close,
}));

describe('global native Relay active context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'local-account',
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
    });
    useUIStore.setState({ activeChatId: 'chat-a' });
  });

  it('mirrors ordinary selected native chats and revokes the scope on account/project changes', async () => {
    const view = render(<RelayActiveContextHost />);
    await waitFor(() =>
      expect(native.update).toHaveBeenCalledWith('global-native-owner', 1, {
        accountId: 'local-account',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        chatId: 'chat-a',
      }),
    );
    act(() => useUIStore.setState({ activeChatId: 'chat-b' }));
    await waitFor(() =>
      expect(native.update).toHaveBeenLastCalledWith('global-native-owner', 2, {
        accountId: 'local-account',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        chatId: 'chat-b',
      }),
    );
    act(() => useAuthStore.setState({ projectId: null }));
    await waitFor(() =>
      expect(native.update).toHaveBeenLastCalledWith('global-native-owner', 3, null),
    );
    view.unmount();
    await waitFor(() => expect(native.close).toHaveBeenCalledWith('global-native-owner', 4));
  });
});
