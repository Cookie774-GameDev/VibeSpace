import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@/types/chat';
import { MessagePart } from './MessagePart';
import { chatRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

const part: Extract<Part, { kind: 'chat_handoff' }> = {
  kind: 'chat_handoff',
  handoff: {
    version: 1,
    sourceChatId: 'chat-source',
    sourceTitle: 'Source chat',
    snapshotAt: 100,
    boundaryMessageId: 'message-1',
    instruction: 'Review and continue the work.',
    projection: {
      version: 1,
      policyVersion: 1,
      source: {
        chatId: 'chat-source',
        title: 'Source chat',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      },
      snapshotAt: 100,
      boundaryAt: 10,
      boundaryMessageId: 'message-1',
      goal: 'Ship the release',
      status: 'Last visible assistant activity',
      lastMeaningfulActivity: 'All tests passed.',
      recentSections: [],
      olderDigest: 'No older visible history.',
      summaries: {
        files: [],
        tools: [],
        actions: [],
        decisions: [],
        blockers: [],
        results: [],
      },
    },
  },
};

describe('MessagePart chat handoff', () => {
  afterEach(() => vi.restoreAllMocks());
  it('renders a safe durable handoff summary without dumping the transcript', () => {
    render(<MessagePart part={part} allParts={[part]} />);

    expect(screen.getByText('Handoff from Source chat')).toBeTruthy();
    expect(screen.getByText('Review and continue the work.')).toBeTruthy();
    expect(screen.getByText('Ship the release')).toBeTruthy();
    expect(screen.queryByText('No older visible history.')).toBeNull();
  });

  it('opens the saved source chat from a delivered task message', async () => {
    useAuthStore.setState({ workspaceId: 'workspace-1' as never });
    useUIStore.setState({ activeChatId: 'chat-recipient' });
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) => ({
      id,
      workspace_id: 'workspace-1',
      mode: 'chat',
      archived: false,
    }) as never);
    const dispatched = {
      ...part,
      handoff: { ...part.handoff, dispatch: { state: 'accepted' } },
    } as Part;
    render(<MessagePart part={dispatched} allParts={[dispatched]} chatId="chat-recipient" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sent by task' }));
    await waitFor(() => expect(useUIStore.getState().activeChatId).toBe('chat-source'));
  });

  it('does not open a task chat from another workspace', async () => {
    useAuthStore.setState({ workspaceId: 'workspace-1' as never });
    useUIStore.setState({ activeChatId: 'chat-recipient' });
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) => ({
      id,
      workspace_id: String(id) === 'chat-source' ? 'workspace-2' : 'workspace-1',
      mode: 'chat',
      archived: false,
    }) as never);
    const dispatched = {
      ...part,
      handoff: { ...part.handoff, dispatch: { state: 'accepted' } },
    } as Part;
    render(<MessagePart part={dispatched} allParts={[dispatched]} chatId="chat-recipient" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sent by task' }));
    await waitFor(() => expect(chatRepo.getById).toHaveBeenCalledTimes(2));
    expect(useUIStore.getState().activeChatId).toBe('chat-recipient');
  });
});
