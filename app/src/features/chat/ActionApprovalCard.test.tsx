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
  getApprovalStatus: vi.fn(),
  decideApproval: vi.fn(),
  executeApproval: vi.fn(),
  dispose: vi.fn(),
}));
const messageRepository = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/lib/jarvis/kernelClient', () => ({
  createJarvisKernelClient: () => kernelClient,
}));
vi.mock('@/lib/db/repositories', () => ({ messageRepo: messageRepository }));

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
    messageRepository.getById.mockResolvedValue({
      id: 'message_1',
      parts: [part('jarvisapproval:jappr_1')],
    });
    messageRepository.update.mockResolvedValue(undefined);
  });

  it('loads fresh protected details when a mounted card receives another approval', async () => {
    kernelClient.getApprovalPresentation.mockResolvedValueOnce({
      kind: 'approval_presentation',
      approvalId: 'jappr_2',
      actionId: 'schedule.create',
      expectedEffect: 'Create the replacement schedule.',
      risk: 'confirm',
      parameters: [],
    });
    const view = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'terminal.run',
      expectedEffect: 'Run the original command.',
      risk: 'dangerous',
      parameters: [],
    });
    view.rerender(
      <ActionApprovalCard
        part={part('jarvisapproval:jappr_2')}
        allParts={[part('jarvisapproval:jappr_2')]}
        messageId={'message_2' as never}
        chatId="chat_1"
      />,
    );
    expect(screen.queryByText('Run the original command.')).toBeNull();
    await screen.findByText('Create the replacement schedule.');
    expect(kernelClient.getApprovalPresentation).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_2',
    });
  });

  it('does not carry a submitted decision into a different protected request', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
      continuation: 'tool_request',
    });
    const presentation = {
      actionId: 'schedule.create',
      expectedEffect: 'Create one schedule.',
      risk: 'confirm' as const,
      parameters: [],
    };
    const view = renderCard(part('jarvisapproval:jappr_1'), presentation);
    fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));
    await waitFor(() => expect(kernelClient.dispose).toHaveBeenCalledOnce());
    view.rerender(
      <ActionApprovalCard
        part={part('jarvisapproval:jappr_2')}
        allParts={[part('jarvisapproval:jappr_2')]}
        messageId={'message_2' as never}
        chatId="chat_1"
        presentation={presentation}
      />,
    );
    expect((screen.getByRole('button', { name: 'Approve fixed action' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Deny action' }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.container.firstElementChild?.getAttribute('data-status')).toBe('pending');
  });

  it('returns an approved live tool decision to its waiting call without executing again or sending another turn', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
      continuation: 'tool_request',
    });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      const { container } = renderCard(part('jarvisapproval:jappr_1'), {
        actionId: 'schedule.create',
        expectedEffect: 'Create one fixed schedule.',
        risk: 'confirm',
        parameters: [],
      });
      fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));
      await waitFor(() => expect(kernelClient.dispose).toHaveBeenCalledOnce());
      expect(kernelClient.executeApproval).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(container.firstElementChild?.getAttribute('data-status')).toBe('running');
    } finally {
      window.removeEventListener('jarvis:send', send);
    }
  });

  it('denies only a waiting tool action without declaring the whole parent chat cancelled', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'denied',
      continuation: 'tool_request',
    });
    const state = vi.fn();
    window.addEventListener('jarvis:run-state', state);
    try {
      const { container } = renderCard(part('jarvisapproval:jappr_1'), {
        actionId: 'schedule.create',
        expectedEffect: 'Create one fixed schedule.',
        risk: 'confirm',
        parameters: [],
      });
      fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));
      await waitFor(() => expect(kernelClient.dispose).toHaveBeenCalledOnce());
      expect(kernelClient.executeApproval).not.toHaveBeenCalled();
      expect(state).not.toHaveBeenCalled();
      expect(container.firstElementChild?.getAttribute('data-status')).toBe('cancelled');
    } finally {
      window.removeEventListener('jarvis:run-state', state);
    }
  });

  it('retains a settled tool projection that arrives before its decision response', async () => {
    let answer!: (value: unknown) => void;
    kernelClient.decideApproval.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const presentation = {
      actionId: 'schedule.create',
      expectedEffect: 'Create fixed schedule.',
      risk: 'confirm' as const,
      parameters: [],
    };
    const actionPart = part('jarvisapproval:jappr_1');
    const view = renderCard(actionPart, presentation);
    fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));
    view.rerender(
      <ActionApprovalCard
        part={{ ...actionPart, status: 'success' }}
        allParts={[actionPart]}
        messageId={'message_1' as never}
        chatId="chat_1"
        presentation={presentation}
      />,
    );
    await waitFor(() =>
      expect(view.container.firstElementChild?.getAttribute('data-status')).toBe('success'),
    );
    answer({
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
      continuation: 'tool_request',
    });
    await waitFor(() => expect(kernelClient.dispose).toHaveBeenCalledOnce());
    expect(view.container.firstElementChild?.getAttribute('data-status')).toBe('success');
    expect(kernelClient.executeApproval).not.toHaveBeenCalled();
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
      continuation: 'waiting',
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

  it('continues the public chat run after a settled canonical action', async () => {
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
      continuation: 'ready',
    });
    const events: Array<{ chatId?: string; status?: string }> = [];
    const sends: Array<Record<string, unknown>> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<{ chatId?: string; status?: string }>).detail);
    };
    const sendListener = (event: Event) => {
      sends.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener('jarvis:run-state', listener);
    window.addEventListener('jarvis:send', sendListener);
    renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.read',
      expectedEffect: 'Read one approved file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve fixed action' }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(events).toContainEqual({ chatId: 'chat_1', status: 'running' });
    expect(events).not.toContainEqual({ chatId: 'chat_1', status: 'done' });
    expect(sends[0]).toMatchObject({
      chatId: 'chat_1',
      interactionMode: 'ask',
      approvalContinuation: {
        messageId: 'message_1',
        callId: 'jarvisapproval:jappr_1',
        approvalId: 'jappr_1',
      },
      runtimeSettings: { rlmEnabled: false },
    });
    window.removeEventListener('jarvis:run-state', listener);
    window.removeEventListener('jarvis:send', sendListener);
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
    expect(kernelClient.getApprovalStatus).not.toHaveBeenCalled();
    expect(kernelClient.executeApproval).not.toHaveBeenCalled();
  });

  it('persists a verified denial before releasing the run so remount cannot restore active controls', async () => {
    const deniedPart = part('jarvisapproval:jappr_1');
    const siblingPart = part('jarvisapproval:jappr_2');
    let persistedParts: Part[] = [
      { kind: 'text', text: 'One protected action requires review.' },
      deniedPart,
      siblingPart,
    ];
    const lifecycle: string[] = [];
    messageRepository.getById.mockImplementation(async () => ({
      id: 'message_1',
      parts: persistedParts,
    }));
    messageRepository.update.mockImplementation(async (_messageId, patch) => {
      persistedParts = patch.parts;
      lifecycle.push('persisted');
    });
    kernelClient.decideApproval.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'denied',
    });
    const onRunState = () => lifecycle.push('run-released');
    window.addEventListener('jarvis:run-state', onRunState);
    const rendered = renderCard(deniedPart, {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    await waitFor(() => expect(messageRepository.update).toHaveBeenCalledOnce());
    expect(messageRepository.update).toHaveBeenCalledWith('message_1', {
      parts: [
        { kind: 'text', text: 'One protected action requires review.' },
        expect.objectContaining({
          kind: 'action_proposal',
          call_id: 'jarvisapproval:jappr_1',
          status: 'cancelled',
        }),
        siblingPart,
      ],
    });
    await waitFor(() => expect(lifecycle).toEqual(['persisted', 'run-released']));

    rendered.unmount();
    const persistedDeniedPart = persistedParts[1] as Extract<Part, { kind: 'action_proposal' }>;
    const remounted = renderCard(persistedDeniedPart, {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });
    expect(remounted.container.firstElementChild?.getAttribute('data-status')).toBe('cancelled');
    expect(screen.queryByRole('button', { name: 'Approve fixed action' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny action' })).toBeNull();
    expect(kernelClient.decideApproval).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:run-state', onRunState);
  });

  it('keeps denial actionable and withholds public cancellation when persistence fails', async () => {
    messageRepository.update.mockRejectedValueOnce(new Error('disk unavailable'));
    kernelClient.decideApproval.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'denied',
    });
    const events: Array<{ chatId?: string; status?: string }> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<{ chatId?: string; status?: string }>).detail);
    };
    window.addEventListener('jarvis:run-state', listener);
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Approval decision could not be saved. Refresh protected state before retrying.',
    );
    expect(container.firstElementChild?.getAttribute('data-status')).toBe('pending');
    expect(
      (screen.getByRole('button', { name: 'Approve fixed action' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Deny action' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(events).toEqual([]);
    expect(messageRepository.update).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:run-state', listener);
  });

  it('reconciles an already-kernel-denied approval only after exact account-scoped status proof', async () => {
    const lifecycle: string[] = [];
    kernelClient.decideApproval.mockImplementationOnce(async () => {
      lifecycle.push('decide-unavailable');
      return {
        version: 1,
        kind: 'unavailable',
        requestKind: 'approval_decide',
        reason: 'invalid_response',
      };
    });
    kernelClient.getApprovalStatus.mockImplementationOnce(async () => {
      lifecycle.push('status-denied');
      return {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_1',
        status: 'denied',
      };
    });
    messageRepository.update.mockImplementationOnce(async () => {
      lifecycle.push('persisted');
    });
    const listener = () => lifecycle.push('run-released');
    window.addEventListener('jarvis:run-state', listener);
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-status')).toBe('cancelled'),
    );
    expect(kernelClient.getApprovalStatus).toHaveBeenCalledWith({
      accountId: 'account-smoke',
      approvalId: 'jappr_1',
    });
    expect(lifecycle).toEqual(['decide-unavailable', 'status-denied', 'persisted', 'run-released']);
    expect(kernelClient.executeApproval).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:run-state', listener);
  });

  it.each([
    [
      'missing',
      {
        version: 1,
        kind: 'unavailable',
        requestKind: 'approval_status',
        reason: 'kernel_not_activated',
      },
    ],
    [
      'pending',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_1',
        status: 'pending',
      },
    ],
    [
      'approved',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_1',
        status: 'approved',
      },
    ],
    [
      'consumed',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_1',
        status: 'consumed',
      },
    ],
    [
      'expired',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_1',
        status: 'expired',
      },
    ],
    [
      'mismatched account',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'different-account',
        approvalId: 'jappr_1',
        status: 'denied',
      },
    ],
    [
      'mismatched approval',
      {
        version: 1,
        kind: 'approval_state',
        accountId: 'account-smoke',
        approvalId: 'jappr_other',
        status: 'denied',
      },
    ],
  ])('keeps local denial actionable when status proof is %s', async (_label, statusResponse) => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      version: 1,
      kind: 'unavailable',
      requestKind: 'approval_decide',
      reason: 'invalid_response',
    });
    kernelClient.getApprovalStatus.mockResolvedValueOnce(statusResponse);
    const events: Array<{ chatId?: string; status?: string }> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<{ chatId?: string; status?: string }>).detail);
    };
    window.addEventListener('jarvis:run-state', listener);
    const { container } = renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Approval decision could not be verified. Refresh protected state before retrying.',
    );
    expect(container.firstElementChild?.getAttribute('data-status')).toBe('pending');
    expect(messageRepository.update).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(
      (screen.getByRole('button', { name: 'Deny action' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    window.removeEventListener('jarvis:run-state', listener);
  });

  it('does not reinterpret an approved deny response as a denied status retry', async () => {
    kernelClient.decideApproval.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_decided',
      approvalId: 'jappr_1',
      status: 'approved',
    });
    renderCard(part('jarvisapproval:jappr_1'), {
      actionId: 'files.create',
      expectedEffect: 'Create one protected file.',
      risk: 'confirm',
      parameters: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny action' }));

    await screen.findByRole('alert');
    expect(kernelClient.getApprovalStatus).not.toHaveBeenCalled();
    expect(messageRepository.update).not.toHaveBeenCalled();
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
