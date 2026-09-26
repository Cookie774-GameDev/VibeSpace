type JsonRecord = Record<string, unknown>;

export type CodexQueueReconciliation =
  | { state: 'consumed_in_progress'; turnId: string; turnStatus: 'inProgress' }
  | {
      state: 'consumed_terminal';
      turnId: string;
      turnStatus: 'completed' | 'interrupted' | 'failed';
      terminalResponseText?: string;
    }
  | { state: 'pending'; submissionId: string; threadId: string; clientUserMessageId: string }
  | { state: 'review_required' };

export interface CodexQueueReconciliationInput {
  /** JSON-RPC response frame for thread/read with includeTurns: true. */
  threadReadFrame: unknown;
  /** Ordered raw JSON-RPC response frames for every thread/queue/list page. */
  queuePages: readonly unknown[];
  threadId: string;
  submissionId: string;
  clientUserMessageId: string;
}

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const safeIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(value);

const responseResult = (frame: unknown): JsonRecord | undefined => {
  const envelope = record(frame);
  if (!envelope || 'error' in envelope || !('result' in envelope)) return undefined;
  return record(envelope.result);
};

const terminalResponseText = (turn: JsonRecord): string | undefined => {
  const items = turn.items;
  if (turn.itemsView !== 'full' || !Array.isArray(items)) return undefined;
  const finalMessages = items
    .map(record)
    .filter(
      (item): item is JsonRecord => item?.type === 'agentMessage' && item.phase === 'final_answer',
    );
  if (finalMessages.length !== 1) return undefined;
  const text = finalMessages[0].text;
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
};

/**
 * Reconcile a previously acknowledged Codex queue/add without replaying it.
 * Any malformed, incomplete, conflicting, or not-yet-observable state fails closed.
 */
export function reconcileCodexQueue(
  input: CodexQueueReconciliationInput,
): CodexQueueReconciliation {
  const { threadId, submissionId, clientUserMessageId, queuePages } = input;
  if (
    !safeIdentifier(threadId) ||
    !safeIdentifier(submissionId) ||
    !safeIdentifier(clientUserMessageId) ||
    queuePages.length === 0
  ) {
    return { state: 'review_required' };
  }

  const read = responseResult(input.threadReadFrame);
  const thread = record(read?.thread);
  if (!thread || thread.id !== threadId) return { state: 'review_required' };
  const threadStatus = record(thread.status)?.type;
  if (!['idle', 'active', 'notLoaded', 'systemError'].includes(String(threadStatus))) {
    return { state: 'review_required' };
  }
  const turns = thread.turns;
  if (!Array.isArray(turns)) return { state: 'review_required' };

  const allQueueRows: JsonRecord[] = [];
  const seenCursors = new Set<string>();
  let expectedCursor: string | null = null;
  for (let pageIndex = 0; pageIndex < queuePages.length; pageIndex += 1) {
    const pageFrame = queuePages[pageIndex];
    // A page following nextCursor:null, or a gap before a non-final page, is incomplete/ambiguous.
    if (pageIndex > 0 && expectedCursor === null) return { state: 'review_required' };
    const response = responseResult(pageFrame);
    if (!response || !Array.isArray(response.data)) return { state: 'review_required' };
    for (const rawRow of response.data) {
      const row = record(rawRow);
      if (
        !row ||
        !safeIdentifier(row.id) ||
        !safeIdentifier(row.clientUserMessageId) ||
        !Array.isArray(row.input)
      )
        return { state: 'review_required' };
      allQueueRows.push(row);
    }
    const nextCursor = response.nextCursor;
    if (nextCursor !== null && !safeIdentifier(nextCursor)) return { state: 'review_required' };
    if (typeof nextCursor === 'string') {
      if (seenCursors.has(nextCursor)) return { state: 'review_required' };
      seenCursors.add(nextCursor);
    }
    expectedCursor = nextCursor as string | null;
    if (pageIndex < queuePages.length - 1 && expectedCursor === null) {
      return { state: 'review_required' };
    }
  }
  // A non-null cursor means the caller supplied an incomplete listing. Never infer absence.
  if (expectedCursor !== null) return { state: 'review_required' };

  const matchingQueueRows = allQueueRows.filter(
    (row) => row.id === submissionId || row.clientUserMessageId === clientUserMessageId,
  );
  if (
    matchingQueueRows.length > 1 ||
    matchingQueueRows.some(
      (row) => row.id !== submissionId || row.clientUserMessageId !== clientUserMessageId,
    )
  ) {
    return { state: 'review_required' };
  }

  const consumed: { turn: JsonRecord; turnId: string; status: string }[] = [];
  for (const rawTurn of turns) {
    const turn = record(rawTurn);
    if (
      !turn ||
      !safeIdentifier(turn.id) ||
      !Array.isArray(turn.items) ||
      !['inProgress', 'completed', 'interrupted', 'failed'].includes(String(turn.status))
    ) {
      return { state: 'review_required' };
    }
    for (const rawItem of turn.items) {
      const item = record(rawItem);
      if (item?.type === 'userMessage' && item.clientId === clientUserMessageId) {
        consumed.push({ turn, turnId: turn.id as string, status: turn.status as string });
      }
    }
  }
  if (consumed.length > 1) return { state: 'review_required' };
  if (consumed.length === 1) {
    if (matchingQueueRows.length !== 0) return { state: 'review_required' };
    const { turn, turnId, status } = consumed[0];
    if (status === 'inProgress')
      return { state: 'consumed_in_progress', turnId, turnStatus: 'inProgress' };
    if (status === 'completed' || status === 'interrupted' || status === 'failed') {
      const responseText = status === 'completed' ? terminalResponseText(turn) : undefined;
      return {
        state: 'consumed_terminal',
        turnId,
        turnStatus: status,
        ...(responseText ? { terminalResponseText: responseText } : {}),
      };
    }
    return { state: 'review_required' };
  }

  if (matchingQueueRows.length === 1 && threadStatus === 'idle') {
    if (turns.some((rawTurn) => record(rawTurn)?.status === 'inProgress')) {
      return { state: 'review_required' };
    }
    return {
      state: 'pending',
      submissionId,
      threadId,
      clientUserMessageId,
    };
  }
  return { state: 'review_required' };
}
