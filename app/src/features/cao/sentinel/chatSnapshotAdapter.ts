import type { Message } from '@/types/chat';
import type { JarvisDexie } from '@/lib/db/database';
import { getChatRunState, type ChatRunState } from '@/features/chat/runtime/chatRunState';
import { readCaoChatTargetIdentity } from '../targetIdentity';
import { buildCaoTargetSnapshot } from './targetSnapshot';
import type { CaoExecutionIdentity } from '../executionProfile';
import type { CaoTargetSnapshot } from './types';

function sameExecutionIdentity(
  expected: CaoExecutionIdentity,
  observed: CaoExecutionIdentity | undefined,
): boolean {
  return (
    observed?.backend === expected.backend &&
    observed.providerId === expected.providerId &&
    observed.connectionId === expected.connectionId &&
    observed.modelId === expected.modelId &&
    observed.reasoningEffort === expected.reasoningEffort
  );
}

function publicMessageText(message: Message): string {
  return message.parts
    .flatMap((part) => {
      if (part.kind === 'text') return [part.text];
      if (part.kind === 'tool_result')
        return [typeof part.error === 'string' ? part.error : 'tool result observed'];
      if (part.kind === 'provider_error') return [part.error.message];
      if (part.kind === 'action_proposal' && part.status === 'error')
        return [part.error ?? 'action failed'];
      return [];
    })
    .join('\n')
    .slice(-6000);
}

function messageErrors(messages: readonly Message[]): string[] {
  return messages
    .flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.kind === 'provider_error') return [part.error.message];
        if (part.kind === 'tool_result' && part.error) return [part.error];
        if (part.kind === 'action_proposal' && part.status === 'error')
          return [part.error ?? 'action failed'];
        return [];
      }),
    )
    .slice(-24);
}

function pendingApproval(messages: readonly Message[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.kind === 'action_proposal' && part.status === 'pending'),
  );
}

function pendingTool(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return last?.parts.some((part) => part.kind === 'tool_call') === true;
}

export function createCaoChatSnapshotAdapter(input: {
  database: JarvisDexie;
  identity: CaoExecutionIdentity;
  readRunState?: (chatId: string) => ChatRunState | undefined;
  now?: () => number;
}) {
  const readRunState = input.readRunState ?? getChatRunState;
  const now = input.now ?? Date.now;
  return async (request: {
    missionId: string;
    accountId: string;
    workspaceId: string;
    projectId: string | null;
    targetId: string;
    assignment: string;
    ownedPaths: readonly string[];
    contextRevision?: string | null;
  }): Promise<CaoTargetSnapshot> => {
    const chat = await input.database.chats.get(request.targetId as never);
    if (
      !chat ||
      chat.workspace_id !== request.workspaceId ||
      (chat.project_id ?? null) !== request.projectId
    ) {
      throw new Error('cao_chat_snapshot_scope_mismatch');
    }
    const workspace = await input.database.workspaces.get(request.workspaceId as never);
    if (!workspace || workspace.owner_id !== request.accountId)
      throw new Error('cao_chat_snapshot_scope_mismatch');
    const observedIdentity = readCaoChatTargetIdentity(chat);
    if (!observedIdentity || !sameExecutionIdentity(input.identity, observedIdentity)) {
      throw new Error('cao_chat_snapshot_identity_mismatch');
    }
    const newestMessages = await input.database.messages
      .where('[chat_id+created_at]')
      .between([request.targetId, 0], [request.targetId, now()], true, true)
      .reverse()
      .limit(40)
      .toArray();
    const messages = [...newestMessages].reverse();
    const state = readRunState(request.targetId);
    const runStatus = state?.status ?? 'idle';
    return buildCaoTargetSnapshot({
      missionId: request.missionId,
      targetId: request.targetId,
      kind: 'chat',
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      ...observedIdentity,
      assignment: request.assignment,
      ownedPaths: request.ownedPaths,
      targetRevision: chat.updated_at,
      runStatus,
      lastActivityAt: chat.updated_at,
      pendingUserInput: false,
      pendingApproval: pendingApproval(messages),
      pendingTool: pendingTool(messages),
      pendingRetry: state?.status === 'error',
      receiptIds: messages
        .flatMap((message) => (message.usage?.provider && message.id ? [String(message.id)] : []))
        .slice(-24),
      verification: 'pending',
      recentDelta: messages.slice(-12).map(publicMessageText).filter(Boolean).join('\n'),
      errors: messageErrors(messages),
      claims: [],
      contextRevision: request.contextRevision ?? null,
      milestone: runStatus === 'done' ? 'turn-complete' : 'active-turn',
      cursor: { targetRevision: chat.updated_at, observedAt: now() },
    });
  };
}
