import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@/types/chat';
import { PermissionRequestCard } from './PermissionRequestCard';
import { useJarvisInteractionStore } from './sessionStore';

const repo = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  respondToApproval: vi.fn(),
  grantMutation: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  messageRepo: repo,
}));

vi.mock('@/lib/ai/adapters/opencodePersistent', () => ({
  respondToPersistentOpenCodeApproval: repo.respondToApproval,
}));

vi.mock('@/lib/harness/toolGatewayProduction', () => ({
  grantToolGatewayMutation: repo.grantMutation,
}));

const permissionPart: Extract<Part, { kind: 'permission_request' }> = {
  kind: 'permission_request',
  request: {
    id: 'perm_1',
    title: 'Write Composer mode chip',
    description: 'Jarvis wants to edit Composer.tsx.',
    risk: 'medium',
    action: 'write_file',
    targets: ['app/src/features/chat/Composer.tsx'],
    planId: 'plan_1',
    status: 'pending',
  },
};

const harnessPermissionPart: Extract<Part, { kind: 'permission_request' }> = {
  kind: 'permission_request',
  request: {
    ...permissionPart.request,
    id: 'approval-1',
    title: 'Write to terminal',
    action: 'run_command',
    targets: ['terminal:4'],
    harness: {
      protocol: 'opencode-approval-v1',
      chatId: 'chat_1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      workingDirectory: 'C:\\workspace',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      capability: 'terminal.write',
    },
  },
};

describe('PermissionRequestCard', () => {
  beforeEach(() => {
    repo.getById.mockReset();
    repo.update.mockReset();
    repo.respondToApproval.mockReset();
    repo.respondToApproval.mockResolvedValue(undefined);
    repo.grantMutation.mockReset();
    window.dispatchEvent = vi.fn();
    useJarvisInteractionStore.setState(useJarvisInteractionStore.getInitialState());
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [permissionPart],
    });
    repo.update.mockResolvedValue({});
  });

  function persist(part: Extract<Part, { kind: 'permission_request' }>) {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [part],
    });
  }

  it('approves a request once and dispatches permission context', async () => {
    render(
      <PermissionRequestCard part={permissionPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve once/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:send',
        detail: expect.objectContaining({
          structuredContext: expect.objectContaining({
            kind: 'permission_response',
            payload: expect.objectContaining({ status: 'approved' }),
          }),
        }),
      }),
    );
  });

  it('approves all safe changes for this plan', async () => {
    render(
      <PermissionRequestCard part={permissionPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve all safe changes/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(useJarvisInteractionStore.getState().hasPlanSafeApproval('chat_1' as never)).toBe(true);
  });

  it('denies a request without dispatching execution context', async () => {
    render(
      <PermissionRequestCard part={permissionPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Deny/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('adds an edited instruction and dispatches it to Jarvis', async () => {
    render(
      <PermissionRequestCard part={permissionPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Add instruction/i), {
      target: { value: 'Only touch the mode chip.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send instruction/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          text: expect.stringContaining('Only touch the mode chip.'),
        }),
      }),
    );
  });

  it.each([
    ['Approve once', 'approved', 'once'],
    ['Approve all safe changes', 'approved_plan', 'always'],
  ] as const)('maps %s to the exact OpenCode approval', async (button, _status, response) => {
    persist(harnessPermissionPart);
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: new RegExp(button, 'i') }));

    await waitFor(() =>
      expect(repo.respondToApproval).toHaveBeenCalledWith({
        sessionId: 'session-1',
        approvalId: 'approval-1',
        response,
        route: harnessPermissionPart.request.harness,
      }),
    );
    expect(repo.grantMutation).toHaveBeenCalledWith('session-1', 'terminal.write', response);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('recovers a native builtin approval without granting unrelated semantic tool authority', async () => {
    const part = { ...harnessPermissionPart, request: { ...harnessPermissionPart.request,
      harness: { ...harnessPermissionPart.request.harness!, capability: 'external_directory' },
    } };
    persist(part);
    repo.grantMutation.mockImplementation(() => { throw new Error('tool_gateway_authority_unavailable'); });
    render(<PermissionRequestCard part={part} messageId={'msg_1' as never} chatId="chat_1" />);
    fireEvent.click(screen.getByRole('button', { name: /Approve once/i }));
    await waitFor(() => expect(repo.respondToApproval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', approvalId: 'approval-1', response: 'once', route: part.request.harness,
    })));
    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(repo.grantMutation).not.toHaveBeenCalled();
  });

  it('rejects the exact OpenCode approval on deny', async () => {
    persist(harnessPermissionPart);
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Deny/i }));

    await waitFor(() =>
      expect(repo.respondToApproval).toHaveBeenCalledWith({
        sessionId: 'session-1',
        approvalId: 'approval-1',
        response: 'reject',
        route: harnessPermissionPart.request.harness,
      }),
    );
    expect(repo.grantMutation).not.toHaveBeenCalled();
  });

  it('rejects an edited OpenCode request before sending the narrowed instruction', async () => {
    persist(harnessPermissionPart);
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Add instruction/i), {
      target: { value: 'Use terminal 4 only.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send instruction/i }));

    await waitFor(() => expect(repo.respondToApproval).toHaveBeenCalled());
    expect(repo.respondToApproval.mock.invocationCallOrder[0]).toBeLessThan(
      (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(repo.respondToApproval).toHaveBeenCalledWith({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      response: 'reject',
      route: harnessPermissionPart.request.harness,
    });
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ text: expect.stringContaining('Use terminal 4 only.') }),
      }),
    );
  });

  it('renders exact approval identity and a distinct cancel action', () => {
    persist(harnessPermissionPart);
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );

    expect(screen.getByTestId('permission-request').getAttribute('data-approval-id')).toBe(
      'approval-1',
    );
    expect((screen.getByRole('button', { name: /^Cancel$/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('does not persist an approved status when the exact native reply fails', async () => {
    persist(harnessPermissionPart);
    repo.respondToApproval.mockRejectedValueOnce(
      new Error('OpenCode approval is no longer pending.'),
    );
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve once/i }));

    await screen.findByRole('alert');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('fails a stale persisted request closed before replying', async () => {
    persist({
      ...harnessPermissionPart,
      request: { ...harnessPermissionPart.request, status: 'denied' },
    });
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve once/i }));

    await screen.findByRole('alert');
    expect(repo.respondToApproval).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('cancels the exact pending approval and persists cancelled truth after native rejection', async () => {
    persist(harnessPermissionPart);
    render(
      <PermissionRequestCard
        part={harnessPermissionPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(repo.respondToApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          response: 'reject',
          route: harnessPermissionPart.request.harness,
        }),
      ),
    );
    expect(repo.update).toHaveBeenCalledWith(
      'msg_1',
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            request: expect.objectContaining({ status: 'cancelled' }),
          }),
        ],
      }),
    );
  });
});
