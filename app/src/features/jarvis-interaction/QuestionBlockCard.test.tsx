import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineQuestionBlockCard, QuestionBlockCard } from './QuestionBlockCard';
import type { Part } from '@/types/chat';

const nativeWindowDispatchEvent = window.dispatchEvent.bind(window);

const repo = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));
const openCodeQuestion = vi.hoisted(() => ({ respond: vi.fn() }));
const playUiSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sfx', () => ({ playUiSound }));
afterEach(() => vi.useRealTimers());

vi.mock('@/lib/db/repositories', () => ({
  messageRepo: repo,
}));

vi.mock('@/lib/ai/adapters/opencodePersistent', () => ({
  respondToPersistentOpenCodeQuestion: openCodeQuestion.respond,
}));

const blockPart: Extract<Part, { kind: 'question_block' }> = {
  kind: 'question_block',
  block: {
    id: 'qb_1',
    title: 'Clarify scope',
    description: 'Answer these before Jarvis continues.',
    status: 'pending',
    questions: [
      {
        id: 'q1',
        prompt: 'Which areas should Jarvis touch?',
        type: 'multi',
        required: true,
        options: [
          { id: 'chat', label: 'Chat UI' },
          { id: 'runtime', label: 'Runtime' },
          { id: 'both', label: 'Both areas' },
        ],
      },
      {
        id: 'q2',
        prompt: 'Anything else?',
        type: 'text',
        required: false,
        allowCustomResponse: true,
        placeholder: 'Add detail',
        options: [
          { id: 'none', label: 'Nothing else' },
          { id: 'tests', label: 'Add tests' },
          { id: 'docs', label: 'Add documentation' },
        ],
      },
    ],
  },
};

const harnessPart: Extract<Part, { kind: 'question_block' }> = {
  kind: 'question_block',
  block: {
    id: 'qb_opencode_exact',
    title: 'Implement this plan?',
    status: 'pending',
    questions: [
      {
        id: 'q_opencode_exact',
        prompt: 'Implement this plan?',
        type: 'single',
        required: true,
        allowSkip: false,
        options: [
          { id: 'qo_yes', label: 'Yes' },
          { id: 'qo_no', label: 'No' },
        ],
      },
    ],
  },
  harness: {
    protocol: 'opencode-question-v1',
    blockId: 'qb_opencode_exact',
    requestId: 'que_opencode_exact',
    sessionId: 'ses_opencode_exact',
    tool: { messageId: 'msg_native_exact', callId: 'call_native_exact' },
    questions: [
      {
        questionId: 'q_opencode_exact',
        questionIndex: 0,
        multiple: false,
        allowCustomAnswer: false,
        options: [
          { optionId: 'qo_yes', optionIndex: 0, label: 'Yes' },
          { optionId: 'qo_no', optionIndex: 1, label: 'No' },
        ],
      },
    ],
  },
};

