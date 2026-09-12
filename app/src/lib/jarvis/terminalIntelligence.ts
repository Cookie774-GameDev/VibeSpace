import type { TerminalCommand } from '@/features/terminals/terminalCommandQueue';
import { useTerminalCommandQueue } from '@/features/terminals/terminalCommandQueue';
import {
  sanitizePersistedDraft,
  sanitizePersistedTerminalText,
} from '@/features/terminals/terminalContentSanitizer';
import type { TerminalExecution } from '@/features/terminals/terminalExecutionStore';
import { useTerminalExecutionStore } from '@/features/terminals/terminalExecutionStore';
import type { SessionTranscript } from '@/features/terminals/transcriptStore';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { deepFreezeJarvisCopy } from './requestEnvelope';

const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_RECENT_OUTPUT_BYTES = 4 * 1024;
const MAX_RECENT_OUTPUT_LINES = 50;
const MAX_ERROR_BYTES = 240;
const MAX_SUMMARY_CHARS = 240;
const MAX_ERRORS_PER_PANE = 3;

export type JarvisTerminalLifecycleState =
  | 'prepared'
  | 'awaiting_approval'
  | 'queued'
  | 'sent'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'unknown';

export type JarvisTerminalJournalState = Exclude<
  JarvisTerminalLifecycleState,
  'stalled' | 'unknown'
>;

export type JarvisTerminalMarker =
  | 'build_passed'
  | 'build_failed'
  | 'tests_passed'
  | 'tests_failed'
  | 'working_tree_clean';

export interface JarvisTerminalLifecycleObservation {
  readonly state: JarvisTerminalJournalState;
  readonly updatedAt: number;
}

export interface JarvisTerminalFileActivity {
  readonly lockedFiles?: readonly string[];
  readonly editedFiles?: readonly string[];
}

export interface JarvisTerminalPaneSnapshot {
  readonly paneId: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly processInstanceId?: string;
  readonly pid?: number;
  readonly processStartedAt?: number;
  readonly runtimeGeneration?: string;
  readonly agentSlug?: string;
  readonly cwd?: string;
  readonly launchedCommand?: string;
  readonly state: JarvisTerminalLifecycleState;
  readonly exitCode?: number | null;
  readonly recentMeaningfulOutput?: string;
  readonly lastOutputAt?: number;
  readonly stale: boolean;
  readonly queuedCommand?: string;
  readonly markers: readonly JarvisTerminalMarker[];
  readonly errors: readonly string[];
  readonly lockedFiles: readonly string[];
  readonly editedFiles: readonly string[];
}

export interface JarvisTerminalOperatingSnapshot {
  readonly capturedAt: number;
  readonly panes: readonly JarvisTerminalPaneSnapshot[];
}

export interface JarvisTerminalOperatingSnapshotInput {
  readonly observedAt: number;
  readonly staleAfterMs?: number;
  readonly transcripts: Readonly<Record<string, SessionTranscript>>;
  readonly executions: Readonly<Record<string, TerminalExecution>>;
  readonly queue: readonly TerminalCommand[];
  readonly lifecycleByExecutionId?: Readonly<
    Record<string, JarvisTerminalLifecycleObservation | undefined>
  >;
  readonly fileActivityByPaneId?: Readonly<Record<string, JarvisTerminalFileActivity | undefined>>;
}

export interface ReadJarvisTerminalOperatingSnapshotOptions {
  readonly observedAt: number;
  readonly staleAfterMs?: number;
  readonly projectId?: string;
  readonly lifecycleByExecutionId?: Readonly<
    Record<string, JarvisTerminalLifecycleObservation | undefined>
  >;
  readonly fileActivityByPaneId?: Readonly<Record<string, JarvisTerminalFileActivity | undefined>>;
}

export interface JarvisTerminalOperatingSummary {
  readonly total: number;
  readonly active: number;
  readonly stalled: number;
  readonly failed: number;
  readonly completed: number;
  readonly text: string;
}

type ShellCommand = Extract<TerminalCommand, { kind: 'shell' }>;

const EXECUTION_STATE: Readonly<Record<TerminalExecution['status'], JarvisTerminalLifecycleState>> =
  Object.freeze({
    queued: 'queued',
    starting: 'sent',
    running: 'running',
    cancellation_requested: 'running',
    complete: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  });

const ACTIVE_STATES = new Set<JarvisTerminalLifecycleState>(['sent', 'running', 'verifying']);

