import {
  GROK_HIGH_REASONING_EFFORT,
  HIVE_FRONTIER_MODELS,
} from './frontierModels';
import type { StackPresetId, StackStepSpec, StackTaskType } from './types';

export const DEFAULT_CUSTOM_STEPS: StackStepSpec[] = [
  {
    id: 'local-draft',
    label: 'Local draft',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    temperature: 0.6,
    systemAppend: 'First pass answer.',
  },
  {
    id: 'cloud-polish',
    label: 'Cloud polish',
    provider: 'google',
    model: HIVE_FRONTIER_MODELS.google_flash,
    temperature: 0.3,
    systemAppend: 'Polish the draft. Final answer only.',
  },
];

const FAST_GENERAL: StackStepSpec[] = [
  {
    id: 'answer',
    label: 'Answer',
    provider: 'google',
    model: HIVE_FRONTIER_MODELS.google_flash,
    temperature: 0.5,
    systemAppend: 'Answer directly in one pass. Be concise.',
  },
];

const BALANCED_GENERAL: StackStepSpec[] = [
  {
    id: 'draft',
    label: 'Draft',
    provider: 'google',
    model: HIVE_FRONTIER_MODELS.google_flash,
    temperature: 0.6,
    systemAppend: 'Produce a complete first draft. Structure clearly.',
  },
  {
    id: 'check',
    label: 'Check',
    provider: 'anthropic',
    model: HIVE_FRONTIER_MODELS.anthropic_opus,
    temperature: 0.3,
    systemAppend:
      'Review the draft above. Fix factual errors and unclear phrasing. Return the improved final answer only — no meta commentary.',
  },
];

const QUALITY_GENERAL: StackStepSpec[] = [
  {
    id: 'draft',
    label: 'Draft',
    provider: 'anthropic',
    model: HIVE_FRONTIER_MODELS.anthropic_opus,
    temperature: 0.7,
    systemAppend: 'Produce a thorough first draft.',
  },
  {
    id: 'critique',
    label: 'Critique',
    provider: 'openai',
    model: HIVE_FRONTIER_MODELS.openai_flagship,
    temperature: 0.4,
    systemAppend:
      'Critique the draft: list issues (accuracy, structure, missing steps). Then provide a revised version that fixes them. Output only the revised answer.',
  },
  {
    id: 'polish',
    label: 'Polish',
    provider: 'google',
    model: HIVE_FRONTIER_MODELS.google_flash,
    temperature: 0.3,
    max_output_tokens: 4096,
    systemAppend: 'Tighten the answer. Remove redundancy. Return the final polished version only.',
  },
];

const HIGH_ORIENT: StackStepSpec = {
  id: 'orient',
  label: 'Orient',
  provider: 'xai',
  model: HIVE_FRONTIER_MODELS.grok,
  temperature: 0.5,
  provider_options: { reasoning_effort: GROK_HIGH_REASONING_EFFORT },
  systemAppend:
    'Analyze the question. Identify constraints, risks, and the best solution shape. Output a structured brief for downstream steps.',
};

const HIGH_GENERAL: StackStepSpec[] = [
  HIGH_ORIENT,
  {
    id: 'draft',
    label: 'Draft',
    provider: 'anthropic',
    model: HIVE_FRONTIER_MODELS.anthropic_opus,
    temperature: 0.7,
    systemAppend: 'Using the brief above, produce a thorough first draft.',
  },
  {
    id: 'harden',
    label: 'Harden',
    provider: 'openai',
    model: HIVE_FRONTIER_MODELS.openai_coding,
    temperature: 0.3,
    systemAppend:
      'Stress-test reasoning and correctness. Fix logic gaps. Return the improved answer only.',
  },
  {
    id: 'polish',
    label: 'Polish',
    provider: 'google',
    model: HIVE_FRONTIER_MODELS.google_flash,
    temperature: 0.3,
    max_output_tokens: 4096,
    systemAppend: 'Final polish. Remove redundancy. Return the final answer only.',
  },
];

const QUALITY_CODE: StackStepSpec[] = [
  {
    id: 'plan',
    label: 'Plan',
    provider: 'anthropic',
    model: HIVE_FRONTIER_MODELS.anthropic_opus,
    systemAppend: 'Write a short implementation plan, then the code.',
  },
  {
    id: 'implement',
    label: 'Implement',
    provider: 'deepseek',
    model: HIVE_FRONTIER_MODELS.deepseek_pro,
    max_output_tokens: 8192,
    systemAppend: 'Implement based on the plan. Match project conventions.',
  },
  {
    id: 'review',
    label: 'Review',
    provider: 'openai',
    model: HIVE_FRONTIER_MODELS.openai_coding,
    systemAppend: 'Security and correctness review. Return the final code only.',
  },
];

const BALANCED_CODE: StackStepSpec[] = [
  {
    id: 'plan',
    label: 'Plan',
    provider: 'deepseek',
    model: HIVE_FRONTIER_MODELS.deepseek_pro,
    systemAppend: 'Outline the implementation approach in bullets, then write the code.',
  },
  {
    id: 'review',
    label: 'Review',
    provider: 'anthropic',
    model: HIVE_FRONTIER_MODELS.anthropic_opus,
    systemAppend: 'Review the code for bugs and edge cases. Return the fixed final code only.',
  },
];

function cloneSteps(steps: readonly StackStepSpec[]): StackStepSpec[] {
  return steps.map((step) => ({
    ...step,
    provider_options: step.provider_options ? { ...step.provider_options } : undefined,
  }));
}

export function stepsForPreset(
  preset: StackPresetId,
  taskType: StackTaskType,
  customSteps: readonly StackStepSpec[] = DEFAULT_CUSTOM_STEPS,
): StackStepSpec[] {
  if (preset === 'off') return [];
  if (preset === 'custom') return cloneSteps(customSteps);
  if (taskType === 'code') {
    if (preset === 'balanced') return cloneSteps(BALANCED_CODE);
    if (preset === 'quality') return cloneSteps(QUALITY_CODE);
    if (preset === 'high') return cloneSteps([HIGH_ORIENT, ...QUALITY_CODE]);
  }
  if (preset === 'fast') return cloneSteps(FAST_GENERAL);
  if (preset === 'balanced') return cloneSteps(BALANCED_GENERAL);
  if (preset === 'quality') return cloneSteps(QUALITY_GENERAL);
  return cloneSteps(HIGH_GENERAL);
}
