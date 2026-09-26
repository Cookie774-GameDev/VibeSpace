import { describe, expect, it } from 'vitest';
import { reconcileCodexQueue } from './codexQueueReconcile';

const threadId = 'thread-1';
const submissionId = 'submission-1';
const clientUserMessageId = 'client-message-1';
const read = (
  turns: unknown[] = [],
  status: 'idle' | 'active' | 'notLoaded' | 'systemError' = 'idle',
  id = threadId,
) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { thread: { id, status: { type: status }, turns } },
});
const queuePage = (data: unknown[], nextCursor: string | null, id = 2) => ({
  jsonrpc: '2.0',
  id,
  result: { data, nextCursor },
});
const queued = (id = submissionId, clientId = clientUserMessageId) => ({
  id,
  clientUserMessageId: clientId,
  input: [{ type: 'text', text: 'queued prompt' }],
});
const userItem = (clientId = clientUserMessageId) => ({
  type: 'userMessage',
  id: 'user-item-1',
  clientId,
  content: [{ type: 'text', text: 'queued prompt' }],
});
const turn = (id: string, status: string, items: unknown[], itemsView = 'full') => ({
  id,
  status,
  itemsView,
  items,
});
const reconcile = (threadReadFrame: unknown, queuePages: unknown[]) =>
  reconcileCodexQueue({
    threadReadFrame,
    queuePages,
    threadId,
    submissionId,
    clientUserMessageId,
  });

describe('reconcileCodexQueuedSubmission', () => {
  it('recognizes an auto-consumed user item and does not request another start', () => {
    expect(
      reconcile(read([turn('turn-1', 'inProgress', [userItem()])], 'active'), [
        queuePage([], null),
      ]),
    ).toEqual({ state: 'consumed_in_progress', turnId: 'turn-1', turnStatus: 'inProgress' });
  });

  it('returns terminal text only for one explicit final_answer assistant message', () => {
    expect(
      reconcile(
        read(
          [
            turn('turn-2', 'completed', [
              userItem(),
              {
                type: 'agentMessage',
                id: 'assistant-1',
                phase: 'final_answer',
                text: 'Completed safely.',
              },
            ]),
          ],
          'notLoaded',
        ),
        [queuePage([], null)],
      ),
    ).toEqual({
      state: 'consumed_terminal',
      turnId: 'turn-2',
      turnStatus: 'completed',
      terminalResponseText: 'Completed safely.',
    });
  });

  it('omits response text when terminal assistant output is ambiguous', () => {
    expect(
      reconcile(
        read([
          turn('turn-2', 'completed', [
            userItem(),
            { type: 'agentMessage', id: 'assistant-1', phase: 'final_answer', text: 'First.' },
            { type: 'agentMessage', id: 'assistant-2', phase: 'final_answer', text: 'Second.' },
          ]),
        ]),
        [queuePage([], null)],
      ),
    ).toEqual({ state: 'consumed_terminal', turnId: 'turn-2', turnStatus: 'completed' });
  });

  it('returns pending only for the exact acknowledged row on an idle thread', () => {
    expect(reconcile(read(), [queuePage([queued()], null)])).toEqual({
      state: 'pending',
      submissionId,
      threadId,
      clientUserMessageId,
    });
  });

  it('fails closed when the item is absent from both complete queue and thread history', () => {
    expect(reconcile(read(), [queuePage([], null)])).toEqual({ state: 'review_required' });
  });

  it('fails closed on thread mismatch, queue identity mismatch, or queue/history conflict', () => {
    const emptyQueue = [queuePage([], null)];
    expect(reconcile(read([], 'idle', 'other-thread'), emptyQueue)).toEqual({
      state: 'review_required',
    });
    expect(
      reconcile(read(), [
        {
          jsonrpc: '2.0',
          id: 2,
          result: { data: [queued(submissionId, 'another-client')], nextCursor: null },
        },
      ]),
    ).toEqual({ state: 'review_required' });
    expect(
      reconcile(read([turn('turn-1', 'inProgress', [userItem()])], 'active'), [
        queuePage([queued()], null),
      ]),
    ).toEqual({ state: 'review_required' });
  });

  it('requires every queue page and its cursor chain before deciding pending or absent', () => {
    expect(reconcile(read(), [queuePage([], 'next')])).toEqual({ state: 'review_required' });
    expect(reconcile(read(), [queuePage([], 'next'), queuePage([], null)])).toEqual({
      state: 'review_required',
    });
    expect(reconcile(read(), [queuePage([queued()], 'next'), queuePage([], null)])).toEqual({
      state: 'pending',
      submissionId,
      threadId,
      clientUserMessageId,
    });
  });

  it('fails closed on duplicate client identity and withholds text from summary-only turns', () => {
    expect(
      reconcile(
        read([
          turn('turn-2', 'completed', [
            userItem(),
            userItem(),
            { type: 'agentMessage', id: 'assistant-1', phase: 'final_answer', text: 'First.' },
            { type: 'agentMessage', id: 'assistant-2', phase: 'final_answer', text: 'Second.' },
          ]),
        ]),
        [queuePage([], null)],
      ),
    ).toEqual({ state: 'review_required' });
    expect(
      reconcile(
        read([
          turn(
            'turn-3',
            'completed',
            [
              userItem(),
              {
                type: 'agentMessage',
                id: 'assistant-3',
                phase: 'final_answer',
                text: 'Not fully hydrated.',
              },
            ],
            'summary',
          ),
        ]),
        [queuePage([], null)],
      ),
    ).toEqual({ state: 'consumed_terminal', turnId: 'turn-3', turnStatus: 'completed' });
  });
});
