#!/usr/bin/env node
/**
 * Vibe Hive topology simulator — estimates composite VibeScore for pipeline
 * configs vs single-model baselines (Opus 4.8, GPT-5.5, Fable 5) using
 * published June 2026 benchmark strengths (no API calls).
 *
 * Usage: node benchmarks/vibebench/simulate-hive-topologies.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'hive-simulation-2026-06.json');

const CATEGORIES = [
  'HiveQuality',
  'TerminalAware',
  'ToolActions',
  'CodeCorrect',
  'Security',
  'Latency',
  'CostEfficiency',
];

const WEIGHTS = {
  HiveQuality: 0.25,
  TerminalAware: 0.15,
  ToolActions: 0.15,
  CodeCorrect: 0.2,
  Security: 0.1,
  Latency: 0.1,
  CostEfficiency: 0.05,
};

/** Per-category strength 0–100 from public benchmarks (June 15, 2026). */
const MODEL_PROFILES = {
  'fable-5': {
    label: 'Claude Fable 5 (single, suspended)',
    costPer1kTok: 0.06,
    scores: { HiveQuality: 96, TerminalAware: 88, ToolActions: 85, CodeCorrect: 94, Security: 97, Latency: 72 },
  },
  'opus-4.8': {
    label: 'Claude Opus 4.8 (single)',
    costPer1kTok: 0.03,
    scores: { HiveQuality: 93, TerminalAware: 90, ToolActions: 88, CodeCorrect: 96, Security: 92, Latency: 70 },
  },
  'gpt-5.5': {
    label: 'GPT-5.5 (single)',
    costPer1kTok: 0.035,
    scores: { HiveQuality: 90, TerminalAware: 95, ToolActions: 94, CodeCorrect: 91, Security: 88, Latency: 68 },
  },
  'gpt-5.5-codex': {
    label: 'GPT-5.5 Codex (single)',
    costPer1kTok: 0.04,
    scores: { HiveQuality: 88, TerminalAware: 97, ToolActions: 90, CodeCorrect: 95, Security: 86, Latency: 65 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro (single)',
    costPer1kTok: 0.0012,
    scores: { HiveQuality: 86, TerminalAware: 82, ToolActions: 78, CodeCorrect: 93, Security: 84, Latency: 88 },
  },
  'deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash (single)',
    costPer1kTok: 0.0004,
    scores: { HiveQuality: 78, TerminalAware: 75, ToolActions: 72, CodeCorrect: 85, Security: 80, Latency: 95 },
  },
  'gemini-3.5-flash': {
    label: 'Gemini 3.5 Flash (single)',
    costPer1kTok: 0.008,
    scores: { HiveQuality: 87, TerminalAware: 84, ToolActions: 90, CodeCorrect: 86, Security: 83, Latency: 92 },
  },
  'gemini-3.1-pro': {
    label: 'Gemini 3.1 Pro (single)',
    costPer1kTok: 0.015,
    scores: { HiveQuality: 89, TerminalAware: 86, ToolActions: 87, CodeCorrect: 88, Security: 85, Latency: 80 },
  },
  'grok-4.3-high': {
    label: 'Grok 4.3 X High (single)',
    costPer1kTok: 0.0038,
    scores: { HiveQuality: 85, TerminalAware: 88, ToolActions: 91, CodeCorrect: 84, Security: 82, Latency: 78 },
  },
  'qwen-3.7-max': {
    label: 'Qwen 3.7 Max (single)',
    costPer1kTok: 0.0045,
    scores: { HiveQuality: 88, TerminalAware: 83, ToolActions: 80, CodeCorrect: 90, Security: 85, Latency: 85 },
  },
  'kimi-k2.6': {
    label: 'Kimi K2.6 (single)',
    costPer1kTok: 0.002,
    scores: { HiveQuality: 84, TerminalAware: 81, ToolActions: 79, CodeCorrect: 88, Security: 83, Latency: 86 },
  },
};

/** Step roles map to which profile supplies each category during that step. */
const ROLE_STRENGTH = {
  planner: { HiveQuality: 0.35, CodeCorrect: 0.15, Security: 0.1 },
  coder: { CodeCorrect: 0.5, HiveQuality: 0.2, TerminalAware: 0.1 },
  terminal: { TerminalAware: 0.55, ToolActions: 0.25, CodeCorrect: 0.1 },
  tools: { ToolActions: 0.6, TerminalAware: 0.2, HiveQuality: 0.1 },
  critic: { HiveQuality: 0.3, Security: 0.35, CodeCorrect: 0.2 },
  security: { Security: 0.65, CodeCorrect: 0.2, HiveQuality: 0.1 },
  polish: { HiveQuality: 0.45, Latency: 0.2 },
  synthesize: { HiveQuality: 0.4, TerminalAware: 0.15 },
  factcheck: { HiveQuality: 0.25, Security: 0.2 },
};

