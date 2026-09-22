import { sanitizeCaoTargetSnapshot } from './snapshotSanitizer';
import type { CaoTargetSnapshot, CaoTargetSnapshotInput } from './types';

function fingerprintText(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export function snapshotEvidenceHash(snapshot: CaoTargetSnapshot): string {
  return fingerprintText(
    JSON.stringify({
      missionId: snapshot.missionId,
      targetId: snapshot.targetId,
      accountId: snapshot.accountId,
      workspaceId: snapshot.workspaceId,
      projectId: snapshot.projectId,
      backend: snapshot.backend,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      reasoningEffort: snapshot.reasoningEffort,
      assignment: snapshot.assignment,
      ownedPaths: snapshot.ownedPaths,
      targetRevision: snapshot.targetRevision,
      runStatus: snapshot.runStatus,
      lastActivityAt: snapshot.lastActivityAt,
      pendingUserInput: snapshot.pendingUserInput,
      pendingApproval: snapshot.pendingApproval,
      pendingTool: snapshot.pendingTool,
      pendingRetry: snapshot.pendingRetry,
      receiptIds: snapshot.receiptIds,
      verification: snapshot.verification,
      recentDelta: snapshot.recentDelta,
      errors: snapshot.errors,
      claims: snapshot.claims,
      contextRevision: snapshot.contextRevision,
      milestone: snapshot.milestone,
    }),
  );
}

export function buildCaoTargetSnapshot(input: CaoTargetSnapshotInput): CaoTargetSnapshot {
  const sanitized = sanitizeCaoTargetSnapshot(input);
  const evidenceHash = snapshotEvidenceHash(sanitized);
  return Object.freeze({
    ...sanitized,
    cursor: Object.freeze({ ...sanitized.cursor, contentHash: evidenceHash }),
  });
}