const ACTIONABLE_ERROR =
  /(?:\b(?:error|fatal)\s*:|\b(?:exception|panic|missing import|cannot find|TS\d{3,})\b)/i;

function safeTimestamp(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function staleThreshold(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.floor(value as number)
    : DEFAULT_STALE_AFTER_MS;
}

function sanitizedOutput(value: string): string {
  return sanitizePersistedTerminalText(value, {
    maxBytes: MAX_RECENT_OUTPUT_BYTES,
    maxLines: MAX_RECENT_OUTPUT_LINES,
  }).text.trim();
}

function sanitizedScalar(
  value: string | null | undefined,
  recentOutput = '',
  maxBytes = MAX_RECENT_OUTPUT_BYTES,
): string | undefined {
  if (!value) return undefined;
  const draft = sanitizePersistedDraft(value, recentOutput).trim();
  if (!draft) return undefined;
  const bounded = sanitizePersistedTerminalText(draft, {
    maxBytes,
    maxLines: 1,
    truncationMarker: '',
  }).text.trim();
  return bounded || undefined;
}

function sanitizedStringList(
  values: readonly string[] | undefined,
  recentOutput: string,
): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const safe = sanitizedScalar(value, recentOutput);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    result.push(safe);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function newestExecution(
  executions: readonly TerminalExecution[],
  predicate: (execution: TerminalExecution) => boolean,
): TerminalExecution | undefined {
  return executions
    .filter(predicate)
    .sort(
      (left, right) =>
        safeTimestamp(right.updatedAt) - safeTimestamp(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )[0];
}

function commandExecutionId(command: ShellCommand): string {
  return command.canonical?.executionId ?? command.id;
}

function commandReferencesTranscript(
  command: ShellCommand,
  transcript: SessionTranscript,
): boolean {
  return Boolean(
    command.refs?.some(
      (ref) =>
        (ref.sessionId && ref.sessionId === transcript.sessionId) ||
        (ref.paneId && transcript.paneId && ref.paneId === transcript.paneId),
    ),
  );
}

function matchingCommand(
  commands: readonly ShellCommand[],
  transcript: SessionTranscript,
  execution: TerminalExecution | undefined,
): ShellCommand | undefined {
  return commands.find(
    (command) =>
      commandReferencesTranscript(command, transcript) ||
      (execution !== undefined && commandExecutionId(command) === execution.id),
  );
}

function executionForTranscript(
  executions: readonly TerminalExecution[],
  commands: readonly ShellCommand[],
  transcript: SessionTranscript,
): TerminalExecution | undefined {
  const bySession = newestExecution(
    executions,
    (execution) => execution.sessionId === transcript.sessionId,
  );
  if (bySession) return bySession;
  const command = commands.find((candidate) => commandReferencesTranscript(candidate, transcript));
  return command
    ? newestExecution(executions, (execution) => execution.id === commandExecutionId(command))
    : undefined;
}

type JarvisTerminalProcessProjection = Readonly<{
  executionId: string;
  processInstanceId: string;
  pid: number;
  processStartedAt: number;
  runtimeGeneration: string;
}>;

function stableIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function processProjectionForTranscript(
  execution: TerminalExecution | undefined,
  transcript: SessionTranscript,
  paneId: string,
  executions: readonly TerminalExecution[],
): JarvisTerminalProcessProjection | undefined {
  const identity = execution?.processIdentity;
  const transcriptProjectId =
    transcript.projectId === undefined || transcript.projectId === null
      ? null
      : transcript.projectId;
  if (
    !execution ||
    !identity ||
    !Object.isFrozen(identity) ||
    executions.filter((candidate) => candidate.sessionId === transcript.sessionId).length !== 1 ||
    !stableIdentity(execution.accountId) ||
    !stableIdentity(execution.runId) ||
    !stableIdentity(execution.id) ||
    !stableIdentity(transcript.sessionId) ||
    !stableIdentity(paneId) ||
    (transcriptProjectId !== null && !stableIdentity(transcriptProjectId)) ||
    identity.accountId !== execution.accountId ||
    identity.projectId !== transcriptProjectId ||
    identity.runId !== execution.runId ||
    identity.executionId !== execution.id ||
    identity.paneId !== paneId ||
    identity.sessionId !== transcript.sessionId ||
    execution.sessionId !== transcript.sessionId ||
    !stableIdentity(identity.processInstanceId) ||
    !stableIdentity(identity.runtimeGeneration) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pid > 0xffff_ffff ||
    !Number.isSafeInteger(identity.processStartedAt) ||
    identity.processStartedAt <= 0
  ) {
    return undefined;
  }
  return {
    executionId: identity.executionId,
    processInstanceId: identity.processInstanceId,
    pid: identity.pid,
    processStartedAt: identity.processStartedAt,
    runtimeGeneration: identity.runtimeGeneration,
  };
}

function lifecycleForExecution(
  execution: TerminalExecution | undefined,
  lifecycleByExecutionId:
    | Readonly<Record<string, JarvisTerminalLifecycleObservation | undefined>>
    | undefined,
): JarvisTerminalLifecycleObservation | undefined {
  return execution ? lifecycleByExecutionId?.[execution.id] : undefined;
}

function stateFor(
  execution: TerminalExecution | undefined,
  lifecycle: JarvisTerminalLifecycleObservation | undefined,
  hasQueuedCommand: boolean,
): JarvisTerminalLifecycleState {
  return (
    lifecycle?.state ??
    (execution ? EXECUTION_STATE[execution.status] : undefined) ??
    (hasQueuedCommand ? 'queued' : 'unknown')
  );
}

function staleState(
  state: JarvisTerminalLifecycleState,
  observedAt: number,
  evidenceAt: number | undefined,
  staleAfterMs: number,
): { state: JarvisTerminalLifecycleState; stale: boolean } {
  if (evidenceAt === undefined) return { state, stale: false };
  const stale = Math.max(0, observedAt - safeTimestamp(evidenceAt)) > staleAfterMs;
  return {
    state: stale && ACTIVE_STATES.has(state) ? 'stalled' : state,
    stale,
  };
}

function detectMarkers(output: string): JarvisTerminalMarker[] {
  const markers: JarvisTerminalMarker[] = [];
  const buildFailed = /\b(?:build failed|failed to build|compilation failed)\b/i.test(output);
  const buildPassed =
    !buildFailed &&
    /\b(?:build (?:passed|succeeded|successful)|compiled successfully)\b/i.test(output);
  const testsFailed =
    /\b(?:test files?.*failed|\d+\s+(?:tests?|test files?)\s+failed|tests? failed)\b/i.test(output);
  const testsPassed =
    !testsFailed &&
    /\b(?:\d+\s+tests?\s+passed|test files?.*passed|all .* tests .* green)\b/i.test(output);
  if (buildFailed) markers.push('build_failed');
  else if (buildPassed) markers.push('build_passed');
  if (testsFailed) markers.push('tests_failed');
  else if (testsPassed) markers.push('tests_passed');
  if (/\b(?:working tree clean|nothing to commit)\b/i.test(output)) {
    markers.push('working_tree_clean');
  }
  return markers;
}

function detectErrors(output: string, settlementError: string | undefined): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const append = (value: string | null | undefined) => {
    const safe = sanitizedScalar(value, output, MAX_ERROR_BYTES);
    if (!safe || seen.has(safe) || errors.length >= MAX_ERRORS_PER_PANE) return;
    seen.add(safe);
    errors.push(safe);
  };
  append(settlementError);
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (ACTIONABLE_ERROR.test(trimmed)) append(trimmed);
  }
  return errors;
}

