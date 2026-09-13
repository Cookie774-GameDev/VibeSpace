import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDelete: vi.fn(),
  projectList: vi.fn(),
  chatList: vi.fn(),
  chatUpdate: vi.fn(),
  setProjectId: vi.fn(),
  setRoute: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

const project = {
  id: 'project-a',
  workspace_id: 'workspace-a',
  name: 'Project Alpha',
  color_hue: 210,
  created_at: 1,
  updated_at: 1,
};

const fallbackProject = {
  ...project,
  id: 'project-b',
  name: 'Project Beta',
};

const projectChats = [
  { id: 'chat-a', project_id: project.id },
  { id: 'chat-b', project_id: project.id },
];

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) => {
    if (defaultValue === undefined) return project;
    if (defaultValue === 0) return projectChats.length;
    return [];
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a',
      projectId: project.id,
      setProjectId: mocks.setProjectId,
    }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({ setRoute: mocks.setRoute }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({ agents: {} }),
}));

vi.mock('@/lib/accountIdentity', async (original) => ({
  ...(await original<typeof import('@/lib/accountIdentity')>()),
  getActiveAccountIdentity: () => ({ source: 'local', accountId: 'project-delete-test' }),
}));
vi.mock('@/lib/db/repositories', () => ({
  projectRepo: { getById: async () => project, delete: mocks.projectDelete },
  chatRepo: { listByProject: mocks.chatList, update: mocks.chatUpdate },
  taskRepo: {},
}));

vi.mock('@/lib/db', () => ({
  db: {},
  projectRepo: {
    getById: vi.fn(),
    update: vi.fn(),
    listByWorkspace: mocks.projectList,
    delete: mocks.projectDelete,
  },
  chatRepo: {
    listByProject: mocks.chatList,
    update: mocks.chatUpdate,
  },
}));

vi.mock('@/features/browser-chat/browserChatRepository', () => ({
  createProviderProjectLinkRepository: () => ({
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

import { ProjectDetail } from './ProjectDetail';

function beginDelete() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
}

async function reachTypedConfirmation() {
  beginDelete();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to impact review' }));
  await screen.findByRole('heading', { name: 'Review deletion impact' });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to final confirmation' }));
  await screen.findByRole('heading', { name: 'Type Delete to confirm' });
}

describe('ProjectDetail deletion safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectList.mockResolvedValue([project, fallbackProject]);
    mocks.chatList.mockResolvedValue(projectChats);
    mocks.chatUpdate.mockResolvedValue(undefined);
    mocks.projectDelete.mockResolvedValue(undefined);
  });

  it('requires two explicit reviews and exact case-sensitive typed confirmation before mutation', async () => {
    render(<ProjectDetail />);

    beginDelete();
    expect(screen.getByRole('heading', { name: 'Delete Project Alpha?' })).toBeTruthy();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to impact review' }));
    await screen.findByRole('heading', { name: 'Review deletion impact' });
    expect(screen.getByText(/2 chats will become unassigned/i)).toBeTruthy();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to final confirmation' }));
    await screen.findByRole('heading', { name: 'Type Delete to confirm' });
    const finalButton = screen.getByRole('button', { name: 'Move project to Recycle Bin' });
    const input = screen.getByLabelText('Type Delete to confirm project deletion');

    expect((finalButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'delete' } });
    expect((finalButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Delete ' } });
    expect((finalButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Delete' } });
    expect((finalButton as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();

    fireEvent.click(finalButton);

    await waitFor(() => expect(mocks.projectDelete).toHaveBeenCalledWith(project.id));
    expect(mocks.chatUpdate.mock.calls).toEqual([
      ['chat-a', { project_id: undefined }],
      ['chat-b', { project_id: undefined }],
    ]);
    expect(mocks.setProjectId).toHaveBeenCalledWith(fallbackProject.id);
    expect(mocks.setRoute).toHaveBeenCalledWith('chat');
  });

  it('resets confirmation state after cancellation and never mutates', async () => {
    render(<ProjectDetail />);
    await reachTypedConfirmation();

    fireEvent.change(screen.getByLabelText('Type Delete to confirm project deletion'), {
      target: { value: 'Delete' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel project deletion' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();

    beginDelete();
    expect(screen.getByRole('heading', { name: 'Delete Project Alpha?' })).toBeTruthy();
    expect(screen.queryByDisplayValue('Delete')).toBeNull();
  });

  it('lets Escape cancel while Enter in the typed field cannot bypass the final action', async () => {
    render(<ProjectDetail />);
    await reachTypedConfirmation();

    const input = screen.getByLabelText('Type Delete to confirm project deletion');
    fireEvent.change(input, { target: { value: 'Delete' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();
  });

  it('refreshes the affected chat count before the final typed stage', async () => {
    mocks.chatList
      .mockResolvedValueOnce(projectChats)
      .mockResolvedValueOnce([...projectChats, { id: 'chat-c', project_id: project.id }]);
    render(<ProjectDetail />);

    beginDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to impact review' }));
    await screen.findByRole('heading', { name: 'Review deletion impact' });
    expect(screen.getByText(/2 chats will become unassigned/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to final confirmation' }));
    await screen.findByRole('heading', { name: 'Type Delete to confirm' });
    expect(screen.getByText(/current impact: 3 chats will become unassigned/i)).toBeTruthy();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();
  });

  it('rechecks workspace safety immediately before deletion and fails closed', async () => {
    render(<ProjectDetail />);
    await reachTypedConfirmation();
    mocks.projectList.mockResolvedValueOnce([project]);

    fireEvent.change(screen.getByLabelText('Type Delete to confirm project deletion'), {
      target: { value: 'Delete' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move project to Recycle Bin' }));

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        "Can't delete",
        'You need at least one other project. Create another first.',
      ),
    );
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.projectDelete).not.toHaveBeenCalled();
  });

  it('uses a single in-flight deletion when the final action is clicked repeatedly', async () => {
    let resolveDelete!: () => void;
    mocks.projectDelete.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDelete = resolve)),
    );
    render(<ProjectDetail />);
    await reachTypedConfirmation();

    fireEvent.change(screen.getByLabelText('Type Delete to confirm project deletion'), {
      target: { value: 'Delete' },
    });
    const finalButton = screen.getByRole('button', { name: 'Move project to Recycle Bin' });
    fireEvent.click(finalButton);
    fireEvent.click(finalButton);

    await waitFor(() => expect(mocks.projectDelete).toHaveBeenCalledTimes(1));
    expect(mocks.chatUpdate).toHaveBeenCalledTimes(projectChats.length);
    resolveDelete();
    await waitFor(() => expect(mocks.setRoute).toHaveBeenCalledWith('chat'));
  });

  it('reports repository deletion failure without routing or selecting a fallback', async () => {
    mocks.projectDelete.mockRejectedValueOnce(new Error('local delete failed'));
    render(<ProjectDetail />);
    await reachTypedConfirmation();

    fireEvent.change(screen.getByLabelText('Type Delete to confirm project deletion'), {
      target: { value: 'Delete' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move project to Recycle Bin' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Delete failed', 'local delete failed'),
    );
    expect(mocks.setProjectId).not.toHaveBeenCalled();
    expect(mocks.setRoute).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
