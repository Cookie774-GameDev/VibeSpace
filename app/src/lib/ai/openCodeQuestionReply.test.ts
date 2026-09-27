import { describe, expect, it } from 'vitest';
import type { JarvisQuestionAnswer } from '@/features/jarvis-interaction/types';
import type { OpenCodeQuestionReplyRoute } from './openCodeQuestionProjection';
import {
  buildOpenCodeQuestionRejectRequest,
  buildOpenCodeQuestionReplyRequest,
} from './openCodeQuestionReply';

const route: OpenCodeQuestionReplyRoute = {
  protocol: 'opencode-question-v1',
  blockId: 'qb_opencode_abc123',
  requestId: 'que_native_42',
  sessionId: 'ses_exact',
  tool: { messageId: 'msg_exact', callId: 'call_exact' },
  questions: [
    {
      questionId: 'q_single',
      questionIndex: 0,
      multiple: false,
      allowCustomAnswer: true,
      options: [
        { optionId: 'opt_alpha', optionIndex: 0, label: 'Alpha' },
        { optionId: 'opt_beta', optionIndex: 1, label: 'Beta' },
      ],
    },
    {
      questionId: 'q_multi',
      questionIndex: 1,
      multiple: true,
      allowCustomAnswer: true,
      options: [
        { optionId: 'opt_red', optionIndex: 0, label: 'Red' },
        { optionId: 'opt_green', optionIndex: 1, label: 'Green' },
        { optionId: 'opt_blue', optionIndex: 2, label: 'Blue' },
      ],
    },
  ],
};

function reply(answers: readonly JarvisQuestionAnswer[]) {
  return buildOpenCodeQuestionReplyRequest({
    route,
    expectedSessionId: route.sessionId,
    blockId: route.blockId,
    answers,
  });
}

describe('OpenCode question reply request contract', () => {
  it('builds the official ordered reply body while retaining exact waiting-session authority', () => {
    const request = reply([
      {
        questionId: 'q_multi',
        selectedOptionIds: ['opt_blue', 'opt_red'],
        text: 'Amber',
      },
      { questionId: 'q_single', selectedOptionIds: ['opt_beta'] },
    ]);

    expect(request).toEqual({
      kind: 'reply',
      authority: {
        protocol: 'opencode-question-v1',
        blockId: route.blockId,
        requestId: route.requestId,
        sessionId: route.sessionId,
        tool: route.tool,
      },
      method: 'POST',
      path: '/question/que_native_42/reply',
      body: {
        answers: [['Beta'], ['Red', 'Blue', 'Amber']],
      },
    });
  });

  it('supports a custom-only answer without inventing an option', () => {
    const customOnlyRoute: OpenCodeQuestionReplyRoute = {
      ...route,
      questions: [
        {
          questionId: 'q_text',
          questionIndex: 0,
          multiple: false,
          allowCustomAnswer: true,
          options: [],
        },
      ],
    };

    expect(
      buildOpenCodeQuestionReplyRequest({
        route: customOnlyRoute,
        expectedSessionId: customOnlyRoute.sessionId,
        blockId: customOnlyRoute.blockId,
        answers: [{ questionId: 'q_text', text: '  exact custom answer  ' }],
      })?.body,
    ).toEqual({ answers: [['exact custom answer']] });
  });

  it('gives an allowed custom answer precedence over a stale single-choice selection', () => {
    const request = reply([
      { questionId: 'q_single', selectedOptionIds: ['opt_alpha'], text: 'Retro pixel' },
      { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
    ]);

    expect(request).toMatchObject({
      authority: {
        requestId: route.requestId,
        sessionId: route.sessionId,
        blockId: route.blockId,
      },
      path: `/question/${route.requestId}/reply`,
      body: { answers: [['Retro pixel'], ['Red']] },
    });
  });

  it('builds the official reject request without a fabricated body', () => {
    const request = buildOpenCodeQuestionRejectRequest({
      route,
      expectedSessionId: route.sessionId,
      blockId: route.blockId,
    });

    expect(request).toEqual({
      kind: 'reject',
      authority: {
        protocol: 'opencode-question-v1',
        blockId: route.blockId,
        requestId: route.requestId,
        sessionId: route.sessionId,
        tool: route.tool,
      },
      method: 'POST',
      path: '/question/que_native_42/reject',
    });
    expect(request).not.toHaveProperty('body');
  });

  it.each<
    [
      string,
      {
        route?: OpenCodeQuestionReplyRoute;
        expectedSessionId?: string;
        blockId?: string;
      },
    ]
  >([
    ['wrong session', { expectedSessionId: 'ses_other' }],
    ['wrong block', { blockId: 'qb_other' }],
    ['wrong protocol', { route: { ...route, protocol: 'other' as 'opencode-question-v1' } }],
    ['invalid request identity', { route: { ...route, requestId: '../que_native_42' } }],
    [
      'partial tool identity',
      { route: { ...route, tool: { messageId: 'msg_exact', callId: '' } } },
    ],
    [
      'tampered question order',
      {
        route: {
          ...route,
          questions: [{ ...route.questions[0], questionIndex: 1 }, route.questions[1]],
        },
      },
    ],
    [
      'tampered option order',
      {
        route: {
          ...route,
          questions: [
            {
              ...route.questions[0],
              options: [{ ...route.questions[0].options[0], optionIndex: 1 }],
            },
            route.questions[1],
          ],
        },
      },
    ],
  ])('fails closed for %s route authority', (_label, overrides) => {
    expect(
      buildOpenCodeQuestionRejectRequest({
        route: overrides.route ?? route,
        expectedSessionId: overrides.expectedSessionId ?? route.sessionId,
        blockId: overrides.blockId ?? route.blockId,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['missing question', [{ questionId: 'q_single', selectedOptionIds: ['opt_alpha'] }]],
    [
      'duplicate question',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_alpha'] },
        { questionId: 'q_single', selectedOptionIds: ['opt_beta'] },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'unknown question',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_alpha'] },
        { questionId: 'q_unknown', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'unknown option',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_unknown'] },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'duplicate option',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_alpha', 'opt_alpha'] },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'multiple selections for a single question',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_alpha', 'opt_beta'] },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'custom text cannot conceal multiple single-choice selections',
      [
        { questionId: 'q_single', selectedOptionIds: ['opt_alpha', 'opt_beta'], text: 'Custom' },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'empty required answer',
      [
        { questionId: 'q_single', text: '   ' },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
    [
      'skipped answer',
      [
        { questionId: 'q_single', skipped: true },
        { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly JarvisQuestionAnswer[]]>)(
    'fails closed for %s',
    (_label, answers) => {
      expect(reply(answers)).toBeUndefined();
    },
  );

  it('rejects custom text when the exact native question did not allow it', () => {
    const customDisabledRoute: OpenCodeQuestionReplyRoute = {
      ...route,
      questions: [{ ...route.questions[0], allowCustomAnswer: false }, route.questions[1]],
    };

    expect(
      buildOpenCodeQuestionReplyRequest({
        route: customDisabledRoute,
        expectedSessionId: route.sessionId,
        blockId: route.blockId,
        answers: [
          { questionId: 'q_single', selectedOptionIds: ['opt_alpha'], text: 'Not allowed' },
          { questionId: 'q_multi', selectedOptionIds: ['opt_red'] },
        ],
      }),
    ).toBeUndefined();
  });
});