function paneFromTranscript(
  transcript: SessionTranscript,
  executions: readonly TerminalExecution[],
  commands: readonly ShellCommand[],
  input: JarvisTerminalOperatingSnapshotInput,
  matchedCommandIds: Set<string>,
): JarvisTerminalPaneSnapshot {
  const paneId = sanitizedScalar(transcript.paneId) ?? `session:${transcript.sessionId}`;
  const execution = executionForTranscript(executions, commands, transcript);
  const command = matchingCommand(commands, transcript, execution);
  if (command) matchedCommandIds.add(command.id);
  const lifecycle = lifecycleForExecution(execution, input.lifecycleByExecutionId);
  const rawOutput = sanitizedOutput(transcript.text);
  const output = rawOutput || undefined;
  const lastOutputAt = safeTimestamp(transcript.lastWriteAt);
  const baseState = stateFor(execution, lifecycle, command !== undefined);
  const evidenceAt = transcript.lastWriteAt ?? execution?.updatedAt ?? lifecycle?.updatedAt;
  const state = staleState(
    baseState,
    safeTimestamp(input.observedAt),
    evidenceAt,
    staleThreshold(input.staleAfterMs),
  );
  const activity = input.fileActivityByPaneId?.[paneId];
  const agentSlug =
    sanitizedScalar(transcript.agentSlug, rawOutput) ??
    sanitizedScalar(command?.agentSlug, rawOutput) ??
    sanitizedScalar(command?.refs?.[0]?.agentSlug, rawOutput);
  const cwd = sanitizedScalar(command?.cwd, rawOutput);
  const launchedCommand = sanitizedScalar(transcript.command, rawOutput);
  const queuedCommand = sanitizedScalar(command?.command, rawOutput);
  const sessionId = sanitizedScalar(transcript.sessionId, rawOutput);
  const processProjection = processProjectionForTranscript(
    execution,
    transcript,
    paneId,
    executions,
  );

  return {
    paneId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(processProjection === undefined ? {} : processProjection),
    ...(agentSlug === undefined ? {} : { agentSlug }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(launchedCommand === undefined ? {} : { launchedCommand }),
    state: state.state,
    ...(execution === undefined || execution.exitCode === undefined
      ? {}
      : { exitCode: execution.exitCode }),
    ...(output === undefined ? {} : { recentMeaningfulOutput: output }),
    ...(Number.isFinite(lastOutputAt) ? { lastOutputAt } : {}),
    stale: state.stale,
    ...(queuedCommand === undefined ? {} : { queuedCommand }),
    markers: detectMarkers(rawOutput),
    errors: detectErrors(rawOutput, execution?.settlementError),
    lockedFiles: sanitizedStringList(activity?.lockedFiles, rawOutput),
    editedFiles: sanitizedStringList(activity?.editedFiles, rawOutput),
  };
}

function paneFromQueueOnly(
  command: ShellCommand,
  executions: readonly TerminalExecution[],
  input: JarvisTerminalOperatingSnapshotInput,
): JarvisTerminalPaneSnapshot {
  const executionId = commandExecutionId(command);
  const execution = newestExecution(executions, (candidate) => candidate.id === executionId);
  const lifecycle = lifecycleForExecution(execution, input.lifecycleByExecutionId);
  const ref = command.refs?.[0];
  const paneId = `queued:${sanitizedScalar(command.id) ?? 'unknown'}`;
  const state = staleState(
    stateFor(execution, lifecycle, true),
    safeTimestamp(input.observedAt),
    lifecycle?.updatedAt ?? execution?.updatedAt,
    staleThreshold(input.staleAfterMs),
  );
  const activity =
    input.fileActivityByPaneId?.[paneId] ??
    (ref?.paneId ? input.fileActivityByPaneId?.[ref.paneId] : undefined);
  const queuedCommand = sanitizedScalar(command.command);
  const sessionId = sanitizedScalar(ref?.sessionId);
  const agentSlug = sanitizedScalar(command.agentSlug) ?? sanitizedScalar(ref?.agentSlug);
  const cwd = sanitizedScalar(command.cwd);

  return {
    paneId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentSlug === undefined ? {} : { agentSlug }),
    ...(cwd === undefined ? {} : { cwd }),
    state: state.state,
    ...(execution === undefined || execution.exitCode === undefined
      ? {}
      : { exitCode: execution.exitCode }),
    stale: state.stale,
    ...(queuedCommand === undefined ? {} : { queuedCommand }),
    markers: [],
    errors: detectErrors('', execution?.settlementError),
    lockedFiles: sanitizedStringList(activity?.lockedFiles, ''),
    editedFiles: sanitizedStringList(activity?.editedFiles, ''),
  };
}

