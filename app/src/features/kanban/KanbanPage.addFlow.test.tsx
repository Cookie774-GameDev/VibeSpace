import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    useMilestonesStore.setState({ items: [] });
  });

  afterEach(() => cleanup());

  it('focuses the matching input when an empty plus control is clicked', () => {
    render(<KanbanPage />);
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

  it('adds typed to-dos and milestones through the existing shared store', () => {
    const { container } = render(<KanbanPage />);
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
});
