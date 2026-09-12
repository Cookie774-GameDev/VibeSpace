import * as React from 'react';
import type {
  JarvisArtifactV1,
  JarvisCommandCenterSnapshot,
  JarvisEvent,
  JarvisLiveSystemNode,
  JarvisRun,
} from './types';
import { conciseJarvisArtifactSummary, isRenderableJarvisArtifact } from './artifactAccess';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL } from '@/lib/jarvis/smoke/evidenceIds';
import { formatUserTime } from '@/lib/timeFormat';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});
const MAX_GRAPH_NODES = 12;
const MAX_ACTIVITY_EVENTS = 8;
const FLOWING_STATES = new Set([
  'active',
  'busy',
  'executing',
  'in_progress',
  'partial',
  'running',
  'started',
  'streaming',
]);
const FLOWING_RUN_STATES = new Set<JarvisRun['status']>(['compiling', 'running']);
const SAFE_SOURCE_PROTOCOLS = new Set(['app:', 'asset:', 'https:', 'jarvis:', 'vibespace:']);
const SAFE_DETAIL_LIMIT = 160;

type LiveGraphNode = Readonly<{
  id: string;
  kind: 'model' | 'capability' | 'source' | 'output';
  type: string;
  group: 'model' | 'agent' | 'connector' | 'tool' | 'entitlement' | 'source' | 'output';
  label: string;
  accessibleLabel: string;
  state: string;
  detail: string;
  location?: string;
  summary?: string;
  observedAt: number;
  flowing: boolean;
}>;
type ScopedSource = Readonly<{
  source: JarvisEvent['sourceRefs'][number];
  event: JarvisEvent;
}>;
type LiveGraphProjectionInput = Readonly<{
  nodes: readonly JarvisLiveSystemNode[];
  events: readonly JarvisEvent[];
  outputs: readonly JarvisArtifactV1[];
  run: Readonly<JarvisRun>;
}>;

