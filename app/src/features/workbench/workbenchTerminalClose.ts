type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type NativeTerminalSession = Readonly<{
  sessionId: string;
  projectId?: string | null;
  processInstanceId: string;
  pid: number;
  processStartedAt: number;
  runtimeGeneration: string;
}>;

async function listTerminalSessions(
  invokeCommand: InvokeCommand,
): Promise<NativeTerminalSession[]> {
  const sessions = await invokeCommand('terminal_list');
  if (!Array.isArray(sessions)) throw new Error('Terminal session list is unavailable.');
  return sessions as NativeTerminalSession[];
}

/** Explicit Workbench close: never lose the only panel for a live PTY. */
export async function closeWorkbenchTerminalSession(
  sessionId: string,
  projectId: string | null,
  invokeCommand: InvokeCommand,
): Promise<'absent' | 'stopped'> {
  if (!sessionId) throw new Error('Terminal session identity is missing.');
  const before = await listTerminalSessions(invokeCommand);
  const matches = before.filter((session) => session?.sessionId === sessionId);
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) throw new Error('Terminal session identity is ambiguous.');
  const session = matches[0];
  if ((session.projectId ?? null) !== projectId) {
    throw new Error('Terminal session belongs to a different project.');
  }
  if (
    !session.processInstanceId ||
    !Number.isFinite(session.pid) ||
    session.pid <= 0 ||
    !Number.isFinite(session.processStartedAt) ||
    session.processStartedAt <= 0 ||
    !session.runtimeGeneration
  ) {
    throw new Error('Terminal process binding is incomplete.');
  }

  const result = (await invokeCommand('terminal_kill', {
    sessionId,
    expectedBinding: {
      projectId,
      processInstanceId: session.processInstanceId,
      pid: session.pid,
      processStartedAt: session.processStartedAt,
      runtimeGeneration: session.runtimeGeneration,
    },
  })) as { kind?: string } | null;
  if (!result || !['signal_delivered', 'already_exited', 'missing'].includes(result.kind ?? '')) {
    throw new Error('Terminal did not accept the stop request.');
  }
  const after = await listTerminalSessions(invokeCommand);
  if (after.some((candidate) => candidate?.sessionId === sessionId)) {
    throw new Error('Terminal is still active after the stop request.');
  }
  return 'stopped';
}
