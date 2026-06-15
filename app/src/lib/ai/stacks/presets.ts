import type { ProviderId } from '@/types/common';
import { GOOGLE_DEFAULT_MODEL } from '../providers/google';
import { GROQ_DEFAULT_MODEL } from '../providers/groq';
import { FRONTIER } from './frontierModels';
import type { StackPresetId, StackStepSpec, StackTaskType } from './types';

/** User-facing Vibe Hive mode labels. */
export const VIBE_HIVE_LABELS: Record<StackPresetId, string> = {
  off: 'Single model',
  fast: 'Vibe Hive Fast',
  balanced: 'Vibe Hive Balanced',
  quality: 'Vibe Hive Quality',
  custom: 'Vibe Hive Custom',
};

/** @deprecated Use VIBE_HIVE_LABELS */
export const STACK_PRESET_LABELS = VIBE_HIVE_LABELS;

const FAST: StackStepSpec[] = [
  {
    id: 'answer',
    label: 'Answer',
    provider: 'google',
    model: FRONTIER.google_flash,
    systemAppend: 'Answer directly in one pass. Be concise.',
    temperature: 0.5,
  },
];

const BALANCED: StackStepSpec[] = [
  {
    id: 'draft',
    label: 'Draft',
    provider: 'google',
    model: FRONTIER.google_flash,
    systemAppend: 'Produce a complete first draft. Structure clearly.',
    temperature: 0.6,
  },
  {
    id: 'check',
    label: 'Check',
    provider: 'anthropic',
    model: FRONTIER.anthropic_opus,
    systemAppend:
      'Review the draft above. Fix factual errors and unclear phrasing. Return the improved final answer only — no meta commentary.',
    temperature: 0.3,
  },
];

const QUALITY: StackStepSpec[] = [
  {
    id: 'draft',
    label: 'Draft',
    provider: 'anthropic',
    model: FRONTIER.anthropic_opus,
    systemAppend: 'Produce a thorough first draft.',
    temperature: 0.7,
  },
  {
    id: 'critique',
    label: 'Critique',
    provider: 'openai',
    model: FRONTIER.openai_flagship,
    systemAppend:
      'Critique the draft: list issues (accuracy, structure, missing steps). Then provide a revised version that fixes them. Output only the revised answer.',
    temperature: 0.4,
  },
  {
    id: 'polish',
    label: 'Polish',
    provider: 'google',
    model: FRONTIER.google_flash,
    systemAppend: 'Tighten the answer. Remove redundancy. Return the final polished version only.',
    temperature: 0.3,
    max_output_tokens: 4096,
  },
];

