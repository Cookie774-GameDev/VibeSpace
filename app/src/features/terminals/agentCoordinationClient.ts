import { invoke } from '@tauri-apps/api/core';
import {
  applyCoordinationEvent,
  createEmptyCoordinationSnapshot,
  summarizeCoordinationSnapshot,
  type AgentCoordinationMode,
  type AgentCoordinationSnapshot,
  type AgentProvider,
} from './agentCoordination';

interface NativeCoordinationFiles {
  coordinationDir: string;
  stateJson?: string | null;
  locksJson?: string | null;
  eventsText?: string | null;
}

interface CoordinationTerminalInput {
  cwd: string | null | undefined;
  mode: AgentCoordinationMode;
  terminalId: string;
  paneId?: string | null;
  agentSlug?: string | null;
  agentName: string;
  provider: AgentProvider;
  now?: string;
  status?: 'idle' | 'working';
  summary?: string;
}

/**
 * Identity supplied by the host only after it verifies the live native terminal
 * process and its authenticated account/workspace/project scope.
 */
export interface TerminalRelayParticipantIdentity {
  accountId: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  terminalId: string;
  processInstanceId: string;
  runtimeGeneration: string;
  provider: AgentProvider;
  agentName: string;
}

export interface TerminalRelayParticipantDescriptor extends TerminalRelayParticipantIdentity {
  readonly surface: 'terminal';
  /** Stable only for this process generation and account/workspace/project scope. */
  readonly participantKey: string;
}

export type TerminalRelayParticipationResult =
  | { ok: true; participantKey: string; deduplicated: boolean }
  | { ok: false; reason: 'invalid_identity' | 'register_failed' | 'unregister_failed' };

export interface TerminalRelayParticipationCallbacks {
  register(participant: TerminalRelayParticipantDescriptor): void | Promise<void>;
  unregister(participant: TerminalRelayParticipantDescriptor): void | Promise<void>;
}

interface CoordinationWriteResult {
  ok: boolean;
  skipped?: boolean;
  summary?: string;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

const RELAY_ID_MAX_LENGTH = 256;
const RELAY_NAME_MAX_LENGTH = 120;
const VALID_AGENT_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'custom',
];

