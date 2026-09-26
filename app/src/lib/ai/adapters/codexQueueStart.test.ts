import { describe, expect, it, vi } from 'vitest';
import { createCodexQueueStartCoordinator } from './codexQueueStart';

describe('Codex native queued turn start', () => {
  it('starts the exact acknowledged submission only after the active turn completes', async () => {
    const queue = createCodexQueueStartCoordinator('thread_a');
    expect(
      queue.recordAdded({
        threadId: 'thread_a',
        turnId: 'turn_a',
        submissionId: 'submission_a',
        clientUserMessageId: 'message_a',
      }),
    ).toBe(true);
    const send = vi.fn(async (request) => ({
      id: request.id,
      result: { turn: { id: 'turn_b', status: 'inProgress' } },
    }));
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_a',
        currentTurnStatus: 'inProgress',
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'turn_active' });
    expect(send).not.toHaveBeenCalled();
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_a',
        currentTurnStatus: 'completed',
        send,
      }),
    ).resolves.toEqual({
      ok: true,
      submissionId: 'submission_a',
      clientUserMessageId: 'message_a',
      turnId: 'turn_b',
      turnStatus: 'inProgress',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      method: 'thread/queue/start',
      params: { threadId: 'thread_a', queuedSubmissionId: 'submission_a' },
    });
    expect(queue.pendingCount()).toBe(0);
  });

  it('refuses a stale completed-turn identity before making a native call', async () => {
    const queue = createCodexQueueStartCoordinator('thread_a');
    queue.recordAdded({
      threadId: 'thread_a',
      turnId: 'turn_a',
      submissionId: 'submission_a',
      clientUserMessageId: 'message_a',
    });
    const send = vi.fn();
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_other',
        currentTurnStatus: 'completed',
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'turn_mismatch' });
    expect(send).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(1);
  });

  it('fails closed for cross-thread, interrupted, failed, or unacknowledged queued items', async () => {
    const queue = createCodexQueueStartCoordinator('thread_a');
    expect(
      queue.recordAdded({
        threadId: 'thread_b',
        turnId: 'turn_b',
        submissionId: 'sub_b',
        clientUserMessageId: 'msg_b',
      }),
    ).toBe(false);
    const send = vi.fn();
    await expect(
      queue.startNext({
        threadId: 'thread_b',
        currentTurnId: 'turn_a',
        currentTurnStatus: null,
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'thread_mismatch' });
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_a',
        currentTurnStatus: 'interrupted',
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'turn_not_completed' });
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_a',
        currentTurnStatus: 'failed',
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'turn_not_completed' });
    await expect(
      queue.startNext({
        threadId: 'thread_a',
        currentTurnId: 'turn_a',
        currentTurnStatus: null,
        send,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unknown_submission' });
    expect(send).not.toHaveBeenCalled();
  });

  it('retains malformed submissions but never retries an uncertain native start', async () => {
    const queue = createCodexQueueStartCoordinator('thread_a');
    queue.recordAdded({
      threadId: 'thread_a',
      turnId: 'turn_a',
      submissionId: 'submission_a',
      clientUserMessageId: 'message_a',
    });
    const send = vi.fn(async (request) => ({
      id: request.id,
      result: { turn: { id: 'turn_b', status: 'unknown' } },
    }));
    const input = {
      threadId: 'thread_a',
      currentTurnId: 'turn_a',
      currentTurnStatus: 'completed' as const,
      send,
    };
    await expect(queue.startNext(input)).resolves.toEqual({
      ok: false,
      reason: 'invalid_acknowledgement',
    });
    await expect(queue.startNext(input)).resolves.toEqual({
      ok: false,
      reason: 'start_outcome_unknown',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(queue.pendingCount()).toBe(1);
  });

  it('does not retry if the start response is lost', async () => {
    const queue = createCodexQueueStartCoordinator('thread_a');
    queue.recordAdded({
      threadId: 'thread_a',
      turnId: 'turn_a',
      submissionId: 'submission_a',
      clientUserMessageId: 'message_a',
    });
    const send = vi.fn(async () => {
      throw new Error('unsupported method or lost response');
    });
    const input = {
      threadId: 'thread_a',
      currentTurnId: 'turn_a',
      currentTurnStatus: 'completed' as const,
      send,
    };
    await expect(queue.startNext(input)).resolves.toEqual({
      ok: false,
      reason: 'start_outcome_unknown',
    });
    await expect(queue.startNext(input)).resolves.toEqual({
      ok: false,
      reason: 'start_outcome_unknown',
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
