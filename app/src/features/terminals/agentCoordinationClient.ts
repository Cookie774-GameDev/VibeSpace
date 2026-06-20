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

interface CoordinationWriteResult {
  ok: boolean;
  skipped?: boolean;
  summary?: string;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSnapshot(projectRoot: string, files: NativeCoordinationFiles, now: string): AgentCoordinationSnapshot {
  if (files.stateJson?.trim()) {
    try {
      const parsed = JSON.parse(files.stateJson) as AgentCoordinationSnapshot;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.agents) && Array.isArray(parsed.locks)) {
        return parsed;
      }
    } catch {
      /* fall through to clean snapshot */
    }
  }
  return createEmptyCoordinationSnapshot(projectRoot, now);
}

async function readNativeSnapshot(projectRoot: string, now: string): Promise<AgentCoordinationSnapshot> {
  const files = await invoke<NativeCoordinationFiles>('agent_coordination_snapshot', { projectRoot });
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

export async function registerCoordinatedTerminal(input: CoordinationTerminalInput): Promise<CoordinationWriteResult> {
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

export async function heartbeatCoordinatedTerminal(input: CoordinationTerminalInput): Promise<CoordinationWriteResult> {
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
