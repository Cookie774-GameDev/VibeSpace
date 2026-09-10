import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { TabStrip } from './TabStrip';
import { TooltipProvider } from '@/components/ui/tooltip';

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], get: vi.fn() }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => fixture.rows }));
vi.mock('@/lib/db', () => ({ db: {}, chatRepo: { getById: fixture.get } }));
vi.mock('@/features/chat/chatLifecycle', () => ({ ensureActiveChat: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('keeps a newly selected persisted chat while live query refreshes an older tab list', async () => {
  const previousAuth = useAuthStore.getState();
  const previousUI = useUIStore.getState();
  const oldChat = { id: 'old-chat', title: 'Old chat' };
  fixture.rows = [oldChat];
  fixture.get.mockResolvedValue({ id: 'new-chat', project_id: null });
  useAuthStore.setState({ workspaceId: 'workspace' as never, projectId: null });
  useUIStore.setState({ activeChatId: 'old-chat', route: 'chat' });
  try {
    const view = render(<TooltipProvider><TabStrip /></TooltipProvider>);
    await act(async () => { useUIStore.getState().setActiveChat('new-chat'); });
    fixture.rows = [{ ...oldChat }];
    view.rerender(<TooltipProvider><TabStrip /></TooltipProvider>);
    await waitFor(() => expect(fixture.get).toHaveBeenCalledWith('new-chat'));
    expect(useUIStore.getState().activeChatId).toBe('new-chat');
  } finally {
    cleanup();
    useAuthStore.setState(previousAuth);
    useUIStore.setState(previousUI);
  }
});
