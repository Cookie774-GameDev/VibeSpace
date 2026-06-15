import type { StackPresetId, StackTaskType } from './types';

const PRESET_TOKENS = new Set<StackPresetId>([
  'off',
  'fast',
  'balanced',
  'quality',
  'high',
  'custom',
]);

const TASK_TOKENS = new Set<StackTaskType>([
  'general',
  'write',
  'code',
  'review',
  'research',
]);

export interface ParsedStackSlashCommand {
  matched: boolean;
  preset?: StackPresetId;
  taskType?: StackTaskType;
  text: string;
}

export function classifyStackTask(userText: string): StackTaskType {
  const text = userText.toLowerCase();
  if (/\b(review|critique|audit|feedback|grade)\b/.test(text)) return 'review';
  if (/\b(research|compare|sources?|cite|summari[sz]e)\b/.test(text)) return 'research';
  if (/\b(code|bug|fix|implement|typescript|api|test)\b/.test(text)) return 'code';
  if (/\b(write|draft|email|blog|essay|copy)\b/.test(text)) return 'write';
  return 'general';
}

export function parseStackSlashCommand(raw: string): ParsedStackSlashCommand {
  const match = /^\s*\/(?:hive|stack)\b\s*/i.exec(raw);
  if (!match) return { matched: false, text: raw };
  const rest = raw.slice(match[0].length);
  const tokens = rest.trimStart().split(/\s+/).filter(Boolean);
  let preset: StackPresetId | undefined;
  let taskType: StackTaskType | undefined;
  let consumed = 0;

  const token1 = tokens[0]?.toLowerCase();
  if (token1 && PRESET_TOKENS.has(token1 as StackPresetId)) {
    preset = token1 as StackPresetId;
    consumed = 1;
  } else if (token1 && TASK_TOKENS.has(token1 as StackTaskType)) {
    taskType = token1 as StackTaskType;
    consumed = 1;
  }

  const token2 = tokens[consumed]?.toLowerCase();
  if (token2 && TASK_TOKENS.has(token2 as StackTaskType)) {
    taskType = token2 as StackTaskType;
    consumed += 1;
  }

  return {
    matched: true,
    preset,
    taskType,
    text: tokens.slice(consumed).join(' '),
  };
}

export function effectiveStackPreset(
  storedPreset: StackPresetId,
  slashPreset: StackPresetId | undefined,
): StackPresetId {
  return slashPreset ?? storedPreset;
}
