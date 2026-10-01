import Dexie from 'dexie';

import type { JarvisDexie } from '@/lib/db';
import type { JarvisArtifactRow, JarvisRunRow } from '@/lib/db/schema';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_RUNS = 50;
const MAX_OUTPUTS = 100;
const RUN_STATES = new Set<JarvisRunRow['status']>([
  'queued',
  'compiling',
  'running',
  'awaiting_approval',
  'partial',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const RUN_SOURCES = new Set<JarvisRunRow['source']>([
  'typed_chat',
  'voice',
  'schedule',
  'hive_final',
  'phone',
  'browser_chat',
]);

export type BrowserChatOutputSummary = Readonly<{
  id: string;
  runId: string;
  state: Exclude<JarvisArtifactRow['state'], 'quarantined'>;
  kind: JarvisArtifactRow['kind'];
  title: string;
  summary?: string;
  contentHash?: string;
  sizeBytes?: number;
  createdAt: number;
  trust: 'app_verified';
}>;

export type BrowserChatOutputRun = Readonly<{
  id: string;
  source: JarvisRunRow['source'];
  status: JarvisRunRow['status'];
  updatedAt: number;
  completedAt?: number;
  outputs: readonly BrowserChatOutputSummary[];
}>;

export type BrowserChatOutputFeed = Readonly<{
  runs: readonly BrowserChatOutputRun[];
  runningCount: number;
  failedCount: number;
  truncated: boolean;
}>;

function stableText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL.test(value)
  );
}

function validInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Browser Chat output feed cancelled.', 'AbortError');
}

function validRun(row: JarvisRunRow): boolean {
  return (
    SAFE_ID.test(row.id) &&
    RUN_SOURCES.has(row.source) &&
    RUN_STATES.has(row.status) &&
    validInteger(row.updated_at) &&
    (row.completed_at === undefined || validInteger(row.completed_at))
  );
}

function publicOutput(row: JarvisArtifactRow): BrowserChatOutputSummary | null {
  if (
    row.state === 'quarantined' ||
    !SAFE_ID.test(row.id) ||
    !SAFE_ID.test(row.run_id) ||
    !stableText(row.title, 400) ||
    !validInteger(row.created_at) ||
    (row.safe_summary !== undefined && !stableText(row.safe_summary, 2_000)) ||
    (row.content_hash !== undefined && !HASH.test(row.content_hash)) ||
    (row.size_bytes !== undefined && !validInteger(row.size_bytes))
  ) {
    return null;
  }
  return Object.freeze({
    id: row.id,
    runId: row.run_id,
    state: row.state,
    kind: row.kind,
    title: row.title,
    ...(row.safe_summary === undefined ? {} : { summary: row.safe_summary }),
    ...(row.content_hash === undefined ? {} : { contentHash: row.content_hash }),
    ...(row.size_bytes === undefined ? {} : { sizeBytes: row.size_bytes }),
    createdAt: row.created_at,
    trust: 'app_verified' as const,
  });
}

export async function listBrowserChatOutputFeed(input: {
  database: JarvisDexie;
  accountId: string;
  workspaceId: string;
  projectId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<BrowserChatOutputFeed> {
  const limit = input.limit ?? 20;
  if (
    !SAFE_ID.test(input.accountId) ||
    !SAFE_ID.test(input.workspaceId) ||
    !SAFE_ID.test(input.projectId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RUNS
  ) {
    throw new Error('browser_chat_output_feed_invalid');
  }
  abort(input.signal);
  const scopedRuns = await input.database.jarvis_runs
    .where('[account_id+updated_at]')
    .between([input.accountId, Dexie.minKey], [input.accountId, Dexie.maxKey], true, true)
    .reverse()
    .filter(
      (run) =>
        run.workspace_id === input.workspaceId &&
        run.project_id === input.projectId &&
        validRun(run),
    )
    .limit(limit + 1)
    .toArray();
  abort(input.signal);
  const selectedRuns = scopedRuns.slice(0, limit);
  const runIds = selectedRuns.map((run) => run.id);
  const artifactRows = runIds.length
    ? await input.database.jarvis_artifacts
        .where('run_id')
        .anyOf(runIds)
        .filter((artifact) => artifact.state !== 'quarantined')
        .limit(MAX_OUTPUTS + 1)
        .toArray()
    : [];
  abort(input.signal);
  const outputs = artifactRows
    .map(publicOutput)
    .filter((output): output is BrowserChatOutputSummary => output !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_OUTPUTS);
  const outputsByRun = new Map<string, BrowserChatOutputSummary[]>();
  for (const output of outputs) {
    const current = outputsByRun.get(output.runId) ?? [];
    current.push(output);
    outputsByRun.set(output.runId, current);
  }
  const runs = selectedRuns.map((run) =>
    Object.freeze({
      id: run.id,
      source: run.source,
      status: run.status,
      updatedAt: run.updated_at,
      ...(run.completed_at === undefined ? {} : { completedAt: run.completed_at }),
      outputs: Object.freeze(outputsByRun.get(run.id) ?? []),
    }),
  );
  return Object.freeze({
    runs: Object.freeze(runs),
    runningCount: runs.filter((run) =>
      ['queued', 'compiling', 'running', 'awaiting_approval'].includes(run.status),
    ).length,
    failedCount: runs.filter((run) => ['failed', 'timed_out'].includes(run.status)).length,
    truncated: scopedRuns.length > limit || artifactRows.length > MAX_OUTPUTS,
  });
}
