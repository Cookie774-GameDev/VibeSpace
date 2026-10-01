import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  liveQueryCall: 0,
  links: [] as Array<{
    id: string;
    provider: 'chatgpt';
    providerProjectUrl?: string;
    state: 'linked' | 'stale' | 'unsupported';
  }>,
  create: vi.fn(),
  remove: vi.fn(),
  openExternal: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const project = {
  id: 'project-a',
  workspace_id: 'workspace-a',
  name: 'Project Alpha',
  color_hue: 210,
  created_at: 1,
  updated_at: 1,
};

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) => {
    mocks.liveQueryCall += 1;
    if (defaultValue === undefined) return project;
    if (defaultValue === 0) return 0;
    return mocks.links;
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      setProjectId: vi.fn(),
    }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({ setRoute: vi.fn() }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({ agents: {} }),
}));

vi.mock('@/lib/db', () => ({
  db: {},
  projectRepo: {
    getById: vi.fn(),
    update: vi.fn(),
    listByWorkspace: vi.fn(),
    delete: vi.fn(),
  },
  chatRepo: {
    listByProject: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/features/browser-chat/browserChatRepository', () => ({
  createProviderProjectLinkRepository: () => ({
    list: vi.fn(),
    create: mocks.create,
    remove: mocks.remove,
  }),
}));

vi.mock('@/lib/tauri', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: vi.fn(),
  },
}));

import { ProjectDetail } from './ProjectDetail';

describe('ProjectDetail Browser Chat project links', () => {
  beforeEach(() => {
    mocks.liveQueryCall = 0;
    mocks.links = [];
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(undefined);
    mocks.remove.mockReset();
    mocks.remove.mockResolvedValue(undefined);
    mocks.openExternal.mockReset();
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it('saves a validated provider project URL as a local-only link', async () => {
    render(<ProjectDetail />);

    expect(screen.getByText(/does not create or verify remote project membership/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ChatGPT project URL'), {
      target: { value: 'https://chatgpt.com/g/project-abc/project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save local link' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        provider: 'chatgpt',
        providerProjectUrl: 'https://chatgpt.com/g/project-abc/project',
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Local link saved',
      expect.stringMatching(/not verified remote membership/i),
    );
  });

  it('opens and unlinks only the saved local provider pointer', async () => {
    mocks.links = [
      {
        id: 'link-a',
        provider: 'chatgpt',
        providerProjectUrl: 'https://chatgpt.com/g/project-abc/project',
        state: 'linked',
      },
    ];
    render(<ProjectDetail />);

    fireEvent.click(screen.getByRole('button', { name: 'Open ChatGPT project' }));
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith('https://chatgpt.com/g/project-abc/project'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unlink ChatGPT project' }));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        { accountId: 'account-a', workspaceId: 'workspace-a' },
        'link-a',
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Local link removed',
      expect.stringMatching(/remote project was not changed/i),
    );
  });

  it('fails closed when the repository rejects a non-provider project URL', async () => {
    mocks.create.mockRejectedValueOnce(new Error('provider_project_url_invalid'));
    render(<ProjectDetail />);

    fireEvent.change(screen.getByLabelText('ChatGPT project URL'), {
      target: { value: 'https://attacker.example/project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save local link' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Link not saved',
        'Enter an exact project URL from the selected provider.',
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
