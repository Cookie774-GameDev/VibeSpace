import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { parseToolGatewayRequest } from './toolGatewayProtocol';
import {
  authorizeToolGatewayRequest,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  clearToolGatewayAuthorityForTests,
} from './toolGatewayAuthority';

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
});
