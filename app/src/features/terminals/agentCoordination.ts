export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom';
export type AgentCoordinationMode = 'default' | 'coordinated' | 'no-context';
export type AgentCoordinationStatus = 'idle' | 'working' | 'blocked' | 'completed' | 'error';
export type AgentFileLockStatus = 'active' | 'released' | 'stale';

export interface AgentCoordinationRecord {
  id: string;
  terminalId: string;
  paneId?: string | null;
  agentName: string;
  agentSlug?: string | null;
  provider: AgentProvider;
  mode: AgentCoordinationMode;
  task?: string;
  status: AgentCoordinationStatus;
  claimedFiles: string[];
  lockedFiles: string[];
  lastHeartbeatAt: string;
  lastActionSummary?: string;
}

export interface AgentFileLock {
  filePath: string;
  lockedByTerminalId: string;
  lockedByAgentName: string;
  reason?: string;
  lockedAt: string;
  expiresAt?: string;
  status: AgentFileLockStatus;
}

export type AgentCoordinationEventType =
  | 'agent_registered'
  | 'task_started'
  | 'file_locked'
  | 'file_unlocked'
  | 'edit_started'
  | 'edit_completed'
  | 'handoff_created'
  | 'error_reported'
  | 'heartbeat';

export interface AgentCoordinationEvent {
  id: string;
  timestamp: string;
  terminalId: string;
  paneId?: string | null;
  agentName: string;
  agentSlug?: string | null;
  provider?: AgentProvider;
  mode?: AgentCoordinationMode;
  type: AgentCoordinationEventType;
  filePath?: string;
  summary: string;
}

export interface AgentCoordinationSnapshot {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  agents: AgentCoordinationRecord[];
  locks: AgentFileLock[];
  events: AgentCoordinationEvent[];
}

export interface FileLockRequest {
  filePath: string;
  terminalId: string;
  agentName: string;
  reason?: string;
  now: string;
  expiresAt?: string;
}

export interface ReleaseFileLockRequest {
  filePath: string;
  terminalId: string;
  now: string;
}

const MAX_RECENT_EVENTS = 20;
const SECRETISH_RE = /\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|AIza|ya29)[A-Za-z0-9_\-]{8,}\b/g;

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function eventId(prefix: string, timestamp: string, terminalId: string): string {
  const compact = timestamp.replace(/[^0-9]/g, '');
  return `${prefix}_${compact}_${terminalId}`;
}

