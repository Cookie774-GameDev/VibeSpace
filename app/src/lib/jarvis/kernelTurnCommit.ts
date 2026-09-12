import Dexie from 'dexie';

import type { Chat, Message } from '@/types';
import type { ActionResult } from '@/lib/actions/types';
import {
  fromJarvisArtifactRow,
  fromJarvisEventRow,
  fromJarvisRunRow,
  toJarvisArtifactRow,
  toJarvisEventRow,
  toJarvisRunRow,
} from '@/lib/db/jarvisMappers';
import {
  enqueueLocalSyncInTransaction,
  type KernelTurnTransactionAuthority,
} from '@/lib/db/kernelTurnTransactionAuthority';
import type {
  JarvisEvent,
  JarvisArtifactV1,
  JarvisProducerSourceEvidenceV1,
  JarvisRun,
  JarvisRunStatus,
  JarvisRunTransitionEventInput,
} from './contracts';
import { canonicalizeJarvisApprovalJson } from './contracts';
import type { JarvisKernelAccountBinding } from './kernelRuntime';

const KERNEL_TURN_TABLES = [
  'messages',
  'chats',
  'sync_queue',
  'settings',
  'jarvis_runs',
  'jarvis_events',
  'jarvis_artifacts',
] as const;

const KERNEL_LIFECYCLE_TABLES = ['jarvis_runs', 'jarvis_events'] as const;

const TERMINAL_STATUSES = new Set<KernelTurnTerminalStatus>([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'timed_out',
]);

export type KernelTurnTerminalStatus = Extract<
  JarvisRunStatus,
  'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
>;

/** @internal Imported only by kernelRuntime.ts and focused tests. */
export type KernelTurnCommitInput = {
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  expectedStatus: JarvisRunStatus;
  accountBinding: JarvisKernelAccountBinding;
  terminal: {
    status: KernelTurnTerminalStatus;
    event: JarvisRunTransitionEventInput;
  };
  assistantMessage: Message;
  artifacts: readonly JarvisArtifactV1[];
  transportAttemptCompletion?: Readonly<{
    attemptNumber: number;
    requestId: string;
  }>;
};

/** @internal Imported only by kernelRuntime.ts and focused tests. */
export type KernelTurnCommitResult =
  | {
      committed: true;
      run: ReturnType<typeof fromJarvisRunRow>;
      event: ReturnType<typeof fromJarvisEventRow>;
      message: Message;
      artifacts: readonly JarvisArtifactV1[];
    }
  | {
      committed: false;
      reason: 'status_conflict';
      actualStatus: JarvisRunStatus;
    }
  | {
      committed: false;
      reason: 'attempt_conflict';
      actualStatus: JarvisRunStatus;
    }
  | {
      committed: false;
      reason: 'account_authority_revoked';
    };

/** @internal Captured and invoked only by a runtime-issued voice handle. */
export type VoiceResponseReadyCommitInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  accountBinding: JarvisKernelAccountBinding;
  assistantMessage: Message;
  artifacts: readonly JarvisArtifactV1[];
  providerResultSource: JarvisProducerSourceEvidenceV1;
  createdAt: number;
}>;

export type VoiceResponseReadyCommitResult =
  | {
      committed: true;
      run: JarvisRun;
      event: JarvisEvent;
      message: Message;
      artifacts: readonly JarvisArtifactV1[];
    }
  | {
      committed: false;
      reason: 'status_conflict' | 'attempt_conflict' | 'response_ready_conflict';
      actualStatus: JarvisRunStatus;
    };

type VoiceResponseReadyPortResult =
  | VoiceResponseReadyCommitResult
  | { committed: false; reason: 'account_authority_revoked' };

/** @internal Persists one canonical provider response after approval creation. */
export type ActionResponseReadyCommitInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  approvalId: string;
  accountBinding: JarvisKernelAccountBinding;
  assistantMessage: Message;
  artifacts: readonly JarvisArtifactV1[];
  providerResultSource: JarvisProducerSourceEvidenceV1;
  createdAt: number;
}>;

export type ActionResponseReadyCommitResult =
  | {
      committed: true;
      run: JarvisRun;
      event: JarvisEvent;
      message: Message;
      artifacts: readonly JarvisArtifactV1[];
    }
  | {
      committed: false;
      reason:
        | 'status_conflict'
        | 'attempt_conflict'
        | 'response_ready_conflict'
        | 'account_authority_revoked';
      actualStatus?: JarvisRunStatus;
    };

/** @internal Finalizes only a previously persisted canonical approval response. */
export type FinalizeActionResponseInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  approvalId: string;
  messageId: string;
  accountBinding: JarvisKernelAccountBinding;
  outcome: 'completed' | 'degraded' | 'denied' | 'handoff';
  resultRef: string;
  result?: ActionResult;
  completedAt: number;
}>;

export type FinalizeActionResponseResult =
  | { committed: true; run: JarvisRun; event: JarvisEvent; message: Message }
  | {
      committed: false;
      reason:
        | 'status_conflict'
        | 'attempt_conflict'
        | 'response_ready_conflict'
        | 'account_authority_revoked';
      actualStatus?: JarvisRunStatus;
    };

/** @internal Captured and invoked only by a runtime-issued voice handle. */
export type VoicePlaybackCommitInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  accountBinding: JarvisKernelAccountBinding;
  terminalStatus: KernelTurnTerminalStatus;
  terminalKind?: 'playback' | 'recovery';
  playbackResultSource?: Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }>;
  createdAt: number;
}>;

