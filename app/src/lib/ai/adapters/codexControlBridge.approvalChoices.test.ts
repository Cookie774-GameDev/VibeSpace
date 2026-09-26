import { afterEach, describe, expect, it, vi } from 'vitest';

const protocol = vi.hoisted(() => ({
  buildCodexApprovalResponse: vi.fn(
    (input: {
      decision: string;
      availableDecisions: readonly string[];
      responseHandle: string | number;
    }) => {
      if (!input.availableDecisions.includes(input.decision)) {
        throw new Error('Codex approval decision was not offered by the server.');
      }
      return { id: input.responseHandle, result: { decision: input.decision } };
    },
  ),
  buildCodexQuestionResponse: vi.fn(),
}));

vi.mock('./codexAppServerProtocol', () => protocol);
vi.mock('../openCodeQuestionDispatch', () => ({ executeOpenCodeQuestionRequest: vi.fn() }));

import { createCodexControlBridge, replyCodexApproval } from './codexControlBridge';
import type { CodexApprovalControlRequest } from './codexAppServer';

const baseApproval = (
  availableDecisions: ('accept' | 'acceptForSession' | 'decline' | 'cancel')[],
): CodexApprovalControlRequest => ({
  type: 'approval',
  kind: 'command',
  requestId: 'request-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  responseHandle: 'server-request-1',
  requestMethod: 'item/commandExecution/requestApproval',
  responseKind: 'command',
  display: { action: 'command', availableDecisions },
});

const mode = {
  kind: 'agent',
  approvalPolicy: 'on-request',
  sandbox: { kind: 'workspace-write', writableRoots: ['C:/workspace'], networkAccess: false },
} as const;

describe('Codex offered approval choices', () => {
  afterEach(() => vi.clearAllMocks());

  it('exposes the offered choices and maps Cancel to the exact server cancel decision', async () => {
    const write = vi.fn(async () => {});
    const bridge = createCodexControlBridge(write, mode);
    try {
      const pending = bridge.approval(baseApproval(['accept', 'cancel']), 'rpc-1');
      expect(pending.availableDecisions).toEqual(['accept', 'cancel']);
      await replyCodexApproval({
        sessionId: pending.sessionId,
        approvalId: pending.id,
        response: 'cancel',
      });
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith({ id: 'rpc-1', result: { decision: 'cancel' } });
      expect(protocol.buildCodexApprovalResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancel',
          availableDecisions: ['accept', 'cancel'],
        }),
      );
    } finally {
      bridge.dispose();
    }
  });

  it('does not let UI metadata add a decline choice absent from the captured server offer', async () => {
    const write = vi.fn(async () => {});
    const bridge = createCodexControlBridge(write, mode);
    const control = baseApproval(['accept', 'cancel']);
    try {
      const pending = bridge.approval(control, 'rpc-2');
      const originalChoices = control.display.availableDecisions as (
        | 'accept'
        | 'acceptForSession'
        | 'decline'
        | 'cancel'
      )[];
      originalChoices.splice(0, originalChoices.length, 'accept', 'decline');
      expect(pending.availableDecisions).toEqual(['accept', 'cancel']);
      await expect(
        replyCodexApproval({
          sessionId: pending.sessionId,
          approvalId: pending.id,
          response: 'reject',
        }),
      ).rejects.toThrow('not offered by the server');
      expect(write).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
    }
  });
});
