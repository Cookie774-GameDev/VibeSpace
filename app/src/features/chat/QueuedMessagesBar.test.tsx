import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildQueuedMultitaskCommand,
  dispatchQueuedMessageAfterAcceptance,
  QueuedMessagesBar,
  shouldAutoSendQueuedOnRunStatus,
  takeNextQueuedMessage,
  type QueuedChatMessage,
} from './QueuedMessagesBar';

const queued: QueuedChatMessage[] = [
  { id: 'q_1', text: 'First queued request', createdAt: 1, flushMode: 'after-run' },
];

afterEach(cleanup);
describe('QueuedMessagesBar', () => {
  it('shows the first three, expands in order, and keeps hidden row actions connected', () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      ...queued[0]!,
      id: `q_${index}`,
      text: `Request ${index}`,
    }));
    const onDelete = vi.fn();
    const { container, rerender } = render(
      <QueuedMessagesBar
        messages={messages}
        onEdit={vi.fn()}
        onSendNow={vi.fn()}
        onDelete={onDelete}
        onStartMultitask={vi.fn()}
      />,
    );
    const visibleIds = () =>
      Array.from(container.querySelectorAll('[data-queued-message-id]')).map((row) =>
        row.getAttribute('data-queued-message-id'),
      );
    expect(visibleIds()).toEqual(['q_0', 'q_1', 'q_2']);
    const toggle = screen.getByRole('button', { name: 'Show 4 more 7 queued' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(visibleIds()).toEqual(messages.map((message) => message.id));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete queued message' })[6]!);
    expect(onDelete).toHaveBeenCalledWith('q_6');
    fireEvent.click(screen.getByRole('button', { name: 'Show less 7 queued' }));
    expect(visibleIds()).toEqual(['q_0', 'q_1', 'q_2']);
    rerender(
      <QueuedMessagesBar
        messages={messages.slice(0, 3)}
        onEdit={vi.fn()}
        onSendNow={vi.fn()}
        onDelete={onDelete}
        onStartMultitask={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
    expect(visibleIds()).toEqual(['q_0', 'q_1', 'q_2']);
  });

  it('steers and deletes directly, with edit and side chat in options', () => {
    const onEdit = vi.fn(),
      onSendNow = vi.fn(),
      onDelete = vi.fn(),
      onOpenSideChat = vi.fn();
    render(
      <QueuedMessagesBar
        messages={queued}
        onEdit={onEdit}
        onSendNow={onSendNow}
        onDelete={onDelete}
        onStartMultitask={vi.fn()}
        onOpenSideChat={onOpenSideChat}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Steer queued message' }));
    expect(onSendNow).toHaveBeenCalledWith('q_1');
    fireEvent.click(screen.getByRole('button', { name: 'Queued message options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    expect(onEdit).toHaveBeenCalledWith('q_1');
    fireEvent.click(screen.getByRole('button', { name: 'Queued message options' }));
    expect(screen.queryByText('Turn on queuing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in side chat' }));
    expect(onOpenSideChat).toHaveBeenCalledWith('q_1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete queued message' }));
    expect(onDelete).toHaveBeenCalledWith('q_1');
  });
  it('labels an OpenCode stop-and-follow-up action with its next-turn behavior', () => {
    const onSendNow = vi.fn();
    render(
      <QueuedMessagesBar
        messages={queued}
        steerMode="stop-followup"
        onEdit={vi.fn()}
        onSendNow={onSendNow}
        onDelete={vi.fn()}
        onStartMultitask={vi.fn()}
      />,
    );
    const action = screen.getByRole('button', { name: 'Stop current reply and follow up' });
    expect(action.getAttribute('title')).toBe(
      'Stop the active OpenCode reply and send this message as the next turn.',
    );
    expect(action.textContent).toContain('Follow up');
    fireEvent.click(action);
    expect(onSendNow).toHaveBeenCalledWith('q_1');
    expect(screen.queryByRole('button', { name: 'Steer queued message' })).toBeNull();
  });
  it('keeps model switches on the existing stop-and-restart action', () => {
    const restart = vi.fn(),
      steer = vi.fn();
    render(
      <QueuedMessagesBar
        messages={queued}
        isModelSwitch={() => true}
        onStopAndRestart={restart}
        onEdit={vi.fn()}
        onSendNow={steer}
        onDelete={vi.fn()}
        onStartMultitask={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop current reply and restart with model switch' }),
    );
    expect(restart).toHaveBeenCalledWith('q_1');
    expect(steer).not.toHaveBeenCalled();
  });
  it('disables actions during delivery', () => {
    render(
      <QueuedMessagesBar
        messages={queued}
        busyId="q_1"
        onEdit={vi.fn()}
        onSendNow={vi.fn()}
        onDelete={vi.fn()}
        onStartMultitask={vi.fn()}
      />,
    );
    for (const button of screen.getAllByRole('button'))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('buildQueuedMultitaskCommand', () => {
  it('prefixes /multitask and avoids double-prefix', () => {
    expect(buildQueuedMultitaskCommand('make a file in Downloads')).toBe(
      '/multitask make a file in Downloads',
    );
    expect(buildQueuedMultitaskCommand('/multitask already there')).toBe(
      '/multitask already there',
    );
    expect(buildQueuedMultitaskCommand('/subagents review PRs')).toBe('/multitask review PRs');
  });
});

describe('queued auto-send helpers', () => {
  it('only auto-sends after a terminal run status', () => {
    expect(shouldAutoSendQueuedOnRunStatus('running')).toBe(false);
    expect(shouldAutoSendQueuedOnRunStatus('done')).toBe(true);
    expect(shouldAutoSendQueuedOnRunStatus('error')).toBe(true);
    expect(shouldAutoSendQueuedOnRunStatus('cancelled')).toBe(true);
    expect(shouldAutoSendQueuedOnRunStatus(undefined)).toBe(false);
  });

  it('takes the next queued message in FIFO order', () => {
    const queue: QueuedChatMessage[] = [
      { id: 'a', text: 'first', createdAt: 1, flushMode: 'after-run' },
      { id: 'b', text: 'second', createdAt: 2, flushMode: 'after-tool' },
    ];
    const first = takeNextQueuedMessage(queue);
    expect(first.next?.id).toBe('a');
    expect(first.remaining.map((m) => m.id)).toEqual(['b']);
    const empty = takeNextQueuedMessage([]);
    expect(empty.next).toBeNull();
    expect(empty.remaining).toEqual([]);
  });

  it('keeps a cancelled-run restart queued until the resend is accepted', async () => {
    let queue: QueuedChatMessage[] = [
      { id: 'switch', text: 'Use my local model.', createdAt: 1, flushMode: 'after-run' },
    ];
    const remove = (id: string) => {
      queue = queue.filter((message) => message.id !== id);
    };

    expect(shouldAutoSendQueuedOnRunStatus('cancelled')).toBe(true);
    await expect(
      dispatchQueuedMessageAfterAcceptance(queue[0]!, queue[0]!.text, async () => false, remove),
    ).resolves.toBe(false);
    expect(queue.map((message) => message.id)).toEqual(['switch']);

    await expect(
      dispatchQueuedMessageAfterAcceptance(queue[0]!, queue[0]!.text, async () => true, remove),
    ).resolves.toBe(true);
    expect(queue).toEqual([]);
  });
});