export type JarvisVoicePlaybackCommitResult =
  | { committed: true; run: JarvisRun; event: JarvisEvent }
  | { committed: false; reason: 'status_conflict'; actualStatus: JarvisRunStatus };

type VoicePlaybackPortResult =
  | JarvisVoicePlaybackCommitResult
  | { committed: false; reason: 'account_authority_revoked' };

/** @internal Imported only by kernelRuntime.ts and focused tests. */
export type JarvisKernelCommitPort = Readonly<{
  commitKernelTurn(input: KernelTurnCommitInput): Promise<KernelTurnCommitResult>;
  commitActionResponseReady(
    input: ActionResponseReadyCommitInput,
  ): Promise<ActionResponseReadyCommitResult>;
  finalizeActionResponse(input: FinalizeActionResponseInput): Promise<FinalizeActionResponseResult>;
  commitVoiceResponseReady(
    input: VoiceResponseReadyCommitInput,
  ): Promise<VoiceResponseReadyPortResult>;
  commitVoicePlayback(input: VoicePlaybackCommitInput): Promise<VoicePlaybackPortResult>;
}>;

type CommitDependencies = Readonly<{
  transactionAuthority: KernelTurnTransactionAuthority;
  assertIssuedAccountBinding(binding: JarvisKernelAccountBinding): void;
  consumeArtifactsForCommit(input: {
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    artifacts: readonly JarvisArtifactV1[];
  }): void;
}>;

function isStableIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function assertCommitInput(input: KernelTurnCommitInput): void {
  if (
    !isStableIdentifier(input.accountId) ||
    !isStableIdentifier(input.runId) ||
    !isStableIdentifier(input.requestId) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !TERMINAL_STATUSES.has(input.terminal.status) ||
    input.assistantMessage.role !== 'assistant'
  ) {
    throw new TypeError('kernel_turn_commit_input_invalid');
  }
  const ids = new Set<string>();
  for (const artifact of input.artifacts) {
    if (
      artifact.runId !== input.runId ||
      artifact.requestId !== input.requestId ||
      artifact.attemptNumber !== input.attemptNumber ||
      ids.has(artifact.id)
    ) {
      throw new TypeError('kernel_turn_artifact_scope_mismatch');
    }
    ids.add(artifact.id);
  }
}

function assertVoiceResponseReadyInput(input: VoiceResponseReadyCommitInput): void {
  const providerSource = input.providerResultSource;
  if (
    !isStableIdentifier(input.accountId) ||
    !isStableIdentifier(input.runId) ||
    !isStableIdentifier(input.requestId) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isFinite(input.createdAt) ||
    input.assistantMessage.role !== 'assistant' ||
    providerSource.producerKind !== 'provider' ||
    providerSource.phase !== 'result' ||
    providerSource.accountId !== input.accountId ||
    providerSource.runId !== input.runId ||
    providerSource.requestId !== input.requestId ||
    providerSource.attemptNumber !== input.attemptNumber ||
    (providerSource.state !== 'completed' && providerSource.state !== 'degraded')
  ) {
    throw new TypeError('voice_response_ready_input_invalid');
  }
}

function assertActionResponseReadyInput(input: ActionResponseReadyCommitInput): void {
  const providerSource = input.providerResultSource;
  if (
    !isStableIdentifier(input.accountId) ||
    !isStableIdentifier(input.runId) ||
    !isStableIdentifier(input.requestId) ||
    !isStableIdentifier(input.approvalId) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isFinite(input.createdAt) ||
    input.assistantMessage.role !== 'assistant' ||
    providerSource.producerKind !== 'provider' ||
    providerSource.phase !== 'result' ||
    providerSource.accountId !== input.accountId ||
    providerSource.runId !== input.runId ||
    providerSource.requestId !== input.requestId ||
    providerSource.attemptNumber !== input.attemptNumber ||
    (providerSource.state !== 'completed' && providerSource.state !== 'degraded')
  ) {
    throw new TypeError('action_response_ready_input_invalid');
  }
}

function assertFinalizeActionResponseInput(input: FinalizeActionResponseInput): void {
  if (
    !isStableIdentifier(input.accountId) ||
    !isStableIdentifier(input.runId) ||
    !isStableIdentifier(input.requestId) ||
    !isStableIdentifier(input.approvalId) ||
    !isStableIdentifier(input.messageId) ||
    !isStableIdentifier(input.resultRef) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isFinite(input.completedAt) ||
    !['completed', 'degraded', 'denied', 'handoff'].includes(input.outcome) ||
    (input.result !== undefined && input.outcome !== 'completed')
  ) {
    throw new TypeError('action_response_finalize_input_invalid');
  }
}

function approvalCallId(approvalId: string): string {
  return `jarvisapproval:${encodeURIComponent(approvalId)}`;
}

function approvalIdFromCallId(callId: string): string | undefined {
  if (!callId.startsWith('jarvisapproval:')) return undefined;
  try {
    return decodeURIComponent(callId.slice('jarvisapproval:'.length));
  } catch {
    return undefined;
  }
}

