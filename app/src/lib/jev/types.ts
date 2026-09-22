export type JevJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JevJsonValue[]
  | { readonly [key: string]: JevJsonValue };

export type JevQuestionInstructions = string | JevJsonValue;

export type JevNoulQuestion = Readonly<{
  type: 'noul';
  instructions: JevQuestionInstructions;
  criteria?: Readonly<{ true?: JevQuestionInstructions; false?: JevQuestionInstructions }>;
}>;

export type JevChoiceQuestion = Readonly<{
  type: 'choice';
  instructions: JevQuestionInstructions;
  criteria: Readonly<Record<string, JevQuestionInstructions | null>>;
}>;

export type JevScoreQuestion = Readonly<{
  type: 'score';
  instructions: JevQuestionInstructions;
  criteria: readonly JevQuestionInstructions[];
}>;

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export type JevNoulAnswer = Readonly<{ type: 'noul'; noul: number }>;
export type JevChoiceAnswer = Readonly<{
  type: 'choice';
  choice: string;
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
}>;
export type JevScoreAnswer = Readonly<{
  type: 'score';
  score: number;
  legend: Readonly<Record<string, string>>;
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
}>;

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  /** Provider-reported billing when the native bridge supplies it; otherwise null. */
  costUsd: number | null;
}>;

export type JevEvaluation = Readonly<{
  model: string;
  answers: Readonly<Record<string, JevAnswer>>;
  usage: JevUsage;
  observedAt: number;
}>;
