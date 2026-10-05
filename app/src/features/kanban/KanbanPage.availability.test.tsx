import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import { KanbanPage } from './KanbanPage';

const fixture = vi.hoisted(() => ({
  workspace: vi.fn(),
  project: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock('@/stores/auth', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({
      localUserId: 'kanban-account',
      cloudSession: null,
      workspaceId: 'kanban-workspace',
      projectId: 'kanban-project',
    })),
  };
});
vi.mock('@/lib/db/repositories', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/db/repositories')>('@/lib/db/repositories');
  return {
    ...actual,
    workspaceRepo: {
      ...actual.workspaceRepo,
      getById: fixture.workspace,
      create: fixture.createWorkspace,
    },
    projectRepo: { ...actual.projectRepo, getById: fixture.project, create: fixture.createProject },
  };
});

const workspace = { id: 'kanban-workspace', owner_id: 'kanban-account' };
const project = { id: 'kanban-project', workspace_id: 'kanban-workspace' };
const explanation =
  'Kanban editing is unavailable because this project’s workspace could not be verified. Select a different project or restore a matching account backup in Account Center.';
const buttons = () =>
  [
    screen.getByRole('button', { name: "Add item to Today's to-do" }),
    screen.getByRole('button', { name: 'Add item to Milestones' }),
  ] as HTMLButtonElement[];
const inputs = () =>
  [
    screen.getByRole('textbox', { name: "New item for Today's to-do" }),
    screen.getByRole('textbox', { name: 'New item for Milestones' }),
  ] as HTMLInputElement[];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    localUserId: 'kanban-account',
    cloudSession: null,
    workspaceId: 'kanban-workspace' as never,
    projectId: 'kanban-project' as never,
  });
  useMilestonesStore.setState({
    items: [
      {
        id: 'retained-legacy',
        title: 'Retained unassigned item',
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  fixture.workspace.mockReset().mockResolvedValue(workspace);
  fixture.project.mockReset().mockImplementation(async (id: string) => ({ ...project, id }));
  fixture.createWorkspace.mockReset();
  fixture.createProject.mockReset();
});
afterEach(cleanup);

describe('Kanban unavailable ownership explanation', () => {
  it('waits for the joined ownership check before explaining disabled inputs and add controls', async () => {
    const read = deferred<undefined>();
    fixture.workspace.mockReturnValueOnce(read.promise);
    const before = localStorage.getItem('jarvis-inspector-milestones-v1');
    render(<KanbanPage />);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(screen.queryByText(explanation)).toBeNull();
    expect(buttons().every((button) => !button.hasAttribute('aria-describedby'))).toBe(true);
    await act(async () => {
      read.resolve(undefined);
    });
    const status = await screen.findByText(explanation);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.id).not.toBe('');
    for (const control of [...buttons(), ...inputs()]) {
      expect(control.disabled).toBe(true);
      expect(control.getAttribute('aria-describedby')).toBe(status.id);
      expect(control.getAttribute('title')).toBe(explanation);
    }
    buttons().forEach((button) => fireEvent.click(button));
    expect(localStorage.getItem('jarvis-inspector-milestones-v1')).toBe(before);
    expect(fixture.createWorkspace).not.toHaveBeenCalled();
    expect(fixture.createProject).not.toHaveBeenCalled();
  });

  it('clears the old denial during the next project check and enables only a valid joined project', async () => {
    fixture.workspace.mockResolvedValueOnce(undefined);
    render(<KanbanPage />);
    await screen.findByText(explanation);
    const read = deferred<typeof workspace>();
    fixture.workspace.mockReturnValueOnce(read.promise);
    act(() => useAuthStore.setState({ projectId: 'kanban-other-project' as never }));
    expect(screen.queryByText(explanation)).toBeNull();
    expect(buttons().every((button) => button.disabled)).toBe(true);
    await act(async () => {
      read.resolve(workspace);
    });
    await waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
    expect(screen.queryByText(explanation)).toBeNull();
    expect(buttons().every((button) => !button.hasAttribute('aria-describedby'))).toBe(true);
    fireEvent.change(inputs()[0]!, { target: { value: 'Owned project task' } });
    fireEvent.click(buttons()[0]!);
    expect(useMilestonesStore.getState().items).toContainEqual(
      expect.objectContaining({
        title: 'Owned project task',
        scope: expect.objectContaining({ projectId: 'kanban-other-project' }),
      }),
    );
  });

  it('does not publish a late denied result after another project has been admitted', async () => {
    const old = deferred<undefined>();
    fixture.workspace.mockReturnValueOnce(old.promise);
    render(<KanbanPage />);
    act(() => useAuthStore.setState({ projectId: 'kanban-other-project' as never }));
    await waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
    await act(async () => {
      old.resolve(undefined);
    });
    expect(screen.queryByText(explanation)).toBeNull();
    expect(buttons().every((button) => !button.disabled)).toBe(true);
  });

  it.each(['foreign owner', 'wrong project join', 'failed read'] as const)(
    'explains unavailable editing after %s without changing the fail-closed boundary',
    async (reason) => {
      if (reason === 'foreign owner')
        fixture.workspace.mockResolvedValue({ ...workspace, owner_id: 'foreign-account' });
      else if (reason === 'wrong project join')
        fixture.project.mockResolvedValue({ ...project, workspace_id: 'foreign-workspace' });
      else fixture.workspace.mockRejectedValue(new Error('Synthetic unavailable storage'));
      const before = localStorage.getItem('jarvis-inspector-milestones-v1');
      render(<KanbanPage />);
      await screen.findByText(explanation);
      expect(buttons().every((button) => button.disabled)).toBe(true);
      expect(localStorage.getItem('jarvis-inspector-milestones-v1')).toBe(before);
      expect(fixture.createWorkspace).not.toHaveBeenCalled();
      expect(fixture.createProject).not.toHaveBeenCalled();
    },
  );
});
