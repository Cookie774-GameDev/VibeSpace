import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanReviewCard } from './PlanReviewCard';
import type { Part } from '@/types/chat';
import { useJarvisInteractionStore } from './sessionStore';
import { requestsNoTools } from '@/lib/ai/intent';
import { readAgentApprovalMode, readPermissionAccess, setAgentApprovalMode, setPermissionAccess } from './permissionAccessStore';

const repo = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  messageRepo: repo,
}));

const planPart: Extract<Part, { kind: 'plan_review' }> = {
  kind: 'plan_review',
  plan: {
    id: 'plan_1',
    title: 'Build modes',
    summary: 'Add modes safely.',
    steps: ['Add store', 'Add composer chip'],
    risks: ['Shared chat surface'],
    status: 'pending',
  },
};

const informationalPlanPart: Extract<Part, { kind: 'plan_review' }> = {
  kind: 'plan_review',
  plan: {
    id: 'plan_info',
    title: 'Make coffee',
    summary: 'A simple informational checklist.',
    steps: ['Boil water', 'Add coffee', 'Pour slowly'],
    status: 'pending',
    executable: false,
  },
};

describe('PlanReviewCard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    repo.getById.mockReset();
    repo.update.mockReset();
    repo.create.mockReset();
    window.dispatchEvent = vi.fn();
    useJarvisInteractionStore.setState(useJarvisInteractionStore.getInitialState());
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [planPart],
    });
    repo.update.mockResolvedValue({});
    repo.create.mockResolvedValue({});
  });

  it.each(['pending', 'built'] as const)('implements a %s informational plan with one exact user send and existing Full access', async (status) => {
    const part = { ...informationalPlanPart, plan: { ...informationalPlanPart.plan, status } };
    repo.getById.mockResolvedValue({ id: 'msg_1', chat_id: 'chat_1', role: 'assistant', parts: [part] });
    useJarvisInteractionStore.getState().setChatMode('chat_1', 'plan');
    useJarvisInteractionStore.getState().setChatMode('other_chat', 'ask');
    setAgentApprovalMode('chat_1', 'review');
    setPermissionAccess('chat_1', 'read');
    render(<PlanReviewCard part={part} messageId={'msg_1' as never} chatId="chat_1" />);

    const button = screen.getByRole('button', { name: /^Yes, implement$/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(window.dispatchEvent).toHaveBeenCalledTimes(1));
    expect(useJarvisInteractionStore.getState().modeForChat('chat_1')).toBe('agent');
    expect(useJarvisInteractionStore.getState().modeForChat('other_chat')).toBe('ask');
    expect(readPermissionAccess('chat_1')).toEqual({ access: 'full', approveAll: false });
    expect(readAgentApprovalMode('chat_1')).toBe('full');
    expect(repo.create).toHaveBeenCalledExactlyOnceWith({ chat_id: 'chat_1', role: 'user',
      parts: [{ kind: 'text', text: 'Yes, implement the plan.' }] });
    const event = vi.mocked(window.dispatchEvent).mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe('jarvis:send');
    expect(event.detail).toEqual({ chatId: 'chat_1', text: 'Yes, implement the plan.',
      interactionMode: 'agent', queueIfBusy: true,
      structuredContext: { kind: 'plan_build', sourceMessageId: 'msg_1', payload: { plan: part.plan } } });
    fireEvent.click(button);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it.each(['building', 'cancelled', 'redone'] as const)('cannot implement a %s plan', (status) => {
    const part = { ...planPart, plan: { ...planPart.plan, status } };
    render(<PlanReviewCard part={part} messageId={'msg_1' as never} chatId="chat_1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Yes, implement$/ }));
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps Plan mode and access if the persisted plan is stale', async () => {
    repo.getById.mockResolvedValueOnce({ chat_id: 'other_chat', parts: [planPart] });
    useJarvisInteractionStore.getState().setChatMode('chat_1', 'plan');
    setPermissionAccess('chat_1', 'read');
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Yes, implement$/ }));
    await screen.findByRole('alert');
    expect(useJarvisInteractionStore.getState().modeForChat('chat_1')).toBe('plan');
    expect(readPermissionAccess('chat_1').access).toBe('read');
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps the plan body scrollable while decision actions stay outside the scroll region', () => {
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);

    const planDetails = screen.getByRole('region', { name: 'Plan details' });
    expect(planDetails.className).toContain('overflow-y-auto');
    expect(planDetails.className).toMatch(/max-h-/);
    expect(within(planDetails).getByText('Add store')).toBeTruthy();
    expect(within(planDetails).getByText('Shared chat surface')).toBeTruthy();
    expect(within(planDetails).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes — Implement Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No — Cancel' })).toBeTruthy();
  });

  it('adds a requirement while preserving the original plan in a read-only revision', async () => {
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Plan' }));
    fireEvent.change(screen.getByPlaceholderText('What should Jarvis add to the plan?'), {target:{value:'Add keyboard navigation.'}});
    fireEvent.click(screen.getByRole('button', { name: 'Send Revision' }));
    await waitFor(() => expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type:'jarvis:send', detail:expect.objectContaining({interactionMode:'plan', text:expect.stringContaining('Preserve the existing requirements and add: Add keyboard navigation.'),
        structuredContext:expect.objectContaining({kind:'plan_redo',payload:expect.objectContaining({plan:planPart.plan})})}),
    })));
  });

  it('implements an approved plan by switching to Agent Mode and dispatching execution context', async () => {
    useJarvisInteractionStore.getState().setChatMode('chat_1' as never, 'plan');
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);

    expect(screen.getByText('Implement this plan?')).toBeTruthy();
    const implementButton = screen.getByRole('button', { name: 'Yes — Implement Plan' });
    expect(screen.getByRole('button', { name: 'No — Cancel' })).toBeTruthy();
    fireEvent.click(implementButton);

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(useJarvisInteractionStore.getState().modeForChat('chat_1' as never)).toBe('agent');
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:send',
        detail: expect.objectContaining({
          chatId: 'chat_1',
          interactionMode: 'agent',
          structuredContext: expect.objectContaining({ kind: 'plan_build' }),
        }),
      }),
    );
  });

  it('keeps pre-approval restrictions in the approved payload, not the new turn instruction', async () => {
    const part = { ...planPart, plan: {
      ...planPart.plan, risks: ['No tools or writes will occur before clicking Implement Plan.'],
    } };
    repo.getById.mockResolvedValueOnce({ id: 'msg_1', chat_id: 'chat_1', role: 'assistant', parts: [part] });
    render(<PlanReviewCard part={part} messageId={'msg_1' as never} chatId="chat_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes — Implement Plan' }));
    await waitFor(() => expect(window.dispatchEvent).toHaveBeenCalled());
    const event = vi.mocked(window.dispatchEvent).mock.calls
      .map(([value]) => value as CustomEvent)
      .find(value => value.type === 'jarvis:send')!;
    expect(event.detail.structuredContext).toMatchObject({
      kind: 'plan_build', sourceMessageId: 'msg_1', payload: { plan: part.plan },
    });
    expect(requestsNoTools(event.detail.text)).toBe(false);
    expect(event.detail.text).toContain('approval has been granted');
  });

  it.each([
    ['missing', null],
    [
      'stale',
      {
        id: 'msg_1',
        chat_id: 'chat_1',
        role: 'assistant',
        parts: [
          {
            ...planPart,
            plan: { ...planPart.plan, status: 'cancelled' as const },
          },
        ],
      },
    ],
    [
      'cross-chat',
      {
        id: 'msg_1',
        chat_id: 'chat_other',
        role: 'assistant',
        parts: [planPart],
      },
    ],
    [
      'changed',
      {
        id: 'msg_1',
        chat_id: 'chat_1',
        role: 'assistant',
        parts: [
          {
            ...planPart,
            plan: { ...planPart.plan, steps: ['A different persisted plan'] },
          },
        ],
      },
    ],
  ])('fails closed when persisted plan approval authority is %s', async (_case, message) => {
    repo.getById.mockResolvedValueOnce(message);
    useJarvisInteractionStore.getState().setChatMode('chat_1' as never, 'plan');
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Yes — Implement Plan' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The plan could not start');
    expect(repo.update).not.toHaveBeenCalled();
    expect(useJarvisInteractionStore.getState().modeForChat('chat_1' as never)).toBe('plan');
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('completes an informational plan without starting an Agent Mode build run', async () => {
    repo.getById.mockResolvedValueOnce({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [informationalPlanPart],
    });
    useJarvisInteractionStore.getState().setChatMode('chat_1' as never, 'plan');
    render(
      <PlanReviewCard part={informationalPlanPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Done/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(useJarvisInteractionStore.getState().modeForChat('chat_1' as never)).toBe('plan');
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('redo plan persists a revision instruction and regenerates in Plan Mode', async () => {
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);

    fireEvent.click(screen.getByRole('button', { name: /Redo Plan/i }));
    fireEvent.change(screen.getByPlaceholderText(/What should Jarvis change/i), {
      target: { value: 'Make it smaller.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send Revision/i }));

    await waitFor(() => expect(repo.create).toHaveBeenCalledTimes(1));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        parts: [
          expect.objectContaining({
            kind: 'text',
            text: expect.stringContaining('Make it smaller.'),
          }),
        ],
      }),
    );
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ interactionMode: 'plan' }),
      }),
    );
  });

  it('cancels a pending plan without dispatching execution', async () => {
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'No — Cancel' }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each(['revision', 'cancel'] as const)('keeps %s pending state distinct from implementation', async (action) => {
    let finishRead!: (value: unknown) => void;
    repo.getById.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);
    if (action === 'revision') {
      fireEvent.click(screen.getByRole('button', { name: 'Add to Plan' }));
      fireEvent.change(screen.getByPlaceholderText('What should Jarvis add to the plan?'), {
        target: { value: 'Verify the result.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send Revision' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'No — Cancel' }));
    }
    expect(screen.queryByRole('button', { name: 'Implementing…' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Yes — Implement Plan' }) as HTMLButtonElement).disabled).toBe(true);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    await act(async () => finishRead({ chat_id: 'chat_1', parts: [planPart] }));
    if (action === 'revision') {
      expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
      expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.objectContaining({ interactionMode: 'plan' }),
      }));
    } else {
      expect(window.dispatchEvent).not.toHaveBeenCalled();
    }
  });

  it.each(['revision', 'cancel'] as const)('recovers from a failed %s save without executing', async (action) => {
    repo.update.mockRejectedValueOnce(new Error('Database write failed'));
    render(<PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />);
    if (action === 'revision') {
      fireEvent.click(screen.getByRole('button', { name: 'Redo Plan' }));
      fireEvent.change(screen.getByPlaceholderText('What should Jarvis change in the next plan?'), {
        target: { value: 'Use three steps.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send Revision' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'No — Cancel' }));
    }
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not/i);
    expect(
      (screen.getByRole('button', { name: 'Yes — Implement Plan' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: action === 'revision' ? 'Send Revision' : 'No — Cancel' }));
    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('renders as a wider review card for long plans', () => {
    const { container } = render(
      <PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(container.querySelector('section')?.className).toContain('min-w');
  });

  it('opens the complete plan in a scrollable dialog above the chat composer', () => {
    const longPlanPart = {
      ...planPart,
      plan: {
        ...planPart.plan,
        title: 'Long implementation plan',
        summary: Array.from({ length: 30 }, (_, index) => `Detail ${index + 1}`).join('\n'),
        steps: [...planPart.plan.steps, 'Final verification step'],
      },
    };
    render(
      <PlanReviewCard part={longPlanPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View full plan' }));

    const dialog = screen.getByRole('dialog', { name: 'Long implementation plan' });
    expect(dialog.className).toContain('overflow-y-auto');
    expect(within(dialog).getByText(/Detail 30/)).toBeTruthy();
    expect(within(dialog).getByText('Final verification step')).toBeTruthy();
    expect(within(dialog).getByText('Shared chat surface')).toBeTruthy();
    expect(repo.update).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: 'Yes — Implement Plan' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
