import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Part } from '@/types/chat';
import { useAuthStore } from '@/stores/auth';
import {
  ActionApprovalCard,
  actionStatusForCanonicalExecution,
  createCanonicalApprovalCardController,
} from './ActionApprovalCard';

vi.mock('@/lib/actions', () => ({
  resolveAction: vi.fn(() => ({ id: 'terminal.run', label: 'Run command' })),
}));
vi.mock('@/lib/jarvis/smoke/config', () => ({ isKernelSmokeEnabled: () => true }));
const kernelClient = vi.hoisted(() => ({
  getApprovalPresentation: vi.fn(),
  decideApproval: vi.fn(),
  executeApproval: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@/lib/jarvis/kernelClient', () => ({
  createJarvisKernelClient: () => kernelClient,
}));

function part(callId: string): Extract<Part, { kind: 'action_proposal' }> {
  return {
    kind: 'action_proposal',
    call_id: callId,
    action_id: 'terminal.run',
    params: { command: 'raw-secret-command' },
    rationale: 'Unbounded legacy rationale',
    status: 'pending',
  };
}

function renderCard(
  actionPart: Extract<Part, { kind: 'action_proposal' }>,
  presentation?: {
    actionId: string;
    expectedEffect: string;
    risk: 'safe' | 'confirm' | 'dangerous';
    parameters: readonly { field: string; safeValue: string }[];
  },
) {
  return render(
    <ActionApprovalCard
      part={actionPart}
      allParts={[actionPart]}
      messageId={'message_1' as never}
      chatId="chat_1"
      presentation={presentation}
    />,
  );
}

