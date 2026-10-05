export type SecondBrainMode = 'approve_only' | 'auto';
export type SecondBrainSourceKind = 'chat' | 'terminal' | 'project' | 'context';
export type SecondBrainTarget = 'context_map' | 'user_md' | 'related_markdown';

export interface SecondBrainModel {
  id: string;
  label: string;
  local: boolean;
  provider: string;
  modelId: string;
  connectionId?: string;
}

export interface SecondBrainConfig {
  enabled: boolean;
  scheduleHour: number;
  /** Local wall-clock time; follows the operating system's timezone and DST. */
  scheduleMinute?: number;
  /** JavaScript weekdays: Sunday 0 through Saturday 6. Missing means every day. */
  scheduleDays?: readonly number[];
  mode: SecondBrainMode;
  model: SecondBrainModel | null;
  allowPrivateDataToCloud: boolean;
  sources: Record<SecondBrainSourceKind, boolean>;
}

export interface SecondBrainSource {
  id: string;
  kind: SecondBrainSourceKind;
  content: string;
  observedAt: number;
  privateLocal: boolean;
}

export interface SecondBrainChange {
  id: string;
  target: SecondBrainTarget;
  /** Storage selected when the proposal was created. Missing means legacy storage. */
  backend?: 'legacy' | 'siyuan';
  /** Authoritative SiYuan document block captured by read/create, never model supplied. */
  targetBlockId?: string;
  /** Immutable Context Map identity captured when this change was proposed. */
  targetMapId?: string;
  path: string;
  before: string;
  after: string;
  provenance: readonly string[];
  confidence: number;
  /** Exact scope-bound generated summary; never a user-authored Markdown target. */
  managedSummary?: true;
}

export interface SecondBrainRun {
  id: string;
  scheduledFor: number;
  startedAt: number;
  completedAt: number;
  status: 'pending_approval' | 'applied' | 'rejected' | 'rolled_back' | 'failed';
  mode: SecondBrainMode;
  model: SecondBrainModel;
  changes: readonly SecondBrainChange[];
  summary: string;
  /** True only when the managed SiYuan batch created a repository snapshot before mutation. */
  snapshotCreated?: boolean;
  error?: string;
  retryOf?: string;
  coverageStart?: number;
  coverageEnd?: number;
}

export interface SecondBrainWeekRun {
  id: string;
  scheduledFor: number;
  status: SecondBrainRun['status'] | 'scheduled' | 'not_scheduled';
  summary: string;
}

export interface SecondBrainWeekDay {
  dayStart: number;
  label: string;
  runs: readonly SecondBrainWeekRun[];
}

export const DEFAULT_SECOND_BRAIN_CONFIG: SecondBrainConfig = Object.freeze({
  enabled: false,
  scheduleHour: 2,
  scheduleMinute: 0,
  scheduleDays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  mode: 'approve_only',
  model: null,
  allowPrivateDataToCloud: false,
  sources: Object.freeze({ chat: true, terminal: true, project: true, context: true }),
});

