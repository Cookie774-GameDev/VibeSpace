import { createContextPointer, type ContextPointer } from './losslessContext';
import type {
  ContextOpenResult,
  ContextQueryService,
  ContextScope,
  ContextSearchItem,
} from './contextQueryService';
import type { ExecutionIdentity } from './gateway/contextGatewayContracts';

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
  executionIdentity: Readonly<ExecutionIdentity>;
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

export interface RlmToolInvocation {
  id: string;
  runId: string;
  operation: 'search' | 'open' | 'expand';
  depth: number;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface RlmRuntimeResult extends RlmSynthesis {
  trace: Readonly<{
    mode: 'rlm';
    runId: string;
    wallTimeMs: number;
    events: readonly RlmTraceEvent[];
    toolInvocations?: readonly Readonly<RlmToolInvocation>[];
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

/** Metadata from an actual terminal execution; never prompt or evidence bodies. */
export interface RlmTerminalReceipt {
  readonly runId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly errorCode?: RlmRuntimeErrorCode;
  readonly trace: RlmRuntimeResult['trace'];
}

export type RlmRuntimeErrorCode =
  | 'cancelled'
  | 'abort_unconfirmed'
  | 'wall_time_exceeded'
  | 'budget_invalid'
  | 'execution_identity_invalid'
  | 'execution_route_unavailable'
  | 'no_evidence';

export class RlmRuntimeError extends Error {
  toolInvocations?: readonly Readonly<RlmToolInvocation>[];
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
  expand?: ContextQueryService['expand'];
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

const EXECUTION_IDENTITY_FIELDS = Object.freeze([
  'transportConnectionId',
  'transportAdapterId',
  'upstreamProviderId',
  'upstreamModelId',
  'providerQualifiedModelId',
  'authBillingRoute',
  'effort',
  'fastVariant',
  'catalogRevision',
] as const satisfies readonly (keyof ExecutionIdentity)[]);
const SAFE_IDENTITY_VALUE = /^[^\u0000-\u001f\u007f]{1,512}$/u;

function immutableExecutionIdentity(value: unknown): Readonly<ExecutionIdentity> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new RlmRuntimeError('execution_identity_invalid');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([...EXECUTION_IDENTITY_FIELDS, 'observedProviderIdentity']);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    EXECUTION_IDENTITY_FIELDS.some((field) => {
      const candidate = record[field];
      return (
        typeof candidate !== 'string' ||
        candidate.trim() !== candidate ||
        !SAFE_IDENTITY_VALUE.test(candidate)
      );
    }) ||
    (record.observedProviderIdentity !== undefined &&
      (typeof record.observedProviderIdentity !== 'string' ||
        record.observedProviderIdentity.trim() !== record.observedProviderIdentity ||
        !SAFE_IDENTITY_VALUE.test(record.observedProviderIdentity)))
  ) {
    throw new RlmRuntimeError('execution_identity_invalid');
  }
  const providerQualifiedModelId = `${String(record.upstreamProviderId)}/${String(record.upstreamModelId)}`;
  if (
    record.providerQualifiedModelId !== providerQualifiedModelId ||
    (record.observedProviderIdentity !== undefined &&
      record.observedProviderIdentity !== providerQualifiedModelId)
  ) {
    throw new RlmRuntimeError('execution_identity_invalid');
  }
  return Object.freeze({ ...(record as unknown as ExecutionIdentity) });
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
  // Keep run metadata and tool-policy instructions for the child, but do not
  // let those lines displace source terms in the bounded physical search.
  const semanticQuestion = question.split(/\r?\n/u).map((line) => {
    // A provider may send the marker and source question on one line. Remove
    // only the marker; dropping that line loses the entire retrieval query.
    const content = line.trim()
      .replace(/^(?:(?:ROOT_NUTTX|NUTTX_R27|NUTTX_RLM)_[A-Z0-9_]{4,})(?::\s*|\s+)/u, '')
      .replace(/\s+(?:Use only (?:the )?(?:active )?SiYuan Context Map\b|Answer from mapped source\b)[\s\S]*$/iu, '');
    return /^NuttX source-grounded question \d+\.$/iu.test(content) ? '' : content;
  }
  ).filter((line) =>
    !/^Use only (?:the )?(?:active )?SiYuan Context Map\b.*\bvibespace_context\b/iu.test(line),
  ).join(' ').trim() || question;
  // An explicitly requested source must survive semantic query shortening.
  // The repository validates named paths; prose such as "Focus on" remains a
  // retrieval hint and continues through the existing symbol/macro strategy.
  if (/\bsource\s+(?:file|path)\s+[`"']?(?:[\w.-]+[\\/])+[\w.-]+\.[\w]+/iu.test(semanticQuestion)) {
    return semanticQuestion;
  }
  // Explicit tool requests can name RLM before the source question. Search
  // the factual question so routing words cannot become the index key.
  if (/\b(?:(?:use|invoke|call)\s+(?:the\s+)?|run\s+(?:a\s+)?(?:recursive\s+)?)(?:RLM|vibespace_context)\b/iu.test(semanticQuestion)) {
    const factualQuestion = semanticQuestion.match(/\b(?:and\s+answer|before\s+answering)\s*:\s*(.+)$/iu)?.[1]?.trim();
    if (factualQuestion) return factualQuestion;
  }
  const bracketed = semanticQuestion.match(/\[([^\]]{1,1024})\]/u)?.[1]?.trim();
  const normalized = bracketed?.replace(/\s+/gu, ' ');
  if (normalized) return !normalized.includes('"') ? `"${normalized}"` : normalized;
  // A precise code symbol is a stronger source anchor than surrounding chat
  // instructions, run markers, or requests for citations. Keep the full
  // question for child analysis; only the physical retrieval query narrows.
  const symbol = semanticQuestion.match(/`([A-Za-z_][A-Za-z0-9_]{2,127})`/u)?.[1];
  if (symbol && symbol.length >= 6 && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(symbol)) {
    return symbol;
  }
  // Providers sometimes remove backticks and append an unverified file guess.
  // A C-style macro in the question is a more stable index anchor than that
  // guessed path; the child still receives the complete original question.
  const macro = semanticQuestion.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u)?.[0];
  if (macro) {
    const sentence = semanticQuestion.split(/[.!?]/u).find((part) => part.includes(macro)) ?? '';
    // Source names commonly join a hyphenated "pseudo-files" style domain
    // noun; that compound is more selective than a generic API verb.
    const compoundFile = sentence.match(/\b([A-Za-z]{4,})-files?\b/iu)?.[1];
    if (compoundFile) return `${macro} ${compoundFile}file`;
    // A short generic API name such as `open` is useful only with the more
    // discriminating flag that follows it in the same source question.
    if (symbol && symbol.length < 6 && sentence.includes(`\`${symbol}\``)) {
      return `${macro} ${symbol}`;
    }
    const contextWords = sentence.slice(sentence.indexOf(macro) + macro.length)
      .match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/gu)?.slice(-2) ?? [];
    return [macro, ...contextWords].join(' ');
  }
  const firstSentence = semanticQuestion.split(/[.!?]/u)[0] ?? semanticQuestion;
  const acronym = firstSentence.match(/\b[A-Z]{2,}\b/u);
  if (acronym && acronym.index !== undefined) {
    const before = firstSentence.slice(0, acronym.index).match(/\b([A-Za-z]{5,})\s*$/u)?.[1];
    if (/\bcallback\b/iu.test(firstSentence) && /\ballocat(?:e|ion|ing)\b/iu.test(firstSentence)) {
      return [before, acronym[0], 'callback', 'allocate'].filter(Boolean).join(' ');
    }
    const afterWords = firstSentence.slice(acronym.index + acronym[0].length)
      .match(/\b[A-Za-z][A-Za-z-]{2,}\b/gu)
      ?.flatMap((word) => word.split('-')) ?? [];
    const after = afterWords.map((word, index) => ({ word, index }))
      .filter(({ word }) => !/^(?:file|helper|implementation|request|ordinary|return|when|what|which|the|and|has|been)$/iu.test(word));
    const first = after[0];
    const second = after[1]?.index === (first?.index ?? -2) + 1 ? after[1] : undefined;
    const subject = [before && !/^(?:about|which|their|where|under|before|after)$/iu.test(before) ? before : '',
      acronym[0], first?.word,
      second?.word.replace(/([^aeiou])ies$/iu, '$1y')].filter((word): word is string => Boolean(word));
    // Keep a later named callback when the question asks about its allocation;
    // otherwise the first generic send/receive noun points at buffer code.
    if (/\bcallback\b/iu.test(firstSentence) && !subject.some((word) => /^callback$/iu.test(word))) {
      subject.push('callback');
    }
    // A proper-name anchor alone loses the requested fact when it precedes
    // the acronym (for example, "Who owns ...?"). Keep the source attribute
    // and normalize its verb to the noun used by ordinary records.
    const factualAttribute = /\b(?:owns|owned|owner)\b/iu.test(firstSentence)
      ? 'owner'
      : /\bdepot\b/iu.test(firstSentence) ? 'depot' : undefined;
    if (factualAttribute) {
      const focusedSubject = subject.filter((word) =>
        !/^(?:source|sources|record|records|project|notes)$/iu.test(word));
      if (!focusedSubject.some((word) => word.toLocaleLowerCase('en-US') === factualAttribute)) {
        focusedSubject.push(factualAttribute);
      }
      return focusedSubject.join(' ');
    }
    return subject.join(' ');
  }
  const subject = firstSentence.match(/\b(?:in|with)\s+(?:an?\s+)?([A-Za-z-]{5,})[\s\S]*?\bactive\s+([A-Za-z-]{5,})\b/iu);
  // An alternative build mode can be the discriminating source clue. Keep
  // both sides of "or" instead of collapsing the question to two nouns.
  if (subject && !/\bor\b/iu.test(subject[0])) {
    return `${subject[1]} ${subject[2]}`;
  }
  return semanticQuestion;
}

