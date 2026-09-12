import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  ShieldCheck,
} from 'lucide-react';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';
import { formatUserDateTime } from '@/lib/timeFormat';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import {
  buildNightlySecondBrainWeek,
  manualSecondBrainScheduledFor,
  nextNightlySecondBrainRun,
  type SecondBrainSourceKind,
  type SecondBrainWeekRun,
} from './nightlySecondBrain';
import {
  nightlySecondBrainScopeKey,
  selectNightlySecondBrainScope,
  useNightlySecondBrainStore,
} from './nightlySecondBrainStore';

const SOURCE_LABELS: Readonly<Record<SecondBrainSourceKind, string>> = {
  chat: 'New chat history',
  terminal: 'Terminal and CLI sessions',
  project: 'Project activity',
  context: 'Context Map and Markdown',
};

export function NightlySecondBrainPanel() {
  const [actionStatus, setActionStatus] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const { flatOptions } = useAccessibleChatModels();
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const identity = resolveAccountIdentity({ cloudSession, localUserId });
  const scopeKey =
    identity && workspaceId
      ? nightlySecondBrainScopeKey({
          accountId: identity.accountId,
          workspaceId: String(workspaceId),
          projectId: projectId ? String(projectId) : null,
        })
      : '';
  const scope = useNightlySecondBrainStore((state) =>
    selectNightlySecondBrainScope(state, scopeKey),
  );
  const { config, runs } = scope;
  const setEnabled = useNightlySecondBrainStore((state) => state.setEnabled);
  const setMode = useNightlySecondBrainStore((state) => state.setMode);
  const setModel = useNightlySecondBrainStore((state) => state.setModel);
  const setCloudPrivatePermission = useNightlySecondBrainStore(
    (state) => state.setCloudPrivatePermission,
  );
  const setSourceEnabled = useNightlySecondBrainStore((state) => state.setSourceEnabled);
  const available = flatOptions.filter((option) => option.available !== false);
  const latest = runs[0];
  const configured = config.enabled && Boolean(config.model);
  const [expanded, setExpanded] = useState(() => !configured);
  const wasConfigured = useRef(configured);
  useEffect(() => {
    if (configured && !wasConfigured.current) setExpanded(false);
    wasConfigured.current = configured;
  }, [configured]);
  const week = useMemo(
    () => buildNightlySecondBrainWeek(Date.now(), runs, configured),
    [configured, runs],
  );
  const perform = async (action: () => Promise<unknown>, success: string) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionStatus('Working…');
    try {
      await action();
      setActionStatus(success);
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : 'The operation failed safely.');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-paper-soft p-3"
      aria-labelledby="nightly-second-brain-title"
    >
      <header className="flex items-start gap-2">
        <BrainCircuit className="mt-0.5 h-5 w-5 text-accent-copper" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="nightly-second-brain-title" className="text-ui-strong text-foreground">
            Nightly second-brain update
          </h2>
          <p className="text-metadata text-muted-foreground">
            Runs every night at 2:00 a.m. local time. Missed runs recover after restart.
          </p>
          <p className="mt-1 truncate text-metadata text-accent-copper">
            {config.enabled && config.model
              ? `Configured · ${config.model.label} · ${config.mode === 'auto' ? 'Auto' : 'Approve-only'}`
              : 'Setup required'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? 'Collapse nightly maintenance settings'
              : 'Expand nightly maintenance settings'
          }
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </header>

      {expanded ? (
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-secondary">
            Enable nightly maintenance
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setEnabled(scopeKey, event.target.checked)}
              disabled={!scopeKey}
            />
          </label>

          <label className="grid gap-1 text-secondary">
            Accessible AI model
            <select
              value={config.model?.id ?? ''}
              onChange={(event) => {
                const option = available.find((candidate) => candidate.id === event.target.value);
                setModel(
                  scopeKey,
                  option
                    ? {
                        id: option.id,
                        label: option.label,
                        local: option.connection?.mode === 'local',
                        provider: option.provider,
                        modelId: option.modelId,
                        ...(option.connectionId ? { connectionId: option.connectionId } : {}),
                      }
                    : null,
                );
              }}
            >
              <option value="">Choose an accessible model</option>
              {available.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.modeLabel ?? option.provider}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-1">
            <legend className="text-secondary font-medium">Update mode</legend>
            <label className="flex items-start gap-2 text-metadata">
              <input
                type="radio"
                name="nightly-second-brain-mode"
                checked={config.mode === 'approve_only'}
                onChange={() => setMode(scopeKey, 'approve_only')}
              />
              <span>
                <strong>Approve-only</strong> — review a compact diff in the morning.
              </span>
            </label>
            <label className="flex items-start gap-2 text-metadata">
              <input
                type="radio"
                name="nightly-second-brain-mode"
                checked={config.mode === 'auto'}
                onChange={() => setMode(scopeKey, 'auto')}
              />
              <span>
                <strong>Auto</strong> — apply only verified, deduplicated changes with rollback
                history.
              </span>
            </label>
          </fieldset>

          <fieldset className="space-y-1">
            <legend className="text-secondary font-medium">Sources reviewed</legend>
            {(Object.keys(SOURCE_LABELS) as SecondBrainSourceKind[]).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-metadata">
                <input
                  type="checkbox"
                  checked={config.sources[kind]}
                  onChange={(event) => setSourceEnabled(scopeKey, kind, event.target.checked)}
                />
                {SOURCE_LABELS[kind]}
              </label>
            ))}
          </fieldset>

          {config.model && !config.model.local && (
            <label className="flex items-start gap-2 rounded-md border border-warning/30 p-2 text-metadata">
              <input
                type="checkbox"
                checked={config.allowPrivateDataToCloud}
                onChange={(event) => setCloudPrivatePermission(scopeKey, event.target.checked)}
              />
              <span>
                Permit private/local-only source text to be sent to this cloud model. Off by
                default.
              </span>
            </label>
          )}

          <div className="flex gap-2 text-metadata text-muted-foreground">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            Next run: {formatUserDateTime(nextNightlySecondBrainRun(new Date()).getTime())}
          </div>
          <button
            type="button"
            disabled={!configured || actionBusy}
            onClick={() =>
              void perform(
                async () =>
                  (await import('./nightlySecondBrainRuntime')).runNightlySecondBrain(
                    manualSecondBrainScheduledFor(),
                  ),
                'Manual check completed.',
              )
            }
          >
            Run now
          </button>
          <div className="flex gap-2 text-metadata text-muted-foreground" aria-live="polite">
            {latest ? <History className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            {latest ? latest.summary : 'No run yet. Context remains unchanged.'}
          </div>
          {latest?.changes.length ? (
            <details className="rounded-md border border-border p-2 text-metadata">
              <summary className="cursor-pointer font-medium">
                Review {latest.changes.length} proposed change
                {latest.changes.length === 1 ? '' : 's'}
              </summary>
              <div className="mt-2 space-y-2">
                {latest.changes.map((change) => (
                  <div key={change.id} className="rounded border border-border p-2">
                    <p className="font-medium">{change.path}</p>
                    <p className="text-muted-foreground">Sources: {change.provenance.join(', ')}</p>
                    {change.before ? (
                      <div className="mt-1 grid gap-1">
                        <span className="text-muted-foreground">Before</span>
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap">
                          {change.before}
                        </pre>
                      </div>
                    ) : null}
                    <div className="mt-1 grid gap-1">
                      <span className="text-muted-foreground">
                        {change.before ? 'After' : 'Add'}
                      </span>
                      <pre className="max-h-24 overflow-auto whitespace-pre-wrap">
                        {change.after}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {latest ? (
            <div className="flex flex-wrap gap-2">
              {latest.status === 'pending_approval' ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void perform(
                        async () =>
                          (
                            await import('./nightlySecondBrainRuntime')
                          ).approveNightlySecondBrainRun(latest.id),
                        'Changes applied.',
                      )
                    }
                  >
                    Approve changes
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void perform(
                        async () =>
                          (await import('./nightlySecondBrainRuntime')).rejectNightlySecondBrainRun(
                            latest.id,
                          ),
                        'Changes rejected.',
                      )
                    }
                  >
                    Reject
                  </button>
                </>
              ) : null}
              {latest.status === 'applied' ? (
                <button
                  type="button"
                  onClick={() =>
                    void perform(
                      async () =>
                        (await import('./nightlySecondBrainRuntime')).rollbackNightlySecondBrainRun(
                          latest.id,
                        ),
                      'Changes rolled back.',
                    )
                  }
                >
                  Roll back
                </button>
              ) : null}
              {latest.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() =>
                    void perform(
                      async () =>
                        (await import('./nightlySecondBrainRuntime')).retryNightlySecondBrainRun(
                          latest.id,
                        ),
                      'Retry completed.',
                    )
                  }
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="text-metadata text-muted-foreground" aria-live="polite">
            {actionStatus}
          </p>
        </div>
      ) : null}

      <section aria-label="Nightly maintenance seven-day schedule">
        <div className="mb-2 flex items-center gap-2 text-metadata font-semibold uppercase tracking-wide text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5 text-accent-copper" />
          Seven-day schedule
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((day) => (
            <div
              key={day.dayStart}
              className="min-w-0 rounded-lg border border-border bg-paper px-1.5 py-2 text-center"
              title={
                day.runs.map((run) => `${runStatusLabel(run)}: ${run.summary}`).join('\n') ||
                'No recorded run'
              }
            >
              <span className="block truncate text-[10px] font-semibold text-foreground">
                {day.label.split(',')[0]}
              </span>
              <span className="mt-1 flex min-h-3 items-center justify-center gap-0.5">
                {day.runs.length ? (
                  day.runs
                    .slice(0, 3)
                    .map((run) => (
                      <span
                        key={run.id}
                        className={`h-2 w-2 rounded-full ${runStatusClass(run)}`}
                        aria-label={runStatusLabel(run)}
                      />
                    ))
                ) : (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25"
                    aria-label="No run"
                  />
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 line-clamp-2 text-metadata text-muted-foreground">
          {latest ? `${runStatusLabel(latest)} · ${latest.summary}` : 'No completed checks yet.'}
        </p>
      </section>
    </section>
  );
}

function runStatusLabel(run: Pick<SecondBrainWeekRun, 'status'>): string {
  return run.status === 'pending_approval'
    ? 'Awaiting approval'
    : run.status === 'not_scheduled'
      ? 'Not scheduled'
      : run.status.replaceAll('_', ' ').replace(/^\w/u, (value) => value.toUpperCase());
}

function runStatusClass(run: Pick<SecondBrainWeekRun, 'status'>): string {
  if (run.status === 'applied') return 'bg-accent-sage';
  if (run.status === 'failed' || run.status === 'rejected') return 'bg-destructive';
  if (run.status === 'scheduled') return 'bg-accent-copper';
  if (run.status === 'pending_approval') return 'bg-accent-honey';
  return 'bg-muted-foreground/45';
}
