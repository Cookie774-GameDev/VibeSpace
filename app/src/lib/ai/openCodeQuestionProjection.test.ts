import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from './adapters/types';
import { projectOpenCodeQuestionEvent, resolveNativeQuestionPart } from './openCodeQuestionProjection';

function questionEvent(
  overrides: Partial<Extract<ProviderEvent, { type: 'question' }>['request']> = {},
): Extract<ProviderEvent, { type: 'question' }> {
  return {
    type: 'question',
    request: {
      id: 'que_native_1',
      sessionId: 'ses_exact',
      tool: { messageId: 'msg_assistant_1', callId: 'call_question_1' },
      questions: [
        {
          header: 'Approach',
          prompt: 'Which implementation should I use?',
          options: [
            { label: 'Smallest fix', description: 'Change only the failing boundary.' },
            { label: 'Broader refactor', description: 'Rework the surrounding module.' },
          ],
          multiple: false,
          allowCustomAnswer: true,
        },
        {
          header: 'Checks',
          prompt: 'Which verification should I run?',
          options: [
            { label: 'Focused tests', description: 'Run the focused suite.' },
            { label: 'Typecheck', description: 'Run the full compiler check.' },
          ],
          multiple: true,
          allowCustomAnswer: false,
        },
      ],
      ...overrides,
    },
  };
}

