import { describe, expect, it, vi } from 'vitest';
import { createCodexControlBridge, bindCodexQuestionRoute, replyCodexQuestion, replyCodexApproval } from './codexControlBridge';
import { projectOpenCodeQuestionEvent } from '../openCodeQuestionProjection';
import type { CodexApprovalControlRequest, CodexQuestionControlRequest } from './codexAppServer';
const question: CodexQuestionControlRequest = { type: 'question', requestId: '42', threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a',
  questions: [{ id: 'language', header: 'Language', prompt: 'Which language?', options: [], allowCustomAnswer: true }] };
const approval: CodexApprovalControlRequest = { type: 'approval', kind: 'command', requestId: '7', threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a',
  responseHandle: '7', requestMethod: 'item/commandExecution/requestApproval', responseKind: 'command', display: { action: 'command' } };
const mode = { kind: 'agent', approvalPolicy: 'on-request', sandbox: { kind: 'workspace-write', writableRoots: ['C:/workspace'], networkAccess: false } } as const;
function pendingQuestion(bridge: ReturnType<typeof createCodexControlBridge>) {
  const id = bridge.question(question, 42);
  const projection = projectOpenCodeQuestionEvent({ type: 'question', request: {
    id, sessionId: 'thread-a', tool: { messageId: 'turn-a', callId: 'item-a' },
    questions: question.questions.map(q => ({ ...q, multiple: false })),
  } }, 'thread-a')!;
  expect(bindCodexQuestionRoute(projection.route)).toBe(true);
  return { request: { kind: 'reply' as const, authority: projection.route, method: 'POST' as const,
    path: `/question/${id}/reply`, body: { answers: [['TypeScript']] } },
    expectedSessionId: 'thread-a', expectedBlockId: projection.route.blockId };
}
describe('Codex native controls', () => {
  it('does not resend an approval after an attempted write has an unknown outcome', async () => {
    const write = vi.fn(async () => { throw new Error('write outcome unknown'); });
    const bridge = createCodexControlBridge(write, mode);
    try {
      const pending = bridge.approval(approval, 7);
      const input = { sessionId: pending.sessionId, approvalId: pending.id, response: 'once' as const };
      await expect(replyCodexApproval(input)).rejects.toThrow();
      await expect(replyCodexApproval(input)).rejects.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
    } finally { bridge.dispose(); }
  });
  it('does not resend a question response after an uncertain attempted write', async () => {
    const write = vi.fn(async () => { throw new Error('write outcome unknown'); });
    const bridge = createCodexControlBridge(write, mode);
    try {
      const input = pendingQuestion(bridge);
      await expect(replyCodexQuestion(input)).rejects.toThrow();
      await expect(replyCodexQuestion(input)).rejects.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
    } finally { bridge.dispose(); }
  });
  it('resolves only a pending question with the exact raw RPC id type', () => {
    const bridge = createCodexControlBridge(vi.fn(async () => {}), mode);
    try {
      const numericId = bridge.question(question, 42);
      const stringId = bridge.question(question, '42');

      expect(bridge.resolve('42')).toEqual({
        type: 'question-resolved',
        requestId: stringId,
        sessionId: 'thread-a',
      });
      expect(bridge.resolve(42)).toEqual({
        type: 'question-resolved',
        requestId: numericId,
        sessionId: 'thread-a',
      });
      expect(bridge.resolve(42)).toBeUndefined();
    } finally { bridge.dispose(); }
  });
  it('revokes a question reply after native resolution', async () => {
    const write = vi.fn(async () => {});
    const bridge = createCodexControlBridge(write, mode);
    try {
      const input = pendingQuestion(bridge);

      expect(bridge.resolve(42)).toMatchObject({ type: 'question-resolved' });
      await expect(replyCodexQuestion(input)).rejects.toThrow('no longer');
      expect(write).not.toHaveBeenCalled();
    } finally { bridge.dispose(); }
  });
  it('round trips answers to the exact numeric RPC identity and consumes authority once', async () => {
    const write = vi.fn(async () => {}); const bridge = createCodexControlBridge(write, mode);
    const input = pendingQuestion(bridge);
    await expect(replyCodexQuestion(input)).resolves.toMatchObject({ status: 'accepted' });
    expect(write).toHaveBeenCalledWith({ id: 42, result: { answers: { language: { answers: ['TypeScript'] } } } });
    await expect(replyCodexQuestion(input)).rejects.toThrow('no longer'); bridge.dispose();
  });
  it('rejects wrong sessions and disposed generations without writing', async () => {
    const write = vi.fn(async () => {}); const bridge = createCodexControlBridge(write, mode);
    const input = pendingQuestion(bridge);
    await expect(replyCodexQuestion({ ...input, expectedSessionId: 'other' })).rejects.toThrow();
    bridge.dispose(); await expect(replyCodexQuestion(input)).rejects.toThrow(); expect(write).not.toHaveBeenCalled();
  });
  it('sends approval once through its native process, without OpenCode authority', async () => {
    const write = vi.fn(async () => {}); const bridge = createCodexControlBridge(write, mode);
    const pending = bridge.approval(approval, 7);
    await replyCodexApproval({ sessionId: pending.sessionId, approvalId: pending.id, response: 'once' });
    expect(write).toHaveBeenCalledWith({ id: 7, result: { decision: 'accept' } });
    await expect(replyCodexApproval({ sessionId: pending.sessionId, approvalId: pending.id, response: 'always' })).rejects.toThrow(); bridge.dispose();
  });
  it('does not grant mutations from Plan mode', async () => {
    const write = vi.fn(async () => {}); const bridge = createCodexControlBridge(write, { kind: 'plan' });
    const pending = bridge.approval(approval, 7);
    await expect(replyCodexApproval({ sessionId: pending.sessionId, approvalId: pending.id, response: 'once' })).rejects.toThrow('read-only');
    expect(write).not.toHaveBeenCalled(); bridge.dispose();
  });
  it('grants only the requested additional permissions and only for the requested scope', async () => {
    const write = vi.fn(async () => {}); const bridge = createCodexControlBridge(write, mode);
    const permissions = { network: { enabled: true } };
    const pending = bridge.approval({ ...approval, kind: 'permissions' }, 9, permissions);
    await replyCodexApproval({ sessionId: pending.sessionId, approvalId: pending.id, response: 'once' });
    expect(write).toHaveBeenCalledWith({ id: 9, result: { permissions, scope: 'turn' } }); bridge.dispose();
  });
});
