import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanReviewCard } from './PlanReviewCard';
import type { Part } from '@/types/chat';
import { useJarvisInteractionStore } from './sessionStore';

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

  it('renders as a wider review card for long plans', () => {
    const { container } = render(
      <PlanReviewCard part={planPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(container.querySelector('section')?.className).toContain('min-w');
  });
});
