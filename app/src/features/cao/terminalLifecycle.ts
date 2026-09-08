import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';

type Replacement = ExpectedTerminalProcessBinding & { sessionId: string };
export interface CaoTerminalLifecycleTarget {
  sessionId: string;
  command: string;
  cwd: string;
  projectId: string;
  binding: ExpectedTerminalProcessBinding;
}
export async function runCaoTerminalLifecycle(
  action: 'restart' | 'cancel',
  target: CaoTerminalLifecycleTarget,
  ports: {
    authorize(): Promise<void>;
    kill(sessionId: string, binding: ExpectedTerminalProcessBinding): Promise<{ kind: string }>;
    list(): Promise<readonly { sessionId: string }[]>;
    spawn(input: {
      command: string;
      cwd: string;
      projectId: string;
      rows: number;
      cols: number;
      preserveExisting: true;
    }): Promise<Replacement>;
    attach(sessionId: string): void;
    record(value: {
      status: 'dispatching' | 'stopped' | 'restarted' | 'unconfirmed';
      stopped: boolean;
      replacement?: Replacement;
      stage?: string;
      errorCode?: string;
    }): Promise<void>;
    wait(): Promise<void>;
  },
  signal: AbortSignal,
) {
  if (!/(?:^|[\\/])opencode(?:\.exe)?$/i.test(target.command))
    throw Error('cao_terminal_direct_agent_required');
  let stopped = false;
  let replacement: Replacement | undefined;
  let attached = false;
  let stage = 'stopping';
  const authorize = async () => {
    signal.throwIfAborted();
    await ports.authorize();
    signal.throwIfAborted();
  };
  await authorize();
  await ports.record({ status: 'dispatching', stopped });
  try {
    signal.throwIfAborted();
    const result = await ports.kill(target.sessionId, target.binding);
    if (result.kind === 'delivery_rejected') throw Error('cao_terminal_stop_rejected');
    stage = 'observing-exit';
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted();
      if (!(await ports.list()).some((row) => row.sessionId === target.sessionId)) {
        stopped = true;
        break;
      }
      await ports.wait();
    }
    if (!stopped) throw Error('cao_terminal_stop_unconfirmed');
    if (action === 'cancel') {
      await ports.record({ status: 'stopped', stopped });
      return { status: 'stopped' as const };
    }
    await authorize();
    stage = 'starting';
    replacement = await ports.spawn({
      command: target.command,
      cwd: target.cwd,
      projectId: target.projectId,
      rows: 30,
      cols: 100,
      preserveExisting: true,
    });
    await authorize();
    stage = 'attaching';
    if (!(await ports.list()).some((row) => row.sessionId === replacement!.sessionId))
      throw Error('cao_terminal_restart_unconfirmed');
    ports.attach(replacement.sessionId);
    attached = true;
    await ports.record({ status: 'restarted', stopped, replacement });
    return { status: 'restarted' as const, replacement };
  } catch (error) {
    // A changed pane or revoked scope must not leave an unattached child behind.
    if (replacement && !attached)
      await ports.kill(replacement.sessionId, replacement).catch(() => undefined);
    const errorCode = error instanceof Error && /^cao_terminal_[a-z_]+$/.test(error.message)
      ? error.message : 'cao_terminal_native_operation_failed';
    await ports.record({ status: 'unconfirmed', stopped, replacement, stage, errorCode });
    throw error;
  }
}
