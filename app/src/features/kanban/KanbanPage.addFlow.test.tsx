import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/db/repositories', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/repositories')>('@/lib/db/repositories');
  return { ...actual,
    workspaceRepo: { ...actual.workspaceRepo, getById: vi.fn(async () => ({ id: 'S61-workspace-A', owner_id: 'S61-account-A' })) },
    projectRepo: { ...actual.projectRepo, getById: vi.fn(async () => ({ id: 'S61-project-A', workspace_id: 'S61-workspace-A' })) },
  };
});
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import { KanbanPage } from './KanbanPage';

vi.mock('@/features/inspector/workspaceTasks', () => ({
  useWorkspaceOpenTasks: () => [
    {
      id: 'milestone:unexpected',
      source: 'milestone',
      title: 'Must not become live activity',
      updatedAt: 1,
    },
  ],
}));

vi.mock('@/features/inspector/workspaceAnalytics', () => ({
  useWorkspaceAnalyticsStore: () => 0,
}));

describe('KanbanPage add controls', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ localUserId: 'S61-account-A', cloudSession: null,
      workspaceId: 'S61-workspace-A' as never, projectId: 'S61-project-A' as never });
    useMilestonesStore.setState({ items: [] });
  });

  afterEach(() => cleanup());

  it('focuses the matching input when an empty plus control is clicked', async () => {
    render(<KanbanPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: "Add item to Today's to-do" }) as HTMLButtonElement).disabled).toBe(false));
    const todoInput = screen.getByRole('textbox', { name: "New item for Today's to-do" });
    const todoAdd = screen.getByRole('button', { name: "Add item to Today's to-do" });
    const milestoneInput = screen.getByRole('textbox', { name: 'New item for Milestones' });
    const milestoneAdd = screen.getByRole('button', { name: 'Add item to Milestones' });

    expect((todoAdd as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(todoAdd);
    expect(document.activeElement).toBe(todoInput);

    expect((milestoneAdd as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(milestoneAdd);
    expect(document.activeElement).toBe(milestoneInput);
  });

  it('adds typed to-dos and milestones through the existing shared store', async () => {
    const { container } = render(<KanbanPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: "Add item to Today's to-do" }) as HTMLButtonElement).disabled).toBe(false));
    const todoInput = screen.getByRole('textbox', { name: "New item for Today's to-do" });
    const milestoneInput = screen.getByRole('textbox', { name: 'New item for Milestones' });

    fireEvent.change(todoInput, { target: { value: 'Polish the Warm theme' } });
    fireEvent.click(screen.getByRole('button', { name: "Add item to Today's to-do" }));
    fireEvent.change(milestoneInput, { target: { value: 'Ship the launch build' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item to Milestones' }));

    expect(useMilestonesStore.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Polish the Warm theme', kind: 'todo' }),
        expect.objectContaining({ title: 'Ship the launch build', kind: 'milestone' }),
      ]),
    );
    expect((todoInput as HTMLInputElement).value).toBe('');
    expect((milestoneInput as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Live workspace activity')).toBeNull();
    expect(container.querySelector('[data-kanban-checklist-grid="expanded"]')).not.toBeNull();
  });

  it('marks warm inputs, cards, and empty states without changing creation behavior', async () => {
    const { container } = render(<KanbanPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: "Add item to Today's to-do" }) as HTMLButtonElement).disabled).toBe(false));

    expect(container.querySelectorAll('[data-warm-surface="kanban-input"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-warm-surface="kanban-empty-copy"]')).toHaveLength(2);

    fireEvent.change(screen.getByRole('textbox', { name: "New item for Today's to-do" }), {
      target: { value: 'Warm card proof' },
    });
    fireEvent.click(screen.getByRole('button', { name: "Add item to Today's to-do" }));
    expect(container.querySelector('[data-warm-surface="kanban-card"]')).not.toBeNull();
  });

  it('names populated inline editors without relying on their current values', async () => {
    render(<KanbanPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: "Add item to Today's to-do" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: "New item for Today's to-do" }), {
      target: { value: 'Readable task' },
    });
    fireEvent.click(screen.getByRole('button', { name: "Add item to Today's to-do" }));

    expect(
      (screen.getByRole('textbox', { name: 'Task title: Readable task' }) as HTMLInputElement)
        .value,
    ).toBe('Readable task');
    expect(
      (screen.getByRole('textbox', { name: 'Description for Readable task' }) as HTMLInputElement)
        .value,
    ).toBe('');
  });

  it('edits, completes, and reopens a milestone without stale completion state', async () => {
    render(<KanbanPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: "Add item to Today's to-do" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: 'New item for Milestones' }), {
      target: { value: 'Draft milestone' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add item to Milestones' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Task title: Draft milestone' }), {
      target: { value: 'Verified milestone' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description for Verified milestone' }), {
      target: { value: 'Persist the complete lifecycle' },
    });
    fireEvent.change(screen.getByLabelText('Target date for Verified milestone'), {
      target: { value: '2026-12-31' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Complete Verified milestone' }));
    expect(useMilestonesStore.getState().items[0]).toMatchObject({
      title: 'Verified milestone',
      description: 'Persist the complete lifecycle',
      status: 'done',
      completedAt: expect.any(Number),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Verified milestone not done' }));
    expect(useMilestonesStore.getState().items[0]).toMatchObject({
      title: 'Verified milestone',
      description: 'Persist the complete lifecycle',
      status: 'todo',
      completedAt: undefined,
    });
  });
});
