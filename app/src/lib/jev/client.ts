import {
  JEV_MODEL_ALIAS,
  type JevClient,
  type JevNativeHttpBridge,
  type JevTransport,
  type JevTransportProbe,
  JevClientError,
} from './contracts';
import type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevEvaluation,
  JevJsonValue,
  JevQuestion,
  JevQuestions,
  JevScoreAnswer,
  JevScoreQuestion,
  JevUsage,
} from './types';

const MAX_QUESTION_ID_LENGTH = 128;
const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertQuestionMap(questions: JevQuestions): void {
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new JevClientError('request_invalid');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!id || id.length > MAX_QUESTION_ID_LENGTH || !isRecord(question)) {
      throw new JevClientError('request_invalid');
    }
    if (question.type === 'noul') {
      if (!('instructions' in question)) throw new JevClientError('request_invalid');
      continue;
    }
    if (question.type === 'choice') {
      if (
        !('instructions' in question) ||
        !isRecord(question.criteria) ||
        Object.keys(question.criteria).length < 2 ||
        Object.keys(question.criteria).length > 255
      ) {
        throw new JevClientError('request_invalid');
      }
      continue;
    }
    if (
      question.type !== 'score' ||
      !('instructions' in question) ||
      !Array.isArray(question.criteria) ||
      question.criteria.length < 2 ||
      question.criteria.length > 10
    ) {
      throw new JevClientError('request_invalid');
    }
  }
}

function assertProbabilityDistribution(
  probabilities: unknown,
  expectedKeys: readonly string[],
): asserts probabilities is Record<string, number> {
  if (!isRecord(probabilities)) throw new JevClientError('response_invalid');
  const keys = Object.keys(probabilities).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new JevClientError('response_invalid');
  }
  const values = Object.values(probabilities) as number[];
  if (values.some((value) => !isFiniteProbability(value))) {
    throw new JevClientError('response_invalid');
  }
  const total = values.reduce((sum: number, value: number) => sum + value, 0);
  if (Math.abs(total - 1) > 0.01) throw new JevClientError('response_invalid');
}

function parseAnswer(question: JevQuestion, value: unknown): JevAnswer {
  if (!isRecord(value) || value.type !== question.type)
    throw new JevClientError('response_invalid');
  if (question.type === 'noul') {
    if (!isFiniteProbability(value.noul)) throw new JevClientError('response_invalid');
    return Object.freeze({ type: 'noul', noul: value.noul });
  }
  if (question.type === 'choice') {
    const choice = value.choice;
    if (
      typeof choice !== 'string' ||
      !Object.prototype.hasOwnProperty.call(question.criteria, choice)
    ) {
      throw new JevClientError('response_invalid');
    }
    assertProbabilityDistribution(value.probabilities, Object.keys(question.criteria));
    if (!isFiniteProbability(value.confidence)) throw new JevClientError('response_invalid');
    const answer: JevChoiceAnswer = {
      type: 'choice',
      choice,
      probabilities: Object.freeze({ ...value.probabilities }),
      confidence: value.confidence,
    };
    return Object.freeze(answer);
  }
  const scoreQuestion = question as JevScoreQuestion;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    throw new JevClientError('response_invalid');
  }
  if (value.score < 0 || value.score > scoreQuestion.criteria.length - 1) {
    throw new JevClientError('response_invalid');
  }
  const expectedLegend = Object.fromEntries(
    scoreQuestion.criteria.map((item, index) => [
      String(index),
      typeof item === 'string' ? item : JSON.stringify(item),
    ]),
  );
  if (!isRecord(value.legend)) {
    throw new JevClientError('response_invalid');
  }
  for (const [key, expected] of Object.entries(expectedLegend)) {
    if (typeof value.legend[key] !== 'string' || value.legend[key] !== expected) {
      throw new JevClientError('response_invalid');
    }
  }
  assertProbabilityDistribution(value.probabilities, Object.keys(expectedLegend));
  if (!isFiniteProbability(value.confidence)) throw new JevClientError('response_invalid');
  const answer: JevScoreAnswer = {
    type: 'score',
    score: value.score,
    legend: Object.freeze({ ...expectedLegend }),
    probabilities: Object.freeze({ ...value.probabilities }),
    confidence: value.confidence,
  };
  return Object.freeze(answer);
}

function parseUsage(value: unknown): JevUsage {
  if (value === undefined || value === null) {
    return Object.freeze({ inputTokens: null, outputTokens: null, costUsd: null });
  }
  if (!isRecord(value)) throw new JevClientError('response_invalid');
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  const costUsd = value.cost_usd;
  const parsedInputTokens = inputTokens === undefined ? null : inputTokens;
  const parsedOutputTokens = outputTokens === undefined ? null : outputTokens;
  if (
    (parsedInputTokens !== null && !isNonNegativeSafeInteger(parsedInputTokens)) ||
    (parsedOutputTokens !== null && !isNonNegativeSafeInteger(parsedOutputTokens)) ||
    (costUsd !== undefined &&
      (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0))
  ) {
    throw new JevClientError('response_invalid');
  }
  return Object.freeze({
    inputTokens: parsedInputTokens as number | null,
    outputTokens: parsedOutputTokens as number | null,
    costUsd: costUsd === undefined ? null : costUsd,
  });
}

