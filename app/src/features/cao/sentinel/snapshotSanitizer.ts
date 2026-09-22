import { applySecretPolicy, detectSecrets } from '../../../lib/security/secretDetector';
import type { CaoTargetSnapshot, CaoTargetSnapshotInput } from './types';

const MAX_TEXT = 6000;
const MAX_ITEMS = 24;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TRUSTED_ID_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  mission: /^cao_mission_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  account: /^usr_[A-Za-z0-9_-]{16,128}$/u,
  workspace: /^wks_[A-Za-z0-9_-]{16,128}$/u,
  project: /^prj_[A-Za-z0-9_-]{16,128}$/u,
  target: /^(?:cht|chat|term|terminal|ses|session|pty)_[A-Za-z0-9_-]{16,128}$/u,
});

function text(value: unknown, fallback: string, max = 240): string {
  if (typeof value !== 'string') return fallback;
  const safe = applySecretPolicy(value, 'redact').text ?? '';
  return safe
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function id(value: unknown, field: string): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_ID.test(candidate)) throw new Error(`cao_snapshot_${field}_invalid`);
  const findings = detectSecrets(candidate);
  if (
    findings.length > 0 &&
    (!TRUSTED_ID_PATTERNS[field]?.test(candidate) ||
      findings.some((finding) => finding.secretClass !== 'high_entropy_candidate'))
  ) {
    throw new Error(`cao_snapshot_${field}_invalid`);
  }
  return candidate;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function list(values: unknown, max: number, maxItem = 240): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => text(value, '', maxItem))
    .filter(Boolean)
    .slice(0, max);
}

export function sanitizeCaoTargetSnapshot(input: CaoTargetSnapshotInput): CaoTargetSnapshot {
  const targetRevision = nonNegativeInteger(input.targetRevision, 0);
  const observedAt = nonNegativeInteger(
    input.cursor?.observedAt,
    nonNegativeInteger(input.lastActivityAt, Date.now()),
  );
  const contextRevision =
    input.contextRevision === null ? null : text(input.contextRevision, '', 192) || null;
  const contentHash = text(input.cursor?.contentHash, `revision-${targetRevision}`, 128);
  const snapshot: CaoTargetSnapshot = {
    missionId: id(input.missionId, 'mission'),
    targetId: id(input.targetId, 'target'),
    kind:
      input.kind === 'terminal' || input.kind === 'chat'
        ? input.kind
        : (() => {
            throw new Error('cao_snapshot_kind_invalid');
          })(),
    accountId: id(input.accountId, 'account'),
    workspaceId: id(input.workspaceId, 'workspace'),
    projectId: input.projectId ? id(input.projectId, 'project') : null,
    backend:
      input.backend === 'opencode' || input.backend === 'codex'
        ? input.backend
        : (() => {
            throw new Error('cao_snapshot_backend_invalid');
          })(),
    providerId: id(input.providerId, 'provider'),
    modelId: id(input.modelId, 'model'),
    reasoningEffort:
      text(input.reasoningEffort, '', 64) ||
      (() => {
        throw new Error('cao_snapshot_effort_invalid');
      })(),
    assignment: text(input.assignment, 'unassigned', 1200),
    ownedPaths: list(input.ownedPaths, MAX_ITEMS, 320),
    targetRevision,
    runStatus: ['idle', 'running', 'waiting', 'done', 'error', 'cancelled', 'exited'].includes(
      input.runStatus,
    )
      ? input.runStatus
      : (() => {
          throw new Error('cao_snapshot_status_invalid');
        })(),
    lastActivityAt: nonNegativeInteger(input.lastActivityAt, observedAt),
    pendingUserInput: input.pendingUserInput === true,
    pendingApproval: input.pendingApproval === true,
    pendingTool: input.pendingTool === true,
    pendingRetry: input.pendingRetry === true,
    receiptIds: list(input.receiptIds, MAX_ITEMS, 192),
    verification: ['pending', 'partial', 'verified', 'failed', 'unknown'].includes(
      input.verification,
    )
      ? input.verification
      : (() => {
          throw new Error('cao_snapshot_verification_invalid');
        })(),
    recentDelta: text(input.recentDelta, '', MAX_TEXT),
    errors: list(input.errors, MAX_ITEMS, 600),
    claims: list(input.claims, MAX_ITEMS, 600),
    contextRevision,
    milestone: text(input.milestone, 'unknown', 240),
    cursor: {
      targetRevision,
      contentHash,
      contextRevision,
      observedAt,
    },
  };
  return Object.freeze({
    ...snapshot,
    ownedPaths: Object.freeze(snapshot.ownedPaths),
    receiptIds: Object.freeze(snapshot.receiptIds),
    errors: Object.freeze(snapshot.errors),
    claims: Object.freeze(snapshot.claims),
    cursor: Object.freeze(snapshot.cursor),
  });
}
