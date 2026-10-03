// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isKernelClientRequestV1, isKernelClientResponseV1, responseMatchesKernelRequest } from './kernelBridgeProtocol';
const request = { version: 1 as const, kind: 'run_ownership_diagnostic' as const, runId: 'jrun_fixture' };
const response = { ...request, accountId: 'account', authorityEpoch: 1, consistency: 'non_atomic_observation' as const,
  settlementAuthority: false as const, latestAttempt: { requestId: 'request', attemptNumber: 1 },
  ownerCount: 0, terminalCount: 0, queueCount: 0, cancellationIntentCount: 0, approvalCount: 0,
  pendingCancellation: null, terminalRead: 'unavailable' as const, unknowns: ['registry_owner_unavailable'] };
describe('orphan diagnostic closed DTO alongside R29 issued evidence', () => {
  it('accepts only an issued-format run ID without caller authority', () => {
    expect(isKernelClientRequestV1(request)).toBe(true);
    for (const field of ['accountId', 'root', 'authorityEpoch']) expect(isKernelClientRequestV1({ ...request, [field]: 'foreign' })).toBe(false);
    expect(isKernelClientRequestV1({ ...request, runId: '../foreign' })).toBe(false);
  });
  it('admits bounded read-only metadata while rejecting settlement and private fields', () => {
    expect(isKernelClientResponseV1(response)).toBe(true);
    expect(responseMatchesKernelRequest(request, response)).toBe(true);
    expect(responseMatchesKernelRequest(request, { ...response, runId: 'jrun_foreign' })).toBe(false);
    for (const field of ['ownerId', 'command', 'root', 'body']) expect(isKernelClientResponseV1({ ...response, [field]: 'private' })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, settlementAuthority: true })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, consistency: 'changed_during_read' })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, ownerCount: 101 })).toBe(false);
  });
  it('preserves membership and issued-evidence DTO semantics without whole-map freshness', () => {
    const membership = { version: 1 as const, kind: 'context_source_revision' as const, accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeHash: 'sha256:' + 'a'.repeat(64), chatId: 'chat', mapId: 'map', authorityEpoch: 1, sourceRevision: 'sha256:' + 'b'.repeat(64), membershipRevision: 'sha256:' + 'b'.repeat(64), revisionKind: 'map-membership' as const, wholeMapDiskFreshness: false as const, sourceCount: 0, verifiedBytes: 0 };
    const issued = { ...membership, binding: { runId: 'run', requestId: 'request', attemptNumber: 1 }, revisionKind: 'issued-evidence' as const, sourceRevision: 'sha256:' + 'c'.repeat(64), sourceCount: 1, verifiedBytes: 512 };
    expect(isKernelClientResponseV1(membership)).toBe(true);
    expect(isKernelClientResponseV1(issued)).toBe(true);
    expect(isKernelClientResponseV1({ ...issued, wholeMapDiskFreshness: true })).toBe(false);
    expect(isKernelClientResponseV1({ ...issued, verifiedBytes: 8 * 1024 * 1024 + 1 })).toBe(false);
    expect(isKernelClientResponseV1({ ...membership, sourceRevision: issued.sourceRevision })).toBe(false);
  });
});
