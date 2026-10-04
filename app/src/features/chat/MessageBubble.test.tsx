import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Message } from '@/types';
import { MessageBubble } from './MessageBubble';

afterEach(cleanup);

function message(role: Message['role'], parts: Message['parts']): Message {
  return {
    id: 'message-ledger-bubble' as Message['id'],
    chat_id: 'chat-ledger-bubble' as Message['chat_id'],
    role,
    parts,
    created_at: 100,
    updated_at: 200,
  };
}

describe('MessageBubble assistant activity ledger', () => {
  it('renders continuation content without a second identity and preserves response details', () => {
    const rendered = render(
      <TooltipProvider>
        <MessageBubble
          message={{
            ...message('assistant', [{ kind: 'text', text: 'Continuation content' }]),
            usage: { model: 'openai/gpt-6.1-sol', execution: { mode: 'normal' } },
          }}
          showIdentity={false}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText('Assistant')).toBeNull();
    expect(screen.getByText('Continuation content')).toBeTruthy();
    expect(screen.getByText('Response details')).toBeTruthy();
    expect(rendered.container.querySelector('[data-message-actions]')).toBeTruthy();
  });
  it.each([{ parts: [] }, { parts: [{ kind: 'text' as const, text: '  ' }] }])('hides an empty assistant placeholder: %j', ({ parts }) => {
    const rendered = render(<TooltipProvider><MessageBubble message={message('assistant', parts)} /></TooltipProvider>);
    expect(rendered.container.textContent).toBe('');
    expect(rendered.container.querySelector('[data-message-actions]')).toBeNull();
  });

  it('keeps one assistant identity and replaces raw tool evidence with the safe collapsed ledger', () => {
    render(
      <TooltipProvider>
        <MessageBubble
          message={message('assistant', [
            { kind: 'text', text: 'I checked the project.' },
            {
              kind: 'tool_call',
              call_id: 'call-1',
              tool: 'terminal.exec',
              args: { command: 'echo private-command' },
            },
            {
              kind: 'tool_result',
              call_id: 'call-1',
              result: { stdout: 'private-output', exitCode: 0 },
            },
          ])}
        />
      </TooltipProvider>,
    );

    expect(screen.getAllByText('Assistant')).toHaveLength(1);
    expect(screen.getByText('I checked the project.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /show activity details/i })).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-command');
    expect(document.body.textContent).not.toContain('private-output');
  });

  it('does not mount an assistant ledger in a user turn', () => {
    const rendered = render(
      <TooltipProvider>
        <MessageBubble message={message('user', [{ kind: 'text', text: 'hello' }])} />
      </TooltipProvider>,
    );
    expect(rendered.container.querySelector('[data-assistant-activity-ledger]')).toBeNull();
  });

  it('does not erase an unknown assistant tool when consolidating raw tool cards', () => {
    render(
      <TooltipProvider>
        <MessageBubble
          message={message('assistant', [
            {
              kind: 'tool_call',
              call_id: 'unknown-1',
              tool: 'custom.private_tool',
              args: { payload: 'hidden-payload' },
            },
            { kind: 'tool_result', call_id: 'unknown-1', result: 'hidden-result' },
          ])}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: /show activity details/i })).toBeTruthy();
    expect(screen.getByText('Worked for <1s · 1 action')).toBeTruthy();
    expect(document.body.textContent).not.toContain('hidden-payload');
    expect(document.body.textContent).not.toContain('hidden-result');
  });

  it('replaces a settled generic action card with the compact safe receipt ledger', () => {
    const rendered = render(
      <TooltipProvider>
        <MessageBubble
          message={message('assistant', [
            { kind: 'text', text: 'The file update completed.' },
            {
              kind: 'action_proposal',
              call_id: 'edit-call-1',
              action_id: 'files.edit',
              params: {
                path: 'C:\\private\\project\\brief.md',
                content: 'private replacement content',
              },
              rationale: 'private raw rationale',
              status: 'success',
            },
          ])}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText('The file update completed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /show activity details/i })).toBeTruthy();
    expect(rendered.container.querySelector('[data-action-id="files.edit"]')).toBeNull();
    expect(document.body.textContent).not.toContain('private replacement content');
    expect(document.body.textContent).not.toContain('private raw rationale');
    expect(document.body.textContent).not.toContain('C:\\private\\project');
  });

  it('keeps a settled plugin action as the compact provider card', () => {
    render(
      <TooltipProvider>
        <MessageBubble
          message={message('assistant', [
            {
              kind: 'action_proposal',
              call_id: 'github-plugin-call',
              action_id: 'github.identity',
              params: {},
              status: 'success',
            },
          ])}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText('GitHub plugin activity')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
  });
});


const protectedHost = vi.hoisted(() => ({
  expireInstalledJarvisApproval: vi.fn(), getApprovalPresentation: vi.fn(),
  getApprovalStatus: vi.fn(), decideApproval: vi.fn(), executeApproval: vi.fn(), dispose: vi.fn(),
}));
vi.mock('@/lib/ai/runtime', () => ({ expireInstalledJarvisApproval: protectedHost.expireInstalledJarvisApproval }));
vi.mock('@/lib/jarvis/kernelClient', () => ({ createJarvisKernelClient: () => protectedHost }));

describe('MessageBubble canonical terminal approval history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ localUserId: 'account-smoke', cloudSession: null });
    protectedHost.getApprovalPresentation.mockResolvedValue({
      kind: 'approval_presentation', approvalId: 'jappr_1', actionId: 'schedule.create',
      expectedEffect: 'Create one disposable schedule.', risk: 'confirm', parameters: [],
    });
  });
  function renderProposal(callId: string, status: 'pending' | 'cancelled') {
    return render(<TooltipProvider><MessageBubble message={message('assistant', [
      { kind: 'text', text: 'The task was prepared and awaiting approval.' },
      { kind: 'action_proposal', call_id: callId, action_id: 'schedule.create', params: {}, status },
    ])} /></TooltipProvider>);
  }
  it('renders the native expired cancelled proposal on history reload through actual protected card readback', async () => {
    protectedHost.expireInstalledJarvisApproval.mockResolvedValue({ approvalId: 'jappr_1', status: 'expired', expiresAt: Date.now() - 1 });
    const view = renderProposal('jarvisapproval:jappr_1', 'cancelled');
    await screen.findByText(/Approval expired. The action was not run/);
    expect(view.container.querySelector('[data-approval-id="jappr_1"][data-status="cancelled"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve fixed action' })).toBeNull();
    expect(protectedHost.decideApproval).not.toHaveBeenCalled();
    expect(protectedHost.executeApproval).not.toHaveBeenCalled();
  });
  it('keeps a genuinely pending canonical approval visible with protected review controls', async () => {
    protectedHost.expireInstalledJarvisApproval.mockResolvedValue({ approvalId: 'jappr_1', status: 'pending', expiresAt: Date.now() + 600_000 });
    renderProposal('jarvisapproval:jappr_1', 'pending');
    await screen.findByRole('button', { name: 'Approve fixed action' });
    expect(screen.queryByText(/Approval expired. The action was not run/)).toBeNull();
    expect(protectedHost.decideApproval).not.toHaveBeenCalled();
    expect(protectedHost.executeApproval).not.toHaveBeenCalled();
  });
  it.each(['legacy-call', 'jarvisapproval:', 'jarvisapproval:invalid:extra'])('retains terminal filtering for noncanonical or malformed %s without host authority access', callId => {
    const view = renderProposal(callId, 'cancelled');
    expect(view.container.querySelector('[data-action-id="schedule.create"]')).toBeNull();
    expect(protectedHost.expireInstalledJarvisApproval).not.toHaveBeenCalled();
    expect(protectedHost.decideApproval).not.toHaveBeenCalled();
    expect(protectedHost.executeApproval).not.toHaveBeenCalled();
  });
});
