import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';
import { ChatHandoffDraftCard } from './ChatHandoffDraftCard';

const handoff: ChatHandoffProjectionV1 = {
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
  lastMeaningfulActivity: 'All focused tests passed.',
  recentSections: [],
  olderDigest: 'No older visible history.',
  summaries: { files: [], tools: [], actions: [], decisions: [], blockers: [], results: [] },
};

describe('ChatHandoffDraftCard', () => {
  it('shows canonical source context and keeps the instruction editable', () => {
    const onInstructionChange = vi.fn();
    render(
      <ChatHandoffDraftCard
        handoff={handoff}
        instruction="Review this work"
        onInstructionChange={onInstructionChange}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('Source chat')).toBeTruthy();
    expect(screen.queryByText('Ship the release')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reference Source chat' }));
    expect(screen.getByText('Ship the release')).toBeTruthy();
    expect(screen.getByText('All focused tests passed.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Instruction for Source chat'), {
      target: { value: 'Continue and verify the release' },
    });
    expect(onInstructionChange).toHaveBeenCalledWith('Continue and verify the release');
  });

  it.each(['Backspace', 'Delete'])('removes the entire focused reference with %s', (key) => {
    const onRemove = vi.fn();
    render(
      <ChatHandoffDraftCard
        handoff={handoff}
        instruction="Review"
        onInstructionChange={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reference Source chat' }), { key });
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('does not delete the reference when editing its instruction', () => {
    const onRemove = vi.fn();
    render(
      <ChatHandoffDraftCard
        handoff={handoff}
        instruction="Review"
        onInstructionChange={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reference Source chat' }));
    fireEvent.keyDown(screen.getByLabelText('Instruction for Source chat'), { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('exposes a labeled remove action without sending', () => {
    const onRemove = vi.fn();
    const onSend = vi.fn();
    window.addEventListener('jarvis:send', onSend);
    render(
      <ChatHandoffDraftCard
        handoff={handoff}
        instruction="Review this work"
        onInstructionChange={vi.fn()}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove handoff from Source chat' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:send', onSend);
  });
});