function nodeLabel(node: JarvisLiveSystemNode): string {
  return node.kind === 'model'
    ? `${node.providerId} / ${node.modelId}`
    : `${node.category} / ${node.capabilityId}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function displayState(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return formatUserTime(date);
}

function formatDuration(startedAt: number, endedAt: number): string | undefined {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return undefined;
  }
  const durationMs = endedAt - startedAt;
  if (durationMs < 1_000) return '<1s';
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function conciseSafeText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/gu, ' ');
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  if (characters.length <= SAFE_DETAIL_LIMIT) return normalized;
  return `${characters
    .slice(0, SAFE_DETAIL_LIMIT - 1)
    .join('')
    .trimEnd()}…`;
}

function safeSourceLocation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!SAFE_SOURCE_PROTOCOLS.has(url.protocol.toLowerCase())) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return conciseSafeText(url.toString());
  } catch {
    return undefined;
  }
}

function liveNodeGroup(node: JarvisLiveSystemNode): LiveGraphNode['group'] {
  if (node.kind === 'model') return 'model';
  if (node.category === 'agent') return 'agent';
  if (node.category === 'mcp' || node.category === 'plugin') return 'connector';
  if (node.category === 'tool' || node.category === 'terminal') return 'tool';
  return 'entitlement';
}

function fairlyBoundGraphNodes(nodes: readonly LiveGraphNode[]): readonly LiveGraphNode[] {
  const groupOrder: readonly LiveGraphNode['group'][] = [
    'model',
    'agent',
    'connector',
    'tool',
    'entitlement',
    'source',
    'output',
  ];
  const queues = new Map(
    groupOrder.map((group) => [group, nodes.filter((node) => node.group === group)] as const),
  );
  const selected: LiveGraphNode[] = [];
  for (let index = 0; selected.length < MAX_GRAPH_NODES; index += 1) {
    let added = false;
    for (const group of groupOrder) {
      const node = queues.get(group)?.[index];
      if (!node) continue;
      selected.push(node);
      added = true;
      if (selected.length === MAX_GRAPH_NODES) break;
    }
    if (!added) break;
  }
  return selected;
}

function selectScopedEvents(
  events: readonly JarvisEvent[],
  run: Readonly<JarvisRun>,
): readonly JarvisEvent[] {
  return events
    .filter((event) => event.runId === run.id)
    .sort((left, right) => left.seq - right.seq);
}

function selectScopedOutputs(
  outputs: readonly JarvisArtifactV1[],
  run: Readonly<JarvisRun>,
): readonly JarvisArtifactV1[] {
  return outputs.filter((output) => output.runId === run.id && isRenderableJarvisArtifact(output));
}

function selectScopedSources(events: readonly JarvisEvent[], run: Readonly<JarvisRun>) {
  const byId = new Map<string, ScopedSource>();
  for (const event of events) {
    for (const source of event.sourceRefs) {
      if (
        source.accountId !== run.accountId ||
        source.sensitivity === 'secret' ||
        !source.id.trim() ||
        !source.label.trim()
      ) {
        continue;
      }
      byId.set(source.id, { source, event });
    }
  }
  return [...byId.values()];
}

function selectLatestErrorSummary(events: readonly JarvisEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'error') return conciseSafeText(event.safeSummary);
  }
  return undefined;
}

function buildGraphNodes(input: LiveGraphProjectionInput): readonly LiveGraphNode[] {
  const runFlowing = FLOWING_RUN_STATES.has(input.run.status);
  const verifiedNodes = input.nodes
    .filter((node) => node.runId === input.run.id && node.accountId === input.run.accountId)
    .map<LiveGraphNode>((node) => {
      const label = nodeLabel(node);
      const kind = node.kind === 'model' ? 'Model' : capitalize(node.category);
      return {
        id: node.id,
        kind: node.kind,
        type: kind,
        group: liveNodeGroup(node),
        label,
        accessibleLabel:
          node.kind === 'model'
            ? `Model ${label}`
            : `${capitalize(node.category)} ${node.capabilityId}`,
        state: node.state,
        detail: node.operations.join(' · '),
        observedAt: node.verifiedAt,
        flowing: runFlowing && FLOWING_STATES.has(node.state),
      };
    });
  const hasCanonicalModelNode = input.nodes.some(
    (node) =>
      node.kind === 'model' &&
      node.runId === input.run.id &&
      node.accountId === input.run.accountId &&
      node.providerId === input.run.model.providerId &&
      node.modelId === input.run.model.modelId,
  );
  if (!hasCanonicalModelNode) {
    verifiedNodes.unshift({
      id: `model:snapshot:${input.run.id}`,
      kind: 'model',
      type: 'Model',
      group: 'model',
      label: `${input.run.model.providerId} / ${input.run.model.modelId}`,
      accessibleLabel: `Model ${input.run.model.providerId} / ${input.run.model.modelId}`,
      state: input.run.status,
      detail: 'Canonical run model snapshot',
      observedAt: input.run.model.capturedAt,
      flowing: runFlowing,
    });
  }

  const sourceNodes = selectScopedSources(input.events, input.run).map<LiveGraphNode>(
    ({ source, event }) => {
      const state = event.status || 'read';
      return {
        id: `source:${source.id}`,
        kind: 'source',
        type: 'Source',
        group: 'source',
        label: source.label,
        accessibleLabel: `Source ${source.label}`,
        state,
        detail: displayState(source.kind),
        location: safeSourceLocation(source.uri),
        observedAt: source.observedAt ?? event.createdAt,
        flowing: runFlowing && FLOWING_STATES.has(state),
      };
    },
  );

  const outputNodes = input.outputs.map<LiveGraphNode>((output) => ({
    id: `output:${output.id}`,
    kind: 'output',
    type: 'Output',
    group: 'output',
    label: output.title,
    accessibleLabel: `Output ${output.title}`,
    state: output.state,
    detail: displayState(output.kind),
    summary: conciseJarvisArtifactSummary(output.safeSummary),
    observedAt: output.createdAt,
    flowing: runFlowing && output.state === 'partial',
  }));

  return fairlyBoundGraphNodes([...verifiedNodes, ...sourceNodes, ...outputNodes]);
}

function sameGraphProjection(
  left: readonly LiveGraphNode[],
  right: readonly LiveGraphNode[],
): boolean {
  return (
    left.length === right.length &&
    left.every((node, index) => {
      const candidate = right[index];
      return (
        candidate?.id === node.id &&
        candidate.kind === node.kind &&
        candidate.type === node.type &&
        candidate.group === node.group &&
        candidate.label === node.label &&
        candidate.accessibleLabel === node.accessibleLabel &&
        candidate.state === node.state &&
        candidate.detail === node.detail &&
        candidate.location === node.location &&
        candidate.summary === node.summary &&
        candidate.observedAt === node.observedAt &&
        candidate.flowing === node.flowing
      );
    })
  );
}

export function createLiveGraphProjectionSelector(): (
  input: LiveGraphProjectionInput,
) => readonly LiveGraphNode[] {
  let previousInput: LiveGraphProjectionInput | undefined;
  let previousProjection: readonly LiveGraphNode[] | undefined;

  return (input) => {
    if (
      previousProjection &&
      previousInput?.nodes === input.nodes &&
      previousInput.events === input.events &&
      previousInput.outputs === input.outputs &&
      previousInput.run === input.run
    ) {
      return previousProjection;
    }
    const nextProjection = buildGraphNodes(input);
    previousInput = input;
    if (previousProjection && sameGraphProjection(previousProjection, nextProjection)) {
      return previousProjection;
    }
    previousProjection = nextProjection;
    return previousProjection;
  };
}

function LiveSummary({
  nodes,
  run,
  sources,
  outputs,
}: {
  nodes: readonly JarvisLiveSystemNode[];
  run: Readonly<JarvisRun>;
  sources: number;
  outputs: number;
}) {
  const connectors = nodes.filter(
    (node) =>
      node.kind === 'capability' &&
      (node.state === 'ready' || node.state === 'busy') &&
      (node.category === 'mcp' || node.category === 'plugin'),
  ).length;
  const tools = nodes.filter(
    (node) =>
      node.kind === 'capability' &&
      (node.state === 'ready' || node.state === 'busy') &&
      (node.category === 'tool' || node.category === 'terminal'),
  ).length;
  const counters = [
    `Model ${run.model.providerId} / ${run.model.modelId}`,
    ...(connectors > 0 ? [`Connectors ${connectors}`] : []),
    ...(tools > 0 ? [`Tools ${tools}`] : []),
    ...(sources > 0 ? [`Sources ${sources}`] : []),
    ...(outputs > 0 ? [`Outputs ${outputs}`] : []),
  ];
  if (counters.length === 0) return null;
  return (
    <ul className="jarvis-live-systems__summary" aria-label="Current run summary">
      {counters.map((counter) => (
        <li key={counter}>{counter}</li>
      ))}
    </ul>
  );
}

function LiveExecutionMap({
  nodes,
  run,
  motionEnabled,
  errorSummary,
}: {
  nodes: readonly LiveGraphNode[];
  run: Readonly<JarvisRun>;
  motionEnabled: boolean;
  errorSummary?: string;
}) {
  const detailsId = React.useId();
  const [selectedId, setSelectedId] = React.useState(`run:${run.id}`);
  const selected =
    selectedId === `run:${run.id}` ? undefined : nodes.find((node) => node.id === selectedId);
  const selectedTime = selected ? formatTime(selected.observedAt) : undefined;
  const runDuration = formatDuration(run.createdAt, run.completedAt ?? run.updatedAt);

  React.useEffect(() => {
    if (selectedId !== `run:${run.id}` && !nodes.some((node) => node.id === selectedId)) {
      setSelectedId(`run:${run.id}`);
    }
  }, [nodes, run.id, selectedId]);

  const branches = React.useMemo(
    () =>
      nodes.map((node) => {
        const animated = motionEnabled && node.flowing;
        return (
          <div className="jarvis-live-systems__branch" key={node.id}>
            <span
              className={`jarvis-live-systems__edge${
                animated ? ' jarvis-live-systems__edge--flowing' : ''
              }`}
              aria-hidden="true"
              data-graph-edge={node.id}
              data-edge-state={node.flowing ? 'active' : 'settled'}
              data-animated={String(animated)}
            />
            <button
              type="button"
              className="jarvis-live-systems__node"
              aria-label={node.accessibleLabel}
              aria-controls={detailsId}
              aria-describedby={detailsId}
              aria-pressed={selected?.id === node.id}
              data-kind={node.kind}
              data-state={node.state}
              onClick={() => setSelectedId(node.id)}
              onFocus={() => setSelectedId(node.id)}
            >
              <span>{node.label}</span>
              <small>{displayState(node.state)}</small>
            </button>
          </div>
        );
      }),
    [detailsId, motionEnabled, nodes, selected?.id],
  );

  return (
    <div className="jarvis-live-systems__map-wrap">
      <div className="jarvis-live-systems__map" data-testid="command-center-graph">
        <span
          className="sr-only"
          role="img"
          aria-label="Current run execution map"
          data-run-id={run.id}
        />
        <button
          type="button"
          className="jarvis-live-systems__node jarvis-live-systems__node--root"
          aria-label="Jarvis run"
          aria-controls={detailsId}
          aria-describedby={detailsId}
          aria-pressed={!selected}
          data-state={run.status}
          data-blocked={run.status === 'awaiting_approval' ? 'approval' : undefined}
          onClick={() => setSelectedId(`run:${run.id}`)}
          onFocus={() => setSelectedId(`run:${run.id}`)}
        >
          <span>Jarvis</span>
          <small>{displayState(run.status)}</small>
        </button>
        <div className="jarvis-live-systems__branches">{branches}</div>
      </div>
      <div
        className="jarvis-live-systems__details"
        id={detailsId}
        role="region"
        aria-label="Live system details"
      >
        <span className="jarvis-live-systems__details-title">{selected?.label ?? 'Jarvis'}</span>
        <span>
          {selected
            ? `${selected.type} · ${displayState(selected.state)} · ${
                selected.detail
              }${selectedTime ? ` · ${selectedTime}` : ''}`
            : `Run · ${displayState(run.status)}`}
        </span>
        {selected?.location ? <span>Location · {selected.location}</span> : null}
        {selected?.summary ? <span>Result · {selected.summary}</span> : null}
        {runDuration ? <span>Run duration · {runDuration}</span> : null}
        {errorSummary ? (
          <span className="jarvis-live-systems__details-error">Run error · {errorSummary}</span>
        ) : null}
      </div>
    </div>
  );
}

function LiveActivity({
  events,
  graphNodes,
  includeRun,
  run,
}: {
  events: readonly JarvisEvent[];
  graphNodes: readonly LiveGraphNode[];
  includeRun: boolean;
  run: Readonly<JarvisRun>;
}) {
  const titleId = React.useId();
  if (events.length === 0 && !includeRun) return null;
  return (
    <section className="jarvis-live-systems__activity" aria-labelledby={titleId}>
      <h3 id={titleId}>Activity</h3>
      <ol aria-label="Run activity">
        {includeRun ? (
          <li
            data-activity-state={run.status}
            data-activity-kind="execution-node"
            data-node-kind="run"
          >
            <span aria-hidden="true" />
            <span className="jarvis-live-systems__activity-copy">
              <span>Execution node: Jarvis</span>
              <small>Run · {displayState(run.status)}</small>
            </span>
            <span className="jarvis-live-systems__activity-state">{displayState(run.status)}</span>
          </li>
        ) : null}
        {includeRun
          ? graphNodes.map((node) => (
              <li
                key={`execution-node:${node.id}`}
                data-activity-state={node.state}
                data-activity-kind="execution-node"
                data-node-kind={node.kind}
              >
                <span aria-hidden="true" />
                <span className="jarvis-live-systems__activity-copy">
                  <span>Execution node: {node.accessibleLabel}</span>
                  <small>
                    {node.type} · {node.detail}
                  </small>
                </span>
                <span className="jarvis-live-systems__activity-state">
                  {displayState(node.state)}
                </span>
              </li>
            ))
          : null}
        {events.map((event) => {
          const timestamp = formatTime(event.createdAt);
          const summary = conciseSafeText(event.safeSummary);
          return (
            <li
              key={`${event.seq}:${event.idempotencyKey}`}
              data-activity-state={event.status ?? event.type}
              data-activity-kind={event.type}
            >
              {timestamp ? (
                <time dateTime={new Date(event.createdAt).toISOString()}>{timestamp}</time>
              ) : (
                <span aria-hidden="true" />
              )}
              <span className="jarvis-live-systems__activity-copy">
                <span>{event.title}</span>
                {summary ? <small>{summary}</small> : null}
              </span>
              <span className="jarvis-live-systems__activity-state">
                {displayState(event.status ?? event.type)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const ReadyJarvisLiveSystemsTab = React.memo(function ReadyJarvisLiveSystemsTab({
  liveSystems,
  run,
  events,
  outputs,
  motionEnabled,
}: {
  liveSystems: Extract<JarvisCommandCenterSnapshot['liveSystems'], { state: 'ready' }>;
  run: Readonly<JarvisRun>;
  events: readonly JarvisEvent[];
  outputs: readonly JarvisArtifactV1[];
  motionEnabled: boolean;
}) {
  const scopedEvents = React.useMemo(() => selectScopedEvents(events, run), [events, run]);
  const scopedOutputs = React.useMemo(() => selectScopedOutputs(outputs, run), [outputs, run]);
  const scopedNodes = React.useMemo(
    () =>
      liveSystems.nodes.filter(
        (node) =>
          node.runId === run.id &&
          node.accountId === run.accountId &&
          (node.kind !== 'model' ||
            (node.providerId === run.model.providerId && node.modelId === run.model.modelId)),
      ),
    [liveSystems.nodes, run],
  );
  const sources = React.useMemo(() => selectScopedSources(scopedEvents, run), [run, scopedEvents]);
  const errorSummary = React.useMemo(() => selectLatestErrorSummary(scopedEvents), [scopedEvents]);
  const selectGraphProjection = React.useMemo(createLiveGraphProjectionSelector, []);
  const graphNodes = selectGraphProjection({
    nodes: scopedNodes,
    events: scopedEvents,
    outputs: scopedOutputs,
    run,
  });
  const recentEvents = React.useMemo(
    () => scopedEvents.slice(-MAX_ACTIVITY_EVENTS),
    [scopedEvents],
  );
  const visibleState =
    run.status === 'awaiting_approval'
      ? 'Waiting for approval'
      : run.status === 'failed' || run.status === 'timed_out'
        ? `Run ${displayState(run.status)}`
        : undefined;
  const showExecutionMap = graphNodes.length > 0 || run.status === 'awaiting_approval';

  if (graphNodes.length === 0 && scopedEvents.length === 0 && !visibleState) {
    return (
      <p
        className="jarvis-command-center__empty"
        data-sik-live-state={KERNEL_SMOKE_ENABLED ? liveSystems.state : undefined}
      >
        No verified live activity for this run.
      </p>
    );
  }

  return (
    <div
      className="jarvis-live-systems"
      data-sik-live-state={KERNEL_SMOKE_ENABLED ? liveSystems.state : undefined}
    >
      <LiveSummary
        nodes={scopedNodes}
        run={run}
        sources={sources.length}
        outputs={scopedOutputs.length}
      />
      {visibleState ? (
        <p className="jarvis-live-systems__run-state" data-state={run.status} role="status">
          {visibleState}
        </p>
      ) : null}
      {showExecutionMap ? (
        <LiveExecutionMap
          nodes={graphNodes}
          run={run}
          motionEnabled={motionEnabled}
          errorSummary={errorSummary}
        />
      ) : null}
      <LiveActivity
        events={recentEvents}
        graphNodes={graphNodes}
        includeRun={showExecutionMap}
        run={run}
      />
      {scopedNodes.map((node) => (
        <output
          hidden
          key={node.id}
          data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_CONTROL.liveSystemNode : undefined}
          data-live-node-state={KERNEL_SMOKE_ENABLED ? node.state : undefined}
          data-live-proof-ref={KERNEL_SMOKE_ENABLED ? node.evidenceRef : undefined}
        />
      ))}
    </div>
  );
});

export function JarvisLiveSystemsTab({
  liveSystems,
  run,
  events = [],
  outputs = [],
  motionEnabled = true,
}: {
  liveSystems: JarvisCommandCenterSnapshot['liveSystems'];
  run?: Readonly<JarvisRun>;
  events?: readonly JarvisEvent[];
  outputs?: readonly JarvisArtifactV1[];
  motionEnabled?: boolean;
}) {
  if (liveSystems.state === 'not_loaded' || liveSystems.state === 'loading') {
    return (
      <p
        className="jarvis-command-center__empty"
        aria-live="polite"
        data-sik-live-state={KERNEL_SMOKE_ENABLED ? liveSystems.state : undefined}
      >
        {liveSystems.state === 'loading'
          ? 'Reading verified live evidence…'
          : 'Live evidence not loaded.'}
      </p>
    );
  }
  if (liveSystems.state === 'unavailable') {
    return (
      <p
        className="jarvis-command-center__empty"
        data-sik-live-state={KERNEL_SMOKE_ENABLED ? liveSystems.state : undefined}
      >
        {liveSystems.reason}
      </p>
    );
  }
  if (!run) {
    return <p className="jarvis-command-center__empty">No canonical run is available.</p>;
  }

  return (
    <ReadyJarvisLiveSystemsTab
      liveSystems={liveSystems}
      run={run}
      events={events}
      outputs={outputs}
      motionEnabled={motionEnabled}
    />
  );
}
