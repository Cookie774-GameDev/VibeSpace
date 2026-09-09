import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export function recoveryDelay(failures) {
  return Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
}

export async function supervise(
  stateDir,
  {
    spawnProcess = spawn,
    alive = (pid) => process.kill(pid, 0),
    now = Date.now,
    schedule = setInterval,
    unschedule = clearInterval,
  } = {},
) {
  const base = path.dirname(fileURLToPath(import.meta.url));
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, 'supervisor.lock');
  const acquire = () => open(file, 'wx', 0o600);
  const lock = await acquire().catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    const raw = await readFile(file, 'utf8');
    const prior = JSON.parse(raw);
    if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw Error('Invalid supervisor lock.');
    try {
      alive(prior.pid);
      return null;
    } catch (cause) {
      if (cause.code !== 'ESRCH') throw cause;
    }
    if ((await readFile(file, 'utf8')) !== raw) return null;
    await unlink(file);
    return acquire();
  });
  if (!lock) return;
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  let child,
    busy = false,
    stopping = false,
    failures = 0,
    retryAt = 0;
  const tick = async () => {
    if (stopping || busy || child || now() < retryAt) return;
    busy = true;
    try {
      // Do not compete with a gateway already owned by another launch.
      try {
        const prior = JSON.parse(await readFile(path.join(stateDir, 'gateway.lock'), 'utf8'));
        if (Number.isSafeInteger(prior.pid) && prior.pid > 0) {
          alive(prior.pid);
          return;
        }
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
      if (stopping) return;
      const started = now();
      const launched = spawnProcess(process.execPath, [path.join(base, 'gateway.mjs')], {
        cwd: base,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          VIBESPACE_CONNECTOR_PORT: '0',
          VIBESPACE_CONNECTOR_STATE_DIR: stateDir,
        },
      });
      child = launched;
      const exited = () => {
        if (child !== launched) return;
        child = undefined;
        if (now() - started > 60000) failures = 0;
        retryAt = now() + recoveryDelay(failures++);
      };
      launched.once('error', exited);
      launched.once('exit', exited);
    } catch {
      retryAt = now() + recoveryDelay(failures++);
    } finally {
      busy = false;
    }
  };
  const timer = schedule(() => {
    void tick();
  }, 1000);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    unschedule(timer);
    // Closing VibeSpace does not signal this detached process; explicit shutdown stops only its child.
    const owned = child;
    if (owned?.connected) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          owned.kill();
          resolve();
        }, 10000);
        owned.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        owned.send('shutdown', (error) => {
          if (error) owned.kill();
        });
      });
    } else owned?.kill();
    await lock.close();
    await unlink(file).catch(() => {});
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  await tick();
  return { tick, stop };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await supervise(
    path.resolve(process.argv[2] || process.env.VIBESPACE_CONNECTOR_STATE_DIR || 'state'),
  );
}
