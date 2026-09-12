import { createContextPointer, type ContextPointer } from './losslessContext';
import type {
  ContextOpenResult,
  ContextQueryService,
  ContextScope,
  ContextSearchItem,
} from './contextQueryService';

export const RLM_CHILD_PROVIDER = 'ollama' as const;
export const RLM_CHILD_MODEL = 'llama3.2:latest' as const;

export interface RlmBudget {
  maxDepth: number;
  maxSubcalls: number;
  maxConcurrentSubcalls: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxOpenBytes: number;
}

export interface RlmChildRequest {
  question: string;
  evidence: readonly ContextOpenResult[];
  sourcePointers: readonly ContextPointer[];
  provider: typeof RLM_CHILD_PROVIDER;
  model: typeof RLM_CHILD_MODEL;
  depth: number;
  budget: Readonly<{
    maxInputTokens?: number;
    maxOutputTokens?: number;
  }>;
  signal: AbortSignal;
}

export interface RlmChildAnalysis {
  answer: string;
  citations: readonly ContextPointer[];
  followups?: readonly string[];
  depth?: number;
}

export interface RlmSynthesisRequest {
  question: string;
  scope: ContextScope;
  evidence: readonly ContextOpenResult[];
  childAnalyses: readonly RlmChildAnalysis[];
  signal: AbortSignal;
}

export interface RlmSynthesis {
  answer: string;
  citations: readonly ContextPointer[];
}

export type RlmTraceEventType =
  | 'root_started'
  | 'search_completed'
  | 'evidence_opened'
  | 'child_started'
  | 'child_completed'
  | 'child_failed'
  | 'synthesized'
  | 'cancelled'
  | 'wall_time_exceeded';

export interface RlmTraceEvent {
  type: RlmTraceEventType;
  at: number;
  depth: number;
  detail?: string;
}

export interface RlmRuntimeResult extends RlmSynthesis {
  trace: Readonly<{
    mode: 'rlm';
    runId: string;
    wallTimeMs: number;
    events: readonly RlmTraceEvent[];
    usage: Readonly<{
      subcalls: number;
      toolCalls: number;
      openBytes: number;
      maxDepthReached: number;
    }>;
    budget: Readonly<RlmBudget>;
    budgetExhausted: boolean;
  }>;
}

export type RlmRuntimeErrorCode =
  | 'cancelled'
  | 'wall_time_exceeded'
  | 'budget_invalid'
  | 'no_evidence';

export class RlmRuntimeError extends Error {
  constructor(
    readonly code: RlmRuntimeErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'RlmRuntimeError';
  }
}

interface RlmContextTools {
  search: ContextQueryService['search'];
  open: ContextQueryService['open'];
}

function positiveInteger(value: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function validateBudget(budget: RlmBudget): Readonly<RlmBudget> {
  if (
    !positiveInteger(budget.maxDepth, true) ||
    !positiveInteger(budget.maxSubcalls) ||
    !positiveInteger(budget.maxConcurrentSubcalls) ||
    !positiveInteger(budget.maxWallTimeMs) ||
    !positiveInteger(budget.maxToolCalls) ||
    !positiveInteger(budget.maxOpenBytes) ||
    (budget.maxInputTokens !== undefined && !positiveInteger(budget.maxInputTokens)) ||
    (budget.maxOutputTokens !== undefined && !positiveInteger(budget.maxOutputTokens))
  ) {
    throw new RlmRuntimeError('budget_invalid');
  }
  return Object.freeze({ ...budget });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function trimUtf8(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maximumBytes));
}

function retrievalQuery(question: string): string {
  const bracketed = question.match(/\[([^\]]{1,1024})\]/u)?.[1]?.trim();
  const normalized = bracketed?.replace(/\s+/gu, ' ');
  return normalized && !normalized.includes('"') ? `"${normalized}"` : normalized || question;
}

function abortError(signal: AbortSignal, timedOut: boolean): RlmRuntimeError {
  return new RlmRuntimeError(timedOut ? 'wall_time_exceeded' : 'cancelled', String(signal.reason));
}