function isValidRelayIdentityPart(
  value: unknown,
  maxLength = RELAY_ID_MAX_LENGTH,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Builds a process-bound Relay identity from host-verified terminal metadata.
 * It performs no native reads or writes; callers must verify the supplied tuple.
 */
export function createTerminalRelayParticipantDescriptor(
  input: TerminalRelayParticipantIdentity | null | undefined,
): TerminalRelayParticipantDescriptor | null {
  if (
    !input ||
    !isValidRelayIdentityPart(input.accountId) ||
    !isValidRelayIdentityPart(input.workspaceId) ||
    !isValidRelayIdentityPart(input.projectId) ||
    !isValidRelayIdentityPart(input.sessionId) ||
    !isValidRelayIdentityPart(input.terminalId) ||
    !isValidRelayIdentityPart(input.processInstanceId) ||
    !isValidRelayIdentityPart(input.runtimeGeneration) ||
    !isValidRelayIdentityPart(input.agentName, RELAY_NAME_MAX_LENGTH) ||
    !VALID_AGENT_PROVIDERS.includes(input.provider)
  ) {
    return null;
  }

  const participantKey = JSON.stringify([
    'terminal',
    input.accountId,
    input.workspaceId,
    input.projectId,
    input.sessionId,
    input.terminalId,
    input.processInstanceId,
    input.runtimeGeneration,
  ]);
  return Object.freeze({
    ...input,
    surface: 'terminal',
    participantKey,
  });
}

/**
 * A small callback adapter for host-owned enrollment. Registration is
 * idempotent per verified process tuple and callback failures remain retryable.
 */
export function createTerminalRelayParticipationAdapter(
  callbacks: TerminalRelayParticipationCallbacks,
) {
  const registered = new Map<string, TerminalRelayParticipantDescriptor>();
  const registering = new Map<string, Promise<TerminalRelayParticipationResult>>();
  const unregistering = new Map<string, Promise<TerminalRelayParticipationResult>>();

  return {
    async register(
      input: TerminalRelayParticipantIdentity | null | undefined,
    ): Promise<TerminalRelayParticipationResult> {
      const participant = createTerminalRelayParticipantDescriptor(input);
      if (!participant) return { ok: false, reason: 'invalid_identity' };
      const { participantKey } = participant;

      const pendingUnregister = unregistering.get(participantKey);
      if (pendingUnregister) {
        const removed = await pendingUnregister;
        if (!removed.ok) return removed;
      }
      if (registered.has(participantKey)) {
        return { ok: true, participantKey, deduplicated: true };
      }
      const pendingRegister = registering.get(participantKey);
      if (pendingRegister) {
        const result = await pendingRegister;
        return result.ok ? { ...result, deduplicated: true } : result;
      }

      const operation = (async (): Promise<TerminalRelayParticipationResult> => {
        try {
          await callbacks.register(participant);
          registered.set(participantKey, participant);
          return { ok: true, participantKey, deduplicated: false };
        } catch {
          return { ok: false, reason: 'register_failed' };
        }
      })();
      registering.set(participantKey, operation);
      try {
        return await operation;
      } finally {
        if (registering.get(participantKey) === operation) registering.delete(participantKey);
      }
    },

    async unregister(participantKey: string): Promise<TerminalRelayParticipationResult> {
      if (!isValidRelayIdentityPart(participantKey, 4096)) {
        return { ok: false, reason: 'invalid_identity' };
      }
      const pendingRegister = registering.get(participantKey);
      if (pendingRegister) {
        const added = await pendingRegister;
        if (!added.ok) return { ok: true, participantKey, deduplicated: true };
      }

      const pendingUnregister = unregistering.get(participantKey);
      if (pendingUnregister) {
        const result = await pendingUnregister;
        return result.ok ? { ...result, deduplicated: true } : result;
      }
      const participant = registered.get(participantKey);
      if (!participant) return { ok: true, participantKey, deduplicated: true };

      const operation = (async (): Promise<TerminalRelayParticipationResult> => {
        try {
          await callbacks.unregister(participant);
          registered.delete(participantKey);
          return { ok: true, participantKey, deduplicated: false };
        } catch {
          return { ok: false, reason: 'unregister_failed' };
        }
      })();
      unregistering.set(participantKey, operation);
      try {
        return await operation;
      } finally {
        if (unregistering.get(participantKey) === operation) unregistering.delete(participantKey);
      }
    },
  };
}

function parseSnapshot(
  projectRoot: string,
  files: NativeCoordinationFiles,
  now: string,
): AgentCoordinationSnapshot {
  if (files.stateJson?.trim()) {
    try {
      const parsed = JSON.parse(files.stateJson) as AgentCoordinationSnapshot;
      if (
        parsed &&
        parsed.version === 1 &&
        Array.isArray(parsed.agents) &&
        Array.isArray(parsed.locks)
      ) {
        return parsed;
      }
    } catch {
      /* fall through to clean snapshot */
    }
  }
  return createEmptyCoordinationSnapshot(projectRoot, now);
}

async function readNativeSnapshot(
  projectRoot: string,
  now: string,
): Promise<AgentCoordinationSnapshot> {
  const files = await invoke<NativeCoordinationFiles>('agent_coordination_snapshot', {
    projectRoot,
  });
  return parseSnapshot(projectRoot, files, now);
}

function eventBase(input: CoordinationTerminalInput, timestamp: string) {
  return {
    timestamp,
    terminalId: input.terminalId,
    paneId: input.paneId ?? null,
    agentName: input.agentName,
    agentSlug: input.agentSlug ?? null,
    provider: input.provider,
    mode: input.mode,
  };
}

export function inferAgentProvider(command?: string | null): AgentProvider {
  const normalized = (command ?? '').toLowerCase();
  if (/\bclaude\b/.test(normalized)) return 'claude';
  if (/\bcodex\b/.test(normalized)) return 'codex';
  if (/\bgemini\b/.test(normalized)) return 'gemini';
  if (/\b(opencode|open-code|open code)\b/.test(normalized)) return 'opencode';
  return 'custom';
}

export async function registerCoordinatedTerminal(
  input: CoordinationTerminalInput,
): Promise<CoordinationWriteResult> {
  if (input.mode !== 'coordinated' || !input.cwd) return { ok: true, skipped: true };
  const timestamp = input.now ?? nowIso();
  try {
    const snapshot = await readNativeSnapshot(input.cwd, timestamp);
    const event = {
      id: `agent_registered_${timestamp.replace(/[^0-9]/g, '')}_${input.terminalId}`,
      ...eventBase(input, timestamp),
      type: 'agent_registered' as const,
      summary: input.summary ?? `${input.agentName} joined coordinated terminal mode.`,
    };
    const next = applyCoordinationEvent(snapshot, event);
    await invoke('agent_coordination_register', {
      projectRoot: input.cwd,
      stateJson: JSON.stringify(next),
      eventJson: JSON.stringify(event),
    });
    return { ok: true, summary: summarizeCoordinationSnapshot(next) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function heartbeatCoordinatedTerminal(
  input: CoordinationTerminalInput,
): Promise<CoordinationWriteResult> {
  if (input.mode !== 'coordinated' || !input.cwd) return { ok: true, skipped: true };
  const timestamp = input.now ?? nowIso();
  try {
    const snapshot = await readNativeSnapshot(input.cwd, timestamp);
    const event = {
      id: `heartbeat_${timestamp.replace(/[^0-9]/g, '')}_${input.terminalId}`,
      ...eventBase(input, timestamp),
      type: 'heartbeat' as const,
      summary: input.summary ?? `${input.agentName} heartbeat.`,
    };
    const next = applyCoordinationEvent(snapshot, event);
    await invoke('agent_coordination_heartbeat', {
      projectRoot: input.cwd,
      stateJson: JSON.stringify(next),
      eventJson: JSON.stringify(event),
    });
    return { ok: true, summary: summarizeCoordinationSnapshot(next) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loadCoordinationSummary(cwd: string | null | undefined): Promise<string> {
  if (!cwd) return '';
  const timestamp = nowIso();
  try {
    const snapshot = await readNativeSnapshot(cwd, timestamp);
    return summarizeCoordinationSnapshot(snapshot);
  } catch {
    return '';
  }
}