describe('QuestionBlockCard', () => {
  beforeEach(() => {
    playUiSound.mockClear();
    repo.getById.mockReset();
    repo.update.mockReset();
    repo.create.mockReset();
    openCodeQuestion.respond.mockReset();
    window.sessionStorage.clear();
    window.dispatchEvent = vi.fn();
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [blockPart],
    });
    repo.update.mockResolvedValue({});
    repo.create.mockResolvedValue({});
    openCodeQuestion.respond.mockResolvedValue({
      protocol: 'opencode-question-dispatch-receipt-v1',
      status: 'accepted',
      action: 'reply',
      sessionId: 'ses_opencode_exact',
      requestId: 'que_opencode_exact',
      blockId: 'qb_opencode_exact',
      questionCount: 1,
    });
  });

  it('renders pending transcript questions as a concise exact-chat focus action', () => {
    render(<QuestionBlockCard part={blockPart} chatId="chat_1" />);

    expect(screen.getByRole('button', { name: 'Answer question' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Chat UI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Answer question' }));

    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:question:focus-inline',
        detail: { chatId: 'chat_1', blockId: 'qb_1' },
      }),
    );
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
  });

  it('keeps the resolved transcript answer display unchanged', () => {
    const answeredPart: Extract<Part, { kind: 'question_block' }> = {
      ...blockPart,
      block: {
        ...blockPart.block,
        status: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['chat'] }],
      },
    };
    render(<QuestionBlockCard part={answeredPart} chatId="chat_1" />);

    expect(screen.getByRole('button', { name: 'Chat UI' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Answered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer question' })).toBeNull();
  });

  it('shows native expiry, preserves the answer draft, and offers no late-submit controls', () => {
    const expiredPart: Extract<Part, { kind: 'question_block' }> = {
      kind: 'question_block',
      block: {
        id: 'qb_expired',
        title: 'Native preference question',
        status: 'expired',
        questions: [
          {
            id: 'q_expired',
            prompt: 'What would you choose?',
            type: 'text',
            required: true,
          },
        ],
      },
      harness: {
        ...harnessPart.harness!,
        blockId: 'qb_expired',
        requestId: 'que_codex_expired',
      },
    };
    const draftKey = 'jarvis-question-draft:chat_1:qb_expired';
    window.sessionStorage.setItem(
      draftKey,
      JSON.stringify({ selected: {}, text: { q_expired: 'draft before timeout' }, activeIndex: 0 }),
    );
    const onDictationToggle = vi.fn();

    render(
      <InlineQuestionBlockCard
        part={expiredPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
        deadlineAt={Date.now() + 30_000}
        onDictationToggle={onDictationToggle}
      />,
    );

    expect(screen.getByText('Expired.')).toBeTruthy();
    const answer = screen.getByRole('textbox', {
      name: 'Custom response for What would you choose?',
    }) as HTMLTextAreaElement;
    expect(answer.value).toBe('draft before timeout');
    expect(answer.disabled).toBe(true);
    expect(window.sessionStorage.getItem(draftKey)).toContain('draft before timeout');
    expect(screen.queryByRole('button', { name: /Submit|Next|Skip|Cancel|Dismiss question/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dictate answer/i })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(onDictationToggle).not.toHaveBeenCalled();
  });

  it('labels a protocol-resolved question neutrally and removes late-answer controls', () => {
    const resolvedPart: Extract<Part, { kind: 'question_block' }> = {
      ...harnessPart,
      block: { ...harnessPart.block, status: 'resolved' },
      harness: { ...harnessPart.harness!, requestId: 'que_codex_resolved' },
    };

    render(
      <InlineQuestionBlockCard
        part={resolvedPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
        deadlineAt={Date.now() + 30_000}
        onDictationToggle={vi.fn()}
      />,
    );

    expect(screen.getByText('No longer pending.')).toBeTruthy();
    expect(screen.queryByText('Expired.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Submit|Next|Skip|Cancel|Dismiss question|Dictate answer/i })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('reopens and focuses only the inline card for the matching chat and block', async () => {
    window.dispatchEvent = nativeWindowDispatchEvent;
    const { container } = render(
      <>
        <QuestionBlockCard part={blockPart} chatId="chat_1" />
        <InlineQuestionBlockCard part={blockPart} chatId="chat_1" />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
    expect(screen.getByRole('button', { name: 'Reopen question' })).toBeTruthy();

    window.dispatchEvent(
      new CustomEvent('jarvis:question:focus-inline', {
        detail: { chatId: 'chat_other', blockId: 'qb_1' },
      }),
    );
    expect(screen.getByRole('button', { name: 'Reopen question' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Answer question' }));

    const answerChoice = screen.getByRole('button', { name: 'Chat UI' });
    await waitFor(() => expect(document.activeElement).toBe(answerChoice));
    expect(container.querySelector('[data-inline-question-block-id="qb_1"]')).toBeTruthy();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
  });

  it('plays the existing UI sound on selection and locks completed answers', () => {
    const { rerender } = render(<InlineQuestionBlockCard part={blockPart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat UI' }));
    expect(playUiSound).toHaveBeenCalledWith('ui_click_soft');
    expect(screen.getByRole('button', { name: 'Chat UI' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    rerender(
      <InlineQuestionBlockCard
        part={{ ...blockPart, block: { ...blockPart.block, status: 'answered' } }}
      />,
    );
    expect((screen.getByRole('button', { name: 'Chat UI' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(playUiSound).toHaveBeenCalledTimes(1);
  });

  it('shows one question at a time with a real progress label', () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    expect(screen.getByText(/Which areas should Jarvis touch/i)).toBeTruthy();
    expect(screen.queryByText(/Anything else/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Next/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Submit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Back/i })).toBeNull();
  });

  it('restores submitted choices and custom text without a session draft', () => {
    render(
      <InlineQuestionBlockCard
        part={{
          ...blockPart,
          block: {
            ...blockPart.block,
            status: 'answered',
            answers: [
              { questionId: 'q1', selectedOptionIds: ['runtime'] },
              { questionId: 'q2', text: 'Keep the existing files.' },
            ],
          },
        }}
        messageId={'msg_1' as never}
        chatId="chat_1"
      />,
    );
    expect(screen.getByRole('button', { name: 'Runtime' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Custom response for Anything else?',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Keep the existing files.');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
  });

  it('does not auto-advance multi-select choices before Next', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));

    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('validates the current required question before moving on', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByText(/Please answer this question/i)).toBeTruthy();
    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('supports Next and Back navigation while keeping answers', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByText('Question 2 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Write my own answer/i }));
    expect(screen.getByPlaceholderText(/Add detail/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));

    expect(await screen.findByText('Question 1 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Chat UI/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('persists answers, creates a question_answer message, and dispatches structured context', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Write my own answer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Add detail/i), {
      target: { value: 'Keep it in chat only.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 'chat_1',
        role: 'user',
        parts: expect.arrayContaining([
          expect.objectContaining({ kind: 'text' }),
          expect.objectContaining({ kind: 'question_answer', blockId: 'qb_1' }),
        ]),
      }),
    );
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:send',
        detail: expect.objectContaining({
          chatId: 'chat_1',
          structuredContext: expect.objectContaining({ kind: 'question_answers' }),
        }),
      }),
    );
  });

  it('hides custom-answer controls unless explicitly allowed while keeping text-only input visible', () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(screen.queryByRole('button', { name: /Write my own answer/i })).toBeNull();

    const textOnlyPart: Extract<Part, { kind: 'question_block' }> = {
      ...blockPart,
      block: {
        ...blockPart.block,
        questions: [
          {
            id: 'q_text_only',
            prompt: 'Add context',
            type: 'text',
            required: false,
          },
        ],
      },
    };
    render(<InlineQuestionBlockCard part={textOnlyPart} chatId="chat_1" />);
    expect(screen.getByRole('textbox', { name: /Custom response for Add context/i })).toBeTruthy();
  });

  it('replies to the exact waiting OpenCode question before persisting without creating a new turn', async () => {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [harnessPart],
    });
    render(
      <InlineQuestionBlockCard part={harnessPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(openCodeQuestion.respond).toHaveBeenCalledWith({
      request: {
        kind: 'reply',
        authority: {
          protocol: 'opencode-question-v1',
          blockId: 'qb_opencode_exact',
          requestId: 'que_opencode_exact',
          sessionId: 'ses_opencode_exact',
          tool: { messageId: 'msg_native_exact', callId: 'call_native_exact' },
        },
        method: 'POST',
        path: '/question/que_opencode_exact/reply',
        body: { answers: [['Yes']] },
      },
      expectedSessionId: 'ses_opencode_exact',
      expectedBlockId: 'qb_opencode_exact',
    });
    expect(openCodeQuestion.respond.mock.invocationCallOrder[0]).toBeLessThan(
      repo.update.mock.invocationCallOrder[0],
    );
    expect(repo.update).toHaveBeenCalledWith(
      'msg_1',
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            kind: 'question_block',
            harness: harnessPart.harness,
            block: expect.objectContaining({ status: 'answered' }),
          }),
        ]),
      }),
    );
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jarvis:send' }),
    );
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vibespace:opencode-question-resolved',
        detail: expect.objectContaining({
          chatId: 'chat_1',
          messageId: 'msg_1',
          part: expect.objectContaining({
            kind: 'question_block',
            harness: harnessPart.harness,
            block: expect.objectContaining({ status: 'answered' }),
          }),
        }),
      }),
    );
  });

  it('rejects the exact waiting OpenCode question before persisting cancellation', async () => {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [harnessPart],
    });
    render(
      <InlineQuestionBlockCard part={harnessPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(openCodeQuestion.respond).toHaveBeenCalledWith({
      request: expect.objectContaining({
        kind: 'reject',
        method: 'POST',
        path: '/question/que_opencode_exact/reject',
      }),
      expectedSessionId: 'ses_opencode_exact',
      expectedBlockId: 'qb_opencode_exact',
    });
    expect(openCodeQuestion.respond.mock.calls[0]?.[0].request).not.toHaveProperty('body');
    expect(openCodeQuestion.respond.mock.invocationCallOrder[0]).toBeLessThan(
      repo.update.mock.invocationCallOrder[0],
    );
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vibespace:opencode-question-resolved',
        detail: expect.objectContaining({
          part: expect.objectContaining({
            harness: harnessPart.harness,
            block: expect.objectContaining({ status: 'cancelled' }),
          }),
        }),
      }),
    );
  });

  it('keeps a harness question pending with a sanitized retry when exact dispatch fails', async () => {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [harnessPart],
    });
    openCodeQuestion.respond.mockRejectedValueOnce(new Error('secret transport detail'));
    render(
      <InlineQuestionBlockCard part={harnessPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /could not send.*original agent session.*still active.*retry/i,
    );
    expect(alert.textContent).not.toContain('secret transport detail');
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Submit/i })).toHaveProperty('disabled', false);
  });

  it('emits no harness resolution when persistence fails after an accepted reply', async () => {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [harnessPart],
    });
    repo.update.mockRejectedValueOnce(new Error('storage detail'));
    render(
      <InlineQuestionBlockCard part={harnessPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not send.*original agent session.*still active.*retry/i,
    );
    expect(openCodeQuestion.respond).toHaveBeenCalledOnce();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('fails closed before OpenCode I/O when the persisted harness authority changed', async () => {
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [
        {
          ...harnessPart,
          harness: { ...harnessPart.harness!, sessionId: 'ses_replaced' },
        },
      ],
    });
    render(
      <InlineQuestionBlockCard part={harnessPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not send.*original agent session.*still active.*retry/i,
    );
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted source message belongs to a different chat', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_2" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    await waitFor(() => expect(repo.getById).toHaveBeenCalledWith('msg_1'));
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /no longer belongs to this chat/i,
    );
  });

  it('fails closed when the exact question block is no longer in its source message', async () => {
    repo.getById.mockResolvedValueOnce({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [{ kind: 'text', text: 'The question was replaced.' }],
    });
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer available/i);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('restores in-progress draft answers after remount', async () => {
    const first = render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Write my own answer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Add detail/i), {
      target: { value: 'Draft answer in progress' },
    });
    first.unmount();

    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(screen.getByText('Question 2 of 2')).toBeTruthy();
    expect((screen.getByPlaceholderText(/Add detail/i) as HTMLTextAreaElement).value).toBe(
      'Draft answer in progress',
    );

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByRole('button', { name: /Chat UI/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('cancels without sending anything to Jarvis', async () => {
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    const updated = repo.update.mock.calls[0]?.[1] as {
      parts: Array<{ kind: string; block?: { status: string } }>;
    };
    expect(updated.parts.find((p) => p.kind === 'question_block')?.block?.status).toBe('cancelled');
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('marks optional blocks skipped and dispatches skipped context', async () => {
    const optionalPart: Extract<Part, { kind: 'question_block' }> = {
      ...blockPart,
      block: {
        ...blockPart.block,
        questions: [{ ...blockPart.block.questions[0], required: false, allowSkip: true }],
      },
    };
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [optionalPart],
    });

    render(
      <InlineQuestionBlockCard part={optionalPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Skip/i }));

    await waitFor(() => expect(repo.update).toHaveBeenCalledTimes(1));
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:send',
        detail: expect.objectContaining({
          structuredContext: expect.objectContaining({
            payload: expect.objectContaining({ skipped: true }),
          }),
        }),
      }),
    );
  });

  it('shows progress and Submit for a single-question card', () => {
    const singlePart: Extract<Part, { kind: 'question_block' }> = {
      ...blockPart,
      block: {
        ...blockPart.block,
        questions: [blockPart.block.questions[1]],
      },
    };

    render(
      <InlineQuestionBlockCard part={singlePart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    expect(screen.getByText(/Question 1 of 1/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Submit/i })).toBeTruthy();
  });

  it('keeps answers and shows a retryable error when persistence fails', async () => {
    repo.update.mockRejectedValueOnce(new Error('Storage unavailable'));
    render(
      <InlineQuestionBlockCard part={blockPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Chat UI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Question 2 of 2/i)).toBeTruthy();
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Submit/i })).toHaveProperty('disabled', false);
  });

  it('dismisses and reopens the inline card without resolving its pending question', () => {
    const onDismiss = vi.fn();
    const onReopen = vi.fn();
    const onDictationCleanup = vi.fn();
    const view = render(
      <InlineQuestionBlockCard
        part={harnessPart}
        messageId={'msg_1' as never}
        chatId="chat_1"
        onDismiss={onDismiss}
        onReopen={onReopen}
        onDictationCleanup={onDictationCleanup}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDictationCleanup).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Reopen question' })).toBeTruthy();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(openCodeQuestion.respond).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen question' }));

    expect(screen.getByText('Question 1 of 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(onReopen).toHaveBeenCalledOnce();
    view.unmount();
    expect(onDictationCleanup).toHaveBeenCalledTimes(2);
  });

  it('routes inline dictation to the active answer textarea', () => {
    const onDictationToggle = vi.fn();
    const textPart: Extract<Part, { kind: 'question_block' }> = {
      ...blockPart,
      block: {
        ...blockPart.block,
        questions: [{ id: 'q_voice', prompt: 'Voice answer', type: 'text', required: true }],
      },
    };
    render(<InlineQuestionBlockCard part={textPart} onDictationToggle={onDictationToggle} />);

    const answerField = screen.getByRole('textbox', { name: 'Custom response for Voice answer' });
    fireEvent.click(screen.getByRole('button', { name: 'Dictate answer' }));

    expect(onDictationToggle).toHaveBeenCalledOnce();
    expect(onDictationToggle.mock.calls[0]?.[0]).toBe(answerField);
    const commitQuestionAnswer = onDictationToggle.mock.calls[0]?.[1] as
      | ((value: string, caret: number) => void)
      | undefined;
    expect(commitQuestionAnswer).toBeTypeOf('function');
    act(() => commitQuestionAnswer?.('The spoken answer', 18));
    expect(answerField).toHaveProperty('value', 'The spoken answer');
  });

  it('shows countdown only when real Codex deadline metadata is supplied', () => {
    const codexPart: Extract<Part, { kind: 'question_block' }> = {
      ...harnessPart,
      harness: { ...harnessPart.harness!, requestId: 'que_codex_native' },
    };
    const deadlineAt = Date.now() + 30_000;

    const { rerender } = render(
      <InlineQuestionBlockCard part={codexPart} deadlineAt={deadlineAt} />,
    );
    expect(screen.getByRole('timer').getAttribute('aria-label')).toMatch(/seconds/i);

    rerender(<InlineQuestionBlockCard part={codexPart} />);
    expect(screen.queryByRole('timer')).toBeNull();

    rerender(<InlineQuestionBlockCard part={harnessPart} deadlineAt={deadlineAt} />);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('updates a supplied native Codex deadline countdown once per second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const codexPart: Extract<Part, { kind: 'question_block' }> = {
      ...harnessPart,
      harness: { ...harnessPart.harness!, requestId: 'que_codex_native' },
    };
    const view = render(<InlineQuestionBlockCard part={codexPart} deadlineAt={3_000} />);

    expect(screen.getByRole('timer').textContent).toBe('3s left');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('timer').textContent).toBe('2s left');
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('timer').textContent).toBe('Deadline reached');
    view.unmount();
  });

  it('keeps inline native answer submission duplicate-guarded', async () => {
    let finishReply!: (value: {
      protocol: string;
      status: 'accepted';
      action: 'reply';
      sessionId: string;
      requestId: string;
      blockId: string;
      questionCount: number;
    }) => void;
    openCodeQuestion.respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReply = resolve;
        }),
    );
    const codexPart: Extract<Part, { kind: 'question_block' }> = {
      ...harnessPart,
      harness: { ...harnessPart.harness!, requestId: 'que_codex_native' },
    };
    repo.getById.mockResolvedValue({
      id: 'msg_1',
      chat_id: 'chat_1',
      role: 'assistant',
      parts: [codexPart],
    });
    render(
      <InlineQuestionBlockCard part={codexPart} messageId={'msg_1' as never} chatId="chat_1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(openCodeQuestion.respond).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(openCodeQuestion.respond).toHaveBeenCalledOnce();
    await act(async () => {
      finishReply({
        protocol: 'opencode-question-dispatch-receipt-v1',
        status: 'accepted',
        action: 'reply',
        sessionId: 'ses_opencode_exact',
        requestId: 'que_codex_native',
        blockId: 'qb_opencode_exact',
        questionCount: 1,
      });
    });
    await waitFor(() => expect(repo.update).toHaveBeenCalledOnce());
    expect(openCodeQuestion.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          authority: expect.objectContaining({ requestId: 'que_codex_native' }),
        }),
      }),
    );
    expect(repo.create).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jarvis:send' }),
    );
  });
});