function sanitizeSummary(text: string | undefined, max = 220): string {
  const clean = (text ?? '')
    .replace(SECRETISH_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function upsertAgent(
  snapshot: AgentCoordinationSnapshot,
  record: AgentCoordinationRecord,
): AgentCoordinationRecord[] {
  const existing = snapshot.agents.find((agent) => agent.terminalId === record.terminalId);
  if (!existing) return [...snapshot.agents, record];
  return snapshot.agents.map((agent) => (
    agent.terminalId === record.terminalId
      ? {
          ...existing,
          ...record,
          claimedFiles: Array.from(new Set([...existing.claimedFiles, ...record.claimedFiles])),
          lockedFiles: Array.from(new Set(record.lockedFiles)),
        }
      : agent
  ));
}

function appendEvent(
  snapshot: AgentCoordinationSnapshot,
  event: AgentCoordinationEvent,
): AgentCoordinationEvent[] {
  const cleanEvent = {
    ...event,
    summary: sanitizeSummary(event.summary, 500),
    filePath: event.filePath ? normalizePath(event.filePath) : undefined,
  };
  return [...snapshot.events, cleanEvent].slice(-MAX_RECENT_EVENTS);
}

function withAgentLockFile(
  agents: AgentCoordinationRecord[],
  terminalId: string,
  filePath: string,
  add: boolean,
): AgentCoordinationRecord[] {
  return agents.map((agent) => {
    if (agent.terminalId !== terminalId) return agent;
    const locked = new Set(agent.lockedFiles.map(normalizePath));
    if (add) locked.add(filePath);
    else locked.delete(filePath);
    return {
      ...agent,
      lockedFiles: Array.from(locked),
      claimedFiles: add
        ? Array.from(new Set([...agent.claimedFiles.map(normalizePath), filePath]))
        : agent.claimedFiles,
    };
  });
}

export function createEmptyCoordinationSnapshot(
  projectRoot: string,
  now: string,
): AgentCoordinationSnapshot {
  return {
    version: 1,
    projectRoot,
    generatedAt: now,
    agents: [],
    locks: [],
    events: [],
  };
}

export function applyCoordinationEvent(
  snapshot: AgentCoordinationSnapshot,
  event: AgentCoordinationEvent,
): AgentCoordinationSnapshot {
  let agents = snapshot.agents;
  const timestamp = event.timestamp;
  if (event.type === 'agent_registered' || event.type === 'heartbeat') {
    const existing = snapshot.agents.find((agent) => agent.terminalId === event.terminalId);
    agents = upsertAgent(snapshot, {
      id: existing?.id ?? `agent_${event.terminalId}`,
      terminalId: event.terminalId,
      paneId: event.paneId ?? existing?.paneId ?? null,
      agentName: event.agentName,
      agentSlug: event.agentSlug ?? existing?.agentSlug ?? null,
      provider: event.provider ?? existing?.provider ?? 'custom',
      mode: event.mode ?? existing?.mode ?? 'coordinated',
      task: existing?.task,
      status: event.type === 'heartbeat' ? existing?.status ?? 'idle' : 'idle',
      claimedFiles: existing?.claimedFiles ?? [],
      lockedFiles: existing?.lockedFiles ?? [],
      lastHeartbeatAt: timestamp,
      lastActionSummary: sanitizeSummary(event.summary),
    });
  }
  return {
    ...snapshot,
    generatedAt: timestamp,
    agents,
    events: appendEvent(snapshot, event),
  };
}

export function acquireFileLock(
  snapshot: AgentCoordinationSnapshot,
  request: FileLockRequest,
): { ok: true; snapshot: AgentCoordinationSnapshot; lock: AgentFileLock } | {
  ok: false;
  snapshot: AgentCoordinationSnapshot;
  conflict: AgentFileLock;
} {
  const filePath = normalizePath(request.filePath);
  const conflict = snapshot.locks.find((lock) => (
    normalizePath(lock.filePath) === filePath &&
    lock.status === 'active' &&
    lock.lockedByTerminalId !== request.terminalId
  ));
  if (conflict) return { ok: false, snapshot, conflict };

  const existingIndex = snapshot.locks.findIndex((lock) => (
    normalizePath(lock.filePath) === filePath &&
    lock.lockedByTerminalId === request.terminalId &&
    lock.status === 'active'
  ));
  const lock: AgentFileLock = {
    filePath,
    lockedByTerminalId: request.terminalId,
    lockedByAgentName: request.agentName,
    reason: request.reason,
    lockedAt: request.now,
    expiresAt: request.expiresAt,
    status: 'active',
  };
  const locks = existingIndex >= 0
    ? snapshot.locks.map((current, index) => (index === existingIndex ? lock : current))
    : [...snapshot.locks, lock];
  const agents = withAgentLockFile(snapshot.agents, request.terminalId, filePath, true);
  const next: AgentCoordinationSnapshot = {
    ...snapshot,
    generatedAt: request.now,
    locks,
    agents,
    events: appendEvent(snapshot, {
      id: eventId('file_locked', request.now, request.terminalId),
      timestamp: request.now,
      terminalId: request.terminalId,
      agentName: request.agentName,
      type: 'file_locked',
      filePath,
      summary: request.reason ?? `Locked ${filePath}`,
    }),
  };
  return { ok: true, snapshot: next, lock };
}

export function releaseFileLock(
  snapshot: AgentCoordinationSnapshot,
  request: ReleaseFileLockRequest,
): { ok: true; snapshot: AgentCoordinationSnapshot; lock: AgentFileLock } | {
  ok: false;
  snapshot: AgentCoordinationSnapshot;
  conflict?: AgentFileLock;
} {
  const filePath = normalizePath(request.filePath);
  const lock = snapshot.locks.find((current) => (
    normalizePath(current.filePath) === filePath &&
    current.status === 'active'
  ));
  if (!lock) return { ok: false, snapshot };
  if (lock.lockedByTerminalId !== request.terminalId) {
    return { ok: false, snapshot, conflict: lock };
  }
  const released: AgentFileLock = { ...lock, status: 'released' };
  return {
    ok: true,
    lock: released,
    snapshot: {
      ...snapshot,
      generatedAt: request.now,
      locks: snapshot.locks.map((current) => (current === lock ? released : current)),
      agents: withAgentLockFile(snapshot.agents, request.terminalId, filePath, false),
      events: appendEvent(snapshot, {
        id: eventId('file_unlocked', request.now, request.terminalId),
        timestamp: request.now,
        terminalId: request.terminalId,
        agentName: lock.lockedByAgentName,
        type: 'file_unlocked',
        filePath,
        summary: `Released ${filePath}`,
      }),
    },
  };
}

export function markStaleCoordinationLocks(
  snapshot: AgentCoordinationSnapshot,
  opts: { now: string; heartbeatTtlMs: number },
): AgentCoordinationSnapshot {
  const nowMs = Date.parse(opts.now);
  const staleOwners = new Set(
    snapshot.agents
      .filter((agent) => nowMs - Date.parse(agent.lastHeartbeatAt) > opts.heartbeatTtlMs)
      .map((agent) => agent.terminalId),
  );
  if (staleOwners.size === 0) return snapshot;
  return {
    ...snapshot,
    generatedAt: opts.now,
    agents: snapshot.agents.map((agent) => (
      staleOwners.has(agent.terminalId) ? { ...agent, status: 'blocked' } : agent
    )),
    locks: snapshot.locks.map((lock) => (
      lock.status === 'active' && staleOwners.has(lock.lockedByTerminalId)
        ? { ...lock, status: 'stale' }
        : lock
    )),
  };
}

export function summarizeCoordinationSnapshot(snapshot: AgentCoordinationSnapshot): string {
  const lines: string[] = [
    '## Coordination Summary',
    `Project root: ${snapshot.projectRoot}`,
  ];

  const activeAgents = snapshot.agents.filter((agent) => agent.mode === 'coordinated');
  lines.push('### Active agents');
  if (activeAgents.length === 0) {
    lines.push('- None registered.');
  } else {
    for (const agent of activeAgents.slice(0, 10)) {
      const locked = agent.lockedFiles.length ? `; locks: ${agent.lockedFiles.join(', ')}` : '';
      const summary = agent.lastActionSummary ? `; ${sanitizeSummary(agent.lastActionSummary)}` : '';
      lines.push(`- ${agent.agentName} (${agent.provider}, ${agent.status}, terminal ${agent.terminalId})${locked}${summary}`);
    }
  }

  lines.push('### File locks');
  const locks = snapshot.locks.filter((lock) => lock.status !== 'released');
  if (locks.length === 0) {
    lines.push('- No active or stale locks.');
  } else {
    for (const lock of locks.slice(0, 20)) {
      const reason = lock.reason ? ` — ${sanitizeSummary(lock.reason, 120)}` : '';
      lines.push(`- ${lock.filePath}: ${lock.status} by ${lock.lockedByAgentName} (${lock.lockedByTerminalId})${reason}`);
    }
  }

  lines.push('### Recent coordination events');
  if (snapshot.events.length === 0) {
    lines.push('- No recent events.');
  } else {
    for (const event of snapshot.events.slice(-8)) {
      const file = event.filePath ? ` ${event.filePath}` : '';
      lines.push(`- ${event.timestamp} ${event.type}${file}: ${sanitizeSummary(event.summary, 160)}`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}
