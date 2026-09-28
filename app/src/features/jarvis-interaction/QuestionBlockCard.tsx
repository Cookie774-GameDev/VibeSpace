import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, HelpCircle, Mic, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { playUiSound } from '@/lib/sfx';
import './QuestionBlockCard.css';
import { messageRepo } from '@/lib/db/repositories';
import {
  buildOpenCodeQuestionRejectRequest,
  buildOpenCodeQuestionReplyRequest,
} from '@/lib/ai/openCodeQuestionReply';
import { respondToPersistentOpenCodeQuestion } from '@/lib/ai/adapters/opencodePersistent';
import type { MessageId, Part } from '@/types';
import type { JarvisQuestion, JarvisQuestionAnswer, JarvisQuestionHarnessRoute } from './types';

type QuestionBlockPart = Extract<Part, { kind: 'question_block' }>;
const FOCUS_INLINE_QUESTION_EVENT = 'jarvis:question:focus-inline';

export interface QuestionBlockCardProps {
  part: QuestionBlockPart;
  messageId?: MessageId;
  chatId?: string;
  compact?: boolean;
  /** Absolute Unix timestamp in milliseconds from actual native Codex metadata. */
  deadlineAt?: number;
  onDictationToggle?: (
    answerInput: HTMLTextAreaElement,
    commitQuestionAnswer: (value: string, caret: number) => void,
  ) => void;
  /** Clear the parent's temporary STT target on dismiss, step/status change, or unmount. */
  onDictationCleanup?: () => void;
  onDismiss?: () => void;
  onReopen?: () => void;
}

export type InlineQuestionBlockCardProps = Omit<QuestionBlockCardProps, 'compact'>;

interface QuestionDraft {
  selected: Record<string, string[]>;
  text: Record<string, string>;
  activeIndex: number;
}

interface ConfirmedOpenCodeQuestionResponse {
  blockId: string;
  requestId: string;
  sessionId: string;
  action: 'reply' | 'reject';
  answers: JarvisQuestionAnswer[];
}

const EMPTY_DRAFT: QuestionDraft = { selected: {}, text: {}, activeIndex: 0 };

function draftKeyFor(chatId: string | undefined, blockId: string): string {
  return `jarvis-question-draft:${chatId ?? 'chat'}:${blockId}`;
}

/**
 * In-progress answers survive navigating away and back (session-scoped).
 * Corrupted or missing drafts fall back to a clean state.
 */
function readDraft(key: string): QuestionDraft {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<QuestionDraft> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_DRAFT;
    return {
      selected:
        parsed.selected && typeof parsed.selected === 'object'
          ? (parsed.selected as Record<string, string[]>)
          : {},
      text:
        parsed.text && typeof parsed.text === 'object'
          ? (parsed.text as Record<string, string>)
          : {},
      activeIndex:
        typeof parsed.activeIndex === 'number' && Number.isFinite(parsed.activeIndex)
          ? parsed.activeIndex
          : 0,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(key: string, draft: QuestionDraft) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Session storage full or unavailable - drafts are best-effort only.
  }
}

function clearDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore - nothing to recover.
  }
}

function confirmedResponseKey(key: string): string {
  return `${key}:confirmed-response`;
}

function readConfirmedResponse(key: string): ConfirmedOpenCodeQuestionResponse | null {
  try {
    const raw = window.sessionStorage.getItem(confirmedResponseKey(key));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConfirmedOpenCodeQuestionResponse> | null;
    return value && typeof value === 'object' &&
      typeof value.blockId === 'string' && typeof value.requestId === 'string' &&
      typeof value.sessionId === 'string' &&
      (value.action === 'reply' || value.action === 'reject') && Array.isArray(value.answers)
      ? value as ConfirmedOpenCodeQuestionResponse
      : null;
  } catch {
    return null;
  }
}

function writeConfirmedResponse(key: string, response: ConfirmedOpenCodeQuestionResponse) {
  try {
    window.sessionStorage.setItem(confirmedResponseKey(key), JSON.stringify(response));
  } catch {
    // The mounted card still retains the receipt in memory if storage is unavailable.
  }
}

function clearConfirmedResponse(key: string) {
  try {
    window.sessionStorage.removeItem(confirmedResponseKey(key));
  } catch {
    // Ignore unavailable storage; no retry remains after a confirmed local save.
  }
}