describe('projectOpenCodeQuestionEvent', () => {
  it('retains an observed native Codex deadline and original response identity', () => {
    const projection = projectOpenCodeQuestionEvent(questionEvent({
      id: 'que_codex_1', nativeRequestId: 42, deadlineAt: 1_800_000_005_000,
    }), 'ses_exact');
    expect(projection?.route).toMatchObject({ nativeRequestId: 42, deadlineAt: 1_800_000_005_000 });
    expect(projectOpenCodeQuestionEvent(questionEvent(), 'ses_exact')?.route).not.toHaveProperty('deadlineAt');
  });

  it('resolves only the exact pending native question without inventing expiry or replacing accepted answers', () => {
    const part = projectOpenCodeQuestionEvent(questionEvent({ id: 'que_codex_1', nativeRequestId: 42 }), 'ses_exact')!.part;
    const resolved = { requestId: 'que_codex_1', sessionId: 'ses_exact' };
    expect(resolveNativeQuestionPart(part, resolved).block.status).toBe('resolved');
    expect(resolveNativeQuestionPart(part, { ...resolved, sessionId: 'other' })).toBe(part);
    expect(resolveNativeQuestionPart(part, { ...resolved, requestId: 'que_codex_other' })).toBe(part);
    const answered = { ...part, block: { ...part.block, status: 'answered' as const } };
    expect(resolveNativeQuestionPart(answered, resolved)).toBe(answered);
  });

  it('projects ordered native questions into one deterministic persisted block and exact route', () => {
    const event = questionEvent();
    const first = projectOpenCodeQuestionEvent(event, 'ses_exact');
    const second = projectOpenCodeQuestionEvent(event, 'ses_exact');

    expect(first).toEqual(second);
    expect(first?.part.kind).toBe('question_block');
    expect(first?.part.block).toMatchObject({
      id: expect.stringMatching(/^qb_opencode_/u),
      title: 'Approach',
      status: 'pending',
      questions: [
        {
          id: expect.stringMatching(/^q_opencode_/u),
          prompt: 'Which implementation should I use?',
          type: 'single',
          required: true,
          allowSkip: false,
          allowCustomResponse: true,
          options: [
            {
              id: expect.stringMatching(/^qo_opencode_/u),
              label: 'Smallest fix',
              description: 'Change only the failing boundary.',
            },
            {
              id: expect.stringMatching(/^qo_opencode_/u),
              label: 'Broader refactor',
              description: 'Rework the surrounding module.',
            },
          ],
        },
        {
          id: expect.stringMatching(/^q_opencode_/u),
          prompt: 'Which verification should I run?',
          type: 'multi',
          required: true,
          allowSkip: false,
          options: [{ label: 'Focused tests' }, { label: 'Typecheck' }],
        },
      ],
    });
    expect(first?.part.block.questions[1]).not.toHaveProperty('allowCustomResponse');
    expect(
      new Set(
        first?.part.block.questions.flatMap((question) => [
          question.id,
          ...(question.options ?? []).map((option) => option.id),
        ]),
      ).size,
    ).toBe(6);

    expect(first?.route).toEqual({
      protocol: 'opencode-question-v1',
      blockId: first?.part.block.id,
      requestId: 'que_native_1',
      sessionId: 'ses_exact',
      tool: { messageId: 'msg_assistant_1', callId: 'call_question_1' },
      questions: first?.part.block.questions.map((question, questionIndex) => ({
        questionId: question.id,
        questionIndex,
        multiple: questionIndex === 1,
        allowCustomAnswer: questionIndex === 0,
        options:
          question.options?.map((option, optionIndex) => ({
            optionId: option.id,
            optionIndex,
            label: option.label,
          })) ?? [],
      })),
    });
    expect(first?.part.harness).toEqual(first?.route);
    expect(JSON.stringify(first)).not.toMatch(/callback|function|prompt-for-provider/iu);
  });

  it('creates identity-scoped IDs and preserves duplicate option order without collisions', () => {
    const duplicateOptions = [
      { label: 'Same', description: 'First occurrence.' },
      { label: 'Same', description: 'Second occurrence.' },
    ];
    const base = projectOpenCodeQuestionEvent(
      questionEvent({
        questions: [{ ...questionEvent().request.questions[0], options: duplicateOptions }],
      }),
      'ses_exact',
    );
    const otherSession = projectOpenCodeQuestionEvent(
      questionEvent({ sessionId: 'ses_other' }),
      'ses_other',
    );
    const otherRequest = projectOpenCodeQuestionEvent(
      questionEvent({ id: 'que_native_2' }),
      'ses_exact',
    );
    const otherTool = projectOpenCodeQuestionEvent(
      questionEvent({ tool: { messageId: 'msg_assistant_1', callId: 'call_question_2' } }),
      'ses_exact',
    );

    expect(base?.part.block.questions[0].options?.map((option) => option.label)).toEqual([
      'Same',
      'Same',
    ]);
    expect(base?.part.block.questions[0].options?.[0].id).not.toBe(
      base?.part.block.questions[0].options?.[1].id,
    );
    expect(otherSession?.part.block.id).not.toBe(base?.part.block.id);
    expect(otherRequest?.part.block.id).not.toBe(base?.part.block.id);
    expect(otherTool?.part.block.id).not.toBe(base?.part.block.id);
  });

  it('preserves a custom-only native prompt as required text input', () => {
    const projection = projectOpenCodeQuestionEvent(
      questionEvent({
        questions: [
          {
            header: 'Details',
            prompt: 'What should the title say?',
            options: [],
            multiple: false,
            allowCustomAnswer: true,
          },
        ],
      }),
      'ses_exact',
    );

    expect(projection?.part.block.questions[0]).toMatchObject({
      type: 'text',
      required: true,
      allowCustomResponse: true,
      options: [],
    });
    expect(projection?.route.questions[0]).toMatchObject({
      questionIndex: 0,
      multiple: false,
      allowCustomAnswer: true,
      options: [],
    });
  });

  it.each([
    ['non-question event', { type: 'text', delta: 'hello' } as ProviderEvent, 'ses_exact'],
    ['cross-session event', questionEvent(), 'ses_other'],
    ['missing request identity', questionEvent({ id: '' }), 'ses_exact'],
    ['missing session identity', questionEvent({ sessionId: '' }), 'ses_exact'],
    ['missing questions', questionEvent({ questions: [] }), 'ses_exact'],
    [
      'partial tool identity',
      questionEvent({ tool: { messageId: 'msg_assistant_1' } as never }),
      'ses_exact',
    ],
  ])('fails closed for %s', (_label, event, expectedSessionId) => {
    expect(projectOpenCodeQuestionEvent(event, expectedSessionId)).toBeUndefined();
  });
});
