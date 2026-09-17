import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { parseToolGatewayRequest } from './toolGatewayProtocol';
import {
  authorizeToolGatewayRequest,
  bindToolGatewayObservedExecutionAuthority,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  clearToolGatewayAuthorityForTests,
  readToolGatewayObservedExecutionAuthority,
  readToolGatewayRequestSignal,
  releaseToolGatewaySessionAuthority,
} from './toolGatewayAuthority';

const observedIdentity = Object.freeze({
  transportConnectionId: 'opencode-cli',
  transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'opencode-go',
  upstreamModelId: 'deepseek-v4-flash-vision-exp',
  providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
  authBillingRoute: 'opencode-provider-session',
  effort: 'high',
  fastVariant: 'standard',
  catalogRevision: 'catalog-verified-7',
  observedProviderIdentity: 'opencode-go/deepseek-v4-flash-vision-exp',
});

function readRequest(sessionId: string) {
  return parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: `request-${sessionId}`,
    sessionId,
    messageId: `message-${sessionId}`,
    tool: 'app.getState',
    args: {},
  });
}

describe('tool gateway session authority', () => {
  beforeEach(() => {
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
    });
    clearToolGatewayAuthorityForTests();
  });

  it('rejects a session that was not bound when OpenCode created it', () => {
    expect(authorizeToolGatewayRequest(readRequest('unseen-session'))).toBe(false);
  });

  it('rejects a creation claim captured before an authority transition', () => {
    const claim = captureToolGatewayAuthorityClaim();
    expect(claim).not.toBeNull();

    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });

    expect(bindToolGatewaySessionAuthority('late-session', claim!)).toBe(false);
    expect(authorizeToolGatewayRequest(readRequest('late-session'))).toBe(false);
  });

  it('permanently retires a bound session after an authority transition', () => {
    expect(
      bindToolGatewaySessionAuthority('old-session', captureToolGatewayAuthorityClaim()!),
    ).toBe(true);
    expect(authorizeToolGatewayRequest(readRequest('old-session'))).toBe(true);

    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    expect(authorizeToolGatewayRequest(readRequest('old-session'))).toBe(false);
    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    expect(authorizeToolGatewayRequest(readRequest('old-session'))).toBe(false);

    expect(
      bindToolGatewaySessionAuthority('new-session', captureToolGatewayAuthorityClaim()!),
    ).toBe(true);
    expect(authorizeToolGatewayRequest(readRequest('new-session'))).toBe(true);
  });

  it('does not reopen retired sessions after more than the former tombstone capacity', () => {
    const sessionIds = Array.from({ length: 300 }, (_, index) => `session-${index}`);
    for (const sessionId of sessionIds) {
      expect(bindToolGatewaySessionAuthority(sessionId, captureToolGatewayAuthorityClaim()!)).toBe(
        true,
      );
    }

    useAuthStore.setState({ projectId: 'project-b' as ProjectId });

    for (const sessionId of sessionIds) {
      expect(authorizeToolGatewayRequest(readRequest(sessionId))).toBe(false);
    }
  });

  it('does not let another turn replace or remove a bound cancellation owner', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const owner = new AbortController();
    expect(bindToolGatewaySessionAuthority('owned-session', claim, owner.signal)).toBe(true);
    expect(bindToolGatewaySessionAuthority('owned-session', claim, owner.signal)).toBe(true);
    expect(bindToolGatewaySessionAuthority('owned-session', claim, new AbortController().signal)).toBe(false);
    expect(bindToolGatewaySessionAuthority('owned-session', claim)).toBe(false);
    const captured = readToolGatewayRequestSignal(readRequest('owned-session'));
    expect(captured).toBe(owner.signal);
    releaseToolGatewaySessionAuthority('owned-session');
    expect(readToolGatewayRequestSignal(readRequest('owned-session'))).toBeUndefined();
    owner.abort();
    expect(captured?.aborted).toBe(true);
    expect(bindToolGatewaySessionAuthority('owned-session', claim, owner.signal)).toBe(false);
    expect(bindToolGatewaySessionAuthority('owned-session', claim, new AbortController().signal)).toBe(true);
  });

  it('keeps execution identity unavailable until the exact session records an observation', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('observed-session', claim)).toBe(true);
    expect(readToolGatewayObservedExecutionAuthority('observed-session')).toBeNull();

    expect(
      bindToolGatewayObservedExecutionAuthority('observed-session', claim, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    expect(readToolGatewayObservedExecutionAuthority('observed-session')).toEqual({
      executionIdentity: observedIdentity,
      performance: 'quality',
      scopeRevision: 'observed-session:0',
    });
    expect(Object.isFrozen(readToolGatewayObservedExecutionAuthority('observed-session'))).toBe(
      true,
    );
    expect(
      Object.isFrozen(
        readToolGatewayObservedExecutionAuthority('observed-session')?.executionIdentity,
      ),
    ).toBe(true);
  });

  it('rejects malformed, selected-only, or mismatched execution identity claims', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('strict-session', claim)).toBe(true);
    expect(
      bindToolGatewayObservedExecutionAuthority('strict-session', claim, {
        executionIdentity: {
          ...observedIdentity,
          upstreamModelId: '',
        },
        performance: 'quality',
      }),
    ).toBe(false);
    expect(
      bindToolGatewayObservedExecutionAuthority(
        'strict-session',
        { ...claim, generation: claim.generation + 1 },
        { executionIdentity: observedIdentity, performance: 'quality' },
      ),
    ).toBe(false);
    expect(readToolGatewayObservedExecutionAuthority('strict-session')).toBeNull();
  });

  it('revokes observed identity on scope transition and erases it on release', () => {
    const firstClaim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('first-session', firstClaim)).toBe(true);
    expect(
      bindToolGatewayObservedExecutionAuthority('first-session', firstClaim, {
        executionIdentity: observedIdentity,
        performance: 'balanced',
      }),
    ).toBe(true);

    useAuthStore.setState({ projectId: 'project-b' as ProjectId });
    expect(readToolGatewayObservedExecutionAuthority('first-session')).toBeNull();

    const secondClaim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('second-session', secondClaim)).toBe(true);
    expect(
      bindToolGatewayObservedExecutionAuthority('second-session', secondClaim, {
        executionIdentity: observedIdentity,
        performance: 'responsive',
      }),
    ).toBe(true);
    releaseToolGatewaySessionAuthority('second-session');
    expect(readToolGatewayObservedExecutionAuthority('second-session')).toBeNull();
  });
});