function costEfficiency(vibeScore, totalCost) {
  return Math.min(100, (vibeScore / Math.max(totalCost, 0.0001)) * 0.8);
}

function vibeScore(categoryScores) {
  let t = 0;
  for (const c of CATEGORIES) {
    t += (categoryScores[c] ?? 0) * (WEIGHTS[c] ?? 0);
  }
  return Math.round(t * 10) / 10;
}

function simulatePipeline(id, label, steps) {
  const categoryScores = {};
  for (const c of CATEGORIES) {
    if (c === 'CostEfficiency') continue;
    let acc = 0;
    let wSum = 0;
    for (const step of steps) {
      const profile = MODEL_PROFILES[step.model];
      const role = ROLE_STRENGTH[step.role] ?? { HiveQuality: 0.5 };
      const rw = role[c] ?? 0;
      if (rw <= 0) continue;
      acc += (profile.scores[c] ?? 70) * rw;
      wSum += rw;
    }
    categoryScores[c] = wSum > 0 ? acc / wSum : 70;
  }

  const totalCost = steps.reduce((s, st) => s + (MODEL_PROFILES[st.model].costPer1kTok * (st.tokens ?? 2.5)), 0);
  const base = vibeScore(categoryScores);
  categoryScores.CostEfficiency = costEfficiency(base, totalCost);
  const synergyBonus = steps.length >= 4 ? 1.8 : steps.length === 3 ? 1.2 : 0;
  const final = Math.min(100, vibeScore(categoryScores) + synergyBonus);

  return {
    id,
    label,
    steps: steps.map((s) => ({ ...s, modelLabel: MODEL_PROFILES[s.model].label })),
    category_scores: Object.fromEntries(
      Object.entries(categoryScores).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
    vibe_score: Math.round(final * 10) / 10,
    estimated_cost_usd: Math.round(totalCost * 1000) / 1000,
    step_count: steps.length,
  };
}

function simulateSingle(modelKey) {
  const p = MODEL_PROFILES[modelKey];
  const categoryScores = { ...p.scores };
  categoryScores.CostEfficiency = costEfficiency(vibeScore(categoryScores), p.costPer1kTok * 3);
  return {
    id: `single-${modelKey}`,
    label: p.label,
    steps: [{ role: 'all', model: modelKey }],
    category_scores: categoryScores,
    vibe_score: vibeScore(categoryScores),
    estimated_cost_usd: Math.round(p.costPer1kTok * 3 * 1000) / 1000,
    step_count: 1,
  };
}

const PIPELINES = [
  simulatePipeline('hive-quality-v2', 'Vibe Hive Quality (Opus 4.8→GPT-5.5→Gemini 3.5 Flash)', [
    { role: 'planner', model: 'opus-4.8', tokens: 2 },
    { role: 'critic', model: 'gpt-5.5', tokens: 2 },
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 1.5 },
  ]),
  simulatePipeline('hive-frontier-4', 'Frontier 4-step (Opus plan→DS V4 code→Codex terminal→3.5 Flash polish)', [
    { role: 'planner', model: 'opus-4.8', tokens: 2 },
    { role: 'coder', model: 'deepseek-v4-pro', tokens: 4 },
    { role: 'terminal', model: 'gpt-5.5-codex', tokens: 2 },
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 1.5 },
  ]),
  simulatePipeline('hive-frontier-5', 'Frontier 5-step Ultra (Opus→DS Pro→Codex→Opus security→3.5 Flash)', [
    { role: 'planner', model: 'opus-4.8', tokens: 2.5 },
    { role: 'coder', model: 'deepseek-v4-pro', tokens: 4 },
    { role: 'terminal', model: 'gpt-5.5-codex', tokens: 2 },
    { role: 'security', model: 'opus-4.8', tokens: 1.5 },
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 1.5 },
  ]),
  simulatePipeline('hive-frontier-6', 'Frontier 6-step Max (3.1 Pro outline→Opus plan→DS implement→Codex terminal→Opus audit→3.5 Flash ship)', [
    { role: 'synthesize', model: 'gemini-3.1-pro', tokens: 1.5 },
    { role: 'planner', model: 'opus-4.8', tokens: 2 },
    { role: 'coder', model: 'deepseek-v4-pro', tokens: 4 },
    { role: 'terminal', model: 'gpt-5.5-codex', tokens: 2 },
    { role: 'security', model: 'opus-4.8', tokens: 1.5 },
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 1 },
  ]),
  simulatePipeline('hive-code-specialist', 'Code task hive (Opus plan→DS V4 Pro→Codex review→Opus security)', [
    { role: 'planner', model: 'opus-4.8', tokens: 2 },
    { role: 'coder', model: 'deepseek-v4-pro', tokens: 5 },
    { role: 'terminal', model: 'gpt-5.5-codex', tokens: 2.5 },
    { role: 'security', model: 'opus-4.8', tokens: 1.5 },
  ]),
  simulatePipeline('hive-agent-specialist', 'Agent/tools hive (Grok X High tools→Opus reason→Codex terminal→3.5 Flash polish)', [
    { role: 'tools', model: 'grok-4.3-high', tokens: 2 },
    { role: 'planner', model: 'opus-4.8', tokens: 2 },
    { role: 'terminal', model: 'gpt-5.5-codex', tokens: 2 },
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 1.5 },
  ]),
  simulatePipeline('hive-research', 'Research hive (3.1 Pro outline→Opus synthesize→Grok X High browse→Qwen factcheck)', [
    { role: 'synthesize', model: 'gemini-3.1-pro', tokens: 2 },
    { role: 'planner', model: 'opus-4.8', tokens: 2.5 },
    { role: 'tools', model: 'grok-4.3-high', tokens: 2 },
    { role: 'factcheck', model: 'qwen-3.7-max', tokens: 1.5 },
  ]),
  simulatePipeline('hive-balanced-v2', 'Balanced v2 (DS Flash draft→Opus check)', [
    { role: 'polish', model: 'deepseek-v4-flash', tokens: 2 },
    { role: 'critic', model: 'opus-4.8', tokens: 1.5 },
  ]),
  simulatePipeline('hive-fast-v2', 'Fast v2 (Gemini 3.5 Flash only)', [
    { role: 'polish', model: 'gemini-3.5-flash', tokens: 2 },
  ]),
];