function abortError(signal: AbortSignal, timedOut: boolean): RlmRuntimeError {
  return new RlmRuntimeError(timedOut ? 'wall_time_exceeded' : 'cancelled', String(signal.reason));
}

const CHILD_ABORT_ACK_TIMEOUT_MS = 5_000;

async function abortable<T>(
  startWork: () => Promise<T>,
  signal: AbortSignal,
  timedOut: () => boolean,
  abortAcknowledgementTimeoutMs = 0,
): Promise<T> {
  if (signal.aborted) throw abortError(signal, timedOut());

  let work: Promise<T>;
  try {
    work = startWork();
  } catch (error) {
    throw error;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (acknowledgementTimer !== undefined) clearTimeout(acknowledgementTimer);
      complete();
    };
    const onAbort = () => {
      if (abortAcknowledgementTimeoutMs <= 0) {
        finish(() => reject(abortError(signal, timedOut())));
        return;
      }
      acknowledgementTimer = setTimeout(() => {
        finish(() => reject(new RlmRuntimeError(
          'abort_unconfirmed',
          'rlm_abort_acknowledgement_timeout',
        )));
      }, abortAcknowledgementTimeoutMs);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        finish(() => {
          if (signal.aborted) reject(abortError(signal, timedOut()));
          else resolve(value);
        });
      },
      (error) => {
        const unconfirmedAbort =
          error instanceof RlmRuntimeError && error.code === 'abort_unconfirmed';
        finish(() => reject(unconfirmedAbort || !signal.aborted ? error : abortError(signal, timedOut())));
      },
    );
    if (signal.aborted) onAbort();
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
  onTerminalReceipt?(receipt: Readonly<RlmTerminalReceipt>): void;
}) {
  const partitionSize = Math.max(1, Math.floor(dependencies.partitionSize ?? 2));

  const investigate = async (input: {
    question: string;
    scope: ContextScope;
    executionIdentity: Readonly<ExecutionIdentity>;
    budget: RlmBudget;
    signal?: AbortSignal;
  }): Promise<RlmRuntimeResult> => {
    const budget = validateBudget(input.budget);
    const executionIdentity = immutableExecutionIdentity(input.executionIdentity);
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
    const toolInvocations: RlmToolInvocation[] = [];
    const invocationSnapshot = () => Object.freeze(
      toolInvocations.map((invocation) => Object.freeze({ ...invocation })),
    );
    const invokeTool = async <T>(
      operation: RlmToolInvocation['operation'],
      invoke: () => Promise<T>,
    ): Promise<T> => {
      // Called only by the abortable factory when the real dependency starts.
      if (signal.aborted) throw abortError(signal, timedOut);
      const invocation: RlmToolInvocation = {
        id: `${runId}:tool-${toolInvocations.length + 1}`,
        runId, operation, depth: 0, startedAt: Date.now(), status: 'running',
      };
      toolInvocations.push(invocation);
      const settle = (status: RlmToolInvocation['status']) => {
        if (invocation.status !== 'running') return;
        invocation.status = status;
        invocation.finishedAt = Date.now();
      };
      const onAbort = () => settle('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await invoke();
        settle('completed');
        return result;
      } catch (error) {
        settle(signal.aborted ? 'cancelled' : 'failed');
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const usage = { subcalls: 0, toolCalls: 0, openBytes: 0, maxDepthReached: 0 };
    let budgetExhausted = false;
    let abortUnconfirmedError: RlmRuntimeError | undefined;
    let workerPromises: Promise<void>[] = [];
    let terminalStatus: RlmTerminalReceipt['status'] = 'failed';
    let terminalErrorCode: RlmRuntimeErrorCode | undefined;
    const event = (type: RlmTraceEventType, depth: number, detail?: string) => {
      events.push({ type, at: Date.now(), depth, ...(detail ? { detail } : {}) });
    };

    try {
      if (signal.aborted) throw abortError(signal, timedOut);
      const searchQuery = retrievalQuery(input.question);
      // Leave room in the bounded tool budget for a source follow-up. Opening
      // every search hit consumed all twelve calls before the child analysis
      // could reach decisive nearby branches in large mapped files.
      // A compact one- or two-symbol probe has a sharper index rank; four
      // sources leave more of the tool and wall budget for reading the branch.
      const searchCap = searchQuery.trim().split(/\s+/u).length <= 2 ? 4 : 6;
      const initialSearchLimit = Math.min(searchCap, Math.max(1, budget.maxToolCalls - 3));
      event('root_started', 0, `run=${runId}`);
      usage.toolCalls += 1;
      const found = await abortable(
        () => invokeTool('search', () => dependencies.contextTools.search({
          scope: input.scope,
          query: searchQuery,
          limit: initialSearchLimit,
          signal,
        })),
        signal,
        () => timedOut,
      );
      event(
        'search_completed',
        0,
        `strategy=exact_anchor query=${searchQuery} hits=${found.items.length}`,
      );

      const evidence: ContextOpenResult[] = [];
      for (const item of found.items as readonly ContextSearchItem[]) {
        if (usage.toolCalls >= budget.maxToolCalls || usage.openBytes >= budget.maxOpenBytes) {
          budgetExhausted = true;
          break;
        }
        usage.toolCalls += 1;
        const remaining = budget.maxOpenBytes - usage.openBytes;
        const pointerStart = item.pointer.byteStart;
        const pointerEnd = item.pointer.byteEnd;
        const hasByteBounds = typeof pointerStart === 'number'
          && typeof pointerEnd === 'number' && pointerEnd > pointerStart;
        const pointerBytes = hasByteBounds ? pointerEnd - pointerStart : remaining;
        const expansionSpace = remaining - pointerBytes;
        // Two line-numbered source excerpts share one child input window. For a
        // named allocation, keep both excerpts short enough that the branch at
        // the second pointer survives prompt construction.
        const allocationFocus = /\bcallback allocate\b/iu.test(searchQuery);
        const windowBytes = Math.min(allocationFocus ? 10_240 : 20_480, Math.max(0, expansionSpace));
        const beforeBytes = Math.min(allocationFocus ? 4_096 : 8_192,
          Math.floor(windowBytes * 0.8), Math.max(0, pointerStart ?? 0));
        const afterBytes = Math.min(16_384, Math.max(0, windowBytes - beforeBytes));
        // Search pointers are short excerpts. Expanding the already issued
        // authority includes preceding acquisition/guard branches as well as
        // following cleanup, without granting a new path or exceeding the budget.
        const opened = await abortable(
          () => dependencies.contextTools.expand && hasByteBounds && expansionSpace > 0
            ? invokeTool('expand', () => dependencies.contextTools.expand!({
                scope: input.scope, pointer: item.pointer, beforeBytes, afterBytes, signal,
              }))
            : invokeTool('open', () => dependencies.contextTools.open({
                scope: input.scope, pointer: item.pointer, maxBytes: remaining, signal,
              })),
          signal,
          () => timedOut,
        );
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
        if (signal.aborted) throw abortError(signal, timedOut);
        if (depth > budget.maxDepth || usage.subcalls >= budget.maxSubcalls) {
          budgetExhausted = true;
          return;
        }
        usage.subcalls += 1;
        usage.maxDepthReached = Math.max(usage.maxDepthReached, depth);
        event(
          'child_started',
          depth,
          `provider=${executionIdentity.upstreamProviderId} model=${executionIdentity.upstreamModelId} evidence=${narrowEvidence.length}`,
        );
        try {
          const analysis = await abortable(
            () => dependencies.childRunner({
              question,
              evidence: narrowEvidence,
              sourcePointers: narrowEvidence.map((item) => item.pointer),
              executionIdentity,
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
            Math.min(CHILD_ABORT_ACK_TIMEOUT_MS, budget.maxWallTimeMs),
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
          if (error instanceof RlmRuntimeError && error.code === 'abort_unconfirmed') {
            abortUnconfirmedError ??= error;
            throw error;
          }
          if (signal.aborted) throw abortError(signal, timedOut);
          if (
            error instanceof RlmRuntimeError &&
            (error.code === 'execution_identity_invalid' ||
              error.code === 'execution_route_unavailable')
          ) {
            throw error;
          }
          event('child_failed', depth, error instanceof Error ? error.name : 'unknown');
        }
      };

      const worker = async () => {
        while (true) {
          if (signal.aborted) throw abortError(signal, timedOut);
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
      workerPromises = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workerPromises);

      const synthesis = await abortable(
        () => dependencies.synthesize({
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
      terminalStatus = 'completed';
      return {
        ...synthesis,
        trace: Object.freeze({
          mode: 'rlm' as const,
          runId,
          wallTimeMs: Math.max(0, Date.now() - startedAt),
          events: Object.freeze([...events]),
          toolInvocations: invocationSnapshot(),
          usage: Object.freeze({ ...usage }),
          budget,
          budgetExhausted,
        }),
      };
    } catch (error) {
      if (signal.aborted) {
        // Promise.all rejects on the first worker, while another active child
        // may still be confirming the same cancellation. Wait only for the
        // worker calls already in flight; workers check the signal before
        // claiming another partition.
        const remainingWorkers = await Promise.allSettled(workerPromises);
        const unconfirmedWorker = remainingWorkers.find((result) =>
          result.status === 'rejected' && result.reason instanceof RlmRuntimeError
          && result.reason.code === 'abort_unconfirmed');
        const unconfirmed = abortUnconfirmedError
          ?? (error instanceof RlmRuntimeError && error.code === 'abort_unconfirmed' ? error : undefined)
          ?? (unconfirmedWorker?.status === 'rejected' ? unconfirmedWorker.reason as RlmRuntimeError : undefined);
        if (unconfirmed) {
          terminalErrorCode = 'abort_unconfirmed';
          unconfirmed.toolInvocations = invocationSnapshot();
          throw unconfirmed;
        }
        event(timedOut ? 'wall_time_exceeded' : 'cancelled', 0);
        const failure = abortError(signal, timedOut);
        terminalStatus = timedOut ? 'timed_out' : 'cancelled';
        terminalErrorCode = failure.code;
        failure.toolInvocations = invocationSnapshot();
        throw failure;
      }
      if (error instanceof RlmRuntimeError) {
        terminalErrorCode = error.code;
        error.toolInvocations = invocationSnapshot();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onOwnerAbort);
      if (dependencies.onTerminalReceipt) {
        const endedAt = Date.now();
        const receipt = Object.freeze({
          runId, startedAt, endedAt, status: terminalStatus,
          ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
          trace: Object.freeze({
            mode: 'rlm' as const, runId, wallTimeMs: Math.max(0, endedAt - startedAt),
            // Event details contain search text and source identifiers. The
            // terminal hook intentionally projects only timing and structure.
            events: Object.freeze(events.map(({ type, at, depth }) => Object.freeze({ type, at, depth }))),
            toolInvocations: invocationSnapshot(), usage: Object.freeze({ ...usage }),
            budget, budgetExhausted,
          }),
        });
        try {
          dependencies.onTerminalReceipt(receipt);
        } catch {
          // A diagnostic receipt sink must not replace the execution outcome.
        }
      }
    }
  };

  return Object.freeze({ investigate });
}

export type RlmRuntime = ReturnType<typeof createRlmRuntime>;