export function createJarvisTerminalOperatingSnapshot(
  input: JarvisTerminalOperatingSnapshotInput,
): JarvisTerminalOperatingSnapshot {
  const executions = Object.values(input.executions);
  const commands = input.queue.filter(
    (command): command is ShellCommand => command.kind === 'shell',
  );
  const matchedCommandIds = new Set<string>();
  const panes = Object.values(input.transcripts).map((transcript) =>
    paneFromTranscript(transcript, executions, commands, input, matchedCommandIds),
  );
  for (const command of commands) {
    if (!matchedCommandIds.has(command.id)) {
      panes.push(paneFromQueueOnly(command, executions, input));
    }
  }
  panes.sort(
    (left, right) =>
      left.paneId.localeCompare(right.paneId) ||
      (left.sessionId ?? '').localeCompare(right.sessionId ?? ''),
  );
  return deepFreezeJarvisCopy({
    capturedAt: safeTimestamp(input.observedAt),
    panes,
  }) as JarvisTerminalOperatingSnapshot;
}

export function readJarvisTerminalOperatingSnapshot(
  options: ReadJarvisTerminalOperatingSnapshotOptions,
): JarvisTerminalOperatingSnapshot {
  const liveTranscripts = useTerminalTranscriptStore.getState().sessions;
  const liveExecutions = useTerminalExecutionStore.getState().executions;
  const liveQueue = useTerminalCommandQueue.getState().queue;
  const projectId = options.projectId?.trim();
  if (!projectId) {
    return createJarvisTerminalOperatingSnapshot({
      ...options,
      transcripts: liveTranscripts,
      executions: liveExecutions,
      queue: liveQueue,
    });
  }

  const transcripts = Object.fromEntries(
    Object.entries(liveTranscripts).filter(([, transcript]) => transcript.projectId === projectId),
  );
  const sessionIds = new Set(Object.values(transcripts).map(({ sessionId }) => sessionId));
  const paneIds = new Set(
    Object.values(transcripts)
      .map(({ paneId }) => paneId)
      .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.length > 0),
  );
  const transcriptExecutionIds = new Set(
    Object.values(liveExecutions)
      .filter(
        (execution) => execution.sessionId !== undefined && sessionIds.has(execution.sessionId),
      )
      .map(({ id }) => id),
  );
  const queue = liveQueue.filter(
    (command): command is ShellCommand =>
      command.kind === 'shell' &&
      Boolean(
        transcriptExecutionIds.has(commandExecutionId(command)) ||
        command.refs?.some(
          (ref) =>
            ref.projectId === projectId ||
            (ref.sessionId !== undefined && sessionIds.has(ref.sessionId)) ||
            (ref.paneId !== undefined && paneIds.has(ref.paneId)),
        ),
      ),
  );
  const executionIds = new Set(queue.map(commandExecutionId));
  const executions = Object.fromEntries(
    Object.entries(liveExecutions).filter(
      ([, execution]) =>
        executionIds.has(execution.id) ||
        (execution.sessionId !== undefined && sessionIds.has(execution.sessionId)),
    ),
  );
  return createJarvisTerminalOperatingSnapshot({
    ...options,
    transcripts,
    executions,
    queue,
  });
}