function fileActionBatchParts(
  parts: Message['parts'],
): Extract<Message['parts'][number], { kind: 'action_proposal' }>[] {
  const proposals = parts.filter(
    (
      part,
    ): part is Extract<Message['parts'][number], { kind: 'action_proposal' }> =>
      part.kind === 'action_proposal' &&
      (part.action_id === 'files.read' || part.action_id === 'files.create'),
  );
  if (proposals.length < 2 || proposals.length > 10) return [];
  if (!proposals.every((part) => part.action_id === proposals[0]!.action_id)) return [];
  return proposals;
}

function approvedFileReadResult(
  actionId: string,
  params: Readonly<Record<string, unknown>>,
  result: ActionResult | undefined,
): Extract<ActionResult, { ok: true }> | undefined {
  if (result === undefined) return undefined;
  if (
    actionId !== 'files.read' ||
    !result.ok ||
    typeof result.summary !== 'string' ||
    result.summary.length > 2_048 ||
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    throw new TypeError('action_response_finalize_result_invalid');
  }
  const data = result.data as Record<string, unknown>;
  const path = data.path;
  const content = data.content;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4_096 ||
    path !== params.path ||
    typeof content !== 'string' ||
    content.length > 48_000
  ) {
    throw new TypeError('action_response_finalize_result_invalid');
  }
  return {
    ok: true,
    summary: result.summary,
    data: { path, content },
  };
}

function assertVoicePlaybackInput(input: VoicePlaybackCommitInput): void {
  const playbackSource = input.playbackResultSource;
  if (
    !isStableIdentifier(input.accountId) ||
    !isStableIdentifier(input.runId) ||
    !isStableIdentifier(input.requestId) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0 ||
    !TERMINAL_STATUSES.has(input.terminalStatus) ||
    (input.terminalKind !== undefined &&
      input.terminalKind !== 'playback' &&
      input.terminalKind !== 'recovery') ||
    (input.terminalKind === 'recovery' && input.terminalStatus !== 'partial') ||
    (playbackSource !== undefined &&
      (playbackSource.producerKind !== 'voice' ||
        playbackSource.producerIdentity.engineKind !== 'playback' ||
        playbackSource.phase !== 'result' ||
        playbackSource.accountId !== input.accountId ||
        playbackSource.runId !== input.runId ||
        playbackSource.requestId !== input.requestId ||
        playbackSource.attemptNumber !== input.attemptNumber ||
        playbackSource.state !== (input.terminalStatus === 'completed' ? 'completed' : 'degraded')))
  ) {
    throw new TypeError('voice_playback_commit_input_invalid');
  }
}

function voiceTerminalCopy(
  status: KernelTurnTerminalStatus,
  kind: 'playback' | 'recovery' = 'playback',
): Readonly<{
  title: string;
  safeSummary: string;
}> {
  if (kind === 'recovery') {
    return {
      title: 'Voice response recovered',
      safeSummary:
        'The response was saved, but playback completion could not be verified after restart.',
    };
  }
  switch (status) {
    case 'completed':
      return {
        title: 'Voice playback completed',
        safeSummary: 'The saved response finished verified playback.',
      };
    case 'partial':
      return {
        title: 'Voice playback incomplete',
        safeSummary: 'The response was saved, but playback did not complete.',
      };
    case 'cancelled':
      return {
        title: 'Voice playback cancelled',
        safeSummary: 'The saved response remains available after verified cancellation.',
      };
    case 'timed_out':
      return {
        title: 'Voice playback timed out',
        safeSummary: 'The saved response remains available after a verified timeout.',
      };
    case 'failed':
      return {
        title: 'Voice playback failed',
        safeSummary: 'The saved response remains available after a verified playback failure.',
      };
  }
}

