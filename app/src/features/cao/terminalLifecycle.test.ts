import { expect, it, vi } from 'vitest';
import { runCaoTerminalLifecycle } from './terminalLifecycle';
const target = {
  sessionId: 'old',
  command: 'C:\\tools\\opencode.exe',
  cwd: 'C:\\game',
  projectId: 'project',
  binding: {
    projectId: 'project',
    pid: 1,
    processStartedAt: 10,
    processInstanceId: 'one',
    runtimeGeneration: 'runtime',
  },
};
function ports() {
  let live = [{ sessionId: 'old' }];
  return {
    authorize: vi.fn(async () => {}),
    kill: vi.fn(async () => {
      live = [];
      return { kind: 'signal_delivered' };
    }),
    list: vi.fn(async () => live),
    spawn: vi.fn(async () => {
      live = [{ sessionId: 'new' }];
      return {
        sessionId: 'new',
        projectId: 'project',
        pid: 2,
        processStartedAt: 20,
        processInstanceId: 'two',
        runtimeGeneration: 'runtime',
      };
    }),
    attach: vi.fn(),
    record: vi.fn(async () => {}),
    wait: async () => {},
  };
}
it('observes exact stop before starting and attaching one replacement, without replaying a prompt', async () => {
  const p = ports();
  const result = await runCaoTerminalLifecycle('restart', target, p, new AbortController().signal);
  expect(result.status).toBe('restarted');
  expect(p.kill).toHaveBeenCalledWith('old', target.binding);
  expect(p.spawn).toHaveBeenCalledExactlyOnceWith({
    command: target.command,
    cwd: target.cwd,
    projectId: 'project',
    rows: 30,
    cols: 100,
    preserveExisting: true,
  });
  expect(p.attach).toHaveBeenCalledOnce();
  expect(p.authorize).toHaveBeenCalledTimes(3);
});
it('does not launch a replacement if access is revoked after stopping', async () => {
  const p = ports();
  p.authorize.mockResolvedValueOnce(undefined).mockRejectedValue(Error('revoked'));
  await expect(
    runCaoTerminalLifecycle('restart', target, p, new AbortController().signal),
  ).rejects.toThrow('revoked');
  expect(p.spawn).not.toHaveBeenCalled();
  expect(p.record).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'unconfirmed', stopped: true }),
  );
});
it('does not equate signal delivery with observed process exit', async () => {
  const p = ports();
  p.list.mockResolvedValue([{ sessionId: 'old' }]);
  await expect(
    runCaoTerminalLifecycle('cancel', target, p, new AbortController().signal),
  ).rejects.toThrow('cao_terminal_stop_unconfirmed');
  expect(p.spawn).not.toHaveBeenCalled();
});
it('cleans only the exact new child if attaching its pane fails', async () => {
  const p = ports();
  p.attach.mockImplementation(() => {
    throw Error('pane changed');
  });
  await expect(
    runCaoTerminalLifecycle('restart', target, p, new AbortController().signal),
  ).rejects.toThrow('pane changed');
  expect(p.kill).toHaveBeenLastCalledWith(
    'new',
    expect.objectContaining({ processInstanceId: 'two', pid: 2 }),
  );
});

it('retains a bounded failure stage when native signal delivery is rejected', async () => {
  const p = ports();
  p.kill.mockResolvedValue({ kind: 'delivery_rejected' });
  await expect(runCaoTerminalLifecycle('restart', target, p, new AbortController().signal))
    .rejects.toThrow('cao_terminal_stop_rejected');
  expect(p.record).toHaveBeenLastCalledWith(expect.objectContaining({
    status: 'unconfirmed', stopped: false, stage: 'stopping', errorCode: 'cao_terminal_stop_rejected',
  }));
});