function boundedSummary(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd()}...`;
}

export function summarizeJarvisTerminalOperatingSnapshot(
  snapshot: JarvisTerminalOperatingSnapshot,
): JarvisTerminalOperatingSummary {
  const total = snapshot.panes.length;
  const active = snapshot.panes.filter((pane) => ACTIVE_STATES.has(pane.state)).length;
  const stalled = snapshot.panes.filter((pane) => pane.state === 'stalled').length;
  const failed = snapshot.panes.filter((pane) => pane.state === 'failed').length;
  const completed = snapshot.panes.filter((pane) => pane.state === 'completed').length;
  const queued = snapshot.panes.filter((pane) =>
    ['prepared', 'awaiting_approval', 'queued'].includes(pane.state),
  ).length;
  const firstError = snapshot.panes.flatMap((pane) => pane.errors)[0];
  let text: string;

  if (total === 0) {
    text = 'No terminal tasks are currently observed.';
  } else if (completed === total) {
    text = `All ${total} terminal tasks completed with verified terminal state.`;
  } else if (failed > 0 || stalled > 0) {
    const parts = [
      `${total} terminal ${total === 1 ? 'pane' : 'panes'} observed:`,
      `${failed} failed,`,
      `${stalled} stalled,`,
      `${active} active,`,
      `${queued} queued.`,
    ];
    text = `${parts.join(' ')}${firstError ? ` ${firstError}` : ''}`;
  } else if (queued === total) {
    text = `${total} terminal ${total === 1 ? 'task' : 'tasks'} queued and not completed.`;
  } else {
    text = `${total} terminal ${total === 1 ? 'pane' : 'panes'} observed: ${active} active, ${queued} queued, ${completed} completed.`;
  }

  return deepFreezeJarvisCopy({
    total,
    active,
    stalled,
    failed,
    completed,
    text: boundedSummary(text),
  }) as JarvisTerminalOperatingSummary;
}