async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<T> {
  if (signal.aborted) throw abortError(signal, timedOut());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal, timedOut()));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function partitions<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function createRlmRuntime(dependencies: {
  contextTools: RlmContextTools;
  childRunner(request: RlmChildRequest): Promise<RlmChildAnalysis>;
  synthesize(request: RlmSynthesisRequest): Promise<RlmSynthesis>;
  partitionSize?: number;
}) {
  const partitionSize = Math.max(1, Math.floor(dependencies.partitionSize ?? 2));

  const investigate = async (input: {
    question: string;
    scope: ContextScope;
    budget: RlmBudget;
    signal?: AbortSignal;
  }): Promise<RlmRuntimeResult> => {
    const budget = validateBudget(input.budget);
    if (!input.question.trim()) throw new RlmRuntimeError('no_evidence', 'question_missing');
    const startedAt = Date.now();
    const runId = `rlm-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const controller = new AbortController();
    let timedOut = false;
    const onOwnerAbort = () => controller.abort(input.signal?.reason ?? 'owner_cancelled');
    input.signal?.addEventListener('abort', onOwnerAbort, { once: true });
    if (input.signal?.aborted) onOwnerAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('rlm_wall_time_exceeded');
    }, budget.maxWallTimeMs);
    const signal = controller.signal;
    const events: RlmTraceEvent[] = [];
    const usage = { subcalls: 0, toolCalls: 0, openBytes: 0, maxDepthReached: 0 };
    let budgetExhausted = false;
    const event = (type: RlmTraceEventType, depth: number, detail?: string) => {
      events.push({ type, at: Date.now(), depth, ...(detail ? { detail } : {}) });
    };

    try {
      const searchQuery = retrievalQuery(input.question);
      event('root_started', 0, `run=${runId}`);
      usage.toolCalls += 1;
      const found = await abortable(
        dependencies.contextTools.search({
          scope: input.scope,
          query: searchQuery,
          limit: Math.max(1, budget.maxToolCalls - 1),
          signal,
        }),
        signal,
        () => timedOut,
      );
      event('search_completed', 0, `strategy=exact_anchor query=${searchQuery} hits=${found.items.length}`);

      const evidence: ContextOpenResult[] = [];
      for (const item of found.items as readonly ContextSearchItem[]) {
        if (usage.toolCalls >= budget.maxToolCalls || usage.openBytes >= budget.maxOpenBytes) {
          budgetExhausted = true;
          break;
        }
        usage.toolCalls += 1;
        const opened = await abortable(
          dependencies.contextTools.open({
            scope: input.scope,
            pointer: item.pointer,
            maxBytes: budget.maxOpenBytes - usage.openBytes,
            signal,
          }),
          signal,
          () => timedOut,
        );
        const remaining = budget.maxOpenBytes - usage.openBytes;
        const text = trimUtf8(opened.text, remaining);
        const openedBytes = byteLength(text);
        if (openedBytes === 0) continue;
        usage.openBytes += openedBytes;
        const exactPointer = createContextPointer({
          ...opened.pointer,
          byteStart: opened.byteStart,
          byteEnd: opened.byteStart + openedBytes,
          lineStart: undefined,
          lineEnd: undefined,
        });
        evidence.push({
          ...opened,
          pointer: exactPointer,
          text,
          byteEnd: opened.byteStart + openedBytes,
          truncated: opened.truncated || text !== opened.text,
        });
        event(
          'evidence_opened',
          0,
          `record=${item.record.id} pointer=${exactPointer.id} bytes=${openedBytes} truncated=${String(
            opened.truncated || text !== opened.text,
          )}`,
        );
        if (text !== opened.text) {
          budgetExhausted = true;
          break;
        }
      }
      if (evidence.length === 0) throw new RlmRuntimeError('no_evidence');

      const work = partitions(evidence, partitionSize);
      if (work.length > budget.maxSubcalls) budgetExhausted = true;
      const childAnalyses: RlmChildAnalysis[] = [];
      let nextPartition = 0;

      const runChild = async (
        narrowEvidence: readonly ContextOpenResult[],
        question: string,
        depth: number,
      ): Promise<void> => {
        if (depth > budget.maxDepth || usage.subcalls >= budget.maxSubcalls) {
          budgetExhausted = true;
          return;
        }
        usage.subcalls += 1;
        usage.maxDepthReached = Math.max(usage.maxDepthReached, depth);
        event(
          'child_started',
          depth,
          `provider=${RLM_CHILD_PROVIDER} model=${RLM_CHILD_MODEL} evidence=${narrowEvidence.length}`,
        );
        try {
          const analysis = await abortable(
            dependencies.childRunner({
              question,
              evidence: narrowEvidence,
              sourcePointers: narrowEvidence.map((item) => item.pointer),
              provider: RLM_CHILD_PROVIDER,
              model: RLM_CHILD_MODEL,
              depth,
              budget: {
                ...(budget.maxInputTokens === undefined
                  ? {}
                  : { maxInputTokens: budget.maxInputTokens }),
                ...(budget.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: budget.maxOutputTokens }),
              },
              signal,
            }),
            signal,
            () => timedOut,
          );
          const normalized = { ...analysis, depth };
          childAnalyses.push(normalized);
          event('child_completed', depth);
          for (const followup of analysis.followups ?? []) {
            if (depth >= budget.maxDepth) {
              budgetExhausted = true;
              break;
            }
            await runChild(narrowEvidence, followup, depth + 1);
          }
        } catch (error) {
          if (signal.aborted) throw abortError(signal, timedOut);
          event('child_failed', depth, error instanceof Error ? error.name : 'unknown');
        }
      };

      const worker = async () => {
        while (true) {
          if (usage.subcalls >= budget.maxSubcalls) {
            budgetExhausted = nextPartition < work.length;
            return;
          }
          const index = nextPartition;
          nextPartition += 1;
          if (index >= work.length) return;
          await runChild(work[index], input.question, 1);
        }
      };
      const workerCount = Math.min(budget.maxConcurrentSubcalls, budget.maxSubcalls, work.length);
      await abortable(
        Promise.all(Array.from({ length: workerCount }, () => worker())),
        signal,
        () => timedOut,
      );

      const synthesis = await abortable(
        dependencies.synthesize({
          question: input.question,
          scope: input.scope,
          evidence,
          childAnalyses,
          signal,
        }),
        signal,
        () => timedOut,
      );
      event('synthesized', 0);
      budgetExhausted =
        budgetExhausted ||
        found.truncated ||
        evidence.length < found.items.length ||
        usage.openBytes >= budget.maxOpenBytes ||
        usage.toolCalls >= budget.maxToolCalls ||
        work.length > usage.subcalls;
      return {
        ...synthesis,
        trace: Object.freeze({
          mode: 'rlm' as const,
          runId,
          wallTimeMs: Math.max(0, Date.now() - startedAt),
          events: Object.freeze([...events]),
          usage: Object.freeze({ ...usage }),
          budget,
          budgetExhausted,
        }),
      };
    } catch (error) {
      if (signal.aborted) {
        event(timedOut ? 'wall_time_exceeded' : 'cancelled', 0);
        throw abortError(signal, timedOut);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onOwnerAbort);
    }
  };

  return Object.freeze({ investigate });
}

export type RlmRuntime = ReturnType<typeof createRlmRuntime>;