describe('ActionApprovalCard canonical adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ localUserId: 'account-smoke', cloudSession: null });
  });

  it('renders historical cards as view-only without raw params or execution controls', () => {
    const { container } = renderCard(part('jarvisrun:legacy:step'));

    expect(screen.getByText(/historical action card is view-only/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('raw-secret-command')).toBeNull();
    expect(screen.queryByText('Unbounded legacy rationale')).toBeNull();
    expect(container.firstElementChild?.getAttribute('data-approval-kind')).toBe('legacy');
  });

  it('renders only bounded canonical presentation data', () => {
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'terminal.run',
      expectedEffect: 'Run the approved test command.',
      risk: 'confirm',
      parameters: [{ field: 'command', safeValue: '[redacted]' }],
    });

    expect(screen.getByText('Run the approved test command.')).toBeTruthy();
    expect(screen.getByText('[redacted]')).toBeTruthy();
    expect(screen.queryByText('raw-secret-command')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve fixed action' })).toBeTruthy();
    expect(container.firstElementChild?.getAttribute('data-approval-kind')).toBe('canonical');
    expect(container.firstElementChild?.getAttribute('data-sik-evidence')).toBe('approval.card');
    expect(container.querySelectorAll('[data-sik-evidence="approval.card"]')).toHaveLength(1);
  });

  it('routes production confirmation through the canonical kernel client and projects readback', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
    });
    kernelClient.executeApproval.mockResolvedValueOnce({
      kind: 'approval_execution',
      approvalId: 'jappr_1',
      runId: 'jrun_1',
      status: 'running',
    });
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'terminal.create',
      expectedEffect: 'Create one fixed terminal.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));

    await waitFor(() => expect(kernelClient.executeApproval).toHaveBeenCalledOnce());
    expect(kernelClient.decideApproval).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_1',
      decision: 'approve',
    });
    expect(kernelClient.executeApproval).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_1',
    });
    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-status')).toBe('running'),
    );
    expect(kernelClient.dispose).toHaveBeenCalledOnce();
  });

  it('releases the public chat run after a settled canonical action', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
    });
    kernelClient.executeApproval.mockResolvedValueOnce({
      kind: 'approval_execution',
      approvalId: 'jappr_1',
      runId: 'jrun_1',
      status: 'completed',
    });
    const events: Array<{ chatId?: string; status?: string }> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<{ chatId?: string; status?: string }>).detail);
    };
    window.addEventListener('jarvis:run-state', listener);
    renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.read',
      expectedEffect: 'Read one approved file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));

    await waitFor(() =>
      expect(events).toContainEqual({ chatId: 'chat_1', status: 'done' }),
    );
    window.removeEventListener('jarvis:run-state', listener);
  });

  it('loads the bounded canonical presentation before exposing production controls', async () => {
    kernelClient.getApprovalPresentation.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_presentation',
      approvalId: 'jappr_1',
      actionId: 'terminal.create',
      expectedEffect: 'Create one protected terminal.',
      risk: 'confirm',
      parameters: [{ field: 'token', safeValue: '[redacted]' }],
    });

    renderCard(part('jarvisapproval:jappr_1'));

    expect(screen.queryByRole('button', { name: 'Approve fixed action' })).toBeNull();
    await waitFor(() => expect(screen.getByText('Create one protected terminal.')).toBeTruthy());
    expect(screen.getByText('[redacted]')).toBeTruthy();
    expect(screen.queryByText('raw-secret-command')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve fixed action' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny action' })).toBeTruthy();
    expect(kernelClient.getApprovalPresentation).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_1',
    });
    const card = screen.getByRole('group', { name: 'terminal.create' });
    expect(card.getAttribute('data-approval-id')).toBe('jappr_1');
    expect(card.getAttribute('tabindex')).toBe('-1');
  });

  it('exposes only the bounded smoke failure reason when presentation readback fails', async () => {
    kernelClient.getApprovalPresentation.mockResolvedValueOnce({
      version: 1,
      kind: 'unavailable',
      requestKind: 'approval_present',
      reason: 'request_timed_out',
    });

    const { container } = renderCard(part('jarvisapproval:jappr_1'));

    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-presentation-state')).toBe('failed'),
    );
    expect(container.firstElementChild?.getAttribute('data-presentation-code')).toBe(
      'request_timed_out',
    );
    expect(container.innerHTML).not.toContain('raw-secret-command');
    expect(container.innerHTML).not.toContain('Error:');
  });

  it('denies through canonical readback without executing and projects cancellation', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'denied',
    });
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'terminal.create',
      expectedEffect: 'Create one protected terminal.',
      risk: 'confirm',
      parameters: [],
    });

    const events: Array<{ chatId?: string; status?: string }> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<{ chatId?: string; status?: string }>).detail);
    };
    window.addEventListener('jarvis:run-state', listener);
    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-status')).toBe('cancelled'),
    );
    expect(events).toContainEqual({ chatId: 'chat_1', status: 'cancelled' });
    window.removeEventListener('jarvis:run-state', listener);
    expect(kernelClient.decideApproval).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_1',
      decision: 'deny',
    });
    expect(kernelClient.executeApproval).not.toHaveBeenCalled();
  });

  it('uses canonical decide readback before execution and preserves handoff truth', async () => {
    const parentRun = { id: 'jrun_1', accountId: 'account-a' } as never;
    const approved = { id: 'jappr_1', runId: 'jrun_1', status: 'approved' } as never;
    const decide = vi.fn(async () => ({ kind: 'committed' as const, value: approved }));
    const execute = vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        kind: 'handoff_pending' as const,
        executorKind: 'terminal' as const,
        ownerId: 'approval:jappr_1',
        result: { ok: true as const, summary: 'Execution handed off' },
      },
    }));
    const controller = createCanonicalApprovalCardController({ decide, execute } as never);

    await expect(
      controller.approve({
        parentRun,
        callId: 'jarvisapproval:jappr_1',
        context: { source: 'user' },
      }),
    ).resolves.toEqual({
      kind: 'committed',
      value: expect.objectContaining({ kind: 'handoff_pending' }),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      actionStatusForCanonicalExecution({
        kind: 'handoff_pending',
        executorKind: 'terminal',
        ownerId: 'approval:jappr_1',
        result: { ok: true, summary: 'Execution handed off' },
      }),
    ).toBe('queued');
  });

  it('rejects mismatched deny readback and historical calls', async () => {
    const parentRun = { id: 'jrun_1', accountId: 'account-a' } as never;
    const decide = vi.fn(async () => ({
      kind: 'committed' as const,
      value: { id: 'jappr_other', runId: 'jrun_1', status: 'pending' } as never,
    }));
    const execute = vi.fn();
    const controller = createCanonicalApprovalCardController({ decide, execute } as never);

    await expect(controller.deny({ parentRun, callId: 'jarvisapproval:jappr_1' })).resolves.toEqual(
      { kind: 'approval_state_mismatch' },
    );
    await expect(controller.deny({ parentRun, callId: 'jarvisrun:legacy:step' })).resolves.toEqual({
      kind: 'invalid_approval_call',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops approve-all at the first failed canonical execution', async () => {
    const parentRun = { id: 'jrun_1', accountId: 'account-a' } as never;
    const decide = vi.fn(async ({ approvalId }: { approvalId: string }) => ({
      kind: 'committed' as const,
      value: { id: approvalId, runId: 'jrun_1', status: 'approved' } as never,
    }));
    const execute = vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        kind: 'settled' as const,
        result: { ok: false as const, error: 'stale_capability' },
      },
    }));
    const controller = createCanonicalApprovalCardController({ decide, execute } as never);

    const outcomes = await controller.approveAll([
      { parentRun, callId: 'jarvisapproval:jappr_1', context: { source: 'user' as const } },
      { parentRun, callId: 'jarvisapproval:jappr_2', context: { source: 'user' as const } },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(decide).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
