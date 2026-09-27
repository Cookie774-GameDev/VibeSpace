import type { JarvisQuestionAnswer } from '@/features/jarvis-interaction/types';
import type {
  OpenCodeQuestionReplyPromptRoute,
  OpenCodeQuestionReplyRoute,
} from './openCodeQuestionProjection';

export interface OpenCodeQuestionRequestAuthority {
  protocol: 'opencode-question-v1';
  blockId: string;
  requestId: string;
  sessionId: string;
  tool?: Readonly<{ messageId: string; callId: string }>;
}

export interface OpenCodeQuestionReplyRequest {
  kind: 'reply';
  authority: OpenCodeQuestionRequestAuthority;
  method: 'POST';
  path: string;
  /** Exact OpenCode HTTP API body. One ordered string array per native question. */
  body: { answers: string[][] };
}

export interface OpenCodeQuestionRejectRequest {
  kind: 'reject';
  authority: OpenCodeQuestionRequestAuthority;
  method: 'POST';
  path: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/u;

function stableText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function opaqueId(value: unknown, max = 512): value is string {
  return stableText(value, max) && OPAQUE_ID.test(value);
}

function validPromptRoute(question: OpenCodeQuestionReplyPromptRoute, index: number): boolean {
  if (
    !question ||
    !opaqueId(question.questionId) ||
    question.questionIndex !== index ||
    typeof question.multiple !== 'boolean' ||
    typeof question.allowCustomAnswer !== 'boolean' ||
    !Array.isArray(question.options) ||
    question.options.length > 8 ||
    (question.options.length === 0 && !question.allowCustomAnswer)
  ) {
    return false;
  }

  const optionIds = new Set<string>();
  for (const [optionIndex, option] of question.options.entries()) {
    if (
      !option ||
      !opaqueId(option.optionId) ||
      option.optionIndex !== optionIndex ||
      !stableText(option.label, 160) ||
      optionIds.has(option.optionId)
    ) {
      return false;
    }
    optionIds.add(option.optionId);
  }
  return true;
}

function authorityFor(
  route: OpenCodeQuestionReplyRoute,
  expectedSessionId: string,
  blockId: string,
): OpenCodeQuestionRequestAuthority | undefined {
  if (
    !route ||
    route.protocol !== 'opencode-question-v1' ||
    !opaqueId(expectedSessionId) ||
    !opaqueId(blockId) ||
    !opaqueId(route.blockId) ||
    route.blockId !== blockId ||
    !opaqueId(route.requestId) ||
    !route.requestId.startsWith('que') ||
    !opaqueId(route.sessionId) ||
    route.sessionId !== expectedSessionId ||
    !Array.isArray(route.questions) ||
    route.questions.length === 0 ||
    route.questions.length > 8
  ) {
    return undefined;
  }

  if (route.tool && (!opaqueId(route.tool.messageId) || !opaqueId(route.tool.callId))) {
    return undefined;
  }

  const questionIds = new Set<string>();
  for (const [questionIndex, question] of route.questions.entries()) {
    if (!validPromptRoute(question, questionIndex) || questionIds.has(question.questionId)) {
      return undefined;
    }
    questionIds.add(question.questionId);
  }

  return {
    protocol: route.protocol,
    blockId: route.blockId,
    requestId: route.requestId,
    sessionId: route.sessionId,
    ...(route.tool ? { tool: { ...route.tool } } : {}),
  };
}

function answerValues(
  question: OpenCodeQuestionReplyPromptRoute,
  answer: JarvisQuestionAnswer,
): string[] | undefined {
  if (answer.skipped) return undefined;
  if (answer.selectedOptionIds !== undefined && !Array.isArray(answer.selectedOptionIds)) {
    return undefined;
  }

  const selectedIds = answer.selectedOptionIds ?? [];
  if (
    selectedIds.length > question.options.length ||
    new Set(selectedIds).size !== selectedIds.length ||
    (!question.multiple && selectedIds.length > 1)
  ) {
    return undefined;
  }
  const selected = new Set(selectedIds);
  if (selectedIds.some((optionId) => !opaqueId(optionId))) return undefined;
  const knownOptionIds = new Set(question.options.map((option) => option.optionId));
  if (selectedIds.some((optionId) => !knownOptionIds.has(optionId))) return undefined;

  let custom: string | undefined;
  if (answer.text !== undefined) {
    if (!stableText(answer.text, 2_048) || !question.allowCustomAnswer) return undefined;
    custom = answer.text.trim();
  }

  const values = question.options
    .filter((option) => selected.has(option.optionId))
    .map((option) => option.label);
  if (custom && !question.multiple) return [custom];
  if (custom) values.push(custom);
  if (values.length === 0 || (!question.multiple && values.length !== 1)) return undefined;
  return values;
}

export function buildOpenCodeQuestionReplyRequest(input: {
  route: OpenCodeQuestionReplyRoute;
  expectedSessionId: string;
  blockId: string;
  answers: readonly JarvisQuestionAnswer[];
}): OpenCodeQuestionReplyRequest | undefined {
  const authority = authorityFor(input.route, input.expectedSessionId, input.blockId);
  if (
    !authority ||
    !Array.isArray(input.answers) ||
    input.answers.length !== input.route.questions.length
  ) {
    return undefined;
  }

  const answersByQuestion = new Map<string, JarvisQuestionAnswer>();
  for (const answer of input.answers) {
    if (!answer || !opaqueId(answer.questionId) || answersByQuestion.has(answer.questionId)) {
      return undefined;
    }
    answersByQuestion.set(answer.questionId, answer);
  }

  const orderedAnswers: string[][] = [];
  for (const question of input.route.questions) {
    const answer = answersByQuestion.get(question.questionId);
    if (!answer) return undefined;
    const values = answerValues(question, answer);
    if (!values) return undefined;
    orderedAnswers.push(values);
  }

  return {
    kind: 'reply',
    authority,
    method: 'POST',
    path: `/question/${encodeURIComponent(authority.requestId)}/reply`,
    body: { answers: orderedAnswers },
  };
}

export function buildOpenCodeQuestionRejectRequest(input: {
  route: OpenCodeQuestionReplyRoute;
  expectedSessionId: string;
  blockId: string;
}): OpenCodeQuestionRejectRequest | undefined {
  const authority = authorityFor(input.route, input.expectedSessionId, input.blockId);
  if (!authority) return undefined;
  return {
    kind: 'reject',
    authority,
    method: 'POST',
    path: `/question/${encodeURIComponent(authority.requestId)}/reject`,
  };
}
