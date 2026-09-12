export type OfficialBenchmarkEvidence = Readonly<{
  provider: 'Google' | 'OpenAI' | 'SpaceXAI';
  model: string;
  benchmark: string;
  metric: string;
  value: number;
  unit: '%' | 'Elo';
  evaluationSetup: string;
  publishedAt: string;
  sourceUrl: string;
  reportedBy: 'Google' | 'OpenAI' | 'SpaceXAI';
  note: string;
}>;

/**
 * Provider-published evidence is intentionally not collapsed into one score.
 * Each result retains the exact benchmark, metric, setup, reporter and source.
 */
export const OFFICIAL_BENCHMARK_EVIDENCE: readonly OfficialBenchmarkEvidence[] = [
  {
    provider: 'Google',
    model: 'Gemini 3.6 Flash',
    benchmark: 'SWE-Bench Pro (Public)',
    metric: 'Resolve rate',
    value: 58.7,
    unit: '%',
    evaluationSetup: 'Google DeepMind published comparison table',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result; compare only with rows using this exact table and setup.',
  },
  {
    provider: 'Google',
    model: 'Gemini 3.5 Flash',
    benchmark: 'SWE-Bench Pro (Public)',
    metric: 'Resolve rate',
    value: 55.1,
    unit: '%',
    evaluationSetup: 'Google DeepMind published comparison table',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result; compare only with rows using this exact table and setup.',
  },
  {
    provider: 'Google',
    model: 'Gemini 3.1 Pro',
    benchmark: 'SWE-Bench Pro (Public)',
    metric: 'Resolve rate',
    value: 54.2,
    unit: '%',
    evaluationSetup: 'Google DeepMind published comparison table',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result; compare only with rows using this exact table and setup.',
  },
  {
    provider: 'Google',
    model: 'Gemini 3.6 Flash',
    benchmark: 'Terminal-bench 2.1',
    metric: 'Task success',
    value: 78,
    unit: '%',
    evaluationSetup: 'Terminus-2 harness',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result with the named Terminus-2 harness.',
  },
  {
    provider: 'Google',
    model: 'Gemini 3.5 Flash',
    benchmark: 'Terminal-bench 2.1',
    metric: 'Task success',
    value: 76.2,
    unit: '%',
    evaluationSetup: 'Terminus-2 harness',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result with the named Terminus-2 harness.',
  },
  {
    provider: 'Google',
    model: 'Gemini 3.1 Pro',
    benchmark: 'Terminal-bench 2.1',
    metric: 'Task success',
    value: 73.8,
    unit: '%',
    evaluationSetup: 'Terminus-2 harness',
    publishedAt: '2026-07-21',
    sourceUrl: 'https://deepmind.google/models/gemini/flash/',
    reportedBy: 'Google',
    note: 'Provider-published result with the named Terminus-2 harness.',
  },
  {
    provider: 'OpenAI',
    model: 'GPT-5.6 Sol',
    benchmark: 'GeneBench-Pro',
    metric: 'Pass rate',
    value: 28.7,
    unit: '%',
    evaluationSetup: 'Highest reasoning level',
    publishedAt: '2026-06-30',
    sourceUrl: 'https://openai.com/index/introducing-genebench-pro/',
    reportedBy: 'OpenAI',
    note: 'OpenAI-published score at the highest standard reasoning level.',
  },
  {
    provider: 'OpenAI',
    model: 'GPT-5.6 Sol Pro',
    benchmark: 'GeneBench-Pro',
    metric: 'Pass rate',
    value: 31.5,
    unit: '%',
    evaluationSetup: 'Pro mode',
    publishedAt: '2026-06-30',
    sourceUrl: 'https://openai.com/index/introducing-genebench-pro/',
    reportedBy: 'OpenAI',
    note: 'OpenAI-published score with Pro mode enabled.',
  },
  {
    provider: 'SpaceXAI',
    model: 'Grok 4.5',
    benchmark: 'Terminal Bench 2.1',
    metric: 'Task success',
    value: 83.3,
    unit: '%',
    evaluationSetup: 'SpaceXAI published launch evaluation',
    publishedAt: '2026-07-16',
    sourceUrl: 'https://x.ai/news/grok-4-5',
    reportedBy: 'SpaceXAI',
    note: 'SpaceXAI-published launch result.',
  },
  {
    provider: 'SpaceXAI',
    model: 'Grok 4.5',
    benchmark: 'SWE Bench Pro',
    metric: 'Resolve rate',
    value: 64.7,
    unit: '%',
    evaluationSetup: 'SpaceXAI published launch evaluation',
    publishedAt: '2026-07-16',
    sourceUrl: 'https://x.ai/news/grok-4-5',
    reportedBy: 'SpaceXAI',
    note: 'SpaceXAI-published launch result.',
  },
] as const;

export type ComparableOfficialBenchmarkGroup = Readonly<{
  id: string;
  benchmark: string;
  metric: string;
  evaluationSetup: string;
  entries: readonly OfficialBenchmarkEvidence[];
}>;

export function comparableOfficialBenchmarkGroups(
  evidence: readonly OfficialBenchmarkEvidence[],
): ComparableOfficialBenchmarkGroup[] {
  const groups = new Map<string, OfficialBenchmarkEvidence[]>();
  for (const entry of evidence) {
    const id = `${entry.benchmark}\u0000${entry.metric}\u0000${entry.evaluationSetup}`;
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, entries]) => ({
      id,
      benchmark: entries[0]!.benchmark,
      metric: entries[0]!.metric,
      evaluationSetup: entries[0]!.evaluationSetup,
      entries: [...entries].sort((a, b) => b.value - a.value),
    }))
    .filter((group) => group.entries.length >= 2);
}
