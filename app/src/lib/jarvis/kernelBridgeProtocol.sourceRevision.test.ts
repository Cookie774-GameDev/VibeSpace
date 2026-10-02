// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isKernelClientRequestV1, isKernelClientResponseV1, responseMatchesKernelRequest } from './kernelBridgeProtocol';
const request = { version: 1 as const, kind: 'context_source_revision' as const, accountId: 'account', chatId: 'chat', mapId: 'map' };
const binding = { runId: 'run', requestId: 'request', attemptNumber: 1 };
const response = { ...request, workspaceId: 'workspace', projectId: 'project', worktreeHash: 'sha256:' + 'a'.repeat(64), authorityEpoch: 1, sourceRevision: 'sha256:' + 'b'.repeat(64) };
describe('protected source-revision DTO', () => {
  it('allows pre-send scoped read without inventing run binding', () => {
    expect(isKernelClientRequestV1(request)).toBe(true);
    expect(isKernelClientResponseV1(response)).toBe(true);
    expect(responseMatchesKernelRequest(request, response)).toBe(true);
  });
  it('rejects caller-supplied physical path or project authority', () => {
    expect(isKernelClientRequestV1({ ...request, path: 'private' })).toBe(false);
    expect(isKernelClientRequestV1({ ...request, projectId: 'other' })).toBe(false);
  });
  it('rejects partial, null and invalid attempt bindings', () => {
    expect(isKernelClientRequestV1({ ...request, binding: { runId: 'run' } })).toBe(false);
    expect(isKernelClientRequestV1({ ...request, binding: null })).toBe(false);
    expect(isKernelClientRequestV1({ ...request, binding: { ...binding, attemptNumber: 0 } })).toBe(false);
  });
  it('matches exact account chat map run request attempt only', () => {
    const bound = { ...request, binding };
    expect(responseMatchesKernelRequest(bound, { ...response, binding })).toBe(true);
    expect(responseMatchesKernelRequest(bound, { ...response, binding: { ...binding, requestId: 'other' } })).toBe(false);
    expect(responseMatchesKernelRequest(request, { ...response, chatId: 'other' })).toBe(false);
    expect(responseMatchesKernelRequest(request, { ...response, mapId: 'other' })).toBe(false);
  });
  it('rejects timestamp substitutes or body-bearing responses', () => {
    expect(isKernelClientResponseV1({ ...response, sourceRevision: '2026-10-02' })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, body: 'private source' })).toBe(false);
    expect(isKernelClientResponseV1({ ...response, authorityEpoch: 0 })).toBe(false);
  });
});
