import type { Part } from '@/types/chat';
import type { JarvisPlanReview } from './types';

const PLAN_FENCE_RE = /```(?:jarvis_plan|json)\s*([\s\S]*?)```/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function textPart(text: string): Part[] {
  const trimmed = text.trim();
  return trimmed ? [{ kind: 'text', text: trimmed }] : [];
}

function cleanPlanText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\{action\}/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isExecutablePlanText(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    /\b(file|files|code|tests?|typecheck|build|terminal|command|script|components?|features?|bug|app|vibespace|cards?|types?)\b/,
    /\b(implement|refactor|edit|update|delete|write|run|deploy|install|configure|fix)\b/,
    /\b(add|create)\s+(?:a\s+|an\s+|the\s+)?(?:file|test|component|page|store|route|button|card|feature|schedule|terminal|agent|skill|action)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function asPlan(value: unknown, index: number): JarvisPlanReview | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = asString(record.title, 'Review plan');
  const summary = asString(record.summary);
  const steps = asStringArray(record.steps);
  if (!summary && steps.length === 0) return null;
  const plan: JarvisPlanReview = {
    id: asString(record.id, `plan_${Date.now()}_${index}`),
    title,
    summary: summary || steps.join('\n'),
    steps,
    risks: asStringArray(record.risks),
    status: 'pending',
  };
  if (typeof record.executable === 'boolean') {
    plan.executable = record.executable;
  } else if (!isExecutablePlanText([title, plan.summary, ...steps].join('\n'))) {
    plan.executable = false;
  }
  return plan;
}

function forcedPlan(text: string): Part {
  const cleaned = cleanPlanText(text) || 'Review the request and confirm the next safe steps.';
  return {
    kind: 'plan_review',
    plan: {
      id: `plan_${Date.now()}`,
      title: 'Review plan',
      summary: cleaned,
      // Prose already contains its steps. Do not repeat the whole plan below
      // the summary; structured provider plans still render their step list.
      steps: [],
      executable: isExecutablePlanText(cleaned),
      status: 'pending',
    },
  };
}

export function parseJarvisPlanBlocks(
  text: string,
  options: { force?: boolean } = {},
): { hasPlanBlocks: boolean; parts: Part[] } {
  const parts: Part[] = [];
  let lastIndex = 0;
  let count = 0;
  for (const match of text.matchAll(PLAN_FENCE_RE)) {
    parts.push(...textPart(text.slice(lastIndex, match.index)));
    lastIndex = (match.index ?? 0) + match[0].length;
    try {
      const plan = asPlan(JSON.parse(match[1] ?? ''), count);
      if (plan) {
        parts.push({ kind: 'plan_review', plan });
        count += 1;
      } else {
        parts.push({ kind: 'text', text: match[0].trim() });
      }
    } catch {
      parts.push({ kind: 'text', text: match[0].trim() });
    }
  }
  parts.push(...textPart(text.slice(lastIndex)));
  if (count === 0 && options.force && text.trim()) {
    return { hasPlanBlocks: true, parts: [forcedPlan(text)] };
  }
  return {
    hasPlanBlocks: count > 0,
    parts: parts.length ? parts : [{ kind: 'text', text }],
  };
}