export function parseJevResponse(
  value: unknown,
  questions: JevQuestions,
): Omit<JevEvaluation, 'observedAt'> {
  assertQuestionMap(questions);
  if (
    !isRecord(value) ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    value.model.length > 256 ||
    !isRecord(value.answers)
  ) {
    throw new JevClientError('response_invalid');
  }
  const answersRecord = value.answers as Record<string, unknown>;
  const expectedIds = Object.keys(questions).sort();
  const answerIds = Object.keys(answersRecord).sort();
  if (
    expectedIds.length !== answerIds.length ||
    expectedIds.some((id, index) => id !== answerIds[index])
  ) {
    throw new JevClientError('response_invalid');
  }
  const answers = Object.fromEntries(
    expectedIds.map((id) => [id, parseAnswer(questions[id]!, answersRecord[id])]),
  );
  return Object.freeze({
    model: value.model.trim(),
    answers: Object.freeze(answers),
    usage: parseUsage(value.usage),
  });
}

/** Adapt the native secure bridge without allowing a renderer key or raw error body through. */
export function createJevTransportFromNative(bridge: JevNativeHttpBridge): JevTransport {
  if (!bridge || typeof bridge.jev_http_systemone !== 'function') {
    throw new Error('jev_native_bridge_missing');
  }
  return async ({ body, signal }) => {
    const result = await bridge.jev_http_systemone({ request: body, signal });
    if (result.kind !== 'ok') throw new JevClientError('transport_unavailable');
    if (!result.usage || !isRecord(result.body) || Array.isArray(result.body)) return result.body;
    const existingUsage = isRecord(result.body.usage) ? result.body.usage : {};
    return {
      ...result.body,
      usage: {
        ...existingUsage,
        ...(result.usage.inputTokens === undefined
          ? {}
          : { input_tokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined
          ? {}
          : { output_tokens: result.usage.outputTokens }),
        ...(result.usage.costUsd === undefined ? {} : { cost_usd: result.usage.costUsd }),
      },
    };
  };
}

export function createJevProbeFromNative(bridge: JevNativeHttpBridge): JevTransportProbe {
  if (!bridge || typeof bridge.jev_http_models !== 'function') {
    throw new Error('jev_native_bridge_missing');
  }
  return async ({ signal }) => {
    const result = await bridge.jev_http_models({ signal });
    if (result.kind !== 'connected') {
      return Object.freeze({ available: false, modelIds: Object.freeze([]) });
    }
    return Object.freeze({
      available: true,
      modelIds: Object.freeze(result.models.map((model) => model.id)),
    });
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (isRecord(error) && error.name === 'AbortError')
  );
}

function mergedAbortSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
  abortPromise: Promise<never>;
} {
  const controller = new AbortController();
  let rejectAbort!: (error: unknown) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(new DOMException('aborted', 'AbortError'));
  };
  const timeout = setTimeout(() => {
    controller.abort();
    rejectAbort(new JevClientError('transport_timeout'));
  }, timeoutMs);
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  return {
    signal: controller.signal,
    abortPromise,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener('abort', abort);
    },
  };
}

async function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  external: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const merged = mergedAbortSignal(external, timeoutMs);
  void merged.abortPromise.catch(() => undefined);
  const operationPromise = Promise.resolve().then(() => operation(merged.signal));
  // A native promise may ignore AbortSignal. Attach a rejection handler so its
  // eventual result cannot produce an unhandled rejection after the timeout.
  void operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, merged.abortPromise]);
  } finally {
    merged.cleanup();
  }
}

function reportUsage(
  callback:
    | ((
        usage: Readonly<{
          model: string;
          usage: JevUsage;
          latencyMs: number;
          status: 'ok' | 'error';
        }>,
      ) => void)
    | undefined,
  value: Readonly<{ model: string; usage: JevUsage; latencyMs: number; status: 'ok' | 'error' }>,
): void {
  try {
    callback?.(value);
  } catch {
    // Usage persistence is observational and must never invalidate a valid Jev decision.
  }
}

export function createJevClient(input: {
  transport: JevTransport;
  probe?: JevTransportProbe;
  model?: string;
  timeoutMs?: number;
  now?: () => number;
  onUsage?: (
    usage: Readonly<{ model: string; usage: JevUsage; latencyMs: number; status: 'ok' | 'error' }>,
  ) => void;
}): JevClient {
  if (typeof input.transport !== 'function') throw new Error('jev_transport_missing');
  const model = input.model?.trim() || JEV_MODEL_ALIAS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('jev_timeout_invalid');
  }
  const now = input.now ?? Date.now;
  return Object.freeze({
    async evaluate(request) {
      assertQuestionMap(request.questions);
      if (request.state === undefined) throw new JevClientError('request_invalid');
      const startedAt = now();
      try {
        const raw = await runBounded(
          (signal) =>
            input.transport({
              body: { state: request.state, model, questions: request.questions },
              signal,
            }),
          request.signal,
          timeoutMs,
        );
        const parsed = parseJevResponse(raw, request.questions);
        reportUsage(input.onUsage, {
          model: parsed.model,
          usage: parsed.usage,
          latencyMs: Math.max(0, now() - startedAt),
          status: 'ok',
        });
        return Object.freeze({ ...parsed, observedAt: now() });
      } catch (error) {
        if (isAbortError(error)) throw error;
        reportUsage(input.onUsage, {
          model,
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
          latencyMs: Math.max(0, now() - startedAt),
          status: 'error',
        });
        if (error instanceof JevClientError) throw error;
        throw new JevClientError('transport_unavailable');
      }
    },
    ...(input.probe
      ? {
          async probe(probeInput?: { signal?: AbortSignal }) {
            try {
              return await runBounded(
                (signal) => input.probe!({ signal }),
                probeInput?.signal,
                timeoutMs,
              );
            } catch (error) {
              if (isAbortError(error)) throw error;
              throw new JevClientError('transport_unavailable');
            }
          },
        }
      : {}),
  });
}
