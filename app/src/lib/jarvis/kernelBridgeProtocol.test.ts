import { describe, expect, it } from 'vitest';
import {
  KERNEL_BRIDGE_VERSION,
  isKernelClientRequestV1,
  isKernelClientResponseV1,
  isKernelClientResponseEvent,
  isKernelHostRequestEvent,
  responseMatchesKernelRequest,
  unavailableKernelResponse,
  type KernelClientRequestV1,
} from './kernelBridgeProtocol';

const turnRequest: KernelClientRequestV1 = {
  version: 1,
  kind: 'turn_dispatch',
  accountId: 'account-1',
  chatId: 'chat-1',
  userMessageId: 'message-1',
};

describe('kernel bridge protocol', () => {
  it('accepts only the explicit same-tool-request approval continuation marker', () => {
    const response = {
      version: 1,
      kind: 'approval_decided',
      approvalId: 'jappr_tool',
      status: 'approved',
    };
    expect(isKernelClientResponseV1({ ...response, continuation: 'tool_request' })).toBe(true);
    expect(isKernelClientResponseV1({ ...response, continuation: 'new_turn' })).toBe(false);
    expect(
      isKernelClientResponseV1({ ...response, continuation: 'tool_request', execute: true }),
    ).toBe(false);
  });
  it('accepts only the closed versioned request union', () => {
    expect(KERNEL_BRIDGE_VERSION).toBe(1);
    expect(isKernelClientRequestV1(turnRequest)).toBe(true);
    expect(
      isKernelClientRequestV1({
        ...turnRequest,
        targetLabel: 'pet-overlay',
      }),
    ).toBe(false);
    expect(
      isKernelClientRequestV1({
        version: 1,
        kind: 'invoke',
        method: 'credential_get',
      }),
    ).toBe(false);
    expect(isKernelClientRequestV1({ ...turnRequest, version: 2 })).toBe(false);
  });

  it.each<KernelClientRequestV1>([
    turnRequest,
    {
      version: 1,
      kind: 'approval_create',
      accountId: 'account-1',
      runId: 'run-1',
      actionRequestId: 'action-request-1',
    },
    {
      version: 1,
      kind: 'approval_present',
      accountId: 'account-1',
      approvalId: 'approval-1',
    },
    {
      version: 1,
      kind: 'approval_status',
      accountId: 'account-1',
      approvalId: 'approval-1',
    },
    {
      version: 1,
      kind: 'approval_decide',
      accountId: 'account-1',
      approvalId: 'approval-1',
      decision: 'approve',
    },
    {
      version: 1,
      kind: 'approval_execute',
      accountId: 'account-1',
      approvalId: 'approval-1',
    },
    { version: 1, kind: 'cancel', accountId: 'account-1', runId: 'run-1' },
    {
      version: 1,
      kind: 'scheduled_retry',
      accountId: 'account-1',
      runId: 'run-1',
      attemptId: 'attempt-2',
    },
    { version: 1, kind: 'command_center_snapshot', accountId: 'account-1' },
  ])('accepts exact $kind fields without authority-bearing payloads', (request) => {
    expect(isKernelClientRequestV1(request)).toBe(true);
    expect(JSON.stringify(request)).not.toMatch(
      /ownerToken|credential|secret|journal|evidence|receipt|lease|targetLabel|method/i,
    );
  });

  it('matches only the response union associated with the request kind', () => {
    expect(
      responseMatchesKernelRequest(turnRequest, {
        version: 1,
        kind: 'turn_accepted',
        runId: 'run-1',
      }),
    ).toBe(true);
    expect(
      responseMatchesKernelRequest(turnRequest, {
        version: 1,
        kind: 'cancellation_state',
        runId: 'run-1',
        state: 'delivered',
      }),
    ).toBe(false);
    expect(
      responseMatchesKernelRequest(
        turnRequest,
        unavailableKernelResponse(turnRequest, 'host_unavailable'),
      ),
    ).toBe(true);
  });

  it('accepts only bounded canonical approval presentations with no raw payload', () => {
    const request = {
      version: 1 as const,
      kind: 'approval_present' as const,
      accountId: 'account-1',
      approvalId: 'approval-1',
    };
    const response = {
      version: 1 as const,
      kind: 'approval_presentation' as const,
      approvalId: 'approval-1',
      actionId: 'terminal.create',
      expectedEffect: 'Create one terminal owned by the active account.',
      risk: 'confirm' as const,
      parameters: [{ field: 'cwd', safeValue: '[redacted]' }],
    };

    expect(isKernelClientRequestV1(request)).toBe(true);
    expect(isKernelClientResponseV1(response)).toBe(true);
    expect(responseMatchesKernelRequest(request, response)).toBe(true);
    expect(isKernelClientResponseV1({ ...response, params: { cwd: 'raw-secret' } })).toBe(false);
    expect(
      isKernelClientResponseV1({
        ...response,
        parameters: Array.from({ length: 33 }, (_, index) => ({
          field: `field-${index}`,
          safeValue: 'bounded',
        })),
      }),
    ).toBe(false);
    expect(responseMatchesKernelRequest({ ...request, approvalId: 'other' }, response)).toBe(false);
  });

  it('binds correlated response identifiers to the exact request', () => {
    const approvalStatusRequest: KernelClientRequestV1 = {
      version: 1,
      kind: 'approval_status',
      accountId: 'account-1',
      approvalId: 'approval-1',
    };
    const deniedState = {
      version: 1 as const,
      kind: 'approval_state' as const,
      accountId: 'account-1',
      approvalId: 'approval-1',
      status: 'denied' as const,
    };
    expect(isKernelClientResponseV1(deniedState)).toBe(true);
    expect(responseMatchesKernelRequest(approvalStatusRequest, deniedState)).toBe(true);
    expect(
      responseMatchesKernelRequest(approvalStatusRequest, {
        ...deniedState,
        accountId: 'different-account',
      }),
    ).toBe(false);
    expect(
      responseMatchesKernelRequest(approvalStatusRequest, {
        ...deniedState,
        approvalId: 'different-approval',
      }),
    ).toBe(false);
    for (const status of ['pending', 'approved', 'denied', 'expired', 'consumed'] as const) {
      expect(isKernelClientResponseV1({ ...deniedState, status })).toBe(true);
    }
    expect(isKernelClientResponseV1({ ...deniedState, status: 'missing' })).toBe(false);
    expect(isKernelClientResponseV1({ ...deniedState, rawApproval: {} })).toBe(false);

    const cancelRequest: KernelClientRequestV1 = {
      version: 1,
      kind: 'cancel',
      accountId: 'account-1',
      runId: 'run-1',
    };
    expect(
      responseMatchesKernelRequest(cancelRequest, {
        version: 1,
        kind: 'cancellation_state',
        runId: 'different-run',
        state: 'delivered',
      }),
    ).toBe(false);

    const commandCenterRequest: KernelClientRequestV1 = {
      version: 1,
      kind: 'command_center_snapshot',
      accountId: 'account-1',
    };
    expect(
      responseMatchesKernelRequest(commandCenterRequest, {
        version: 1,
        kind: 'command_center_snapshot',
        accountId: 'different-account',
        runs: [],
      }),
    ).toBe(false);
  });

  it('validates host/client event envelopes and rejects arbitrary fields', () => {
    const hostEvent = { epoch: 4, requestId: 'kreq-4-1', request: turnRequest };
    expect(isKernelHostRequestEvent(hostEvent)).toBe(true);
    expect(isKernelHostRequestEvent({ ...hostEvent, ownerToken: 'must-not-cross' })).toBe(false);

    const clientEvent = {
      epoch: 4,
      requestId: 'kreq-4-1',
      response: { version: 1, kind: 'turn_accepted', runId: 'run-1' },
    };
    expect(isKernelClientResponseEvent(clientEvent)).toBe(true);
    expect(isKernelClientResponseEvent({ ...clientEvent, targetLabel: 'main' })).toBe(false);
  });

  it('rejects accessor-backed input without invoking the accessor', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expect(isKernelClientRequestV1(input)).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects object-backed enum values without invoking coercion hooks', () => {
    let coercions = 0;
    const status = {
      toString: () => {
        coercions += 1;
        return 'running';
      },
    };

    expect(
      isKernelClientResponseEvent({
        epoch: 4,
        requestId: 'kreq-4-1',
        response: {
          version: 1,
          kind: 'command_center_snapshot',
          accountId: 'account-1',
          runs: [{ runId: 'run-1', status, hasActiveEvidence: true }],
        },
      }),
    ).toBe(false);
    expect(coercions).toBe(0);
  });
});
