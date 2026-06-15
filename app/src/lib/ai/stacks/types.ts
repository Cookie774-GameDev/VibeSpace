import type { ProviderId } from '@/types/common';

/** User-facing Vibe Hive mode. `off` = single-model chat (default). */
export type StackPresetId = 'off' | 'fast' | 'balanced' | 'quality' | 'custom';

export type StackTaskType = 'general' | 'write' | 'code' | 'review' | 'research';

export interface StackStepSpec {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  /** Appended to the agent system prompt for this step only. */
  systemAppend: string;
  temperature?: number;
  max_output_tokens?: number;
}

export interface StackStepResult {
  step: StackStepSpec;
  text: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  provider: ProviderId;
  model: string;
  durationMs: number;
}

export interface StackRunResult {
  finalText: string;
  steps: StackStepResult[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  provider: ProviderId;
  model: string;
  taskType: StackTaskType;
  preset: StackPresetId;
}

export interface StackRunCallbacks {
  onStepStart?: (step: StackStepSpec, index: number, total: number) => void;
  onStepDelta?: (step: StackStepSpec, index: number, delta: string, acc: string) => void;
  onStepDone?: (result: StackStepResult, index: number) => void;
}