export function manualSecondBrainScheduledFor(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

export type SecondBrainSchedule = Pick<
  SecondBrainConfig,
  'scheduleHour' | 'scheduleMinute' | 'scheduleDays'
>;

export function validSecondBrainSchedule(schedule: SecondBrainSchedule): boolean {
  return (
    Number.isInteger(schedule.scheduleHour) &&
    schedule.scheduleHour >= 0 &&
    schedule.scheduleHour <= 23 &&
    Number.isInteger(schedule.scheduleMinute ?? 0) &&
    (schedule.scheduleMinute ?? 0) >= 0 &&
    (schedule.scheduleMinute ?? 0) <= 59 &&
    (schedule.scheduleDays === undefined ||
      (Array.isArray(schedule.scheduleDays) &&
        schedule.scheduleDays.length > 0 &&
        schedule.scheduleDays.length <= 7 &&
        new Set(schedule.scheduleDays).size === schedule.scheduleDays.length &&
        schedule.scheduleDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
  );
}

function scheduledDay(now: Date, schedule: SecondBrainSchedule, direction: 1 | -1): Date {
  if (!validSecondBrainSchedule(schedule)) throw new Error('Invalid nightly schedule.');
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset * direction);
    day.setHours(schedule.scheduleHour, schedule.scheduleMinute ?? 0, 0, 0);
    if (
      (schedule.scheduleDays ?? DEFAULT_SECOND_BRAIN_CONFIG.scheduleDays!).includes(day.getDay()) &&
      (direction === 1 ? day.getTime() > now.getTime() : day.getTime() <= now.getTime())
    )
      return day;
  }
  throw new Error('Nightly schedule has no eligible day.');
}

export function nextNightlySecondBrainRun(
  now: Date,
  schedule: SecondBrainSchedule = DEFAULT_SECOND_BRAIN_CONFIG,
): Date {
  return scheduledDay(now, schedule, 1);
}

export function mostRecentNightlySecondBrainRun(
  now: Date,
  schedule: SecondBrainSchedule = DEFAULT_SECOND_BRAIN_CONFIG,
): Date {
  return scheduledDay(now, schedule, -1);
}

export function successfulSecondBrainCoverage(
  runs: readonly SecondBrainRun[],
  persisted = 0,
): number {
  return runs.reduce(
    (latest, run) =>
      run.status === 'applied' &&
      Number.isSafeInteger(run.coverageEnd) &&
      (run.coverageEnd ?? 0) >= (run.coverageStart ?? 0)
        ? Math.max(latest, run.coverageEnd!)
        : latest,
    persisted,
  );
}

export function buildNightlySecondBrainWeek(
  nowMs: number,
  runs: readonly SecondBrainRun[],
  enabled: boolean,
  schedule: SecondBrainSchedule = DEFAULT_SECOND_BRAIN_CONFIG,
): readonly SecondBrainWeekDay[] {
  const now = new Date(nowMs);
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 3);

  return Object.freeze(
    Array.from({ length: 7 }, (_, index) => {
      const day = new Date(first);
      day.setDate(first.getDate() + index);
      const dayStart = day.getTime();
      const dayEnd = new Date(day);
      dayEnd.setDate(day.getDate() + 1);
      const recorded: SecondBrainWeekRun[] = runs
        .filter((run) => run.scheduledFor >= dayStart && run.scheduledFor < dayEnd.getTime())
        .sort((left, right) => left.scheduledFor - right.scheduledFor)
        .map((run) => ({
          id: run.id,
          scheduledFor: run.scheduledFor,
          status: run.status,
          summary: run.error ? `${run.summary} ${run.error}` : run.summary,
        }));

      const scheduledFor = new Date(day);
      scheduledFor.setHours(schedule.scheduleHour, schedule.scheduleMinute ?? 0, 0, 0);
      const selectedDay = (
        schedule.scheduleDays ?? DEFAULT_SECOND_BRAIN_CONFIG.scheduleDays!
      ).includes(day.getDay());
      if (recorded.length === 0 && scheduledFor.getTime() > nowMs) {
        recorded.push({
          id: `scheduled-${scheduledFor.getTime()}`,
          scheduledFor: scheduledFor.getTime(),
          status: enabled && selectedDay ? 'scheduled' : 'not_scheduled',
          summary:
            enabled && selectedDay
              ? 'Nightly Context check scheduled.'
              : 'No update scheduled for this day.',
        });
      }

      return Object.freeze({
        dayStart,
        label: day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        runs: Object.freeze(recorded),
      });
    }),
  );
}

export function isNightlySecondBrainRunDue(input: {
  now: Date;
  lastScheduledFor?: number;
  schedule?: SecondBrainSchedule;
}): boolean {
  return (
    (input.lastScheduledFor ?? 0) <
    mostRecentNightlySecondBrainRun(input.now, input.schedule).getTime()
  );
}

export interface SecondBrainRuntimePorts {
  coveredThrough?(): Promise<number>;
  collectSources(window: {
    start: number;
    end: number;
  }): Promise<readonly SecondBrainSource[] | SecondBrainSourceBatch>;
  propose(input: {
    model: SecondBrainModel;
    sources: readonly SecondBrainSource[];
    window: { start: number; end: number };
  }): Promise<readonly SecondBrainChange[]>;
  apply(changes: readonly SecondBrainChange[]): Promise<SecondBrainApplyReceipt | void>;
  rollback(changes: readonly SecondBrainChange[]): Promise<void>;
  saveRun(run: SecondBrainRun): Promise<void>;
}

