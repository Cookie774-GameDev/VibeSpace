import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/db/repositories', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/repositories')>('@/lib/db/repositories');
  return { ...actual,
    workspaceRepo: { ...actual.workspaceRepo, getById: vi.fn(async () => ({ id: 'S61-workspace-A', owner_id: 'S61-account-A' })) },
    projectRepo: { ...actual.projectRepo, getById: vi.fn(async () => ({ id: 'S61-project-A', workspace_id: 'S61-workspace-A' })) },
  };
});

import { useChatActivityStore } from '@/features/chat/activity/activityStore';
import type { ChatActivityEvent } from '@/features/chat/activity/types';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';

import { InspectorMilestonesPanel } from './InspectorMilestonesPanel';
import { useMilestonesStore } from './milestonesStore';

function canonicalActivity(id: string, ts: number): ChatActivityEvent {
  return {
    id,
    chatId: 'chat-alpha',
    kind: 'tool',
    status: 'done',
    title: 'Canonical tool activity',
    detail: `Canonical detail ${id}`,
    ts,
  };
}

describe('InspectorMilestonesPanel projection boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ localUserId: 'S61-account-A', cloudSession: null,
      workspaceId: 'S61-workspace-A' as never, projectId: 'S61-project-A' as never });
    useMilestonesStore.setState({ items: [] });
    useChatActivityStore.setState({ eventsByChat: {} });
    useJarvisTaskRunStore.getState().clearForTests();
  });

  it('renders the canonical bounded timeline and ignores legacy activity-store lifecycle writes', async () => {
    useChatActivityStore.getState().record({
      ...canonicalActivity('legacy-event', 1),
      title: 'Legacy activity must stay outside canonical timeline',
    });
    const canonical = Array.from({ length: 20 }, (_, index) =>
      canonicalActivity(`event-${index}`, index + 10),
    );
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceCanonicalForAccount('scope-alpha', [], { 'chat-alpha': canonical });

    render(<InspectorMilestonesPanel view="timeline" onViewChange={vi.fn()} />);

    const canonicalRows = screen.getAllByText('Canonical tool activity');
    expect(canonicalRows).toHaveLength(16);
    fireEvent.click(canonicalRows.at(-1)!.closest('button')!);
    expect(screen.getByText('Canonical detail event-19')).toBeTruthy();
    expect(screen.queryByText('Canonical detail event-0')).toBeNull();
    expect(screen.queryByText('Legacy activity must stay outside canonical timeline')).toBeNull();
  });

  it('keeps manual milestones editable and separate from canonical activity', async () => {
    render(<InspectorMilestonesPanel view="milestones" onViewChange={vi.fn()} />);
    await waitFor(() => expect((screen.getByPlaceholderText('Add milestone…') as HTMLInputElement).disabled).toBe(false));

    fireEvent.change(screen.getByPlaceholderText('Add milestone…'), {
      target: { value: 'Review verified output' },
    });
    fireEvent.click(screen.getByRole('button', { name: '' }));

    expect(screen.getByDisplayValue('Review verified output')).toBeTruthy();
    expect(useMilestonesStore.getState().items).toHaveLength(1);
  });
});
