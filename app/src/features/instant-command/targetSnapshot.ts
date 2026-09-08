import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '@/stores/auth';
import { flattenLeaves, type PaneNode } from '@/features/terminals/paneTree';
import { getLiveTree } from '@/features/terminals/terminalLiveCache';
import { loadTerminalTreeForProject } from '@/features/terminals/terminalProjectMove';
import {
  useTerminalTranscriptStore,
  type SessionTranscript,
} from '@/features/terminals/transcriptStore';
import { canonicalProviderAlias } from './parse';
import type { LiveTerminalTarget } from './types';
import type { BackendTerminalInfo } from '@/features/terminals/restoreSession';

export type NativeTerminalIdentity = BackendTerminalInfo;

const MAX_NATIVE_SESSIONS = 1_024;
const MAX_TRANSCRIPTS = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_COMMAND_LENGTH = 32_768;

// Launch scripts are command metadata, not session identifiers. Generated PowerShell
// launchers legitimately exceed 256 characters and may contain line breaks.
function validCommandMetadata(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= MAX_COMMAND_LENGTH &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function stableNativeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validNativeIdentity(session: unknown): session is NativeTerminalIdentity {
  if (!session || typeof session !== 'object') return false;
  const candidate = session as NativeTerminalIdentity;
  return (
    stableNativeIdentifier(candidate.sessionId) &&
    stableNativeIdentifier(candidate.processInstanceId) &&
    stableNativeIdentifier(candidate.runtimeGeneration) &&
    (candidate.projectId == null || stableNativeIdentifier(candidate.projectId)) &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    Number.isSafeInteger(candidate.processStartedAt) &&
    candidate.processStartedAt > 0
  );
}

function validTranscript(value: unknown): value is SessionTranscript {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as SessionTranscript;
  return (
    stableNativeIdentifier(transcript.sessionId) &&
    stableNativeIdentifier(transcript.paneId) &&
    (transcript.projectId == null || stableNativeIdentifier(transcript.projectId)) &&
    (transcript.command == null || validCommandMetadata(transcript.command)) &&
    (transcript.agentSlug == null || stableNativeIdentifier(transcript.agentSlug))
  );
}

function emptySnapshot(): LiveTerminalTarget[] {
  return Object.freeze([]) as unknown as LiveTerminalTarget[];
}

export type LiveTargetSnapshotInput = Readonly<{
  projectId: string | null;
  tree: PaneNode;
  transcripts: Readonly<Record<string, SessionTranscript>>;
  nativeSessions: readonly NativeTerminalIdentity[];
}>;

function oneTranscriptForPane(
  paneId: string,
  projectId: string | null,
  transcripts: Readonly<Record<string, SessionTranscript>>,
): SessionTranscript | undefined {
  const matches = Object.values(transcripts).filter(
    (item) => item.paneId === paneId && (item.projectId ?? null) === projectId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildLiveTargetSnapshot(input: LiveTargetSnapshotInput): LiveTerminalTarget[] {
  if (
    (input.projectId !== null && !stableNativeIdentifier(input.projectId)) ||
    !Array.isArray(input.nativeSessions) ||
    input.nativeSessions.length > MAX_NATIVE_SESSIONS ||
    !input.nativeSessions.every(validNativeIdentity) ||
    !input.transcripts ||
    typeof input.transcripts !== 'object' ||
    Array.isArray(input.transcripts)
  ) {
    return emptySnapshot();
  }
  const transcriptValues = Object.values(input.transcripts);
  if (transcriptValues.length > MAX_TRANSCRIPTS || !transcriptValues.every(validTranscript)) {
    return emptySnapshot();
  }
  const nativeCounts = new Map<string, number>();
  for (const session of input.nativeSessions) {
    if (!validNativeIdentity(session)) continue;
    nativeCounts.set(session.sessionId, (nativeCounts.get(session.sessionId) ?? 0) + 1);
  }
  const nativeBySession = new Map<string, NativeTerminalIdentity>();
  for (const session of input.nativeSessions) {
    if (
      validNativeIdentity(session) &&
      nativeCounts.get(session.sessionId) === 1 &&
      (session.projectId ?? null) === input.projectId
    ) {
      nativeBySession.set(session.sessionId, session);
    }
  }
  const candidates: LiveTerminalTarget[] = [];
  for (const [index, leaf] of flattenLeaves(input.tree).entries()) {
    if (leaf.projectId != null && leaf.projectId !== input.projectId) continue;
    const paneTranscript = oneTranscriptForPane(leaf.id, input.projectId, input.transcripts);
    if (!leaf.sessionId && !paneTranscript) continue;
    if (
      !leaf.sessionId &&
      Object.values(input.transcripts).filter(
        (item) => item.paneId === leaf.id && (item.projectId ?? null) === input.projectId,
      ).length !== 1
    )
      continue;
    const sessionId = leaf.sessionId ?? paneTranscript?.sessionId;
    if (!sessionId) continue;
    const nativeSession = nativeBySession.get(sessionId);
    if (!nativeSession) continue;
    const transcript = input.transcripts[sessionId] ?? paneTranscript;
    if (transcript && transcript.paneId && transcript.paneId !== leaf.id) continue;
    if (transcript?.projectId != null && transcript.projectId !== input.projectId) continue;
    const command = leaf.startupCommand ?? leaf.command ?? transcript?.command ?? undefined;
    const agentSlug = leaf.agentSlug ?? transcript?.agentSlug ?? undefined;
    const label = leaf.name ?? agentSlug ?? command;
    const provider =
      canonicalProviderAlias(command) ??
      canonicalProviderAlias(agentSlug ?? undefined) ??
      canonicalProviderAlias(label);
    candidates.push(
      Object.freeze({
        sessionId,
        paneId: leaf.id,
        projectId: input.projectId,
        ordinal: index + 1,
        ...(label ? { label } : {}),
        ...(agentSlug ? { agentSlug } : {}),
        ...(provider ? { provider } : {}),
        ...(command ? { command } : {}),
        processIdentity: Object.freeze({
          projectId: nativeSession.projectId ?? null,
          processInstanceId: nativeSession.processInstanceId,
          pid: nativeSession.pid,
          processStartedAt: nativeSession.processStartedAt,
          runtimeGeneration: nativeSession.runtimeGeneration,
        }),
      }),
    );
  }
  const sessionCounts = new Map<string, number>();
  const paneCounts = new Map<string, number>();
  for (const target of candidates) {
    sessionCounts.set(target.sessionId, (sessionCounts.get(target.sessionId) ?? 0) + 1);
    paneCounts.set(target.paneId, (paneCounts.get(target.paneId) ?? 0) + 1);
  }
  return Object.freeze(
    candidates.filter(
      (target) => sessionCounts.get(target.sessionId) === 1 && paneCounts.get(target.paneId) === 1,
    ),
  ) as unknown as LiveTerminalTarget[];
}

export type ReadLiveTargetSnapshotDependencies = Readonly<{
  listNativeSessions?: () => Promise<readonly NativeTerminalIdentity[]>;
}>;

export async function readLiveTargetSnapshot(
  dependencies: ReadLiveTargetSnapshotDependencies = {},
): Promise<LiveTerminalTarget[]> {
  const projectId = useAuthStore.getState().projectId ?? null;
  const tree = getLiveTree(projectId) ?? loadTerminalTreeForProject(projectId);
  try {
    const nativeSessions = await (
      dependencies.listNativeSessions ?? (() => invoke<NativeTerminalIdentity[]>('terminal_list'))
    )();
    return buildLiveTargetSnapshot({
      projectId,
      tree,
      transcripts: useTerminalTranscriptStore.getState().sessions,
      nativeSessions,
    });
  } catch {
    return [];
  }
}
