import type { JarvisPermissionStatus } from '@/features/jarvis-interaction/types';

const MAX_APPROVALS = 256;
const statuses = new Map<string, JarvisPermissionStatus>();

function key(sessionId: string, approvalId: string): string {
  return `${sessionId}\0${approvalId}`;
}

export function recordOpenCodeApprovalStatus(
  sessionId: string,
  approvalId: string,
  status: JarvisPermissionStatus,
): void {
  const approvalKey = key(sessionId, approvalId);
  statuses.delete(approvalKey);
  statuses.set(approvalKey, status);
  while (statuses.size > MAX_APPROVALS) {
    const oldest = statuses.keys().next().value as string | undefined;
    if (!oldest) break;
    statuses.delete(oldest);
  }
}

export function readOpenCodeApprovalStatus(
  sessionId: string,
  approvalId: string,
): JarvisPermissionStatus | undefined {
  return statuses.get(key(sessionId, approvalId));
}

export function clearOpenCodeApprovalStatuses(): void {
  statuses.clear();
}
