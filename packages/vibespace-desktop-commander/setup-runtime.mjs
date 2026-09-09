import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
    tunnelId: '',
    protectedKey: '',
    enabled: true,
    setupComplete: false,
  };
  try {
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (prior.version === 1) saved = { ...saved, ...prior };
  } catch {}
  let child,
    connecting,
    status = 'disconnected',
    error = '',
    healthURL = '',
    writing = Promise.resolve();
  let closed = false,
    failures = 0,
    retryAt = 0;
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
  const snapshot = async () => {
    const identity = { tunnelId: saved.tunnelId, protectedKey: saved.protectedKey, child };
    if (child && !child.killed && child.exitCode == null) {
      try {
        healthURL = (await readFile(healthFile, 'utf8')).trim().replace(/\/$/, '');
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(healthURL)) throw Error();
        const response = await fetchRequest(healthURL + '/readyz', {
          signal: AbortSignal.timeout(2500),
          redirect: 'error',
        });
        status = response.ok ? 'ready' : 'connecting';
      } catch {
        status = 'connecting';
      }
    }
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
  const tick = () => {
    if (
      closed ||
      saved.enabled === false ||
      !saved.protectedKey ||
      !saved.tunnelId ||
      child ||
      connecting ||
      now() < retryAt
    )
      return;
    void reconnect().catch(() => {
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
