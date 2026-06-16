import type { ProviderId } from '@/types';

export type StackPresetId = 'off' | 'fast' | 'balanced' | 'quality' | 'ultra' | 'custom';

export type StackTaskType = 'general' | 'write' | 'code' | 'review' | 'research';

export interface StackStepSpec {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  systemAppend: string;
  temperature?: number;
  max_output_tokens?: number;
  provider_options?: Record<string, unknown>;
}

export interface StackStepResult extends StackStepSpec {
  text: string;
  status: 'done' | 'error';
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  duration_ms: number;
  error?: string;
}

export interface StackRunResult {
  finalText: string;
  steps: StackStepResult[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}