export interface SecondBrainSourceBatch {
  sources: readonly SecondBrainSource[];
  coverageEnd: number;
  remaining: number;
}

/** A bounded chronological prefix. Equal timestamps stay together so no record is skipped. */
export function secondBrainSourceBatch(
  sources: readonly SecondBrainSource[],
  window: { start: number; end: number },
  maximumChars: number,
): SecondBrainSourceBatch {
  const ordered = sources
    .filter((source) => source.observedAt > window.start && source.observedAt <= window.end)
    .sort((left, right) => left.observedAt - right.observedAt);
  let count = 0;
  let chars = 0;
  while (count < ordered.length) {
    const at = ordered[count]!.observedAt;
    let end = count;
    let groupChars = 0;
    while (end < ordered.length && ordered[end]!.observedAt === at) {
      groupChars += ordered[end]!.content.length;
      end++;
    }
    if (groupChars > maximumChars && count === 0)
      throw new Error(
        'One activity timestamp exceeds the summary budget; reduce the selected sources. Coverage was preserved.',
      );
    if (chars + groupChars > maximumChars) break;
    chars += groupChars;
    count = end;
  }
  return {
    sources: ordered.slice(0, count),
    coverageEnd: count < ordered.length ? ordered[count]!.observedAt - 1 : window.end,
    remaining: ordered.length - count,
  };
}

export interface SecondBrainApplyReceipt {
  changes: readonly SecondBrainChange[];
  snapshotCreated: boolean;
}

