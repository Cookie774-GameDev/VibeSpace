import * as React from 'react';
import '@/features/all-about-me/sakura-all-about-me.css';
import {
  AlertTriangle,
  Brain,
  Check,
  FileText,
  PauseCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { formatUserDateTime } from '@/lib/timeFormat';
import { generateAllAboutMeMarkdown, type AllAboutMeCompletion } from '@/features/all-about-me/ai';
import {
  completeAllAboutMePrompt,
  getAllAboutMeModelOptions,
  type AllAboutMeModelOption,
} from '@/features/all-about-me/completion';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import {
  ALL_ABOUT_ME_FILE_LOCATION,
  ALL_ABOUT_ME_TEST_QUESTIONS,
  type AllAboutMeAnswers,
  type AllAboutMeQuestionAnswer,
} from '@/features/all-about-me/profile';
import type { AllAboutMeTestMode } from '@/features/all-about-me/store';
import { JarvisLearningControls } from '@/features/jarvis-memory/JarvisLearningControls';

interface AllAboutMeProps {
  completePrompt?: AllAboutMeCompletion;
  modelOptions?: AllAboutMeModelOption[];
}

const DEFAULT_ANSWERS: AllAboutMeAnswers = {
  communicationStyle: '',
  toneExamples: '',
  interests: '',
  strongReactions: '',
  preferences: ['short-direct', 'production-focused'],
  dislikedPatterns: ['placeholder-copy', 'walls-of-text'],
  responseStyle: '',
  personalNotes: '',
};

function initialQuestionValues(answers: AllAboutMeAnswers | null): Record<string, string> {
  const values: Record<string, string> = {};
  for (const question of ALL_ABOUT_ME_TEST_QUESTIONS) {
    const saved = answers?.quizResponses?.find((response) => response.questionId === question.id);
    values[question.id] = saved?.answer ?? '';
  }
  return values;
}

function answersFromQuestionValues(
  values: Record<string, string>,
  selectedModel: AllAboutMeModelOption,
): AllAboutMeAnswers {
  const responses: AllAboutMeQuestionAnswer[] = ALL_ABOUT_ME_TEST_QUESTIONS.map((question) => ({
    questionId: question.id,
    prompt: question.prompt,
    kind: question.kind,
    answer: values[question.id]?.trim() ?? '',
  }));
  const byId = (id: string) => values[id]?.trim() ?? '';
  return {
    ...DEFAULT_ANSWERS,
    communicationStyle: [
      byId('displayName') && `Call the user: ${byId('displayName')}`,
      byId('lockedInAddress') && `When locked in: ${byId('lockedInAddress')}`,
      byId('personalityWords') && `Vibe words: ${byId('personalityWords')}`,
      byId('toneExamples'),
      byId('signatureWords') && `Common words/slang: ${byId('signatureWords')}`,
    ]
      .filter(Boolean)
      .join('\n'),
    toneExamples: byId('toneExamples'),
    interests: [
      byId('currentFocus'),
      byId('biggestGoals'),
      byId('interests'),
      byId('attentionTopics'),
      byId('favoriteProjects'),
    ]
      .filter(Boolean)
      .join('\n'),
    strongReactions: [
      byId('strongReactions'),
      byId('energyLoss'),
      byId('hatedVibes'),
      byId('dealbreakers'),
      byId('neverJoke'),
    ]
      .filter(Boolean)
      .join('\n'),
    responseStyle: [
      byId('answerLength'),
      byId('energyLevel'),
      byId('directness'),
      byId('writeAsUserCleanup'),
      byId('humorSafety'),
      byId('youtubeReplyStyle'),
    ]
      .filter(Boolean)
      .join('\n'),
    personalNotes: [byId('motivation'), byId('perfectJarvis'), byId('privacyBoundaries')]
      .filter(Boolean)
      .join('\n'),
    preferences: [
      byId('answerLength'),
      byId('energyLevel'),
      byId('writingCleanliness'),
      byId('proofLevel'),
      byId('buildPace'),
      byId('codingPriority'),
      byId('tradeoffs'),
    ].filter(Boolean),
    dislikedPatterns: [
      byId('avoidPhrases'),
      byId('correctionStyle'),
      byId('cheapAppSignals'),
      byId('dealbreakers'),
    ].filter(Boolean),
    selectedModel: `${selectedModel.provider}/${selectedModel.model}`,
    quizResponses: responses,
  };
}

function QuestionField({
  index,
  questionId,
  prompt,
  value,
  onChange,
  onCtrlEnter,
}: {
  index: number;
  questionId: string;
  prompt: string;
  value: string;
  onChange: (value: string) => void;
  onCtrlEnter: () => void;
}) {
  return (
    <div className="space-y-3">
      <Label
        htmlFor={`all-about-me-${questionId}`}
        className="text-[15px] font-medium leading-snug text-foreground"
      >
        <span className="mr-2 text-metadata font-semibold text-accent-copper">{index + 1}.</span>
        {prompt}
      </Label>
      <Textarea
        id={`all-about-me-${questionId}`}
        value={value}
        autoFocus
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onCtrlEnter();
          }
        }}
        placeholder="Type fast — Ctrl+Enter for next"
        className="min-h-[88px] resize-none text-[15px] leading-relaxed"
      />
      <p className="text-[11px] text-muted-foreground">
        <kbd className="rounded border border-border bg-panel px-1 py-px font-mono text-[10px]">
          Ctrl
        </kbd>
        {' + '}
        <kbd className="rounded border border-border bg-panel px-1 py-px font-mono text-[10px]">
          Enter
        </kbd>
        {' next question'}
      </p>
    </div>
  );
}

