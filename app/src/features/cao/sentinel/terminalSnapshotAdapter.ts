import type { JarvisDexie } from '@/lib/db/database';
import { cleanCaoTerminalHistory } from '../terminalEvidence';
import type { CaoExecutionIdentity } from '../executionProfile';
import type { CaoTerminalExecutionIdentityReceipt } from '../terminalExecutionIdentity';
import { buildCaoTargetSnapshot } from './targetSnapshot';
import type { CaoTargetSnapshot } from './types';

export type CaoTerminalSnapshotIdentityRequest = Readonly<{
  accountId: string;
  projectId: string | null;
  targetId: string;
}>;

export type CaoTerminalSnapshotIdentityReader = (
  request: CaoTerminalSnapshotIdentityRequest,
) => CaoTerminalExecutionIdentityReceipt | undefined;

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

export function createCaoTerminalSnapshotAdapter(input: {
  database: JarvisDexie;
  identity: CaoExecutionIdentity;
  readExecutionIdentity?: CaoTerminalSnapshotIdentityReader;
  readEvidence?: (sessionId: string) => string | undefined;
  now?: () => number;
}) {
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
    const terminal = await input.database.terminal_sessions.get(request.targetId as never);
    if (
      !terminal ||
      terminal.workspace_id !== request.workspaceId ||
      (terminal.project_id ?? null) !== request.projectId
    ) {
      throw new Error('cao_terminal_snapshot_scope_mismatch');
    }
    const workspace = await input.database.workspaces.get(request.workspaceId as never);
    if (!workspace || workspace.owner_id !== request.accountId)
      throw new Error('cao_terminal_snapshot_scope_mismatch');
    const receipt = input.readExecutionIdentity?.({
      accountId: request.accountId,
      projectId: request.projectId,
      targetId: request.targetId,
    });
    if (!receipt) throw new Error('cao_terminal_snapshot_identity_unavailable');
    if (
      request.projectId === null ||
      receipt.binding.accountId !== request.accountId ||
      receipt.binding.projectId !== request.projectId ||
      receipt.binding.sessionId !== request.targetId ||
      receipt.binding.process.projectId !== request.projectId
    ) {
      throw new Error('cao_terminal_snapshot_identity_mismatch');
    }
    if (!sameExecutionIdentity(input.identity, receipt.identity)) {
      throw new Error('cao_terminal_snapshot_identity_mismatch');
    }
    const evidence = cleanCaoTerminalHistory(input.readEvidence?.(request.targetId) ?? '');
    const failed =
      terminal.status === 'exited' && terminal.exit_code !== undefined && terminal.exit_code !== 0;
    return buildCaoTargetSnapshot({
      missionId: request.missionId,
      targetId: request.targetId,
      kind: 'terminal',
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      ...receipt.identity,
      assignment: request.assignment,
      ownedPaths: request.ownedPaths,
      targetRevision: terminal.last_active_at,
      runStatus:
        terminal.status === 'exited'
          ? 'exited'
          : terminal.status === 'detached'
            ? 'waiting'
            : 'running',
      lastActivityAt: terminal.last_active_at,
      pendingUserInput: false,
      pendingApproval: false,
      pendingTool: false,
      pendingRetry: failed,
      receiptIds: [],
      verification: 'pending',
      recentDelta: evidence,
      errors: failed ? [`terminal_exit_${terminal.exit_code ?? 'unknown'}`] : [],
      claims: [],
      contextRevision: request.contextRevision ?? null,
      milestone: terminal.status === 'exited' ? 'terminal-exited' : 'terminal-active',
      cursor: { targetRevision: terminal.last_active_at, observedAt: now() },
    });
  };
}
