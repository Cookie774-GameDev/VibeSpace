// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isKernelClientRequestV1, isKernelClientResponseV1, responseMatchesKernelRequest } from './kernelBridgeProtocol';
const request = { version: 1 as const, kind: 'context_source_revision' as const, accountId: 'account', chatId: 'chat', mapId: 'map' };
const binding = { runId: 'run', requestId: 'request', attemptNumber: 1 };
const response = { ...request, workspaceId: 'workspace', projectId: 'project', worktreeHash: 'sha256:' + 'a'.repeat(64), authorityEpoch: 1, sourceRevision: 'sha256:' + 'b'.repeat(64) };
describe('protected source-revision DTO', () => {
  it('matches reader ASCII 200-character boundaries for source scope and bindings', () => {
    for (const field of ['accountId', 'chatId', 'mapId']) {
      expect(isKernelClientRequestV1({ ...request, [field]: 'a'.repeat(200) })).toBe(true);
      for (const invalid of ['a'.repeat(201), 'é'.repeat(100), ' account', '_account', 'a b', 'a\nb']) {
        expect(isKernelClientRequestV1({ ...request, [field]: invalid })).toBe(false);
      }
    }
    for (const field of ['runId', 'requestId']) {
      expect(isKernelClientRequestV1({ ...request, binding: { ...binding, [field]: 'a'.repeat(200) } })).toBe(true);
      for (const invalid of ['a'.repeat(201), 'é'.repeat(100), '_request', 'a b', 'a\nb']) {
        expect(isKernelClientRequestV1({ ...request, binding: { ...binding, [field]: invalid } })).toBe(false);
      }
    }
    for (const field of ['accountId', 'workspaceId', 'projectId', 'chatId', 'mapId']) {
      expect(isKernelClientResponseV1({ ...response, [field]: 'a'.repeat(200) })).toBe(true);
      for (const invalid of ['a'.repeat(201), 'é'.repeat(100), '_scope', 'a b', 'a\nb']) {
        expect(isKernelClientResponseV1({ ...response, [field]: invalid })).toBe(false);
      }
    }
  });
  it('preserves the legacy 512-character identifier contract on other methods', () => {
    expect(isKernelClientRequestV1({ version: 1, kind: 'command_center_snapshot', accountId: 'a'.repeat(512) })).toBe(true);
    expect(isKernelClientRequestV1({ version: 1, kind: 'command_center_snapshot', accountId: 'a'.repeat(513) })).toBe(false);
  });
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