type TestStep = 'questions' | 'grade';

function ModelChoiceCard({
  option,
  selected,
  onSelect,
}: {
  option: AllAboutMeModelOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const kind =
    option.kind ??
    (option.provider === 'ollama' || option.provider === 'local' ? 'local' : 'cloud');
  return (
    <label
      className={cn(
        'relative flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-all duration-150',
        selected
          ? 'border-accent-copper/70 bg-accent-copper/10 shadow-[0_0_18px_hsl(var(--accent-copper)/0.12)]'
          : 'border-border/80 bg-background/40 hover:border-accent-cyan/45 hover:bg-muted/30',
      )}
    >
      <input
        type="radio"
        name="all-about-me-model"
        aria-label={option.label}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          selected
            ? 'border-accent-copper bg-accent-copper text-background'
            : 'border-border bg-panel text-transparent',
        )}
        aria-hidden
      >
        <Check className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{option.label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {kind === 'local' ? 'Local' : 'Cloud'} · {option.provider}/{option.model}
        </span>
      </span>
    </label>
  );
}

export function AllAboutMe({
  completePrompt = completeAllAboutMePrompt,
  modelOptions,
}: AllAboutMeProps) {
  const markdown = useAllAboutMeStore((state) => state.markdown);
  const quizAnswers = useAllAboutMeStore((state) => state.quizAnswers);
  const testDraft = useAllAboutMeStore((state) => state.testDraft);
  const updatedAt = useAllAboutMeStore((state) => state.updatedAt);
  const saveQuizProfile = useAllAboutMeStore((state) => state.saveQuizProfile);
  const saveTestDraft = useAllAboutMeStore((state) => state.saveTestDraft);
  const clearTestDraft = useAllAboutMeStore((state) => state.clearTestDraft);
  const deleteProfile = useAllAboutMeStore((state) => state.deleteProfile);
  const availableModels = React.useMemo(
    () => modelOptions ?? getAllAboutMeModelOptions(),
    [modelOptions],
  );
  const [selectedModelId, setSelectedModelId] = React.useState(
    () => testDraft?.selectedModelId ?? availableModels[0]?.id ?? '',
  );
  const [testMode, setTestMode] = React.useState<AllAboutMeTestMode>(
    () => testDraft?.mode ?? 'create',
  );
  const [testOpen, setTestOpen] = React.useState(false);
  const [questionValues, setQuestionValues] = React.useState<Record<string, string>>(
    () => testDraft?.questionValues ?? initialQuestionValues(quizAnswers),
  );
  const [currentQuestionIndex, setCurrentQuestionIndex] = React.useState(0);
  const [testStep, setTestStep] = React.useState<TestStep>('questions');
  const [generating, setGenerating] = React.useState(false);
  const [deleteArmed, setDeleteArmed] = React.useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = React.useState('');
  const choiceAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = React.useRef({ testStep: 'questions' as TestStep, currentQuestionIndex: 0 });
  React.useEffect(() => {
    navRef.current = { testStep, currentQuestionIndex };
  }, [testStep, currentQuestionIndex]);

  // Latest draft snapshot for close/unmount/pagehide — never lose answers.
  const draftLiveRef = React.useRef({
    testOpen: false,
    selectedModelId,
    testMode,
    questionValues,
  });
  React.useEffect(() => {
    draftLiveRef.current = { testOpen, selectedModelId, testMode, questionValues };
  }, [testOpen, selectedModelId, testMode, questionValues]);

  React.useEffect(() => {
    const selectedExists = availableModels.some((option) => option.id === selectedModelId);
    if ((!selectedModelId || !selectedExists) && availableModels[0]) {
      setSelectedModelId(availableModels[0].id);
    }
  }, [availableModels, selectedModelId]);

  React.useEffect(() => {
    const onRetake = () => openTest('update');
    window.addEventListener('jarvis:allaboutme:retake', onRetake);
    return () => window.removeEventListener('jarvis:allaboutme:retake', onRetake);
  }, [quizAnswers, testDraft]);

  const selectedModel = availableModels.find((option) => option.id === selectedModelId) ?? null;
  // Submit is allowed with zero answers — only a real grading model is required.
  const canGenerate = Boolean(selectedModel);
  const currentQuestion =
    ALL_ABOUT_ME_TEST_QUESTIONS[currentQuestionIndex] ?? ALL_ABOUT_ME_TEST_QUESTIONS[0]!;
  const answeredCount = ALL_ABOUT_ME_TEST_QUESTIONS.filter((question) =>
    (questionValues[question.id] ?? '').trim(),
  ).length;
  const totalQuestions = ALL_ABOUT_ME_TEST_QUESTIONS.length;

  function firstUnansweredIndex(values: Record<string, string>): number {
    const index = ALL_ABOUT_ME_TEST_QUESTIONS.findIndex(
      (question) => !(values[question.id] ?? '').trim(),
    );
    return index === -1 ? 0 : index;
  }

  function hasAnswerProgress(values: Record<string, string>): boolean {
    return Object.values(values).some((value) => (value ?? '').trim().length > 0);
  }

  /** Persist unfinished test progress to the AllAboutMe store (localStorage). */
  function persistDraft(
    nextValues = questionValues,
    nextMode = testMode,
    nextModelId = selectedModelId,
    options?: { force?: boolean },
  ) {
    const force = options?.force === true;
    if (!force && !hasAnswerProgress(nextValues) && !testOpen) return;
    saveTestDraft({
      selectedModelId: nextModelId,
      mode: nextMode,
      questionValues: nextValues,
    });
  }

  function flushLiveDraft(options?: { force?: boolean }) {
    const live = draftLiveRef.current;
    if (!live.testOpen && !options?.force) return;
    if (!hasAnswerProgress(live.questionValues) && !live.testOpen) return;
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: live.selectedModelId,
      mode: live.testMode,
      questionValues: live.questionValues,
    });
  }

  // Autosave on every answer/model change while the popup is open.
  React.useEffect(() => {
    if (!testOpen) return;
    if (!hasAnswerProgress(questionValues)) return;
    saveTestDraft({
      selectedModelId,
      mode: testMode,
      questionValues,
    });
  }, [testOpen, questionValues, selectedModelId, testMode, saveTestDraft]);

  // Accidental close of Settings (or tab unmount) must still keep answers.
  React.useEffect(() => {
    const onPageHide = () => flushLiveDraft({ force: true });
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      flushLiveDraft({ force: true });
    };
  }, []);

  function allQuestionsAnswered(values: Record<string, string>): boolean {
    return ALL_ABOUT_ME_TEST_QUESTIONS.every(
      (question) => (values[question.id] ?? '').trim().length > 0,
    );
  }

  function openTest(mode: AllAboutMeTestMode) {
    if (choiceAdvanceTimerRef.current) {
      clearTimeout(choiceAdvanceTimerRef.current);
      choiceAdvanceTimerRef.current = null;
    }
    const nextValues =
      testDraft?.mode === mode ? testDraft.questionValues : initialQuestionValues(quizAnswers);
    setTestMode(mode);
    setQuestionValues(nextValues);
    const done = allQuestionsAnswered(nextValues);
    const nextStep: TestStep = done ? 'grade' : 'questions';
    const nextIndex = done
      ? ALL_ABOUT_ME_TEST_QUESTIONS.length - 1
      : firstUnansweredIndex(nextValues);
    setTestStep(nextStep);
    setCurrentQuestionIndex(nextIndex);
    navRef.current = { testStep: nextStep, currentQuestionIndex: nextIndex };
    setSelectedModelId(testDraft?.selectedModelId ?? availableModels[0]?.id ?? '');
    setTestOpen(true);
  }

  function goNextQuestion() {
    const { testStep: step, currentQuestionIndex: index } = navRef.current;
    if (step !== 'questions') return;
    if (index >= ALL_ABOUT_ME_TEST_QUESTIONS.length - 1) {
      setTestStep('grade');
      navRef.current = { testStep: 'grade', currentQuestionIndex: index };
      return;
    }
    const next = Math.min(ALL_ABOUT_ME_TEST_QUESTIONS.length - 1, index + 1);
    navRef.current = { testStep: 'questions', currentQuestionIndex: next };
    setCurrentQuestionIndex(next);
  }

  function goPrevQuestion() {
    const { testStep: step, currentQuestionIndex: index } = navRef.current;
    if (step === 'grade') {
      setTestStep('questions');
      const last = ALL_ABOUT_ME_TEST_QUESTIONS.length - 1;
      navRef.current = { testStep: 'questions', currentQuestionIndex: last };
      setCurrentQuestionIndex(last);
      return;
    }
    const prev = Math.max(0, index - 1);
    navRef.current = { testStep: 'questions', currentQuestionIndex: prev };
    setCurrentQuestionIndex(prev);
  }

  function jumpToQuestion(index: number) {
    if (choiceAdvanceTimerRef.current) {
      clearTimeout(choiceAdvanceTimerRef.current);
      choiceAdvanceTimerRef.current = null;
    }
    const clamped = Math.max(0, Math.min(ALL_ABOUT_ME_TEST_QUESTIONS.length - 1, index));
    setTestStep('questions');
    setCurrentQuestionIndex(clamped);
    navRef.current = { testStep: 'questions', currentQuestionIndex: clamped };
  }

  function goToSubmitPage() {
    if (choiceAdvanceTimerRef.current) {
      clearTimeout(choiceAdvanceTimerRef.current);
      choiceAdvanceTimerRef.current = null;
    }
    setTestStep('grade');
    navRef.current = {
      testStep: 'grade',
      currentQuestionIndex: navRef.current.currentQuestionIndex,
    };
  }

  function updateQuestionValue(
    questionId: string,
    value: string,
    options?: { autoAdvanceChoice?: boolean },
  ) {
    setQuestionValues((prev) => {
      const next = { ...prev, [questionId]: value };
      // Immediate save — do not wait for Next/close.
      saveTestDraft({
        selectedModelId: draftLiveRef.current.selectedModelId,
        mode: draftLiveRef.current.testMode,
        questionValues: next,
      });
      return next;
    });
    if (options?.autoAdvanceChoice) {
      if (choiceAdvanceTimerRef.current) clearTimeout(choiceAdvanceTimerRef.current);
      // Snappy advance so multi-choice feels instant.
      choiceAdvanceTimerRef.current = setTimeout(() => {
        choiceAdvanceTimerRef.current = null;
        goNextQuestion();
      }, 120);
    }
  }

  function pauseTest() {
    if (choiceAdvanceTimerRef.current) {
      clearTimeout(choiceAdvanceTimerRef.current);
      choiceAdvanceTimerRef.current = null;
    }
    persistDraft(questionValues, testMode, selectedModelId, { force: true });
    setTestOpen(false);
    toast.info('AllAboutMe test saved', 'Progress is autosaved. Resume it any time.');
  }

  function closeTestSaving() {
    if (choiceAdvanceTimerRef.current) {
      clearTimeout(choiceAdvanceTimerRef.current);
      choiceAdvanceTimerRef.current = null;
    }
    persistDraft(questionValues, testMode, selectedModelId, { force: true });
    setTestOpen(false);
  }

  React.useEffect(() => {
    return () => {
      if (choiceAdvanceTimerRef.current) clearTimeout(choiceAdvanceTimerRef.current);
    };
  }, []);

  // Keep the current question chip visible in the compact horizontal map.
  React.useEffect(() => {
    if (!testOpen || testStep !== 'questions') return;
    const chip = document.querySelector<HTMLElement>(
      `[data-testid="all-about-me-q-chip-${currentQuestionIndex + 1}"]`,
    );
    if (chip && typeof chip.scrollIntoView === 'function') {
      chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }, [testOpen, testStep, currentQuestionIndex]);

  async function generateProfile() {
    if (!selectedModel) {
      toast.warning(
        'Pick a generation model',
        'Choose exactly one connected model, then generate AllAboutMe.md.',
      );
      return;
    }
    setGenerating(true);
    try {
      const answers = answersFromQuestionValues(questionValues, selectedModel);
      const complete =
        completePrompt === completeAllAboutMePrompt
          ? (prompt: string) => completeAllAboutMePrompt(prompt, selectedModel)
          : completePrompt;
      const nextMarkdown = await generateAllAboutMeMarkdown(
        answers,
        complete,
        testMode === 'update' ? markdown : undefined,
      );
      saveQuizProfile(answers, nextMarkdown);
      clearTestDraft();
      setTestOpen(false);
      toast.success('AllAboutMe.md generated', `Saved at ${ALL_ABOUT_ME_FILE_LOCATION}.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Generation failed. Check your model connection and try again.';
      toast.error('Could not generate AllAboutMe.md', message);
    } finally {
      setGenerating(false);
    }
  }

  const noRealModels = availableModels.length === 0;

  const currentAnswered = Boolean((questionValues[currentQuestion.id] ?? '').trim());

  return (
    <div className="mc7f-settings-all-about-me flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none">
      <header className="space-y-2">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-panel">
            <Brain className="h-4 w-4 text-accent-cyan" />
          </span>
          <div>
            <h2 className="text-page-title text-foreground">All About Me</h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Private profile Jarvis uses to match your tone, preferences, and writing style.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-[3.25rem]">
          <Badge
            variant="outline"
            className={cn(
              'text-metadata',
              markdown ? 'border-accent-sage/40 text-accent-sage' : 'text-muted-foreground',
            )}
          >
            {markdown ? 'Profile active' : 'Quiz not finished'}
          </Badge>
          {testDraft ? (
            <Badge variant="outline" className="text-metadata text-accent-copper">
              Draft saved
            </Badge>
          ) : null}
          {updatedAt ? (
            <Badge variant="outline" className="text-metadata">
              Updated {formatUserDateTime(updatedAt)}
            </Badge>
          ) : null}
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="space-y-1 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-accent-copper" />
              60-question test
            </CardTitle>
            <CardDescription>
              One question at a time. Answers autosave. Pick a generation model only at the end.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-border/80 bg-background/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-xl">
                  <div className="text-ui-strong text-foreground">Quick popup test</div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Fly through questions with compact progress. Choose exactly one connected model
                    when you generate.
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-metadata tabular-nums">
                  {availableModels.length} model{availableModels.length === 1 ? '' : 's'} ready
                </Badge>
              </div>
              {noRealModels ? (
                <div className="mt-4 rounded-lg border border-dashed border-border bg-panel/50 p-3 text-sm text-muted-foreground">
                  Connect a real AI model in Settings → Providers or install a local model in
                  Settings → Local Models before taking the test.
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={noRealModels}
                  onClick={() => openTest('create')}
                  className="shadow-[0_0_20px_hsl(var(--accent-copper)/0.2)]"
                >
                  <Brain className="h-3.5 w-3.5" />
                  Take the test
                </Button>
                {testDraft ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => openTest(testDraft.mode)}
                  >
                    <PauseCircle className="h-3.5 w-3.5" />
                    Resume saved test
                  </Button>
                ) : null}
                {markdown ? (
                  <Button type="button" variant="ghost" onClick={() => openTest('update')}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retake to update scores
                  </Button>
                ) : null}
              </div>
            </div>

            {markdown ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                  <div className="flex-1">
                    <div className="text-ui-strong text-foreground">Danger zone</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Delete the entire profile only when you want a true fresh retake.
                    </p>
                    {!deleteArmed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="mt-3 text-destructive"
                        onClick={() => setDeleteArmed(true)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete AllAboutMe.md
                      </Button>
                    ) : (
                      <div className="mt-3 flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="all-about-me-delete-confirm">
                            Type delete to confirm
                          </Label>
                          <input
                            id="all-about-me-delete-confirm"
                            value={deleteConfirmation}
                            onChange={(event) => setDeleteConfirmation(event.currentTarget.value)}
                            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={deleteConfirmation !== 'delete'}
                          onClick={() => {
                            if (deleteProfile(deleteConfirmation)) {
                              setDeleteConfirmation('');
                              setDeleteArmed(false);
                              toast.success(
                                'AllAboutMe.md deleted',
                                'You can now take a completely fresh test.',
                              );
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-accent-cyan" />
              AllAboutMe.md
            </CardTitle>
            <CardDescription>
              A stable, user-controlled profile. Automatic interaction preferences are stored
              separately in learning.md.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border bg-background/40 p-3">
              <div>
                <div className="text-ui-strong text-foreground">Intentional profile</div>
                <p className="text-metadata text-muted-foreground">
                  Jarvis changes this document only when you complete the profile flow or make an
                  explicit edit.
                </p>
              </div>
            </div>
            {markdown ? (
              <div className="rounded-md border border-border bg-background/40 p-3">
                <div className="text-ui-strong text-foreground">File location</div>
                <p className="mt-1 font-mono text-xs text-accent-cyan">
                  {ALL_ABOUT_ME_FILE_LOCATION}
                </p>
              </div>
            ) : null}

            {markdown ? (
              <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-black/20 p-4 text-xs leading-5 text-foreground">
                {markdown}
              </pre>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-background/40 p-5 text-secondary text-muted-foreground">
                Finish the quiz to generate the first stable profile. Jarvis will use that document
                as bounded context until you intentionally update or delete it.
              </div>
            )}
          </CardContent>
        </Card>

        <JarvisLearningControls />
      </section>

      <Dialog
        open={testOpen}
        onOpenChange={(open) => {
          // Any close path (X, Escape, overlay, Settings dismiss) must save.
          if (!open) {
            if (choiceAdvanceTimerRef.current) {
              clearTimeout(choiceAdvanceTimerRef.current);
              choiceAdvanceTimerRef.current = null;
            }
            flushLiveDraft({ force: true });
            persistDraft(questionValues, testMode, selectedModelId, { force: true });
          }
          setTestOpen(open);
        }}
      >
        <DialogContent
          hideClose
          className="grid max-h-[92vh] w-[min(920px,calc(100vw-2rem))] max-w-none grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0"
        >
          {/* Compact progress + single-row question navigator */}
          <div className="min-w-0 border-b border-border/70 bg-panel/95 px-4 pb-3 pt-3">
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-border/50"
              role="progressbar"
              aria-label="All About Me test progress"
              aria-valuemin={0}
              aria-valuemax={totalQuestions}
              aria-valuenow={answeredCount}
            >
              <div
                className="h-full rounded-full bg-accent-copper transition-[width] duration-200 ease-out"
                style={{
                  width: `${Math.round((answeredCount / Math.max(totalQuestions, 1)) * 100)}%`,
                }}
              />
            </div>

            <DialogHeader className="mt-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DialogTitle className="text-[16px] leading-tight">All About Me Test</DialogTitle>
                  <DialogDescription className="mt-0.5 text-[12px] leading-snug">
                    {testStep === 'grade'
                      ? 'Pick one generation model, then generate. Blank answers are fine.'
                      : testMode === 'update'
                        ? 'Retake — jump any number, or Submit anytime.'
                        : 'Answer fast, jump any number, Submit anytime.'}
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className="text-metadata tabular-nums"
                    data-testid="all-about-me-question-progress"
                  >
                    {answeredCount}/{totalQuestions}
                  </Badge>
                  {testStep === 'questions' ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-metadata transition-colors duration-150',
                        currentAnswered
                          ? 'border-accent-copper/50 bg-accent-copper/10 text-accent-copper'
                          : 'text-muted-foreground',
                      )}
                      data-testid="all-about-me-current-answered"
                      data-answered={currentAnswered ? 'true' : 'false'}
                    >
                      {currentAnswered ? 'Answered' : 'Unanswered'}
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={closeTestSaving}
                    aria-label="Close and save test"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div
              className="mt-2.5 min-w-0 overflow-x-auto overflow-y-hidden rounded-lg border border-border/55 bg-background/30 px-1.5 py-1.5 [scrollbar-width:thin]"
              role="navigation"
              aria-label="Question map"
              data-testid="all-about-me-question-map"
            >
              <div className="flex w-max gap-0.5">
                {ALL_ABOUT_ME_TEST_QUESTIONS.map((question, index) => {
                  const answered = Boolean((questionValues[question.id] ?? '').trim());
                  const isCurrent = testStep === 'questions' && index === currentQuestionIndex;
                  return (
                    <button
                      key={question.id}
                      type="button"
                      data-testid={`all-about-me-q-chip-${index + 1}`}
                      data-answered={answered ? 'true' : 'false'}
                      data-current={isCurrent ? 'true' : 'false'}
                      aria-label={`Question ${index + 1}${answered ? ', answered' : ', not answered'}${isCurrent ? ', current' : ''}`}
                      aria-current={isCurrent ? 'step' : undefined}
                      onClick={() => jumpToQuestion(index)}
                      className={cn(
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums transition-all duration-150',
                        isCurrent &&
                          'bg-accent-cyan/20 text-foreground ring-2 ring-accent-cyan/65 ring-offset-1 ring-offset-background',
                        !isCurrent &&
                          answered &&
                          'bg-accent-copper/30 text-accent-copper hover:bg-accent-copper/40',
                        !isCurrent &&
                          !answered &&
                          'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {index + 1}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Autosaved · scroll the strip or click a number to jump
            </p>
          </div>

          <div
            data-testid="all-about-me-question-stage"
            className="min-w-0 max-h-[min(58vh,520px)] w-full overflow-y-auto px-4 py-5 sm:px-6"
          >
            {testStep === 'questions' ? (
              <div
                key={currentQuestion.id}
                className="mx-auto w-full max-w-2xl rounded-2xl border border-border/75 bg-background/40 p-5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-opacity duration-150"
              >
                {currentQuestion.kind === 'written' ? (
                  <QuestionField
                    index={currentQuestionIndex}
                    questionId={currentQuestion.id}
                    prompt={currentQuestion.prompt}
                    value={questionValues[currentQuestion.id] ?? ''}
                    onChange={(value) => updateQuestionValue(currentQuestion.id, value)}
                    onCtrlEnter={goNextQuestion}
                  />
                ) : (
                  <div className="space-y-3">
                    <div className="text-[15px] font-medium leading-snug text-foreground">
                      <span className="mr-2 text-metadata font-semibold text-accent-copper">
                        {currentQuestionIndex + 1}.
                      </span>
                      {currentQuestion.prompt}
                    </div>
                    <div className="grid gap-1.5">
                      {(currentQuestion.options ?? []).map((option) => {
                        const selected = questionValues[currentQuestion.id] === option;
                        return (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              updateQuestionValue(currentQuestion.id, option, {
                                autoAdvanceChoice: true,
                              })
                            }
                            className={cn(
                              'rounded-xl border px-3 py-2.5 text-left text-sm transition-all duration-100',
                              selected
                                ? 'border-accent-copper/70 bg-accent-copper/15 text-foreground'
                                : 'border-border/80 bg-background/40 text-muted-foreground hover:border-accent-cyan/40 hover:text-foreground',
                            )}
                          >
                            {option}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Tap a choice to advance instantly.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="mx-auto max-w-xl space-y-4">
                <div className="rounded-2xl border border-border/80 bg-background/40 p-4">
                  <div className="text-ui-strong text-foreground">Generation model</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Select exactly one model you can use right now. Only connected cloud models and
                    installed local models are listed.
                  </p>
                  <div
                    className="mt-3 grid max-h-[240px] gap-1.5 overflow-y-auto pr-0.5"
                    role="radiogroup"
                    aria-label="Generation model"
                  >
                    {availableModels.map((option) => (
                      <ModelChoiceCard
                        key={option.id}
                        option={option}
                        selected={selectedModelId === option.id}
                        onSelect={() => {
                          setSelectedModelId(option.id);
                          persistDraft(questionValues, testMode, option.id, { force: true });
                        }}
                      />
                    ))}
                  </div>
                  {/* Accessible fallback for tests / keyboard users */}
                  <label className="sr-only" htmlFor="all-about-me-model-select">
                    AI model for grading
                  </label>
                  <select
                    id="all-about-me-model-select"
                    aria-label="AI model for grading"
                    value={selectedModelId}
                    onChange={(event) => {
                      setSelectedModelId(event.currentTarget.value);
                      persistDraft(questionValues, testMode, event.currentTarget.value, {
                        force: true,
                      });
                    }}
                    className="mt-3 h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
                  >
                    {availableModels.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} - {option.provider}/{option.model}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rounded-xl border border-dashed border-border/70 bg-panel/40 px-3 py-2 text-metadata text-muted-foreground">
                  {answeredCount}/{totalQuestions} answered
                  {answeredCount === 0
                    ? ' · none required — you can still generate'
                    : ' · ready to generate'}
                </div>
              </div>
            )}
          </div>

          <div className="min-w-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-panel/95 px-5 py-3">
            <p className="text-[11px] text-muted-foreground">
              {testStep === 'questions' ? (
                <>
                  <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">
                    Ctrl
                  </kbd>
                  +
                  <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">
                    Enter
                  </kbd>
                  {' next · Submit anytime'}
                </>
              ) : (
                'One model · Generate writes AllAboutMe.md'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={pauseTest}>
                <PauseCircle className="h-3.5 w-3.5" />
                Pause
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={testStep === 'questions' && currentQuestionIndex === 0}
                onClick={goPrevQuestion}
              >
                Back
              </Button>
              {testStep === 'questions' ? (
                <>
                  <Button type="button" variant="secondary" onClick={goToSubmitPage}>
                    Submit
                  </Button>
                  <Button
                    type="button"
                    onClick={goNextQuestion}
                    aria-label={
                      currentQuestionIndex >= ALL_ABOUT_ME_TEST_QUESTIONS.length - 1
                        ? 'Review and submit'
                        : currentAnswered
                          ? 'Next question'
                          : 'Skip question'
                    }
                  >
                    {currentQuestionIndex >= ALL_ABOUT_ME_TEST_QUESTIONS.length - 1
                      ? 'Submit'
                      : currentAnswered
                        ? 'Next'
                        : 'Skip'}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  onClick={generateProfile}
                  disabled={generating || !canGenerate}
                >
                  {generating ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Generate AllAboutMe.md
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
