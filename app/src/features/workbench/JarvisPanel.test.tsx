import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatId, ProjectId, WorkspaceId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { WorkbenchPanel } from './types';
import { JarvisPanel } from './JarvisPanel';

const mocks = vi.hoisted(() => ({
  chats: [] as Chat[],
  ensureActiveChat: vi.fn(),
}));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => mocks.chats }));
vi.mock('@/features/chat', () => ({
  ChatThread: ({ chatId, compact }: { chatId: string; compact?: boolean }) => (
    <div data-testid="chat-thread" data-compact={String(compact)}>
      {chatId}
    </div>
  ),
  Composer: ({ chatId }: { chatId: string }) => <div data-testid="composer">{chatId}</div>,
  EmptyChat: () => <div>Empty chat</div>,
  ensureActiveChat: mocks.ensureActiveChat,
}));
vi.mock('@/features/chat/token-boss/TokenBossCinematic', () => ({
  TokenBossCinematic: () => null,
}));
vi.mock('@/features/doctor/StorageDoctorNotice', () => ({
  useStorageDoctorSnapshot: () => ({ kind: 'healthy' }),
}));
vi.mock('@/lib/doctor/storageDoctor', () => ({
  isStorageDoctorUnavailableError: () => false,
}));
vi.mock('@/lib/db', () => ({ db: { chats: {} } }));
vi.mock('@/components/ui/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const WORKSPACE = 'workspace-1' as WorkspaceId;
const PROJECT_B = 'project-b' as ProjectId;

const panel: WorkbenchPanel = {
  id: 'jarvis-panel',
  kind: 'jarvis',
  title: 'Jarvis',
  x: 0,
  y: 0,
  width: 480,
  height: 560,
  z: 1,
  minimized: false,
  status: 'idle',
  settings: {},
};

function chat(id: string, workspaceId: WorkspaceId, projectId?: ProjectId): Chat {
  return {
    id: id as ChatId,
    workspace_id: workspaceId,
    project_id: projectId,
    title: id,
    mode: 'chat',
    active_agent_ids: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('Workbench Jarvis canonical chat scope', () => {
  it('shrinks and restores chat density from the panel content width', () => {
    let resize: ResizeObserverCallback = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mocks.chats = [chat('child', WORKSPACE, PROJECT_B)];
    useUIStore.setState({ activeChatId: 'child' });
    render(<JarvisPanel panel={panel} onUpdate={vi.fn()} />);
    React.act(() =>
      resize([{ contentRect: { width: 350 } } as ResizeObserverEntry], {} as ResizeObserver),
    );
    expect(screen.getByTestId('chat-thread').dataset.compact).toBe('true');
    expect((screen.getByTestId('chat-thread').parentElement as HTMLElement).style.zoom).toBe(
      '0.72',
    );
    React.act(() =>
      resize([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver),
    );
    expect(screen.getByTestId('chat-thread').dataset.compact).toBe('false');
    expect((screen.getByTestId('chat-thread').parentElement as HTMLElement).style.zoom).toBe('1');
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    mocks.chats = [];
    mocks.ensureActiveChat.mockReset();
    useAuthStore.setState({ workspaceId: WORKSPACE, projectId: PROJECT_B });
    useUIStore.setState({ activeChatId: null, route: 'workbench' });
  });

  it('never renders a stale active chat and recovers only through the current exact scope', async () => {
    mocks.chats = [
      chat('chat-project-b', WORKSPACE, PROJECT_B),
      chat('chat-unscoped', WORKSPACE),
      chat('chat-other-workspace', 'workspace-2' as WorkspaceId, PROJECT_B),
    ];
    useUIStore.setState({ activeChatId: 'chat-project-a' });
    mocks.ensureActiveChat.mockImplementation(async (options: { navigateToChat?: boolean }) => {
      expect(options).toEqual({ navigateToChat: false });
      useUIStore.getState().setActiveChat('chat-project-b');
      return 'chat-project-b';
    });

    render(<JarvisPanel panel={panel} onUpdate={vi.fn()} />);

    expect(screen.queryByText('chat-project-a')).toBeNull();
    expect(screen.queryByRole('option', { name: 'chat-unscoped' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'chat-other-workspace' })).toBeNull();
    await waitFor(() => expect(mocks.ensureActiveChat).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId('chat-thread').textContent).toBe('chat-project-b'),
    );
    expect(screen.getByTestId('composer').textContent).toBe('chat-project-b');
    expect(useUIStore.getState().route).toBe('workbench');
  });

  it('creates a new scoped chat without navigating out of Workbench', async () => {
    mocks.ensureActiveChat.mockResolvedValue(null);
    render(<JarvisPanel panel={panel} onUpdate={vi.fn()} />);
    await waitFor(() => expect(mocks.ensureActiveChat).toHaveBeenCalled());
    mocks.ensureActiveChat.mockClear();

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0]!);

    await waitFor(() =>
      expect(mocks.ensureActiveChat).toHaveBeenCalledWith({
        forceNew: true,
        navigateToChat: false,
      }),
    );
    expect(useUIStore.getState().route).toBe('workbench');
  });
});
