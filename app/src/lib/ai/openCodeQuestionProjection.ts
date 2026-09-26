import type { Part } from '@/types/chat';
import type { JarvisOpenCodeQuestionRoute } from '@/features/jarvis-interaction/types';
import type { ProviderEvent, ProviderQuestionRequest } from './adapters/types';

type QuestionBlockPart = Extract<Part, { kind: 'question_block' }>;

/** Data-only authority descriptor; it intentionally contains no callback or credential. */
export type OpenCodeQuestionReplyRoute = JarvisOpenCodeQuestionRoute;
export type OpenCodeQuestionReplyPromptRoute = OpenCodeQuestionReplyRoute['questions'][number];
export type OpenCodeQuestionReplyOptionRoute = OpenCodeQuestionReplyPromptRoute['options'][number];

export interface OpenCodeQuestionProjection {
  /** This is the only member intended for Message.parts persistence. */
  part: QuestionBlockPart;
  /** Opaque runtime routing data for a later exact reply/reject bridge. */
  route: OpenCodeQuestionReplyRoute;
}

function stableText(value: unknown, max = 2_048, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function scopedId(prefix: string, ...parts: readonly string[]): string {
  const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
  return `${prefix}_${hash32(canonical, 2_166_136_261)}${hash32(canonical, 3_332_719_903)}`;
}

function validatedRequest(
  event: ProviderEvent,
  expectedSessionId: string,
): ProviderQuestionRequest | undefined {
  if (event.type !== 'question') return undefined;
  const request = event.request;
  if (
    !stableText(expectedSessionId, 512) ||
    !stableText(request.id, 512) ||
    !request.id.startsWith('que') ||
    !stableText(request.sessionId, 512) ||
    request.sessionId !== expectedSessionId ||
    !Array.isArray(request.questions) ||
    request.questions.length === 0 ||
    request.questions.length > 8
  ) {
    return undefined;
  }
  if (
    (request.deadlineAt !== undefined &&
      (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= 0)) ||
    (request.nativeRequestId !== undefined &&
      !(typeof request.nativeRequestId === 'number'
        ? Number.isSafeInteger(request.nativeRequestId)
        : stableText(request.nativeRequestId, 512)))
  ) return undefined;
  if (
    request.tool &&
    (!stableText(request.tool.messageId, 512) || !stableText(request.tool.callId, 512))
  ) {
    return undefined;
  }
  for (const question of request.questions) {
    if (
      !stableText(question.header, 64) ||
      !stableText(question.prompt) ||
      typeof question.multiple !== 'boolean' ||
      typeof question.allowCustomAnswer !== 'boolean' ||
      !Array.isArray(question.options) ||
      question.options.length > 8
    ) {
      return undefined;
    }
    for (const option of question.options) {
      if (!stableText(option.label, 160) || !stableText(option.description, 512, true)) {
        return undefined;
      }
    }
  }
  return request;
}

export function projectOpenCodeQuestionEvent(
  event: ProviderEvent,
  expectedSessionId: string,
): OpenCodeQuestionProjection | undefined {
  const request = validatedRequest(event, expectedSessionId);
  if (!request) return undefined;
  const toolScope = request.tool
    ? [request.tool.messageId, request.tool.callId]
    : ['no-message', 'no-call'];
  const authorityScope = [request.sessionId, request.id, ...toolScope];
  const blockId = scopedId('qb_opencode', ...authorityScope);

  const questions = request.questions.map((question, questionIndex) => {
    const questionId = scopedId('q_opencode', ...authorityScope, String(questionIndex));
    const options = question.options.map((option, optionIndex) => ({
      id: scopedId('qo_opencode', ...authorityScope, String(questionIndex), String(optionIndex)),
      label: option.label,
      description: option.description || undefined,
    }));
    return {
      id: questionId,
      prompt: question.prompt,
      type:
        options.length === 0
          ? ('text' as const)
          : question.multiple
            ? ('multi' as const)
            : ('single' as const),
      options,
      required: true,
      allowSkip: false,
      ...(question.allowCustomAnswer ? { allowCustomResponse: true as const } : {}),
    };
  });

  const route: OpenCodeQuestionReplyRoute = {
    protocol: 'opencode-question-v1',
    blockId,
    requestId: request.id,
    sessionId: request.sessionId,
    ...(request.nativeRequestId !== undefined ? { nativeRequestId: request.nativeRequestId } : {}),
    ...(request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}),
    ...(request.tool ? { tool: { ...request.tool } } : {}),
    questions: questions.map((question, questionIndex) => ({
      questionId: question.id,
      questionIndex,
      multiple: request.questions[questionIndex].multiple,
      allowCustomAnswer: request.questions[questionIndex].allowCustomAnswer,
      options: question.options.map((option, optionIndex) => ({
        optionId: option.id,
        optionIndex,
        label: option.label,
      })),
    })),
  };
  return {
    part: {
      kind: 'question_block',
      block: {
        id: blockId,
        title: request.questions[0].header,
        questions,
        status: 'pending',
      },
      harness: route,
    },
    route,
  };
}

/** A server resolution closes its exact pending request without assuming why it ended. */
export function resolveNativeQuestionPart(
  part: QuestionBlockPart,
  resolved: Readonly<{ requestId: string; sessionId: string }>,
): QuestionBlockPart {
  if (
    part.block.status !== 'pending' ||
    !resolved.requestId.startsWith('que_codex_') ||
    part.harness?.requestId !== resolved.requestId ||
    part.harness.sessionId !== resolved.sessionId
  ) return part;
  return { ...part, block: { ...part.block, status: 'resolved' } };
}
