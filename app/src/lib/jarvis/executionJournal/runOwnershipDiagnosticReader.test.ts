import { describe, it, expect } from 'vitest';
import { createRunOwnershipDiagnosticReader } from './runOwnershipDiagnosticReader';
import { isKernelClientRequestV1, isKernelClientResponseV1, responseMatchesKernelRequest } from '../kernelBridgeProtocol';
const authority = { accountId: 'account', workspaceId: 'workspace', projectId: 'project', epoch: 1 };
const observation = () => ({ scope: { accountId: 'account', runId: 'jrun_fixture', workspaceId: 'workspace', projectId: 'project' },
  consistency: 'non_atomic_observation' as const, settlementAuthority: false as const,
  latestAttempt: { requestId: 'request', attemptNumber: 1 }, registry: null,
  journal: { tailSeq: 2, cancellationIntentSeqs: [2] }, approvals: [], terminals: [], queue: [],
  terminalRead: 'unavailable' as const, unknowns: ['cross_webview_owner_fence_unavailable'] });
describe('host-derived read-only diagnostic authority', () => {
  it('derives account and keeps unavailable owners explicit without settlement', async () => {
    const inspect = async (input: Readonly<{ accountId: string; runId: string }>) => { expect(input).toEqual({ accountId: 'account', runId: 'jrun_fixture' }); return observation(); };
    const result = await createRunOwnershipDiagnosticReader({ currentAuthority: () => authority, inspect })({ runId: 'jrun_fixture' });
    expect(result).toMatchObject({ settlementAuthority: false, cancellationIntentCount: 1, approvalCount: 0, pendingCancellation: null });
    expect(result?.unknowns).toContain('registry_owner_unavailable');
    expect(result).not.toHaveProperty('scope');
  });
  it('rejects caller-supplied account before inspection', async () => {
    let calls = 0; const read = createRunOwnershipDiagnosticReader({ currentAuthority: () => authority, inspect: async () => { calls++; return observation(); } });
    expect(await read(Object.assign({ runId: 'jrun_fixture' }, { accountId: 'foreign' }))).toBeUndefined(); expect(calls).toBe(0);
  });
  it('rejects foreign account/project observation', async () => {
    for (const scope of [{ ...observation().scope, accountId: 'foreign' }, { ...observation().scope, projectId: 'foreign' }]) {
      expect(await createRunOwnershipDiagnosticReader({ currentAuthority: () => authority, inspect: async () => ({ ...observation(), scope }) })({ runId: 'jrun_fixture' })).toBeUndefined();
    }
  });
  it('rejects account ABA even when lexical scope returns', async () => {
    let current = authority; const read = createRunOwnershipDiagnosticReader({ currentAuthority: () => current, inspect: async () => { current = { ...authority, accountId: 'foreign', epoch: 2 }; current = { ...authority, epoch: 3 }; return observation(); } });
    expect(await read({ runId: 'jrun_fixture' })).toBeUndefined();
  });
  it('rejects stale attempt or journal changed during the internal read', async () => {
    const read = createRunOwnershipDiagnosticReader({ currentAuthority: () => authority, inspect: async () => ({ ...observation(), consistency: 'changed_during_read' as const }) });
    expect(await read({ runId: 'jrun_fixture' })).toBeUndefined();
  });
  it('requires closed DTO and exact run correlation', async () => {
    const request = { version: 1 as const, kind: 'run_ownership_diagnostic' as const, runId: 'jrun_fixture' };
    expect(isKernelClientRequestV1(request)).toBe(true); expect(isKernelClientRequestV1({ ...request, accountId: 'foreign' })).toBe(false);
    const projected = await createRunOwnershipDiagnosticReader({ currentAuthority: () => authority, inspect: async () => observation() })({ runId: 'jrun_fixture' });
    const response = { version: 1 as const, kind: 'run_ownership_diagnostic' as const, ...projected! };
    expect(isKernelClientResponseV1(response)).toBe(true); expect(responseMatchesKernelRequest(request, response)).toBe(true);
    expect(responseMatchesKernelRequest({ ...request, runId: 'jrun_foreign' }, response)).toBe(false);
    expect(isKernelClientResponseV1({ ...response, settlementAuthority: true })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, root: 'private' })).toBe(false);
  });
});