function canonicalValuesMatch(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

function bindingIsCurrent(
  dependencies: CommitDependencies,
  binding: JarvisKernelAccountBinding,
): boolean {
  try {
    dependencies.assertIssuedAccountBinding(binding);
    binding.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

function attemptConflict(actualStatus: JarvisRunStatus): KernelTurnCommitResult {
  return { committed: false, reason: 'attempt_conflict', actualStatus };
}

/** @internal Bound only inside the closed artifact/kernel runtime composition. */
export function createKernelTurnCommit(dependencies: CommitDependencies): JarvisKernelCommitPort {
  return Object.freeze({
    async commitActionResponseReady(
      input: ActionResponseReadyCommitInput,
    ): Promise<ActionResponseReadyCommitResult> {
      assertActionResponseReadyInput(input);
      if (!bindingIsCurrent(dependencies, input.accountBinding)) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      if (input.accountBinding.identity.accountId !== input.accountId) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      const expectedCallId = `jarvisapproval:${encodeURIComponent(input.approvalId)}`;
      const proposals = input.assistantMessage.parts.filter(
        (part) => part.kind === 'action_proposal',
      );
      const pendingProposals = proposals.filter((part) => part.status === 'pending');
      const validSingle =
        pendingProposals.length === 1 && pendingProposals[0]!.call_id === expectedCallId;
      const validFileCreateBatch =
        pendingProposals.length >= 2 &&
        pendingProposals.length <= 10 &&
        (pendingProposals[0]?.action_id === 'files.create' ||
          pendingProposals[0]?.action_id === 'files.read') &&
        pendingProposals.every(
          (part) =>
            part.action_id === pendingProposals[0]!.action_id &&
            typeof part.call_id === 'string' &&
            part.call_id.startsWith('jarvisapproval:'),
        ) &&
        pendingProposals.some((part) => part.call_id === expectedCallId);
      if (!validSingle && !validFileCreateBatch) {
        throw new TypeError('action_response_ready_approval_projection_invalid');
      }
      const artifactIds = new Set<string>();
      for (const artifact of input.artifacts) {
        if (
          artifact.runId !== input.runId ||
          artifact.requestId !== input.requestId ||
          artifact.attemptNumber !== input.attemptNumber ||
          artifactIds.has(artifact.id)
        ) {
          return {
            committed: false,
            reason: 'attempt_conflict',
            actualStatus: 'awaiting_approval',
          };
        }
        artifactIds.add(artifact.id);
      }

      const artifactRows = input.artifacts.map(toJarvisArtifactRow);
      const transaction = await dependencies.transactionAuthority.transaction(
        KERNEL_TURN_TABLES,
        input.accountBinding.revocationSignal,
        async (context): Promise<ActionResponseReadyCommitResult> => {
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          const runRow = await context.jarvis_runs.get(input.runId);
          if (!runRow || runRow.account_id !== input.accountId) {
            throw new TypeError('action_response_ready_run_scope_mismatch');
          }
          const current = fromJarvisRunRow(runRow);
          if (current.status !== 'awaiting_approval') {
            return {
              committed: false,
              reason: 'status_conflict',
              actualStatus: current.status,
            };
          }
          if (current.chatId === undefined || input.assistantMessage.chat_id !== current.chatId) {
            throw new TypeError('action_response_ready_message_scope_mismatch');
          }
          const responseKey = `action-response-ready:${input.approvalId}`;
          const [chatRow, existingMessage, existingArtifacts, matchingEvent] = await Promise.all([
            context.chats.get(input.assistantMessage.chat_id),
            context.messages.get(input.assistantMessage.id),
            context.jarvis_artifacts.bulkGet(artifactRows.map((row) => row.id)),
            context.jarvis_events
              .where('run_id')
              .equals(input.runId)
              .filter((row) => row.idempotency_key === responseKey)
              .first(),
          ]);
          if (!chatRow) throw new TypeError('action_response_ready_chat_missing');
          if (existingMessage || existingArtifacts.some(Boolean) || matchingEvent) {
            return {
              committed: false,
              reason: 'response_ready_conflict',
              actualStatus: current.status,
            };
          }
          const lastEvent = await context.jarvis_events
            .where('[run_id+seq]')
            .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
            .last();
          const eventRow = toJarvisEventRow({
            runId: input.runId,
            seq: (lastEvent?.seq ?? 0) + 1,
            idempotencyKey: responseKey,
            type: 'message',
            status: 'approval_required',
            title: 'Action approval required',
            safeSummary: 'The validated response is saved and awaiting an approval decision.',
            sourceRefs: [],
            artifactIds: input.artifacts.map((artifact) => artifact.id),
            createdAt: input.createdAt,
            producerSourceEvidence: structuredClone(input.providerResultSource),
          });
          const message = structuredClone(input.assistantMessage);
          const updatedChat: Chat = {
            ...structuredClone(chatRow),
            updated_at: Math.max(chatRow.updated_at, input.createdAt, message.updated_at),
          };
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          if (input.artifacts.length > 0) {
            dependencies.consumeArtifactsForCommit({
              accountId: input.accountId,
              runId: input.runId,
              requestId: input.requestId,
              attemptNumber: input.attemptNumber,
              artifacts: input.artifacts,
            });
          }
          await context.jarvis_events.add(eventRow);
          await context.messages.add(message);
          await context.chats.put(updatedChat);
          await enqueueLocalSyncInTransaction(context, {
            op: 'insert',
            table: 'messages',
            row: message,
            createdAt: input.createdAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          await enqueueLocalSyncInTransaction(context, {
            op: 'update',
            table: 'chats',
            row: updatedChat,
            createdAt: input.createdAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          if (artifactRows.length > 0) await context.jarvis_artifacts.bulkAdd(artifactRows);
          return {
            committed: true,
            run: current,
            event: fromJarvisEventRow(eventRow),
            message,
            artifacts: Object.freeze(input.artifacts.map((value) => Object.freeze(value))),
          };
        },
      );
      if (transaction.kind === 'cancelled') {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      return transaction.value;
    },
    async finalizeActionResponse(
      input: FinalizeActionResponseInput,
    ): Promise<FinalizeActionResponseResult> {
      assertFinalizeActionResponseInput(input);
      if (!bindingIsCurrent(dependencies, input.accountBinding)) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      if (input.accountBinding.identity.accountId !== input.accountId) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      const transaction = await dependencies.transactionAuthority.transaction(
        KERNEL_TURN_TABLES,
        input.accountBinding.revocationSignal,
        async (context): Promise<FinalizeActionResponseResult> => {
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          const [runRow, storedMessage, runEvents] = await Promise.all([
            context.jarvis_runs.get(input.runId),
            context.messages.get(input.messageId as Message['id']),
            context.jarvis_events
              .where('[run_id+seq]')
              .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
              .toArray(),
          ]);
          if (!runRow || runRow.account_id !== input.accountId) {
            throw new TypeError('action_response_finalize_run_scope_mismatch');
          }
          const current = fromJarvisRunRow(runRow);
          if (!storedMessage || storedMessage.chat_id !== current.chatId) {
            return {
              committed: false,
              reason: 'response_ready_conflict',
              actualStatus: current.status,
            };
          }
          const expectedCallId = approvalCallId(input.approvalId);
          const fileBatch = fileActionBatchParts(storedMessage.parts);
          const isFileActionBatch =
            fileBatch.length >= 2 && fileBatch.some((part) => part.call_id === expectedCallId);
          if (
            current.status !== 'running' &&
            !(isFileActionBatch && current.status === 'awaiting_approval' && input.outcome === 'completed')
          ) {
            return {
              committed: false,
              reason: 'status_conflict',
              actualStatus: current.status,
            };
          }
          let responseReady = runEvents.filter(
            (row) => row.idempotency_key === `action-response-ready:${input.approvalId}`,
          );
          if (responseReady.length !== 1 && isFileActionBatch) {
            const checkpointKeys = new Set(
              fileBatch.flatMap((part) => {
                const siblingId = approvalIdFromCallId(part.call_id);
                return siblingId ? [`action-response-ready:${siblingId}`] : [];
              }),
            );
            responseReady = runEvents.filter((row) => checkpointKeys.has(row.idempotency_key));
          }
          if (responseReady.length !== 1 || input.completedAt < current.updatedAt) {
            return {
              committed: false,
              reason: 'response_ready_conflict',
              actualStatus: current.status,
            };
          }
          let matched = 0;
          const partStatus =
            input.outcome === 'completed'
              ? ('success' as const)
              : input.outcome === 'denied'
                ? ('cancelled' as const)
                : input.outcome === 'handoff'
                  ? ('queued' as const)
                  : ('error' as const);
          const parts = storedMessage.parts.map((part) => {
            if (part.kind !== 'action_proposal' || part.call_id !== expectedCallId) {
              return structuredClone(part);
            }
            matched += 1;
            if (
              (input.outcome === 'handoff' && part.status !== 'pending') ||
              (input.outcome !== 'handoff' && part.status !== 'pending' && part.status !== 'queued')
            ) {
              throw new TypeError('action_response_finalize_projection_conflict');
            }
            const projectedResult = approvedFileReadResult(part.action_id, part.params, input.result);
            return {
              ...structuredClone(part),
              status: partStatus,
              ...(projectedResult === undefined ? {} : { result: projectedResult }),
              ...(partStatus === 'error'
                ? { error: 'The protected action did not complete.' }
                : {}),
            };
          });
          if (matched !== 1) {
            return {
              committed: false,
              reason: 'response_ready_conflict',
              actualStatus: current.status,
            };
          }
          const remainingBatchPending = isFileActionBatch
            ? parts.filter(
                (part) =>
                  part.kind === 'action_proposal' &&
                  (part.action_id === 'files.read' || part.action_id === 'files.create') &&
                  (part.status === 'pending' || part.status === 'queued'),
              ).length
            : 0;
          const keepAwaitingApproval =
            isFileActionBatch && remainingBatchPending > 0 && input.outcome === 'completed';
          let transportAttempts = current.transportAttempts;
          if (current.source === 'schedule' && input.outcome !== 'handoff' && !keepAwaitingApproval) {
            const attempts = structuredClone([...(current.transportAttempts ?? [])]);
            const latest = attempts.at(-1);
            if (
              !latest ||
              latest.requestId !== input.requestId ||
              latest.attemptNumber !== input.attemptNumber ||
              latest.state !== 'provider_in_flight'
            ) {
              return {
                committed: false,
                reason: 'attempt_conflict',
                actualStatus: current.status,
              };
            }
            attempts[attempts.length - 1] = {
              ...latest,
              state: 'completed',
              updatedAt: input.completedAt,
            };
            transportAttempts = attempts;
          }
          const terminalStatus = keepAwaitingApproval
            ? ('awaiting_approval' as const)
            : input.outcome === 'completed'
              ? ('completed' as const)
              : input.outcome === 'denied'
                ? ('cancelled' as const)
                : input.outcome === 'handoff'
                  ? ('running' as const)
                  : ('partial' as const);
          const updatedRun: JarvisRun = {
            ...current,
            status: terminalStatus,
            updatedAt: input.completedAt,
            ...(terminalStatus === 'running' || terminalStatus === 'awaiting_approval'
              ? {}
              : { completedAt: input.completedAt }),
            ...(transportAttempts === undefined ? {} : { transportAttempts }),
          };
          const message: Message = {
            ...structuredClone(storedMessage),
            parts,
            updated_at: input.completedAt,
          };
          const chatRow = await context.chats.get(message.chat_id);
          if (!chatRow) throw new TypeError('action_response_finalize_chat_missing');
          const updatedChat: Chat = {
            ...structuredClone(chatRow),
            updated_at: Math.max(chatRow.updated_at, input.completedAt),
          };
          const responseReadyEvent = fromJarvisEventRow(responseReady[0]!);
          const eventRow = toJarvisEventRow({
            runId: input.runId,
            seq: (runEvents.at(-1)?.seq ?? 0) + 1,
            idempotencyKey:
              input.outcome === 'handoff'
                ? `action-handoff:${input.approvalId}:${input.resultRef}`
                : `action-terminal:${input.approvalId}:${input.resultRef}`,
            type: input.outcome === 'handoff' ? 'tool' : 'run_state',
            status: input.outcome === 'handoff' ? 'handoff_pending' : terminalStatus,
            title:
              input.outcome === 'handoff'
                ? 'Action execution handed off'
                : terminalStatus === 'completed'
                  ? 'Action completed'
                  : terminalStatus === 'cancelled'
                    ? 'Action denied'
                    : terminalStatus === 'awaiting_approval'
                      ? 'Batch action completed'
                      : 'Action ended with degraded state',
            safeSummary:
              input.outcome === 'handoff'
                ? 'The approved action is running under its native execution owner.'
                : terminalStatus === 'completed'
                  ? 'The approved protected action completed.'
                  : terminalStatus === 'cancelled'
                    ? 'The protected action was denied and did not execute.'
                    : terminalStatus === 'awaiting_approval'
                      ? 'The approved file action completed; remaining batch approvals are still pending.'
                      : 'The approved protected action did not fully complete.',
            sourceRefs: responseReadyEvent.sourceRefs,
            artifactIds: responseReadyEvent.artifactIds,
            createdAt: input.completedAt,
          });
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          const updatedRunRow = toJarvisRunRow(updatedRun);
          await context.jarvis_runs.put(updatedRunRow);
          await context.jarvis_events.add(eventRow);
          await context.messages.put(message);
          await context.chats.put(updatedChat);
          await enqueueLocalSyncInTransaction(context, {
            op: 'update',
            table: 'messages',
            row: message,
            createdAt: input.completedAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          await enqueueLocalSyncInTransaction(context, {
            op: 'update',
            table: 'chats',
            row: updatedChat,
            createdAt: input.completedAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          return {
            committed: true,
            run: fromJarvisRunRow(updatedRunRow),
            event: fromJarvisEventRow(eventRow),
            message,
          };
        },
      );
      if (transaction.kind === 'cancelled') {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      return transaction.value;
    },
    async commitVoicePlayback(input: VoicePlaybackCommitInput): Promise<VoicePlaybackPortResult> {
      assertVoicePlaybackInput(input);
      if (!bindingIsCurrent(dependencies, input.accountBinding)) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      if (input.accountBinding.identity.accountId !== input.accountId) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      const authoritySignal = input.accountBinding.revocationSignal;
      const transaction = await dependencies.transactionAuthority.lifecycleTransaction(
        KERNEL_LIFECYCLE_TABLES,
        authoritySignal,
        async (context): Promise<VoicePlaybackPortResult> => {
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          const runRow = await context.jarvis_runs.get(input.runId);
          if (!runRow || runRow.account_id !== input.accountId) {
            throw new TypeError('voice_playback_run_scope_mismatch');
          }
          const current = fromJarvisRunRow(runRow);
          if (current.status !== 'running') {
            return {
              committed: false,
              reason: 'status_conflict',
              actualStatus: current.status,
            };
          }
          if (current.source !== 'voice') {
            throw new TypeError('voice_playback_run_source_mismatch');
          }
          const latestAttempt = current.transportAttempts?.at(-1);
          if (
            latestAttempt &&
            (latestAttempt.requestId !== input.requestId ||
              latestAttempt.attemptNumber !== input.attemptNumber)
          ) {
            throw new TypeError('voice_playback_attempt_scope_mismatch');
          }

          const runEvents = await context.jarvis_events
            .where('[run_id+seq]')
            .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
            .toArray();
          const responseReadyEvents = runEvents.filter(
            (row) => row.type === 'message' && row.status === 'response_ready',
          );
          if (responseReadyEvents.length !== 1) {
            throw new TypeError('voice_playback_response_ready_conflict');
          }
          const responseReady = fromJarvisEventRow(responseReadyEvents[0]!);
          const terminalKind = input.terminalKind ?? 'playback';
          const copy = voiceTerminalCopy(input.terminalStatus, terminalKind);
          const nextSequence = (runEvents.at(-1)?.seq ?? 0) + 1;
          const updatedRun = {
            ...current,
            status: input.terminalStatus,
            updatedAt: input.createdAt,
            completedAt: input.createdAt,
          };
          const updatedRunRow = toJarvisRunRow(updatedRun);
          const eventRow = toJarvisEventRow({
            runId: input.runId,
            seq: nextSequence,
            idempotencyKey:
              terminalKind === 'recovery'
                ? `voice-recovery:${input.runId}`
                : `voice-terminal:${input.runId}:${input.requestId}:${input.attemptNumber}:${input.terminalStatus}`,
            type: 'run_state',
            status: input.terminalStatus,
            title: copy.title,
            safeSummary: copy.safeSummary,
            sourceRefs: responseReady.sourceRefs,
            artifactIds: responseReady.artifactIds,
            createdAt: input.createdAt,
            ...(input.playbackResultSource === undefined
              ? {}
              : { producerSourceEvidence: structuredClone(input.playbackResultSource) }),
          });

          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          await context.jarvis_runs.put(updatedRunRow);
          await context.jarvis_events.add(eventRow);
          return {
            committed: true,
            run: fromJarvisRunRow(updatedRunRow),
            event: fromJarvisEventRow(eventRow),
          };
        },
      );
      if (transaction.kind === 'cancelled') {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      return transaction.value;
    },
    async commitVoiceResponseReady(
      input: VoiceResponseReadyCommitInput,
    ): Promise<VoiceResponseReadyPortResult> {
      assertVoiceResponseReadyInput(input);
      if (!bindingIsCurrent(dependencies, input.accountBinding)) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      if (input.accountBinding.identity.accountId !== input.accountId) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      const artifactIds = new Set<string>();
      for (const artifact of input.artifacts) {
        if (
          artifact.runId !== input.runId ||
          artifact.requestId !== input.requestId ||
          artifact.attemptNumber !== input.attemptNumber ||
          artifactIds.has(artifact.id)
        ) {
          return { committed: false, reason: 'attempt_conflict', actualStatus: 'running' };
        }
        artifactIds.add(artifact.id);
      }

      const artifactRows = input.artifacts.map(toJarvisArtifactRow);
      const authoritySignal = input.accountBinding.revocationSignal;
      const transaction = await dependencies.transactionAuthority.transaction(
        KERNEL_TURN_TABLES,
        authoritySignal,
        async (context): Promise<VoiceResponseReadyPortResult> => {
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          const runRow = await context.jarvis_runs.get(input.runId);
          if (!runRow || runRow.account_id !== input.accountId) {
            throw new TypeError('voice_response_ready_run_scope_mismatch');
          }
          const current = fromJarvisRunRow(runRow);
          if (current.status !== 'running') {
            return {
              committed: false,
              reason: 'status_conflict',
              actualStatus: current.status,
            };
          }
          if (current.source !== 'voice') {
            throw new TypeError('voice_response_ready_run_source_mismatch');
          }
          if (current.chatId === undefined || input.assistantMessage.chat_id !== current.chatId) {
            throw new TypeError('voice_response_ready_message_scope_mismatch');
          }

          const responseKey = `voice-response-ready:${input.runId}:${input.assistantMessage.id}`;
          const [chatRow, existingMessage, existingArtifacts, runEvents] = await Promise.all([
            context.chats.get(input.assistantMessage.chat_id),
            context.messages.get(input.assistantMessage.id),
            context.jarvis_artifacts.bulkGet(artifactRows.map((row) => row.id)),
            context.jarvis_events
              .where('[run_id+seq]')
              .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
              .toArray(),
          ]);
          if (!chatRow) throw new TypeError('voice_response_ready_chat_missing');
          const matchingEvents = runEvents.filter((row) => row.idempotency_key === responseKey);
          const anyCheckpointExists =
            existingMessage !== undefined ||
            existingArtifacts.some((row) => row !== undefined) ||
            matchingEvents.length > 0;
          const allArtifactsExist = existingArtifacts.every((row) => row !== undefined);

          if (anyCheckpointExists) {
            if (
              !existingMessage ||
              !allArtifactsExist ||
              matchingEvents.length !== 1 ||
              !canonicalValuesMatch(existingMessage, input.assistantMessage)
            ) {
              return {
                committed: false,
                reason: 'response_ready_conflict',
                actualStatus: current.status,
              };
            }
            const event = fromJarvisEventRow(matchingEvents[0]!);
            const persistedArtifacts = existingArtifacts.map((row) => fromJarvisArtifactRow(row!));
            if (
              event.type !== 'message' ||
              event.status !== 'response_ready' ||
              event.title !== 'Voice response ready' ||
              event.safeSummary !==
                'The validated response is saved and awaiting playback outcome.' ||
              event.createdAt !== input.createdAt ||
              event.sourceRefs.length !== 0 ||
              !canonicalValuesMatch(
                event.artifactIds,
                input.artifacts.map((value) => value.id),
              ) ||
              !canonicalValuesMatch(event.producerSourceEvidence, input.providerResultSource) ||
              !canonicalValuesMatch(persistedArtifacts, input.artifacts)
            ) {
              return {
                committed: false,
                reason: 'response_ready_conflict',
                actualStatus: current.status,
              };
            }
            return {
              committed: true,
              run: current,
              event,
              message: structuredClone(existingMessage),
              artifacts: Object.freeze(persistedArtifacts.map((value) => Object.freeze(value))),
            };
          }

          const last = runEvents.at(-1);
          const eventRow = toJarvisEventRow({
            runId: input.runId,
            seq: (last?.seq ?? 0) + 1,
            idempotencyKey: responseKey,
            type: 'message',
            status: 'response_ready',
            title: 'Voice response ready',
            safeSummary: 'The validated response is saved and awaiting playback outcome.',
            sourceRefs: [],
            artifactIds: input.artifacts.map((artifact) => artifact.id),
            createdAt: input.createdAt,
            producerSourceEvidence: structuredClone(input.providerResultSource),
          });
          const message = structuredClone(input.assistantMessage);
          const updatedChat: Chat = {
            ...structuredClone(chatRow),
            updated_at: Math.max(chatRow.updated_at, input.createdAt, message.updated_at),
          };
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          if (input.artifacts.length > 0) {
            dependencies.consumeArtifactsForCommit({
              accountId: input.accountId,
              runId: input.runId,
              requestId: input.requestId,
              attemptNumber: input.attemptNumber,
              artifacts: input.artifacts,
            });
          }

          await context.jarvis_events.add(eventRow);
          await context.messages.add(message);
          await context.chats.put(updatedChat);
          await enqueueLocalSyncInTransaction(context, {
            op: 'insert',
            table: 'messages',
            row: message,
            createdAt: input.createdAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          await enqueueLocalSyncInTransaction(context, {
            op: 'update',
            table: 'chats',
            row: updatedChat,
            createdAt: input.createdAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          if (artifactRows.length > 0) await context.jarvis_artifacts.bulkAdd(artifactRows);

          return {
            committed: true,
            run: current,
            event: fromJarvisEventRow(eventRow),
            message,
            artifacts: Object.freeze(input.artifacts.map((value) => Object.freeze(value))),
          };
        },
      );
      if (transaction.kind === 'cancelled') {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      return transaction.value;
    },
    async commitKernelTurn(input: KernelTurnCommitInput): Promise<KernelTurnCommitResult> {
      assertCommitInput(input);
      const artifactRows = input.artifacts.map(toJarvisArtifactRow);
      if (!bindingIsCurrent(dependencies, input.accountBinding)) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      if (input.accountBinding.identity.accountId !== input.accountId) {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      const authoritySignal = input.accountBinding.revocationSignal;

      const transaction = await dependencies.transactionAuthority.transaction(
        KERNEL_TURN_TABLES,
        authoritySignal,
        async (context): Promise<KernelTurnCommitResult> => {
          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }

          const runRow = await context.jarvis_runs.get(input.runId);
          if (!runRow || runRow.account_id !== input.accountId) {
            throw new TypeError('kernel_turn_run_scope_mismatch');
          }
          const current = fromJarvisRunRow(runRow);
          if (current.status !== input.expectedStatus) {
            return {
              committed: false,
              reason: 'status_conflict',
              actualStatus: current.status,
            };
          }

          let transportAttempts = current.transportAttempts;
          const completion = input.transportAttemptCompletion;
          if (!completion && current.source === 'schedule') {
            return attemptConflict(current.status);
          }
          if (completion) {
            if (
              completion.requestId !== input.requestId ||
              completion.attemptNumber !== input.attemptNumber
            ) {
              return attemptConflict(current.status);
            }
            const attempts = structuredClone([...(current.transportAttempts ?? [])]);
            const latest = attempts.at(-1);
            if (
              !latest ||
              latest.state !== 'provider_in_flight' ||
              latest.requestId !== input.requestId ||
              latest.attemptNumber !== input.attemptNumber ||
              latest.effectBarrier.state === 'sealed_for_retry'
            ) {
              return attemptConflict(current.status);
            }
            attempts[attempts.length - 1] = {
              ...latest,
              state: 'completed',
              updatedAt: input.terminal.event.createdAt,
            };
            transportAttempts = attempts;
          }

          if (current.chatId === undefined || input.assistantMessage.chat_id !== current.chatId) {
            throw new TypeError('kernel_turn_message_scope_mismatch');
          }
          const [chatRow, existingMessage, existingArtifacts, lastEvent] = await Promise.all([
            context.chats.get(input.assistantMessage.chat_id),
            context.messages.get(input.assistantMessage.id),
            context.jarvis_artifacts.bulkGet(artifactRows.map((row) => row.id)),
            context.jarvis_events
              .where('[run_id+seq]')
              .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
              .last(),
          ]);
          if (!chatRow) throw new TypeError('kernel_turn_chat_missing');
          if (existingMessage) throw new TypeError('kernel_turn_message_conflict');
          if (existingArtifacts.some((row) => row !== undefined)) {
            throw new TypeError('kernel_turn_artifact_conflict');
          }

          const eventCreatedAt = input.terminal.event.createdAt;
          const nextSequence = (lastEvent?.seq ?? 0) + 1;
          const updatedRun = {
            ...current,
            status: input.terminal.status,
            updatedAt: eventCreatedAt,
            completedAt: eventCreatedAt,
            ...(transportAttempts === undefined ? {} : { transportAttempts }),
          };
          const updatedRunRow = toJarvisRunRow(updatedRun);
          const eventRow = toJarvisEventRow({
            ...input.terminal.event,
            runId: input.runId,
            seq: nextSequence,
            type: 'run_state',
            status: input.terminal.status,
            artifactIds: input.artifacts.map((artifact) => artifact.id),
          });
          const message = structuredClone(input.assistantMessage);
          const updatedChat: Chat = {
            ...structuredClone(chatRow),
            updated_at: Math.max(chatRow.updated_at, eventCreatedAt, message.updated_at),
          };

          if (!bindingIsCurrent(dependencies, input.accountBinding)) {
            return { committed: false, reason: 'account_authority_revoked' };
          }
          if (input.artifacts.length > 0) {
            dependencies.consumeArtifactsForCommit({
              accountId: input.accountId,
              runId: input.runId,
              requestId: input.requestId,
              attemptNumber: input.attemptNumber,
              artifacts: input.artifacts,
            });
          }

          await context.jarvis_runs.put(updatedRunRow);
          await context.jarvis_events.add(eventRow);
          await context.messages.add(message);
          await context.chats.put(updatedChat);
          await enqueueLocalSyncInTransaction(context, {
            op: 'insert',
            table: 'messages',
            row: message,
            createdAt: eventCreatedAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          await enqueueLocalSyncInTransaction(context, {
            op: 'update',
            table: 'chats',
            row: updatedChat,
            createdAt: eventCreatedAt,
            ownerSnapshot: input.accountBinding.syncOwnerSnapshot,
          });
          if (artifactRows.length > 0) await context.jarvis_artifacts.bulkAdd(artifactRows);

          return {
            committed: true,
            run: fromJarvisRunRow(updatedRunRow),
            event: fromJarvisEventRow(eventRow),
            message,
            artifacts: input.artifacts,
          };
        },
      );

      if (transaction.kind === 'cancelled') {
        return { committed: false, reason: 'account_authority_revoked' };
      }
      return transaction.value;
    },
  });
}
