import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DISPLAY_NAME = 'VibeSpace Desktop';
export function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw Error('Use an app name between 1 and 64 characters.');
  const name = value.trim();
  if (name.length > 64 || /[\u0000-\u001f\u007f]/.test(value))
    throw Error('Use an app name between 1 and 64 characters.');
  return name || DEFAULT_DISPLAY_NAME;
}

export function protectKey(value, decrypt = false) {
  const fail = () =>
    Object.assign(
      new Error(
        decrypt
          ? 'Windows secure storage could not unlock the saved runtime key.'
          : 'Windows secure storage could not save your runtime key.',
      ),
      { code: 'CREDENTIAL_STORAGE_UNAVAILABLE' },
    );
  if (
    process.platform !== 'win32' ||
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 65536
  )
    return Promise.reject(fail());
  const base = path.dirname(fileURLToPath(import.meta.url));
  const packaged = existsSync(path.join(base, 'runtime', 'node.exe'));
  const executable = packaged ? path.join(base, 'runtime', 'python', 'python.exe') : 'python.exe';
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        executable,
        [
          '-I',
          '-S',
          '-B',
          path.join(base, 'setup', 'secure-storage.py'),
          decrypt ? 'unprotect' : 'protect',
        ],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
    } catch {
      reject(fail());
      return;
    }
    let result = Buffer.alloc(0),
      settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok && result.length) resolve(result.toString('utf8'));
      else reject(fail());
      result.fill(0);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 30000);
    child.stdout.on('data', (chunk) => {
      if (result.length + chunk.length > 65536) {
        child.kill();
        finish(false);
        return;
      }
      const old = result;
      result = Buffer.concat([result, chunk]);
      old.fill(0);
    });
    child.stdin.on('error', () => finish(false));
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
    child.stdin.end(value, 'utf8');
  });
}

export const SETUP_ERRORS = Object.freeze({
  CREDENTIAL_STORAGE_UNAVAILABLE:
    'Windows secure storage could not save or unlock the runtime key. Your key was not sent to the tunnel.',
  INVALID_PLUGIN_NAME: 'Use a plugin name of at most 64 characters without control characters.',
  INVALID_TUNNEL_ID: 'Paste the complete tunnel ID from OpenAI.',
  INVALID_RUNTIME_KEY: 'Use a restricted runtime API key, not an admin key.',
  TUNNEL_CONFIGURATION_REQUIRED: 'Save your tunnel ID and runtime API key first.',
  TUNNEL_CREDENTIALS_IN_USE: 'Disconnect before changing active tunnel credentials.',
  TUNNEL_START_FAILED:
    'The local tunnel client could not start. Check that its packaged runtime is available.',
  TUNNEL_AUTHENTICATION_FAILED:
    'OpenAI rejected the runtime API key. Replace it with a valid runtime key.',
  TUNNEL_PERMISSION_DENIED:
    'OpenAI denied tunnel access. The runtime key needs Tunnels Read and Use for this tunnel.',
  TUNNEL_CONNECTION_FAILED: 'The tunnel is not ready. Automatic recovery will retry.',
  SETUP_REQUEST_FAILED:
    'The local setup operation could not be completed. Retry without changing your credentials.',
});
export function publicSetupError(error) {
  let code = Object.hasOwn(SETUP_ERRORS, error?.code) ? error.code : 'SETUP_REQUEST_FAILED';
  const known = {
    'Use an app name between 1 and 64 characters.': 'INVALID_PLUGIN_NAME',
    'Enter a valid tunnel ID.': 'INVALID_TUNNEL_ID',
    'Use a runtime API key, not an admin key.': 'INVALID_RUNTIME_KEY',
    'Save your tunnel ID and runtime API key first.': 'TUNNEL_CONFIGURATION_REQUIRED',
    'Disconnect before changing the active tunnel credentials.': 'TUNNEL_CREDENTIALS_IN_USE',
  };
  if (Object.hasOwn(known, error?.message)) code = known[error.message];
  return { code, error: SETUP_ERRORS[code] };
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
    guideTab: 'tunnel',
    tunnelId: '',
    protectedKey: '',
    enabled: true,
    autoConnect: false,
    setupComplete: false,
  };
  try {
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (prior.version === 1) {
      saved = {
        ...saved,
        ...prior,
        guideTab: prior.guideTab === 'api' ? 'api' : 'tunnel',
        autoConnect:
          typeof prior.autoConnect === 'boolean' ? prior.autoConnect : prior.setupComplete === true,
      };
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
    errorCode = '',
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
            errorCode = '';
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
      guideTab: saved.guideTab,
      tunnelId: saved.tunnelId,
      hasKey: Boolean(saved.protectedKey),
      status: saved.enabled === false ? 'off' : status,
      error,
      errorCode,
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
      const guideTab = input.guideTab ?? saved.guideTab;
      if (!['tunnel', 'api'].includes(guideTab)) throw Error('Choose a valid tutorial tab.');
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
        guideTab,
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
    errorCode = '';
    try {
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
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CONTROL_PLANE_API_KEY: key,
            VIBESPACE_MCP_AUTH: 'Bearer ' + token,
          },
        },
      );
    } catch {
      errorCode = 'TUNNEL_START_FAILED';
      error = SETUP_ERRORS[errorCode];
      status = 'error';
      throw Object.assign(new Error(error), { code: errorCode });
    }
    const launched = child;
    let diagnosticTail = '';
    const inspectOutput = (chunk) => {
      if (child !== launched) return;
      diagnosticTail = (diagnosticTail + String(chunk)).slice(-4096);
      const code =
        /(?:HTTP[^\n]{0,12}401|status[^\n]{0,12}401|401 Unauthorized|invalid api key)/i.test(
          diagnosticTail,
        )
          ? 'TUNNEL_AUTHENTICATION_FAILED'
          : /(?:HTTP[^\n]{0,12}403|status[^\n]{0,12}403|403 Forbidden|tunnels? use permission)/i.test(
                diagnosticTail,
              )
            ? 'TUNNEL_PERMISSION_DENIED'
            : '';
      if (code) {
        errorCode = code;
        error = SETUP_ERRORS[code];
      }
    };
    child.stdout?.on('data', inspectOutput);
    child.stderr?.on('data', inspectOutput);
    startedAt = now();
    healthFailures = 0;
    const failed = () => {
      if (child === launched) {
        child = undefined;
        retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        status = 'error';
        errorCode ||= 'TUNNEL_CONNECTION_FAILED';
        error = SETUP_ERRORS[errorCode];
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
    errorCode = '';
  };
  let controlling = Promise.resolve();
  const setEnabled = (enabled) => {
    if (typeof enabled !== 'boolean') return Promise.reject(Error('Enabled must be a boolean.'));
    const operation = controlling.then(async () => {
      await persist((current) => ({ enabled, autoConnect: enabled ? true : current.autoConnect }));
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
      !saved.autoConnect ||
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
      errorCode ||= 'TUNNEL_CONNECTION_FAILED';
      error = SETUP_ERRORS[errorCode];
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
