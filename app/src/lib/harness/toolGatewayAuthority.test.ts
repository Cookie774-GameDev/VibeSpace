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
  authorizeToolGatewayMutation,
  grantToolGatewayMutationForRequest,
  readToolGatewayObservedExecutionAuthority,
  readToolGatewayRequestSignal,
  readToolGatewaySessionAuthority,
  readToolGatewayTurnIdentity,
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

function writeRequest(
  sessionId: string,
  input: Readonly<{ requestId?: string; messageId?: string; terminal?: string; command?: string }> = {},
) {
  return parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: input.requestId ?? `write-request-${sessionId}`,
    sessionId,
    messageId: input.messageId ?? `write-message-${sessionId}`,
    tool: 'terminal.write',
    args: {
      terminal: input.terminal ?? 'tty-a',
      command: input.command ?? 'echo safe',
    },
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

  it('retains an immutable exact protected attempt for a bound tool request', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const protectedAttempt = { accountId: 'account-a', runId: 'run-a', requestId: 'provider-a', attemptNumber: 2 };
    expect(bindToolGatewaySessionAuthority('protected-session', claim, undefined, {
      requestId: 'provider-a', chatId: 'chat-a', protectedAttempt,
    })).toBe(true);
    protectedAttempt.runId = 'changed-after-binding';
    expect(readToolGatewayTurnIdentity('protected-session', 'provider-a')).toEqual({
      requestId: 'provider-a', chatId: 'chat-a', protectedAttempt: {
        accountId: 'account-a', runId: 'run-a', requestId: 'provider-a', attemptNumber: 2,
      },
    });
    expect(readToolGatewayTurnIdentity('protected-session', 'wrong-request')).toBeNull();
  });

  it.each([
    { accountId: 'foreign', runId: 'run-a', requestId: 'provider-a', attemptNumber: 1 },
    { accountId: 'account-a', runId: 'run-a', requestId: 'foreign-request', attemptNumber: 1 },
    { accountId: 'account-a', runId: '', requestId: 'provider-a', attemptNumber: 1 },
    { accountId: 'account-a', runId: 'run-a', requestId: 'provider-a', attemptNumber: 0 },
    { accountId: 'account-a', runId: 'run-a', requestId: 'provider-a', attemptNumber: 1.5 },
  ])('rejects a mismatched or malformed protected attempt: %j', (protectedAttempt) => {
    const claim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('invalid-protected', claim, undefined, {
      requestId: 'provider-a', chatId: 'chat-a', protectedAttempt,
    })).toBe(false);
    expect(readToolGatewayTurnIdentity('invalid-protected', 'provider-a')).toBeNull();
  });

  it('does not replace an already-bound protected attempt and revokes it on cancellation', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const controller = new AbortController();
    const turn = { requestId: 'provider-a', chatId: 'chat-a', protectedAttempt: {
      accountId: 'account-a', runId: 'run-a', requestId: 'provider-a', attemptNumber: 1,
    } };
    expect(bindToolGatewaySessionAuthority('protected-session', claim, controller.signal, turn)).toBe(true);
    expect(bindToolGatewaySessionAuthority('protected-session', claim, controller.signal, {
      ...turn, protectedAttempt: { ...turn.protectedAttempt, runId: 'run-b' },
    })).toBe(false);
    controller.abort();
    expect(readToolGatewayTurnIdentity('protected-session', 'provider-a')).toBeNull();
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

  it('binds a captured project claim after project navigation without accepting forged claims', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    useAuthStore.setState({ projectId: 'project-b' as ProjectId });

    expect(bindToolGatewaySessionAuthority('cold-session', claim)).toBe(true);
    expect(authorizeToolGatewayRequest(readRequest('cold-session'))).toBe(true);
    expect(readToolGatewaySessionAuthority('cold-session')?.scope.projectId).toBe('project-a');

    expect(
      bindToolGatewaySessionAuthority('forged-session', {
        ...claim,
        scope: { ...claim.scope, projectId: 'project-b' },
      }),
    ).toBe(false);
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

  it('keeps project-bound sessions alive across project navigation', () => {
    const sessionIds = Array.from({ length: 300 }, (_, index) => `session-${index}`);
    for (const sessionId of sessionIds) {
      expect(bindToolGatewaySessionAuthority(sessionId, captureToolGatewayAuthorityClaim()!)).toBe(
        true,
      );
    }

    useAuthStore.setState({ projectId: 'project-b' as ProjectId });

    for (const sessionId of sessionIds) {
      expect(authorizeToolGatewayRequest(readRequest(sessionId))).toBe(true);
    }
    expect(readToolGatewaySessionAuthority('session-0')?.scope.projectId).toBe('project-a');
  });

  it('does not reopen project-bound sessions after an account or workspace transition', () => {
    expect(
      bindToolGatewaySessionAuthority('stable-session', captureToolGatewayAuthorityClaim()!),
    ).toBe(true);

    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    expect(authorizeToolGatewayRequest(readRequest('stable-session'))).toBe(false);
    expect(readToolGatewaySessionAuthority('stable-session')).toBeNull();

    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    expect(authorizeToolGatewayRequest(readRequest('stable-session'))).toBe(false);
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

  it('exposes only the exact active request identity and clears it on abort or release', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const owner = new AbortController();
    const turn = { requestId: 'provider-request-a', chatId: 'chat-a' } as const;
    expect(bindToolGatewaySessionAuthority('turn-session', claim, owner.signal, turn)).toBe(true);
    expect(readToolGatewayTurnIdentity('turn-session', turn.requestId)).toEqual(turn);
    expect(readToolGatewayTurnIdentity('turn-session', 'provider-request-b')).toBeNull();
    expect(
      bindToolGatewaySessionAuthority('turn-session', claim, owner.signal, {
        ...turn,
        chatId: 'chat-b',
      }),
    ).toBe(false);

    owner.abort();
    expect(readToolGatewayTurnIdentity('turn-session', turn.requestId)).toBeNull();

    const releasedTurn = { requestId: 'provider-request-c', chatId: 'chat-c' } as const;
    expect(
      bindToolGatewaySessionAuthority('released-turn-session', claim, undefined, releasedTurn),
    ).toBe(true);
    expect(
      readToolGatewayTurnIdentity('released-turn-session', releasedTurn.requestId),
    ).toEqual(releasedTurn);
    releaseToolGatewaySessionAuthority('released-turn-session');
    expect(
      readToolGatewayTurnIdentity('released-turn-session', releasedTurn.requestId),
    ).toBeNull();
  });

  it('clears request identity across account/workspace authority transitions', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const turn = { requestId: 'provider-request-scope', chatId: 'chat-scope' } as const;
    expect(
      bindToolGatewaySessionAuthority('scope-turn-session', claim, undefined, turn),
    ).toBe(true);

    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    expect(readToolGatewayTurnIdentity('scope-turn-session', turn.requestId)).toBeNull();
    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    expect(readToolGatewayTurnIdentity('scope-turn-session', turn.requestId)).toBeNull();
  });

  it('accepts native OpenCode message IDs only on explicitly opted-in turns', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    const codexTurn = { requestId: 'jreq_codex', chatId: 'chat-codex' } as const;
    expect(bindToolGatewaySessionAuthority('codex-turn-session', claim, undefined, codexTurn)).toBe(true);
    expect(readToolGatewayTurnIdentity('codex-turn-session', 'jreq_codex')).toEqual(codexTurn);
    expect(readToolGatewayTurnIdentity('codex-turn-session', 'msg_tool_call')).toBeNull();

    const openCodeTurn = {
      requestId: 'jreq_opencode',
      chatId: 'chat-opencode',
      nativeToolMessageIds: true,
    } as const;
    expect(
      bindToolGatewaySessionAuthority('opencode-turn-session', claim, undefined, openCodeTurn),
    ).toBe(true);
    expect(readToolGatewayTurnIdentity('opencode-turn-session', 'jreq_opencode')).toEqual({
      requestId: 'jreq_opencode',
      chatId: 'chat-opencode',
    });
    expect(readToolGatewayTurnIdentity('opencode-turn-session', 'msg_tool_call')).toEqual({
      requestId: 'jreq_opencode',
      chatId: 'chat-opencode',
    });
    expect(readToolGatewayTurnIdentity('opencode-turn-session', 'message_tool_call')).toBeNull();
    expect(readToolGatewayTurnIdentity('opencode-turn-session', 'msg_')).toBeNull();
    expect(readToolGatewayTurnIdentity('opencode-turn-session', 'msg_tool call')).toBeNull();
  });

  it('binds a one-shot mutation grant to the exact terminal action and run call', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('mutation-session', claim)).toBe(true);
    const expected = writeRequest('mutation-session');
    const retargeted = writeRequest('mutation-session', { terminal: 'tty-b' });

    grantToolGatewayMutationForRequest(expected);
    expect(authorizeToolGatewayMutation(expected)).toBe(true);
    grantToolGatewayMutationForRequest(expected);
    expect(authorizeToolGatewayMutation(retargeted)).toBe(false);
    expect(authorizeToolGatewayMutation(expected)).toBe(false);
  });

  it('revokes an exact mutation grant on account/workspace loss and session release', () => {
    const claim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('mutation-scope', claim)).toBe(true);
    const expected = writeRequest('mutation-scope');
    grantToolGatewayMutationForRequest(expected);

    useAuthStore.setState({ projectId: 'project-b' as ProjectId });
    expect(authorizeToolGatewayMutation(expected)).toBe(false);

    useAuthStore.setState({ projectId: 'project-a' as ProjectId });
    grantToolGatewayMutationForRequest(expected);
    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    expect(authorizeToolGatewayMutation(expected)).toBe(false);

    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    expect(authorizeToolGatewayMutation(expected)).toBe(false);

    clearToolGatewayAuthorityForTests();
    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    const nextClaim = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('mutation-release', nextClaim)).toBe(true);
    const released = writeRequest('mutation-release');
    grantToolGatewayMutationForRequest(released);
    releaseToolGatewaySessionAuthority('mutation-release');
    expect(authorizeToolGatewayMutation(released)).toBe(false);
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

    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
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