const TASK_OVERRIDES: Partial<Record<StackTaskType, Partial<Record<StackPresetId, StackStepSpec[]>>>> = {
  code: {
    balanced: [
      {
        id: 'plan',
        label: 'Plan',
        provider: 'deepseek',
        model: FRONTIER.deepseek_pro,
        systemAppend: 'Outline the implementation approach in bullets, then write the code.',
        temperature: 0.2,
      },
      {
        id: 'review',
        label: 'Review',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Review the code for bugs and edge cases. Return the fixed final code only.',
        temperature: 0.2,
      },
    ],
    quality: [
      {
        id: 'plan',
        label: 'Plan',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Write a short implementation plan, then the code.',
        temperature: 0.3,
      },
      {
        id: 'implement',
        label: 'Implement',
        provider: 'deepseek',
        model: FRONTIER.deepseek_pro,
        systemAppend: 'Implement based on the plan. Match project conventions.',
        temperature: 0.2,
        max_output_tokens: 8192,
      },
      {
        id: 'review',
        label: 'Review',
        provider: 'openai',
        model: FRONTIER.openai_coding,
        systemAppend: 'Security and correctness review. Return the final code only.',
        temperature: 0.2,
      },
    ],
  },
  write: {
    balanced: [
      {
        id: 'draft',
        label: 'Draft',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Write a clear first draft.',
        temperature: 0.7,
      },
      {
        id: 'edit',
        label: 'Edit',
        provider: 'google',
        model: FRONTIER.google_flash,
        systemAppend: 'Edit for clarity and tone. Return the final piece only.',
        temperature: 0.4,
      },
    ],
    quality: [
      {
        id: 'draft',
        label: 'Draft',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Write a thorough first draft.',
        temperature: 0.7,
      },
      {
        id: 'edit',
        label: 'Edit',
        provider: 'openai',
        model: FRONTIER.openai_flagship,
        systemAppend: 'Edit for clarity, structure, and tone. Return the improved piece only.',
        temperature: 0.4,
      },
      {
        id: 'tighten',
        label: 'Tighten',
        provider: 'google',
        model: FRONTIER.google_flash,
        systemAppend: 'Tighten prose. Final version only.',
        temperature: 0.3,
      },
    ],
  },
  review: {
    fast: [
      {
        id: 'review',
        label: 'Review',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Review the content. List issues with severity, then a short summary verdict.',
        temperature: 0.3,
      },
    ],
    quality: [
      {
        id: 'rubric',
        label: 'Score',
        provider: 'openai',
        model: FRONTIER.openai_flagship,
        systemAppend: 'Score against: correctness, clarity, completeness (1-5 each). List gaps.',
        temperature: 0.3,
      },
      {
        id: 'fixes',
        label: 'Fixes',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Provide actionable fixes prioritized by impact.',
        temperature: 0.4,
      },
      {
        id: 'summary',
        label: 'Summary',
        provider: 'google',
        model: FRONTIER.google_flash,
        systemAppend: 'One-paragraph executive summary of the review.',
        temperature: 0.3,
      },
    ],
  },
  research: {
    balanced: [
      {
        id: 'outline',
        label: 'Outline',
        provider: 'google',
        model: FRONTIER.google_pro,
        systemAppend: 'Outline key questions and subtopics to cover.',
        temperature: 0.5,
      },
      {
        id: 'synthesize',
        label: 'Synthesize',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Synthesize a structured answer with TL;DR, findings, caveats.',
        temperature: 0.5,
      },
    ],
    quality: [
      {
        id: 'outline',
        label: 'Outline',
        provider: 'google',
        model: FRONTIER.google_pro,
        systemAppend: 'Outline key questions and subtopics to cover.',
        temperature: 0.5,
      },
      {
        id: 'synthesize',
        label: 'Synthesize',
        provider: 'anthropic',
        model: FRONTIER.anthropic_opus,
        systemAppend: 'Synthesize a structured answer with TL;DR, findings, caveats.',
        temperature: 0.5,
      },
      {
        id: 'factcheck',
        label: 'Fact-check',
        provider: 'openrouter',
        model: FRONTIER.perplexity_sonar,
        systemAppend: 'Fact-check the synthesis. Flag uncertain claims. Return the corrected final answer.',
        temperature: 0.3,
      },
    ],
  },
};

/** Default custom hive — user can override steps in settings later. */
export const DEFAULT_CUSTOM_STEPS: StackStepSpec[] = [
  {
    id: 'local-draft',
    label: 'Local draft',
    provider: 'groq',
    model: GROQ_DEFAULT_MODEL,
    systemAppend: 'First pass answer.',
    temperature: 0.6,
  },
  {
    id: 'cloud-polish',
    label: 'Cloud polish',
    provider: 'google',
    model: FRONTIER.google_flash,
    systemAppend: 'Polish the draft. Final answer only.',
    temperature: 0.3,
  },
];

export function stepsForPreset(
  preset: StackPresetId,
  taskType: StackTaskType,
  customSteps?: StackStepSpec[],
): StackStepSpec[] {
  if (preset === 'off') return [];
  const taskOverride = TASK_OVERRIDES[taskType]?.[preset];
  if (taskOverride?.length) return taskOverride.map((s) => ({ ...s }));

  switch (preset) {
    case 'fast':
      return TASK_OVERRIDES[taskType]?.fast ?? FAST.map((s) => ({ ...s }));
    case 'balanced':
      return BALANCED.map((s) => ({ ...s }));
    case 'quality':
      return QUALITY.map((s) => ({ ...s }));
    case 'custom':
      return (customSteps?.length ? customSteps : DEFAULT_CUSTOM_STEPS).map((s) => ({ ...s }));
    default:
      return [];
  }
}

export function pickProviderFallback(step: StackStepSpec, available: ProviderId[]): StackStepSpec {
  if (available.includes(step.provider)) return step;
  const order: ProviderId[] = ['google', 'groq', 'anthropic', 'openai', 'deepseek', 'openrouter'];
  const fallback = order.find((p) => available.includes(p));
  if (!fallback) return step;
  return { ...step, provider: fallback };
}