function normalizedFact(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function verifiedSecondBrainChanges(
  proposed: readonly SecondBrainChange[],
  admittedSources: readonly SecondBrainSource[],
): readonly SecondBrainChange[] {
  const sourceIds = new Set(admittedSources.map((source) => source.id));
  const seen = new Set<string>();
  const verified: SecondBrainChange[] = [];
  for (const change of proposed.slice(0, 50)) {
    const fact = normalizedFact(change.after);
    if (
      !change.id ||
      !change.path ||
      !fact ||
      fact === normalizedFact(change.before) ||
      seen.has(`${change.target}\0${change.path}\0${fact}`) ||
      change.confidence < 0.7 ||
      change.confidence > 1 ||
      change.provenance.length === 0 ||
      change.provenance.some((id) => !sourceIds.has(id))
    ) {
      continue;
    }
    seen.add(`${change.target}\0${change.path}\0${fact}`);
    verified.push(Object.freeze({ ...change, provenance: Object.freeze([...change.provenance]) }));
  }
  return Object.freeze(verified);
}

export class NightlySecondBrainRunner {
  constructor(private readonly ports: SecondBrainRuntimePorts) {}

  async run(input: {
    config: SecondBrainConfig;
    scheduledFor: number;
    retryOf?: string;
    now?: number;
    coverageStart?: number;
  }): Promise<SecondBrainRun> {
    const startedAt = input.now ?? Date.now();
    const window = { start: input.coverageStart ?? 0, end: startedAt };
    const model = input.config.model;
    if (!input.config.enabled || !model)
      throw new Error('Nightly second-brain model is unavailable.');
    try {
      if (this.ports.coveredThrough) window.start = await this.ports.coveredThrough();
      if (!Number.isSafeInteger(window.start) || window.start < 0 || window.start > window.end)
        throw new Error('Saved coverage is ahead of the current clock or invalid.');
      const collection = await this.ports.collectSources(window);
      const batch = Array.isArray(collection) ? null : (collection as SecondBrainSourceBatch);
      const collected = batch ? batch.sources : (collection as readonly SecondBrainSource[]);
      if (batch) {
        if (
          !Number.isSafeInteger(batch.coverageEnd) ||
          batch.coverageEnd < window.start ||
          batch.coverageEnd > window.end
        )
          throw new Error('Invalid activity coverage interval.');
        window.end = batch.coverageEnd;
      }
      const eligible = collected.filter(
        (source) => source.observedAt > window.start && source.observedAt <= window.end,
      );
      const admitted = eligible.filter(
        (source) =>
          input.config.sources[source.kind] &&
          (!source.privateLocal || model.local || input.config.allowPrivateDataToCloud),
      );
      const withheld = eligible.some(
        (source) => input.config.sources[source.kind] && !admitted.includes(source),
      );
      if (withheld && admitted.length === 0)
        throw new Error(
          'Private evidence requires a local model or your cloud-data permission; coverage was preserved.',
        );
      const changes = verifiedSecondBrainChanges(
        await this.ports.propose({ model, sources: admitted, window }),
        admitted,
      );
      const status = input.config.mode === 'auto' ? 'applied' : 'pending_approval';
      let appliedChanges = changes;
      let snapshotCreated = false;
      if (status === 'applied' && changes.length > 0) {
        const receipt = await this.ports.apply(changes);
        if (receipt) {
          appliedChanges = receipt.changes;
          snapshotCreated = receipt.snapshotCreated;
        }
      }
      const run: SecondBrainRun = Object.freeze({
        id: `second-brain-${input.scheduledFor}-${startedAt}`,
        scheduledFor: input.scheduledFor,
        startedAt,
        completedAt: Date.now(),
        ...(withheld ? {} : { coverageStart: window.start, coverageEnd: window.end }),
        status,
        mode: input.config.mode,
        model,
        changes: appliedChanges,
        summary:
          changes.length === 0
            ? 'No meaningful new context was found.'
            : `${changes.length} verified context ${changes.length === 1 ? 'update' : 'updates'} ${
                status === 'applied' ? 'applied' : 'awaiting approval'
              }.${snapshotCreated ? ' A repository snapshot was created first.' : ''}${withheld ? ' Private evidence was withheld; coverage was preserved.' : ''}${batch?.remaining ? ' More saved activity remains for a later update.' : ''}`,
        ...(snapshotCreated ? { snapshotCreated: true } : {}),
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      });
      await this.ports.saveRun(run);
      return run;
    } catch (cause) {
      const run: SecondBrainRun = Object.freeze({
        id: `second-brain-${input.scheduledFor}-${startedAt}`,
        scheduledFor: input.scheduledFor,
        startedAt,
        completedAt: Date.now(),
        status: 'failed',
        mode: input.config.mode,
        model,
        changes: Object.freeze([]),
        summary:
          'Nightly maintenance failed; coverage was preserved for retry. A completed summary file may remain in the managed folder.',
        error: cause instanceof Error ? cause.message : 'Unknown maintenance failure.',
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      });
      await this.ports.saveRun(run);
      return run;
    }
  }

  async approve(run: SecondBrainRun): Promise<SecondBrainRun> {
    if (run.status !== 'pending_approval') throw new Error('Run is not awaiting approval.');
    const receipt = await this.ports.apply(run.changes);
    const applied = Object.freeze({
      ...run,
      status: 'applied' as const,
      completedAt: Date.now(),
      changes: receipt?.changes ?? run.changes,
      summary:
        run.changes.length === 0
          ? 'No meaningful new context was found.'
          : `${run.changes.length} verified context ${
              run.changes.length === 1 ? 'update' : 'updates'
            } applied.${receipt?.snapshotCreated ? ' A repository snapshot was created first.' : ''}`,
      ...(receipt?.snapshotCreated ? { snapshotCreated: true } : {}),
    });
    await this.ports.saveRun(applied);
    return applied;
  }

  async reject(run: SecondBrainRun): Promise<SecondBrainRun> {
    if (run.status !== 'pending_approval') throw new Error('Run is not awaiting approval.');
    const rejected = Object.freeze({
      ...run,
      status: 'rejected' as const,
      completedAt: Date.now(),
    });
    await this.ports.saveRun(rejected);
    return rejected;
  }

  async rollback(run: SecondBrainRun): Promise<SecondBrainRun> {
    if (run.status !== 'applied') throw new Error('Only applied runs can be rolled back.');
    await this.ports.rollback([...run.changes].reverse());
    const rolledBack = Object.freeze({
      ...run,
      status: 'rolled_back' as const,
      completedAt: Date.now(),
    });
    await this.ports.saveRun(rolledBack);
    return rolledBack;
  }
}
