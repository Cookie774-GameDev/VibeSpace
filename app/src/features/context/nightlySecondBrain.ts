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
  scheduleHour: 2;
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
  /** Immutable Context Map identity captured when this change was proposed. */
  targetMapId?: string;
  path: string;
  before: string;
  after: string;
  provenance: readonly string[];
  confidence: number;
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
  error?: string;
  retryOf?: string;
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
  mode: 'approve_only',
  model: null,
  allowPrivateDataToCloud: false,
  sources: Object.freeze({ chat: true, terminal: true, project: true, context: true }),
});

export function manualSecondBrainScheduledFor(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

export function nextNightlySecondBrainRun(now: Date): Date {
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function mostRecentNightlySecondBrainRun(now: Date): Date {
  const due = new Date(now);
  due.setHours(2, 0, 0, 0);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
  return due;
}

export function buildNightlySecondBrainWeek(
  nowMs: number,
  runs: readonly SecondBrainRun[],
  enabled: boolean,
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
      scheduledFor.setHours(2, 0, 0, 0);
      if (recorded.length === 0 && scheduledFor.getTime() > nowMs) {
        recorded.push({
          id: `scheduled-${scheduledFor.getTime()}`,
          scheduledFor: scheduledFor.getTime(),
          status: enabled ? 'scheduled' : 'not_scheduled',
          summary: enabled ? 'Nightly Context check scheduled.' : 'Nightly maintenance is off.',
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
}): boolean {
  return (input.lastScheduledFor ?? 0) < mostRecentNightlySecondBrainRun(input.now).getTime();
}

export interface SecondBrainRuntimePorts {
  collectSources(): Promise<readonly SecondBrainSource[]>;
  propose(input: {
    model: SecondBrainModel;
    sources: readonly SecondBrainSource[];
  }): Promise<readonly SecondBrainChange[]>;
  apply(changes: readonly SecondBrainChange[]): Promise<void>;
  rollback(changes: readonly SecondBrainChange[]): Promise<void>;
  saveRun(run: SecondBrainRun): Promise<void>;
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
  }): Promise<SecondBrainRun> {
    const startedAt = input.now ?? Date.now();
    const model = input.config.model;
    if (!input.config.enabled || !model)
      throw new Error('Nightly second-brain model is unavailable.');
    try {
      const collected = await this.ports.collectSources();
      const admitted = collected.filter(
        (source) =>
          input.config.sources[source.kind] &&
          (!source.privateLocal || model.local || input.config.allowPrivateDataToCloud),
      );
      const changes = verifiedSecondBrainChanges(
        await this.ports.propose({ model, sources: admitted }),
        admitted,
      );
      const status = input.config.mode === 'auto' ? 'applied' : 'pending_approval';
      if (status === 'applied' && changes.length > 0) await this.ports.apply(changes);
      const run: SecondBrainRun = Object.freeze({
        id: `second-brain-${input.scheduledFor}-${startedAt}`,
        scheduledFor: input.scheduledFor,
        startedAt,
        completedAt: Date.now(),
        status,
        mode: input.config.mode,
        model,
        changes,
        summary:
          changes.length === 0
            ? 'No meaningful new context was found.'
            : `${changes.length} verified context ${changes.length === 1 ? 'update' : 'updates'} ${
                status === 'applied' ? 'applied' : 'awaiting approval'
              }.`,
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
        summary: 'Nightly context maintenance failed safely; no context was changed.',
        error: cause instanceof Error ? cause.message : 'Unknown maintenance failure.',
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      });
      await this.ports.saveRun(run);
      return run;
    }
  }

  async approve(run: SecondBrainRun): Promise<SecondBrainRun> {
    if (run.status !== 'pending_approval') throw new Error('Run is not awaiting approval.');
    await this.ports.apply(run.changes);
    const applied = Object.freeze({ ...run, status: 'applied' as const, completedAt: Date.now() });
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
