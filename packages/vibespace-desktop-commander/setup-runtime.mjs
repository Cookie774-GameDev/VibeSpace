import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_DISPLAY_NAME = 'VibeSpace Desktop';
export function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw Error('Use an app name between 1 and 64 characters.');
  const name = value.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
    throw Error('Use an app name between 1 and 64 characters.');
  return name;
}

export function protectKey(value, decrypt = false) {
  if (process.platform !== 'win32')
    throw Error('Protected credential storage is currently supported on Windows.');
  return new Promise((resolve, reject) => {
    // Avoid inherited PowerShell module paths; use Windows DPAPI through .NET directly.
    const script =
      "$null=[Reflection.Assembly]::LoadWithPartialName('System.Security'); " +
      (decrypt
        ? '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
        : '$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    });
    let result = '';
    child.stdout.on('data', (chunk) => {
      if (result.length < 65536) result += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('Protected storage timed out.'));
    }, 10000);
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('Windows could not protect the runtime key.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 && result
        ? resolve(result.trim())
        : reject(Error('Windows could not unlock the saved runtime key.'));
    });
    child.stdin.end(value);
  });
}

export async function createSetupRuntime({
  stateDir,
  base,
  endpoint,
  token,
  getTools,
  protect = protectKey,
  spawnProcess = spawn,
  fetchRequest = fetch,
  schedule = setInterval,
  unschedule = clearInterval,
  now = Date.now,
}) {
  const file = path.join(stateDir, 'setup.json');
  let saved = {
    version: 1,
    step: 1,
    displayName: DEFAULT_DISPLAY_NAME,
    tunnelId: '',
    protectedKey: '',
    enabled: true,
    setupComplete: false,
  };
  try {
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (prior.version === 1) {
      saved = { ...saved, ...prior };
      // A cosmetic migration must never discard credentials or the user's Off setting.
      try {
        saved.displayName = normalizeDisplayName(prior.displayName ?? DEFAULT_DISPLAY_NAME);
      } catch {
        saved.displayName = DEFAULT_DISPLAY_NAME;
      }
    }
  } catch {}
  let child,
    connecting,
    status = 'disconnected',
    error = '',
    writing = Promise.resolve();
  let closed = false,
    failures = 0,
    retryAt = 0,
    startedAt = 0,
    healthFailures = 0,
    checking = false;
  let healthProbe;
  const persist = (update) => {
    const operation = writing.then(async () => {
      const next = { ...saved, ...(typeof update === 'function' ? update(saved) : update) };
      await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(file + '.tmp', file);
      saved = next;
    });
    writing = operation.catch(() => {});
    return operation;
  };
  const healthFile = path.join(stateDir, 'tunnel-health.url');
  const currentChild = (observed) =>
    observed &&
    child === observed &&
    !closed &&
    saved.enabled !== false &&
    !observed.killed &&
    observed.exitCode == null;
  const probeReady = (observed) => {
    if (healthProbe?.child === observed) return healthProbe.promise;
    const promise = (async () => {
      const healthURL = (await readFile(healthFile, 'utf8')).trim().replace(/\/$/, '');
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(healthURL)) return false;
      const response = await fetchRequest(healthURL + '/readyz', {
        signal: AbortSignal.timeout(800),
        redirect: 'error',
      });
      return response.ok;
    })()
      .catch(() => false)
      .then((ready) => {
        // Ignore replies from a retired child; they cannot revive an Off/new connection.
        if (currentChild(observed)) {
          status = ready ? 'ready' : 'connecting';
          if (ready) {
            healthFailures = 0;
            failures = 0;
            error = '';
          }
        }
        return ready;
      })
      .finally(() => {
        if (healthProbe?.promise === promise) healthProbe = undefined;
      });
    healthProbe = { child: observed, promise };
    return promise;
  };
  const snapshot = async () => {
    const identity = { tunnelId: saved.tunnelId, protectedKey: saved.protectedKey, child };
    if (currentChild(identity.child)) await probeReady(identity.child);
    let toolCount = 0;
    try {
      toolCount = (await getTools()).tools.length;
    } catch {}
    if (status === 'ready' && toolCount > 0 && !saved.setupComplete) {
      await persist((current) =>
        current.tunnelId === identity.tunnelId &&
        current.protectedKey === identity.protectedKey &&
        child === identity.child
          ? { setupComplete: true, step: 3 }
          : {},
      );
    }
    if (status === 'ready') failures = 0;
    return {
      enabled: saved.enabled !== false,
      setupComplete: saved.setupComplete === true,
      watchdog: !closed,
      version: 1,
      step: status === 'ready' ? 3 : saved.step,
      displayName: saved.displayName,
      tunnelId: saved.tunnelId,
      hasKey: Boolean(saved.protectedKey),
      status: saved.enabled === false ? 'off' : status,
      error,
      toolCount,
      connectionDetected: true,
    };
  };
  const save = (input) => {
    const operation = writing.then(async () => {
      const displayName =
        input.displayName === undefined
          ? saved.displayName
          : normalizeDisplayName(input.displayName);
      const tunnelId = String(input.tunnelId ?? saved.tunnelId).trim();
      if (tunnelId && !/^tunnel_[a-zA-Z0-9_-]{8,128}$/.test(tunnelId))
        throw Error('Enter a valid tunnel ID.');
      const key = String(input.apiKey ?? '').trim();
      if (
        key &&
        (key.length < 20 || key.length > 4096 || /\s/.test(key) || key.startsWith('sk-admin-'))
      )
        throw Error('Use a runtime API key, not an admin key.');
      if ((child || connecting) && (tunnelId !== saved.tunnelId || key))
        throw Error('Disconnect before changing the active tunnel credentials.');
      const next = {
        ...saved,
        displayName,
        tunnelId,
        setupComplete: key || tunnelId !== saved.tunnelId ? false : saved.setupComplete,
        step: [1, 2, 3].includes(input.step) ? input.step : saved.step,
        protectedKey: key ? await protect(key) : saved.protectedKey,
      };
      await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(file + '.tmp', file);
      saved = next;
    });
    writing = operation.catch(() => {});
    return operation.then(snapshot);
  };
  const launch = async () => {
    await writing;
    if (closed || saved.enabled === false) return snapshot();
    if (child) return snapshot();
    if (!saved.tunnelId || !saved.protectedKey)
      throw Error('Save your tunnel ID and runtime API key first.');
    const key = await protect(saved.protectedKey, true);
    await unlink(healthFile).catch(() => {});
    status = 'connecting';
    error = '';
    child = spawnProcess(
      path.join(base, 'runtime', 'tunnel-client.exe'),
      [
        'run',
        '--control-plane.tunnel-id',
        saved.tunnelId,
        '--control-plane.api-key',
        'env:CONTROL_PLANE_API_KEY',
        '--mcp.server-url',
        endpoint + '/mcp',
        '--mcp.extra-headers',
        'Authorization: env:VIBESPACE_MCP_AUTH',
        '--health.listen-addr',
        '127.0.0.1:0',
        '--health.url-file',
        healthFile,
      ],
      {
        cwd: base,
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
        env: { ...process.env, CONTROL_PLANE_API_KEY: key, VIBESPACE_MCP_AUTH: 'Bearer ' + token },
      },
    );
    const launched = child;
    startedAt = now();
    healthFailures = 0;
    const failed = () => {
      if (child === launched) {
        child = undefined;
        retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        status = 'error';
        error = 'The tunnel stopped. Check the runtime key and tunnel permissions, then retry.';
      }
    };
    child.once('error', failed);
    child.once('exit', failed);
    return snapshot();
  };
  const reconnect = () => {
    if (!connecting)
      connecting = launch().finally(() => {
        connecting = undefined;
      });
    return connecting;
  };
  const stop = async () => {
    await connecting?.catch(() => {});
    const old = child;
    child = undefined;
    if (old && old.exitCode == null && !old.killed) {
      if (process.platform === 'win32' && Number.isSafeInteger(old.pid)) {
        // Only the process tree launched by this controller, including its cloudflared child.
        await new Promise((resolve) => {
          const stop = spawn('taskkill.exe', ['/PID', String(old.pid), '/T', '/F'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore',
          });
          stop.once('error', () => {
            old.kill();
            resolve();
          });
          stop.once('close', resolve);
        });
      } else old.kill();
    }
    status = 'disconnected';
    error = '';
  };
  let controlling = Promise.resolve();
  const setEnabled = (enabled) => {
    if (typeof enabled !== 'boolean') return Promise.reject(Error('Enabled must be a boolean.'));
    const operation = controlling.then(async () => {
      await persist({ enabled });
      if (enabled) {
        closed = false;
        retryAt = 0;
        await reconnect();
      } else await stop();
      return snapshot();
    });
    controlling = operation.catch(() => {});
    return operation;
  };
  const connect = () => setEnabled(true);
  const tick = async () => {
    if (
      closed ||
      saved.enabled === false ||
      !saved.protectedKey ||
      !saved.tunnelId ||
      connecting ||
      checking ||
      now() < retryAt
    )
      return;
    if (child) {
      const observed = child;
      checking = true;
      try {
        const ready = await probeReady(observed);
        if (!currentChild(observed) || ready || now() - startedAt < 30000) return;
        if (++healthFailures < 3) return;
        // Serialize health recovery with explicit On/Off actions. Only our child is stopped.
        const recovery = controlling.then(async () => {
          if (!currentChild(observed)) return;
          await stop();
          if (!closed && saved.enabled !== false) {
            retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
            status = 'connecting';
            error = 'Tunnel health checks failed. Automatic recovery is retrying.';
          }
        });
        controlling = recovery.catch(() => {});
        await recovery;
      } catch {
        error = 'Automatic recovery could not confirm tunnel health.';
      } finally {
        checking = false;
      }
      return;
    }
    await reconnect().catch(() => {
      retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
      status = 'error';
      error = 'Reconnect failed. Check the saved tunnel and runtime key.';
    });
  };
  const timer = schedule(tick, 1000);
  timer?.unref?.();
  const close = async () => {
    closed = true;
    unschedule(timer);
    await controlling;
    closed = true;
    await stop();
  };
  return { snapshot, save, connect, setEnabled, isEnabled: () => saved.enabled !== false, close };
}
