import type { StackPresetId, StackTaskType } from './types';

const CODE_RE = /\b(code|bug|fix|refactor|implement|typescript|rust|python|function|class|api|test suite|unit test)\b/i;
const WRITE_RE = /\b(write|draft|email|blog|essay|copy|tone|rewrite|proofread|article)\b/i;
const REVIEW_RE = /\b(review|critique|audit|feedback|grade|evaluate|assess|rubrics?)\b/i;
const RESEARCH_RE = /\b(research|compare|sources?|cite|summarize|investigate|pros and cons)\b/i;

const HIVE_SLASH_RE = /^\s*\/(?:hive|stack)(?:\s+(\w+))?(?:\s+(\w+))?\s*/i;

/**
 * Rule-based task classifier for Vibe Hive.
 * Cheap and deterministic — no extra LLM call on the hot path.
 */
export function classifyStackTask(text: string): StackTaskType {
  const t = text.trim();
  if (!t) return 'general';
  if (REVIEW_RE.test(t)) return 'review';
  if (RESEARCH_RE.test(t)) return 'research';
  if (CODE_RE.test(t)) return 'code';
  if (WRITE_RE.test(t)) return 'write';
  return 'general';
}

/** Parse `/hive quality write` or `/stack balanced` slash hints. */
export function parseStackSlashCommand(text: string): {
  preset?: StackPresetId;
  taskType?: StackTaskType;
  cleanText: string;
} {
  const m = HIVE_SLASH_RE.exec(text);
  if (!m) return { cleanText: text };

  const presetRaw = m[1]?.toLowerCase();
  const taskRaw = m[2]?.toLowerCase();
  const presetMap: Record<string, StackPresetId> = {
    fast: 'fast',
    balanced: 'balanced',
    quality: 'quality',
    custom: 'custom',
    off: 'off',
  };
  const taskMap: Record<string, StackTaskType> = {
    write: 'write',
    code: 'code',
    review: 'review',
    research: 'research',
    general: 'general',
  };

  return {
    preset: presetRaw ? presetMap[presetRaw] : undefined,
    taskType: taskRaw ? taskMap[taskRaw] : undefined,
    cleanText: text.slice(m[0].length).trim() || text.trim(),
  };
}

export function effectiveStackPreset(
  userPreset: StackPresetId,
  slashPreset?: StackPresetId,
): StackPresetId {
  if (slashPreset && slashPreset !== 'off') return slashPreset;
  return userPreset;
}