const BASELINES = [
  'fable-5',
  'opus-4.8',
  'gpt-5.5',
  'gpt-5.5-codex',
  'deepseek-v4-pro',
  'gemini-3.5-flash',
  'grok-4.3-high',
].map(simulateSingle);

const all = [...BASELINES, ...PIPELINES].sort((a, b) => b.vibe_score - a.vibe_score);
const fableScore = BASELINES.find((b) => b.id === 'single-fable-5').vibe_score;
const opusBaseline = BASELINES.find((b) => b.id === 'single-opus-4.8').vibe_score;
const winnersVsFable = all.filter((r) => r.vibe_score > fableScore);
const winnersVsOpus = all.filter((r) => r.vibe_score > opusBaseline);

const report = {
  simulated_at: new Date().toISOString(),
  roster_date: '2026-06-15',
  methodology:
    'Weighted VibeBench categories; per-step role contribution; +1.2 synergy (3-step) / +1.8 (4+ steps). Roster: Opus 4.8, GPT-5.5/Codex, Gemini 3.5 Flash, Grok 4.3 high, DS V4, Qwen 3.7 Max, Kimi K2.6. Fable 5 suspended — Opus used as security fallback.',
  fable_5_baseline_score: fableScore,
  opus_4_8_baseline_score: opusBaseline,
  pipelines_beating_fable_5: winnersVsFable.length,
  pipelines_beating_opus_4_8: winnersVsOpus.length,
  rankings: all.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    label: r.label,
    vibe_score: r.vibe_score,
    beats_fable_5: r.vibe_score > fableScore,
    beats_opus_4_8: r.vibe_score > opusBaseline,
    delta_vs_fable_5: Math.round((r.vibe_score - fableScore) * 10) / 10,
    delta_vs_opus_4_8: Math.round((r.vibe_score - opusBaseline) * 10) / 10,
    estimated_cost_usd: r.estimated_cost_usd,
    step_count: r.step_count,
    category_scores: r.category_scores,
  })),
  recommended_default: all[0],
  recommended_by_task: {
    code: all.find((r) => r.id === 'hive-code-specialist'),
    agent: all.find((r) => r.id === 'hive-agent-specialist'),
    research: all.find((r) => r.id === 'hive-research'),
    general: all.find((r) => r.id === 'hive-frontier-6'),
  },
};

const resultsDir = join(__dirname, 'results');
if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('Vibe Hive Topology Simulation — June 15, 2026');
console.log(`Fable 5 baseline VibeScore: ${fableScore} (suspended — reference only)`);
console.log(`Opus 4.8 baseline VibeScore: ${opusBaseline}`);
console.log(`Pipelines beating Fable 5: ${winnersVsFable.length}/${PIPELINES.length}`);
console.log(`Pipelines beating Opus 4.8: ${winnersVsOpus.length}/${all.length}`);
console.log('');
for (const r of report.rankings.slice(0, 12)) {
  const mark = r.beats_opus_4_8 ? '✓' : ' ';
  console.log(
    `${mark} #${r.rank} ${r.vibe_score.toFixed(1)} (+${r.delta_vs_opus_4_8 >= 0 ? r.delta_vs_opus_4_8 : r.delta_vs_opus_4_8} vs Opus) — ${r.label}`,
  );
}
console.log(`\nWrote ${OUT}`);
