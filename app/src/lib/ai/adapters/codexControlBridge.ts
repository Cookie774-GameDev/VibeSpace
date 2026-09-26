import type { CodexApprovalControlRequest, CodexQuestionControlRequest } from './codexAppServer';
import { buildCodexApprovalResponse, buildCodexQuestionResponse, type CodexExecutionMode } from './codexAppServerProtocol';
import type { OpenCodeQuestionReplyRoute } from '../openCodeQuestionProjection';
import { executeOpenCodeQuestionRequest, type ManagedOpenCodeQuestionRequest } from '../openCodeQuestionDispatch';
import type { VibeSpaceApproval } from '@/lib/harness/types';

type Writer = (message: Record<string, unknown>) => Promise<void>;
type Pending = { sessionId: string; write: Writer; rawId: string | number; active: () => boolean; busy: boolean; revoked: boolean };
const questions = new Map<string, Pending & { control: CodexQuestionControlRequest; route?: OpenCodeQuestionReplyRoute }>();
const approvals = new Map<string, Pending & { control: CodexApprovalControlRequest; mode: CodexExecutionMode; permissions?: Record<string, unknown> }>();
const DEFAULT_SIMPLE_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;

export function createCodexControlBridge(write: Writer, mode: CodexExecutionMode) {
  let active = true;
  const owned = new Set<string>();
  const base = (sessionId: string, rawId: string | number): Pending => ({ sessionId, rawId, write,
    active: () => active, busy: false, revoked: false });
  return {
    question(control: CodexQuestionControlRequest, rawId: string | number): string {
      const id = `que_codex_${crypto.randomUUID()}`;
      questions.set(id, { ...base(control.threadId, rawId), control }); owned.add(id); return id;
    },
    resolve(rawId: string | number) {
      const matches = [...owned].flatMap((id) => {
        const pending = questions.get(id);
        return pending?.active() && !pending.revoked && pending.rawId === rawId ? [{ id, pending }] : [];
      });
      if (matches.length !== 1) return undefined;
      const match = matches[0];
      if (!match) return undefined;
      match.pending.revoked = true;
      questions.delete(match.id);
      owned.delete(match.id);
      return {
        type: 'question-resolved' as const,
        requestId: match.id,
        sessionId: match.pending.sessionId,
      };
    },
    approval(control: CodexApprovalControlRequest, rawId: string | number,
      permissions?: Record<string, unknown>): VibeSpaceApproval {
      const capturedControl = structuredClone(control);
      const id = `codex-approval-${crypto.randomUUID()}`;
      approvals.set(id, { ...base(capturedControl.threadId, rawId), control: capturedControl, mode,
        ...(permissions ? { permissions: structuredClone(permissions) } : {}) }); owned.add(id);
      return { id, sessionId: capturedControl.threadId,
        title: capturedControl.display.reason ?? (capturedControl.kind === 'command' ? 'Run command' : 'Grant requested permissions'),
        capability: capturedControl.kind === 'command' ? 'command.run' : 'file.write',
        pattern: capturedControl.display.commandPreview ? [capturedControl.display.commandPreview] : capturedControl.display.fileLabels,
        ...(capturedControl.kind !== 'permissions'
          ? { availableDecisions: capturedControl.display.availableDecisions ?? DEFAULT_SIMPLE_DECISIONS }
          : {}),
      };
    },
    dispose() { active = false; for (const id of owned) { questions.delete(id); approvals.delete(id); } owned.clear(); },
  };
}

export function bindCodexQuestionRoute(route: OpenCodeQuestionReplyRoute): boolean {
  if (!route.requestId.startsWith('que_codex_')) return false;
  const pending = questions.get(route.requestId);
  if (!pending?.active() || pending.revoked || pending.sessionId !== route.sessionId ||
      pending.control.turnId !== route.tool?.messageId || pending.control.itemId !== route.tool?.callId)
    throw new Error('Codex question is no longer active.');
  pending.route = structuredClone(route); return true;
}

export async function replyCodexQuestion(input: { request: ManagedOpenCodeQuestionRequest;
  expectedSessionId: string; expectedBlockId: string; signal?: AbortSignal }) {
  const id = input.request.authority.requestId;
  const pending = questions.get(id);
  if (!pending?.active() || pending.revoked || pending.busy || pending.sessionId !== input.expectedSessionId)
    throw new Error('Codex question is no longer waiting.');
  pending.busy = true;
  let writeAttempted = false;
  try {
    const receipt = await executeOpenCodeQuestionRequest(input.request, {
      readWaitingAuthority: async () => pending.route,
      request: async () => {
        if (!pending.active() || pending.revoked) throw new Error('Codex question is no longer active.');
        if (input.request.kind === 'reject') {
          writeAttempted = true;
          await pending.write({ id: pending.rawId, result: { answers: {} } }); return true;
        }
        const answers = input.request.body.answers;
        const frame = buildCodexQuestionResponse({ responseHandle: id,
          questionIds: pending.control.questions.map(q => q.id),
          answers: Object.fromEntries(pending.control.questions.map((q, index) => [q.id, answers[index] ?? []])) });
        writeAttempted = true;
        await pending.write({ ...frame, id: pending.rawId }); return true;
      },
    }, { sessionId: input.expectedSessionId, blockId: input.expectedBlockId, signal: input.signal });
    questions.delete(id); return receipt;
  } finally {
    // A failed attempted write has an unknown remote outcome; do not replay it.
    // Validation failures before any write remain retryable. Disposal revokes the handle.
    pending.busy = writeAttempted;
  }
}

export async function replyCodexApproval(input: { sessionId: string; approvalId: string;
  response: 'once' | 'always' | 'reject' | 'cancel' }): Promise<void> {
  const pending = approvals.get(input.approvalId);
  if (!pending?.active() || pending.busy || pending.sessionId !== input.sessionId)
    throw new Error('Codex approval is no longer pending.');
  pending.busy = true;
  let writeAttempted = false;
  try {
    let result: Record<string, unknown>;
    if (pending.control.kind === 'permissions') {
      const rejecting = input.response === 'reject' || input.response === 'cancel';
      if (!rejecting && pending.mode.kind !== 'agent')
        throw new Error('Read-only mode cannot grant additional permissions.');
      if (!rejecting && !pending.permissions) throw new Error('Requested permissions are unavailable.');
      result = { permissions: rejecting ? {} : pending.permissions,
        scope: input.response === 'always' ? 'session' : 'turn' };
    } else {
      result = buildCodexApprovalResponse({ responseHandle: input.approvalId,
        kind: pending.control.kind, mode: pending.mode,
        decision: input.response === 'once' ? 'accept' : input.response === 'always' ? 'acceptForSession' : input.response === 'cancel' ? 'cancel' : 'decline',
        availableDecisions: pending.control.display.availableDecisions ?? DEFAULT_SIMPLE_DECISIONS,
      }).result;
    }
    writeAttempted = true;
    await pending.write({ id: pending.rawId, result }); approvals.delete(input.approvalId);
  } finally {
    // A failed attempted write has an unknown remote outcome; do not replay it.
    // Validation failures before any write remain retryable. Disposal revokes the handle.
    pending.busy = writeAttempted;
  }
}