function QuestionDeadline({ deadlineAt }: { deadlineAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingSeconds = Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  return (
    <span
      className="question-card__deadline text-metadata"
      role="timer"
      aria-label={
        remainingSeconds > 0
          ? `Answer deadline in ${remainingSeconds} seconds`
          : 'Answer deadline reached'
      }
    >
      {remainingSeconds > 0 ? `${remainingSeconds}s left` : 'Deadline reached'}
    </span>
  );
}

function answerLabel(question: JarvisQuestion, answer: JarvisQuestionAnswer): string {
  if (answer.skipped) return `${question.prompt}: skipped`;
  const choiceLabels = (answer.selectedOptionIds ?? [])
    .map((id) => question.options?.find((option) => option.id === id)?.label ?? id)
    .filter(Boolean);
  const text = answer.text?.trim();
  return `${question.prompt}: ${[...choiceLabels, text].filter(Boolean).join(', ') || 'answered'}`;
}

function buildAnswerSummary(questions: JarvisQuestion[], answers: JarvisQuestionAnswer[]): string {
  return answers
    .map((answer) => {
      const question = questions.find((item) => item.id === answer.questionId);
      return question ? answerLabel(question, answer) : `${answer.questionId}: answered`;
    })
    .join('\n');
}

function sameHarnessRoute(
  left: JarvisQuestionHarnessRoute | undefined,
  right: JarvisQuestionHarnessRoute | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (
    left.protocol !== right.protocol ||
    left.blockId !== right.blockId ||
    left.requestId !== right.requestId ||
    left.sessionId !== right.sessionId ||
    left.tool?.messageId !== right.tool?.messageId ||
    left.tool?.callId !== right.tool?.callId ||
    left.questions.length !== right.questions.length
  ) {
    return false;
  }
  return left.questions.every((question, questionIndex) => {
    const candidate = right.questions[questionIndex];
    return Boolean(
      candidate &&
      question.questionId === candidate.questionId &&
      question.questionIndex === candidate.questionIndex &&
      question.multiple === candidate.multiple &&
      question.allowCustomAnswer === candidate.allowCustomAnswer &&
      question.options.length === candidate.options.length &&
      question.options.every((option, optionIndex) => {
        const candidateOption = candidate.options[optionIndex];
        return Boolean(
          candidateOption &&
          option.optionId === candidateOption.optionId &&
          option.optionIndex === candidateOption.optionIndex &&
          option.label === candidateOption.label,
        );
      }),
    );
  });
}

export function QuestionBlockCard({
  part,
  messageId,
  chatId,
  compact = false,
  deadlineAt,
  onDictationToggle,
  onDictationCleanup,
  onDismiss,
  onReopen,
}: QuestionBlockCardProps) {
  const { block } = part;
  const draftKey = draftKeyFor(chatId, block.id);
  const initialDraft = useMemo(() => {
    if (block.status !== 'answered' || !block.answers?.length) return readDraft(draftKey);
    return {
      selected: Object.fromEntries(
        block.answers.map((answer) => [answer.questionId, answer.selectedOptionIds ?? []]),
      ),
      text: Object.fromEntries(
        block.answers.map((answer) => [answer.questionId, answer.text ?? '']),
      ),
      activeIndex: 0,
    };
  }, [draftKey, block.status, block.answers]);
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, string[]>>(
    initialDraft.selected,
  );
  const [textByQuestion, setTextByQuestion] = useState<Record<string, string>>(initialDraft.text);
  const [customOpenByQuestion, setCustomOpenByQuestion] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      Object.keys(initialDraft.text).map((id) => [id, Boolean(initialDraft.text[id])]),
    ),
  );
  const total = block.questions.length;
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.min(Math.max(initialDraft.activeIndex, 0), Math.max(total - 1, 0)),
  );
  const [error, setError] = useState<string | null>(null);
  const [submissionFailed, setSubmissionFailed] = useState(false);
  const [acceptedHarnessResponse, setAcceptedHarnessResponse] = useState(() =>
    readConfirmedResponse(draftKey),
  );
  const [busy, setBusy] = useState(false);
  const [inlineDismissed, setInlineDismissed] = useState(false);
  const [focusInlineRequested, setFocusInlineRequested] = useState(false);
  const busyRef = useRef(false);
  const inlineCardRef = useRef<HTMLElement | null>(null);
  const answerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dictationCleanupRef = useRef(onDictationCleanup);
  dictationCleanupRef.current = onDictationCleanup;
  const previousActiveQuestionIdRef = useRef<string | undefined>();

  const isPending = block.status === 'pending';
  const harnessResponseLocked = Boolean(part.harness && acceptedHarnessResponse);
  const isWizard = total > 1;
  const activeQuestion = block.questions[activeIndex];
  const isLast = activeIndex >= total - 1;
  const codexDeadlineAt =
    compact &&
    isPending &&
    part.harness?.requestId.startsWith('que_codex_') &&
    typeof deadlineAt === 'number' &&
    Number.isSafeInteger(deadlineAt) &&
    deadlineAt > 0
      ? deadlineAt
      : undefined;

  useEffect(() => {
    setInlineDismissed(false);
    return () => dictationCleanupRef.current?.();
  }, [block.id]);

  useEffect(() => {
    if (previousActiveQuestionIdRef.current !== activeQuestion?.id) {
      if (previousActiveQuestionIdRef.current !== undefined) {
        dictationCleanupRef.current?.();
      }
      previousActiveQuestionIdRef.current = activeQuestion?.id;
    }
  }, [activeQuestion?.id]);

  useEffect(() => {
    if (!isPending) {
      dictationCleanupRef.current?.();
      setInlineDismissed(false);
    }
  }, [isPending]);

  useEffect(() => {
    if (!compact || !isPending || !chatId) return;
    const handleFocusInlineQuestion = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; blockId?: string }>).detail;
      if (detail?.chatId !== chatId || detail.blockId !== block.id) return;
      setInlineDismissed(false);
      setFocusInlineRequested(true);
    };
    window.addEventListener(FOCUS_INLINE_QUESTION_EVENT, handleFocusInlineQuestion);
    return () => window.removeEventListener(FOCUS_INLINE_QUESTION_EVENT, handleFocusInlineQuestion);
  }, [block.id, chatId, compact, isPending]);

  useEffect(() => {
    if (!compact || !isPending || inlineDismissed || !focusInlineRequested) return;
    const answerControl = inlineCardRef.current?.querySelector<HTMLElement>(
      'textarea:not(:disabled), .question-card__option:not(:disabled)',
    );
    if (!answerControl) return;
    answerControl.focus();
    setFocusInlineRequested(false);
  }, [
    activeIndex,
    compact,
    customOpenByQuestion,
    focusInlineRequested,
    inlineDismissed,
    isPending,
  ]);

  useEffect(() => {
    if (!isPending) return;
    writeDraft(draftKey, { selected: selectedByQuestion, text: textByQuestion, activeIndex });
  }, [draftKey, selectedByQuestion, textByQuestion, activeIndex, isPending]);

  const canSkip = useMemo(
    () => block.questions.every((question) => !question.required || question.allowSkip),
    [block.questions],
  );

  const collectAnswers = (skipped = false): JarvisQuestionAnswer[] =>
    block.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: skipped ? [] : (selectedByQuestion[question.id] ?? []),
      text: skipped ? '' : (textByQuestion[question.id] ?? '').trim(),
      skipped,
    }));

  const questionAnswered = (question: JarvisQuestion, answers: JarvisQuestionAnswer[]): boolean => {
    const answer = answers.find((item) => item.questionId === question.id);
    return Boolean((answer?.selectedOptionIds?.length ?? 0) > 0 || answer?.text?.trim());
  };

  const firstMissingRequired = (answers: JarvisQuestionAnswer[]): number =>
    block.questions.findIndex(
      (question) => question.required && !questionAnswered(question, answers),
    );

  const readPersistedQuestionPart = async () => {
    if (!messageId) throw new Error('This question is no longer available.');
    const message = await messageRepo.getById(messageId);
    if (!message) throw new Error('This question is no longer available.');
    if (!chatId || String(message.chat_id) !== chatId) {
      throw new Error('This question no longer belongs to this chat.');
    }
    const persistedPart = message.parts.find(
      (messagePart): messagePart is QuestionBlockPart =>
        messagePart.kind === 'question_block' && messagePart.block.id === block.id,
    );
    if (
      !persistedPart ||
      persistedPart.block.status !== 'pending' ||
      !sameHarnessRoute(part.harness, persistedPart.harness)
    ) {
      throw new Error('This question is no longer available.');
    }
    return { message, persistedPart };
  };

  const persistBlockStatus = async (
    answers: JarvisQuestionAnswer[],
    status: 'answered' | 'skipped' | 'cancelled',
  ) => {
    if (!messageId) return;
    const { message } = await readPersistedQuestionPart();
    await messageRepo.update(messageId, {
      parts: message.parts.map((messagePart) =>
        messagePart.kind === 'question_block' && messagePart.block.id === block.id
          ? {
              kind: 'question_block',
              block: { ...messagePart.block, answers, status },
              ...(messagePart.harness ? { harness: messagePart.harness } : {}),
            }
          : messagePart,
      ),
    });
  };

  const persistUserAnswer = async (
    answers: JarvisQuestionAnswer[],
    status: 'answered' | 'skipped',
  ) => {
    const id = `msg_question_answer_${encodeURIComponent(String(messageId))}_${encodeURIComponent(block.id)}` as never;
    const summary =
      status === 'skipped'
        ? `Skipped: ${block.title ?? 'Jarvis questions'}`
        : buildAnswerSummary(block.questions, answers);
    const answerPart: Part = { kind: 'question_answer', blockId: block.id, answers };
    try {
      await messageRepo.create({
        id,
        chat_id: chatId as never,
        role: 'user',
        parts: [{ kind: 'text', text: summary }, answerPart],
      });
    } catch (createError) {
      // A retry after the message was committed but a later sync/status step
      // failed must reuse the same answer, never create or dispatch it twice.
      let existing;
      try {
        existing = await messageRepo.getById(id);
      } catch {
        throw createError;
      }
      const existingAnswer = existing?.parts.find(
        (messagePart): messagePart is Extract<Part, { kind: 'question_answer' }> =>
          messagePart.kind === 'question_answer' && messagePart.blockId === block.id,
      );
      if (
        !existing ||
        String(existing.chat_id) !== chatId ||
        existing.role !== 'user' ||
        !existingAnswer ||
        JSON.stringify(existingAnswer.answers) !== JSON.stringify(answers)
      ) {
        throw createError;
      }
    }
  };

  const respondToHarnessQuestion = async (
    answers: JarvisQuestionAnswer[],
    action: 'reply' | 'reject',
  ) => {
    const { persistedPart } = await readPersistedQuestionPart();
    const route = persistedPart.harness;
    if (!route) throw new Error('OpenCode question authority is unavailable.');
    const replyAnswers = answers.map(({ text, ...answer }) =>
      text?.trim() ? { ...answer, text: text.trim() } : answer,
    );
    const request =
      action === 'reply'
        ? buildOpenCodeQuestionReplyRequest({
            route,
            expectedSessionId: route.sessionId,
            blockId: block.id,
            answers: replyAnswers,
          })
        : buildOpenCodeQuestionRejectRequest({
            route,
            expectedSessionId: route.sessionId,
            blockId: block.id,
          });
    if (!request) throw new Error('OpenCode question response is invalid.');
    await respondToPersistentOpenCodeQuestion({
      request,
      expectedSessionId: route.sessionId,
      expectedBlockId: block.id,
    });
  };

  const respondToHarnessQuestionOnce = async (
    answers: JarvisQuestionAnswer[],
    action: 'reply' | 'reject',
  ): Promise<boolean> => {
    const { persistedPart } = await readPersistedQuestionPart();
    const route = persistedPart.harness;
    if (!route) throw new Error('OpenCode question authority is unavailable.');
    const saved = acceptedHarnessResponse ?? readConfirmedResponse(draftKey);
    if (saved) {
      if (
        saved.blockId !== block.id || saved.requestId !== route.requestId ||
        saved.sessionId !== route.sessionId || saved.action !== action ||
        JSON.stringify(saved.answers) !== JSON.stringify(answers)
      ) {
        throw new Error('OpenCode already confirmed a different response. Reload this question before retrying.');
      }
      setAcceptedHarnessResponse(saved);
      return true;
    }
    await respondToHarnessQuestion(answers, action);
    const receipt = {
      blockId: block.id,
      requestId: route.requestId,
      sessionId: route.sessionId,
      action,
      answers,
    } satisfies ConfirmedOpenCodeQuestionResponse;
    writeConfirmedResponse(draftKey, receipt);
    setAcceptedHarnessResponse(receipt);
    return true;
  };

  const emitHarnessResolution = (
    answers: JarvisQuestionAnswer[],
    status: 'answered' | 'skipped' | 'cancelled',
  ) => {
    if (!part.harness || !messageId || !chatId) return;
    window.dispatchEvent(
      new CustomEvent('vibespace:opencode-question-resolved', {
        detail: {
          chatId,
          messageId,
          part: {
            kind: 'question_block',
            block: { ...block, answers, status },
            harness: part.harness,
          },
        },
      }),
    );
  };

  const persistAndSend = async (
    answers: JarvisQuestionAnswer[],
    status: 'answered' | 'skipped',
  ) => {
    if (!messageId || !chatId || busyRef.current) return;
    let harnessResponseConfirmed = false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setSubmissionFailed(false);
    try {
      if (part.harness) {
        harnessResponseConfirmed = await respondToHarnessQuestionOnce(answers, 'reply');
        await persistBlockStatus(answers, status);
        emitHarnessResolution(answers, status);
        clearDraft(draftKey);
        clearConfirmedResponse(draftKey);
        setAcceptedHarnessResponse(null);
        return;
      }
      // Validate the source chat and pending question before creating the
      // deterministic answer message, so stale/cross-chat cards write nothing.
      await readPersistedQuestionPart();
      await persistUserAnswer(answers, status);
      await persistBlockStatus(answers, status);
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: {
            chatId,
            text:
              status === 'skipped'
                ? `Skipped Jarvis question block ${block.id}.`
                : buildAnswerSummary(block.questions, answers),
            structuredContext: {
              kind: 'question_answers',
              sourceMessageId: messageId,
              payload: {
                blockId: block.id,
                originalRequest: block.originalRequest,
                answers,
                skipped: status === 'skipped',
              },
            },
          },
        }),
      );
      clearDraft(draftKey);
    } catch (err) {
      setSubmissionFailed(true);
      setError(
        part.harness
          ? harnessResponseConfirmed
            ? 'OpenCode accepted this answer, but its saved status could not be confirmed. Retry to finish saving; the answer will not be sent twice.'
            : 'Could not send this answer to its original agent session. Check that the request is still active before retrying.'
          : err instanceof Error
            ? err.message
            : 'Could not save these answers. Please retry.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const toggleChoice = (question: JarvisQuestion, optionId: string) => {
    if (busy || !isPending || harnessResponseLocked) return;
    playUiSound('ui_click_soft');
    setError(null);
    setSelectedByQuestion((current) => {
      const selected = current[question.id] ?? [];
      if (question.type === 'single') return { ...current, [question.id]: [optionId] };
      const next = selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId];
      return { ...current, [question.id]: next };
    });
  };

  const handleNext = () => {
    if (busy || !isPending || harnessResponseLocked || !activeQuestion) return;
    const answers = collectAnswers(false);
    if (activeQuestion.required && !questionAnswered(activeQuestion, answers)) {
      setError('Please answer this question before continuing.');
      return;
    }
    setError(null);
    setActiveIndex((index) => Math.min(index + 1, total - 1));
  };

  const handleBack = () => {
    if (busy || !isPending || harnessResponseLocked) return;
    setError(null);
    setActiveIndex((index) => Math.max(index - 1, 0));
  };

  const handleContinue = async () => {
    if (
      busy ||
      !isPending ||
      (harnessResponseLocked && acceptedHarnessResponse?.action !== 'reply')
    ) return;
    const answers = collectAnswers(false);
    const missingIndex = firstMissingRequired(answers);
    if (missingIndex !== -1) {
      setActiveIndex(missingIndex);
      setError('Please answer the required questions before continuing.');
      return;
    }
    await persistAndSend(answers, 'answered');
  };

  const handleSkip = async () => {
    if (busy || !isPending || harnessResponseLocked) return;
    await persistAndSend(collectAnswers(true), 'skipped');
  };

  const handleCancel = async () => {
    if (busyRef.current || !isPending || harnessResponseLocked) return;
    let harnessResponseConfirmed = false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const answers = collectAnswers(true);
      if (part.harness) harnessResponseConfirmed = await respondToHarnessQuestionOnce(answers, 'reject');
      await persistBlockStatus(answers, 'cancelled');
      emitHarnessResolution(answers, 'cancelled');
      clearDraft(draftKey);
      clearConfirmedResponse(draftKey);
      setAcceptedHarnessResponse(null);
    } catch (err) {
      setError(
        part.harness
          ? harnessResponseConfirmed
            ? 'OpenCode rejected this question, but its saved status could not be confirmed. Retry Cancel to finish saving; the rejection will not be sent twice.'
            : 'Could not cancel this OpenCode question. Please retry.'
          : err instanceof Error
            ? err.message
            : 'Could not cancel these questions. Please retry.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (isWizard && !isLast) void handleNext();
    else void handleContinue();
  };

  const renderQuestion = (question: JarvisQuestion, index: number) => {
    const selected = selectedByQuestion[question.id] ?? [];
    return (
      <div key={question.id} className="question-card__question">
        <div className="question-card__prompt text-foreground">
          {isWizard ? question.prompt : `${index + 1}. ${question.prompt}`}
          {question.required && <span className="ml-1 text-accent-copper">*</span>}
        </div>
        {question.options?.length ? (
          <div className="question-card__options">
            {question.options.map((option, optionIndex) => {
              const active = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cn(
                    'question-card__option',
                    active
                      ? 'border-accent-cyan/70 bg-accent-cyan/15 text-foreground'
                      : 'border-border bg-elevated text-muted-foreground hover:text-foreground',
                  )}
                  aria-pressed={active}
                  disabled={busy || !isPending || harnessResponseLocked}
                  onClick={() => toggleChoice(question, option.id)}
                >
                  <span className="question-card__marker" aria-hidden="true">
                    {active ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      String(optionIndex + 1).padStart(2, '0')
                    )}
                  </span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {question.options?.length && question.allowCustomResponse ? (
          <button
            type="button"
            className={cn(
              'question-card__custom mb-2 rounded-md border px-2.5 py-1.5 text-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60',
              customOpenByQuestion[question.id]
                ? 'border-accent-cyan/70 bg-accent-cyan/15 text-foreground'
                : 'border-border bg-elevated text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={Boolean(customOpenByQuestion[question.id])}
            disabled={busy || !isPending || harnessResponseLocked}
            aria-controls={`question-custom-${question.id}`}
            onClick={() =>
              setCustomOpenByQuestion((current) => ({
                ...current,
                [question.id]: !current[question.id],
              }))
            }
          >
            Write my own answer
          </button>
        ) : null}
        {!question.options?.length ||
        (question.allowCustomResponse && customOpenByQuestion[question.id]) ? (
          <textarea
            ref={compact && question.id === activeQuestion?.id ? answerTextareaRef : undefined}
            id={`question-custom-${question.id}`}
            aria-label={`Custom response for ${question.prompt}`}
            className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-secondary text-foreground outline-none focus:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
            placeholder={question.placeholder ?? 'Write your own answer'}
            value={textByQuestion[question.id] ?? ''}
            disabled={busy || !isPending || harnessResponseLocked}
            onKeyDown={handleTextKeyDown}
            onChange={(event) => {
              setError(null);
              setTextByQuestion((current) => ({ ...current, [question.id]: event.target.value }));
            }}
          />
        ) : null}
        {compact &&
        isPending &&
        question.id === activeQuestion?.id &&
        onDictationToggle &&
        (!question.options?.length || customOpenByQuestion[question.id]) ? (
          <div className="question-card__dictation-row">
            <span className="text-metadata text-muted-foreground">Voice answer</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Dictate answer"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const answerInput = answerTextareaRef.current;
                if (!answerInput) return;
                onDictationToggle(answerInput, (value, caret) => {
                  if (answerTextareaRef.current !== answerInput) return;
                  setTextByQuestion((current) => ({ ...current, [question.id]: value }));
                  requestAnimationFrame(() => {
                    if (!answerInput.isConnected || answerInput.value !== value) return;
                    answerInput.focus();
                    const nextCaret = Math.min(Math.max(caret, 0), value.length);
                    answerInput.setSelectionRange(nextCaret, nextCaret);
                  });
                });
              }}
            >
              <Mic className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  const title = block.title ?? 'Jarvis needs a quick answer';

  if (!compact && isPending) {
    return (
      <section className="question-card question-card--transcript-pending">
        <span className="min-w-0 truncate text-secondary text-foreground" title={title}>
          {title}
        </span>
        <Button
          type="button"
          size="sm"
          variant="accent"
          disabled={!chatId}
          onClick={() => {
            if (!chatId) return;
            window.dispatchEvent(
              new CustomEvent(FOCUS_INLINE_QUESTION_EVENT, {
                detail: { chatId, blockId: block.id },
              }),
            );
          }}
        >
          Answer question
        </Button>
      </section>
    );
  }

  if (compact && isPending && inlineDismissed) {
    return (
      <section
        ref={inlineCardRef}
        className="question-card question-card--inline question-card--reopen"
        data-inline-question-block-id={block.id}
      >
        <span className="min-w-0 truncate text-secondary text-foreground" title={title}>
          {title}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Reopen question"
          onClick={() => {
            setInlineDismissed(false);
            onReopen?.();
          }}
        >
          Reopen
        </Button>
      </section>
    );
  }

  return (
    <section
      ref={compact ? inlineCardRef : undefined}
      className={cn('question-card', compact && 'question-card--inline')}
      aria-busy={busy}
      aria-label={compact ? 'Answer question' : undefined}
      data-inline-question-block-id={compact ? block.id : undefined}
    >
      <div
        className={cn(
          'question-card__header mb-3 flex items-start justify-between gap-2',
          compact && 'mb-2',
        )}
      >
        <div className="flex items-start gap-2">
          <div className="question-card__icon">
            <HelpCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="question-card__title text-foreground">{title}</div>
            {!compact && block.description && (
              <p className="text-secondary text-muted-foreground">{block.description}</p>
            )}
          </div>
        </div>
        <div className="question-card__header-actions flex shrink-0 items-center gap-1.5">
          {codexDeadlineAt !== undefined && <QuestionDeadline deadlineAt={codexDeadlineAt} />}
          {isPending && (
            <span className="question-card__count shrink-0 text-metadata text-muted-foreground">
              Question {activeIndex + 1} of {total}
            </span>
          )}
          {compact && isPending && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss question"
              disabled={busy}
              onClick={() => {
                setInlineDismissed(true);
                dictationCleanupRef.current?.();
                onDismiss?.();
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {isWizard && isPending && (
        <div
          className={cn('question-card__progress mb-3 flex gap-1', compact && 'mb-2')}
          aria-hidden
        >
          {block.questions.map((question, index) => (
            <span
              key={question.id}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                index < activeIndex
                  ? 'bg-accent-cyan/70'
                  : index === activeIndex
                    ? 'bg-accent-cyan/45'
                    : 'bg-border',
              )}
            />
          ))}
        </div>
      )}

      <div className={cn('question-card__body flex flex-col gap-3', compact && 'gap-2')}>
        {isPending && isWizard && activeQuestion
          ? renderQuestion(activeQuestion, activeIndex)
          : block.questions.map((question, index) => renderQuestion(question, index))}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-secondary text-destructive">
          {error}
        </p>
      )}
      {!isPending && (
        <p className="mt-2 text-secondary text-muted-foreground">
          {block.status === 'skipped'
          ? 'Skipped.'
          : block.status === 'cancelled'
            ? 'Cancelled.'
            : block.status === 'resolved'
              ? 'No longer pending.'
            : block.status === 'expired'
              ? 'Expired.'
              : 'Answered.'}
        </p>
      )}

      {isPending && (
        <div
          className={cn(
            'question-card__footer flex flex-wrap items-center gap-2',
            compact && 'gap-1.5',
          )}
        >
          {isWizard && activeIndex > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || !isPending || harnessResponseLocked}
              onClick={handleBack}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
          )}
          {isWizard && !isLast ? (
            <Button
              type="button"
              size="sm"
              variant="accent"
              disabled={busy || !isPending || harnessResponseLocked}
              onClick={handleNext}
            >
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="accent"
              disabled={
                busy || !isPending ||
                (harnessResponseLocked && acceptedHarnessResponse?.action !== 'reply')
              }
              onClick={handleContinue}
            >
              {acceptedHarnessResponse ? 'Retry save' : submissionFailed && error ? 'Retry answer' : 'Submit'}
            </Button>
          )}
          {canSkip && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || !isPending || harnessResponseLocked}
              onClick={handleSkip}
            >
              Skip
            </Button>
          )}
          {isPending && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy || harnessResponseLocked}
              onClick={handleCancel}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Compact pending question UI for the Composer. Keep it mounted after dismissal to show Reopen. */
export function InlineQuestionBlockCard(props: InlineQuestionBlockCardProps) {
  return <QuestionBlockCard {...props} compact />;
}
