import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, HelpCircle } from 'lucide-react';
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

export interface QuestionBlockCardProps {
  part: QuestionBlockPart;
  messageId?: MessageId;
  chatId?: string;
}

interface QuestionDraft {
  selected: Record<string, string[]>;
  text: Record<string, string>;
  activeIndex: number;
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

export function QuestionBlockCard({ part, messageId, chatId }: QuestionBlockCardProps) {
  const { block } = part;
  const draftKey = draftKeyFor(chatId, block.id);
  const initialDraft = useMemo(() => {
    if (block.status !== 'answered' || !block.answers?.length) return readDraft(draftKey);
    return {
      selected: Object.fromEntries(block.answers.map(answer => [answer.questionId, answer.selectedOptionIds ?? []])),
      text: Object.fromEntries(block.answers.map(answer => [answer.questionId, answer.text ?? ''])),
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
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const isPending = block.status === 'pending';
  const isWizard = total > 1;
  const activeQuestion = block.questions[activeIndex];
  const isLast = activeIndex >= total - 1;

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
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (part.harness) {
        await respondToHarnessQuestion(answers, 'reply');
        await persistBlockStatus(answers, status);
        emitHarnessResolution(answers, status);
        clearDraft(draftKey);
        return;
      }
      await persistBlockStatus(answers, status);
      await messageRepo.create({
        chat_id: chatId as never,
        role: 'user',
        parts: [
          {
            kind: 'text',
            text:
              status === 'skipped'
                ? `Skipped: ${block.title ?? 'Jarvis questions'}`
                : buildAnswerSummary(block.questions, answers),
          },
          { kind: 'question_answer', blockId: block.id, answers },
        ],
      });
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
      setError(
        part.harness
          ? 'Could not send this answer to its original agent session. Check that the request is still active before retrying.'
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
    if (busy || !isPending) return;
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
    if (busy || !isPending || !activeQuestion) return;
    const answers = collectAnswers(false);
    if (activeQuestion.required && !questionAnswered(activeQuestion, answers)) {
      setError('Please answer this question before continuing.');
      return;
    }
    setError(null);
    setActiveIndex((index) => Math.min(index + 1, total - 1));
  };

  const handleBack = () => {
    if (busy || !isPending) return;
    setError(null);
    setActiveIndex((index) => Math.max(index - 1, 0));
  };

  const handleContinue = async () => {
    if (busy || !isPending) return;
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
    if (busy || !isPending) return;
    clearDraft(draftKey);
    await persistAndSend(collectAnswers(true), 'skipped');
  };

  const handleCancel = async () => {
    if (busyRef.current || !isPending) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const answers = collectAnswers(true);
      if (part.harness) await respondToHarnessQuestion(answers, 'reject');
      await persistBlockStatus(answers, 'cancelled');
      emitHarnessResolution(answers, 'cancelled');
      clearDraft(draftKey);
    } catch (err) {
      setError(
        part.harness
          ? 'Could not cancel this OpenCode question. Please retry.'
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
                  disabled={busy || !isPending}
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
            disabled={busy || !isPending}
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
            id={`question-custom-${question.id}`}
            aria-label={`Custom response for ${question.prompt}`}
            className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-secondary text-foreground outline-none focus:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
            placeholder={question.placeholder ?? 'Write your own answer'}
            value={textByQuestion[question.id] ?? ''}
            disabled={busy || !isPending}
            onKeyDown={handleTextKeyDown}
            onChange={(event) => {
              setError(null);
              setTextByQuestion((current) => ({ ...current, [question.id]: event.target.value }));
            }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <section className="question-card" aria-busy={busy}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div className="question-card__icon">
            <HelpCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="question-card__title text-foreground">
              {block.title ?? 'Jarvis needs a quick answer'}
            </div>
            {block.description && (
              <p className="text-secondary text-muted-foreground">{block.description}</p>
            )}
          </div>
        </div>
        {isPending && (
          <span className="question-card__count shrink-0 text-metadata text-muted-foreground">
            Question {activeIndex + 1} of {total}
          </span>
        )}
      </div>

      {isWizard && isPending && (
        <div className="mb-3 flex gap-1" aria-hidden>
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

      <div className="flex flex-col gap-3">
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
              : 'Answered.'}
        </p>
      )}

      {isPending && <div className="question-card__footer flex flex-wrap items-center gap-2">
        {isWizard && activeIndex > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || !isPending}
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
            disabled={busy || !isPending}
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
            disabled={busy || !isPending}
            onClick={handleContinue}
          >
            Submit
          </Button>
        )}
        {canSkip && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || !isPending}
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
            disabled={busy}
            onClick={handleCancel}
          >
            Cancel
          </Button>
        )}
      </div>}
    </section>
  );
}
