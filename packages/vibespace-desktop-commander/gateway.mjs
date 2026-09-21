import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, open } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { editableConfig, validateSetting } from './config.mjs';
import { browserTool, runBrowserTool } from './browser/tool.mjs';
import { createSetupRuntime } from './setup-runtime.mjs';
import { computerStartup } from './startup.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
export function plugin3TransportOptions(baseDir = base, stateDir = path.join(baseDir, 'state')) {
  const plugin3StateDir = path.resolve(stateDir, 'plugin3');
  return {
    command: process.execPath,
    args: [
      path.join(baseDir, 'plugin3', 'runtime', 'desktop-commander-v3', 'dist', 'index.js'),
      '--no-onboarding',
      '--shared-service',
    ],
    cwd: baseDir,
    // The SDK's minimal environment omits Windows runtime variables required by this package.
    // Preserve these OS settings without forwarding unrelated provider credentials.
    env: {
      ...Object.fromEntries(
        ['ComSpec', 'PATHEXT', 'TMP', 'windir']
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
      PLUGIN3_DATA_DIR: plugin3StateDir,
      PLUGIN3_PYTHON: path.join(baseDir, 'runtime', 'python', 'python.exe'),
      PLUGIN3_SHARED_SERVICE: '1',
    },
    stderr: 'pipe',
  };
}
// Tauri appends the window origin to native HTTP requests. No browser CORS
// permission is granted; every request still needs the private bearer token.
const nativeConfigOrigins = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
  'http://localhost:5174',
]);
export async function startGateway({
  port = 52643,
  stateDir = path.join(base, 'state'),
  client: suppliedClient,
} = {}) {
  await mkdir(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, 'gateway.lock');
  const lock = await open(lockFile, 'wx', 0o600).catch(async (cause) => {
    if (cause.code === 'EEXIST') {
      const raw = await readFile(lockFile, 'utf8');
      const prior = JSON.parse(raw);
      if (Number.isSafeInteger(prior.pid) && prior.pid > 0) {
        try {
          process.kill(prior.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH' && (await readFile(lockFile, 'utf8')) === raw) {
            await unlink(lockFile);
            return open(lockFile, 'wx', 0o600);
          }
        }
      }
    }
    throw Error(
      'This package is already running, or its interrupted gateway.lock needs inspection. Do not start a second copy.',
    );
  });
  await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const unlock = async () => {
    await lock.close();
    await unlink(lockFile);
  };
  const client =
    suppliedClient ?? new Client({ name: 'vibespace-desktop-commander', version: '0.1.0' });
  if (!suppliedClient) {
    const transport = new StdioClientTransport(plugin3TransportOptions(base, stateDir));
    try {
      transport.stderr?.resume(); // Drain privately; a real pipe also supports Windows startup diagnostics.
      await client.connect(transport, { timeout: 60000 });
    } catch (error) {
      await transport.close().catch(() => {});
      await unlock();
      throw error;
    }
  }
  const token = randomBytes(32).toString('hex');
  let setup;
  let startOnComputer = await computerStartup(base, stateDir).catch(() => null);
  const snapshot = async () => ({ ...(await setup.snapshot()), startOnComputer });
  const sessions = new Map();
  let active = 0,
    changing = false;
  const call = (name, args) =>
    name === 'browser_command'
      ? runBrowserTool(args)
      : client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const json = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    // Never accept cross-site browser requests, DNS rebinding, or unauthenticated tunnel traffic.
    const host = req.headers.host ?? '';
    const setupAssets = {
      '/setup': ['index.html', 'text/html'],
      '/setup/app.js': ['app.js', 'text/javascript'],
      '/setup/style.css': ['style.css', 'text/css'],
    };
    if (req.method === 'GET' && setupAssets[req.url] && /^127\.0\.0\.1:\d+$/.test(host)) {
      const [name, type] = setupAssets[req.url];
      let asset;
      try {
        asset = await readFile(path.join(base, 'setup', name));
      } catch {
        return json(res, 404, { error: 'Setup resource unavailable' });
      }
      res.writeHead(200, {
        'content-type': type + '; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      return res.end(asset);
    }
    if (
      (req.headers.origin &&
        !(req.url === '/config' && nativeConfigOrigins.has(req.headers.origin)) &&
        !(req.url.startsWith('/setup/') && req.headers.origin === `http://${host}`)) ||
      !/^127\.0\.0\.1:\d+$/.test(host) ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    if (active >= 8) return json(res, 429, { error: 'Busy; request not accepted' });
    active++;
    try {
      let body;
      if (req.method === 'POST' || req.method === 'PATCH') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
          return json(res, 415, { error: 'JSON required' });
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1048576) return json(res, 413, { error: 'Request too large' });
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
      }
      if (req.url.startsWith('/setup/')) {
        if (!setup) return json(res, 503, { error: 'Connector is starting.' });
        if (req.url === '/setup/state' && req.method === 'GET')
          return json(res, 200, await snapshot());
        if (req.url === '/setup/startup' && req.method === 'POST') {
          if (typeof body?.enabled !== 'boolean')
            return json(res, 400, { error: 'Enabled must be a boolean.' });
          startOnComputer = await computerStartup(base, stateDir, body.enabled);
          return json(res, 200, await snapshot());
        }
        if (req.url === '/setup/draft' && req.method === 'POST')
          return json(res, 200, await setup.save(body ?? {}));
        if (req.url === '/setup/connect' && req.method === 'POST')
          return json(res, 200, await setup.connect());
        if (req.url === '/setup/disconnect' && req.method === 'POST') {
          await setup.setEnabled(false);
          return json(res, 200, await snapshot());
        }
        return json(res, 404, { error: 'Not found' });
      }
      if (req.url === '/config' && req.method === 'GET')
        return json(res, 200, editableConfig(await call('get_config', { origin: 'ui' })));
      if (req.url === '/config' && req.method === 'PATCH') {
        if (changing)
          return json(res, 409, {
            error: 'Another configuration change is in progress. Reload before saving.',
          });
        changing = true;
        try {
          const { key, value, previous } = body ?? {};
          validateSetting(key, value);
          const current = editableConfig(await call('get_config', { origin: 'ui' }));
          if (JSON.stringify(current.config[key]) !== JSON.stringify(previous))
            return json(res, 409, {
              error: 'This setting changed elsewhere. Reload before saving.',
            });
          const result = await call('set_config_value', { key, value, origin: 'ui' });
          if (result.isError) throw Error('Desktop Commander rejected this setting');
          const after = editableConfig(await call('get_config', { origin: 'ui' }));
          if (JSON.stringify(after.config[key]) !== JSON.stringify(value))
            throw Error('Saved value could not be verified. Reload before retrying.');
          return json(res, 200, after);
        } finally {
          changing = false;
        }
      }
      if (req.url !== '/mcp') return json(res, 404, { error: 'Not found' });
      if (!setup?.isEnabled()) return json(res, 503, { error: 'Desktop Link is off.' });
      let entry = sessions.get(req.headers['mcp-session-id']);
      if (
        !entry &&
        req.method === 'POST' &&
        !req.headers['mcp-session-id'] &&
        isInitializeRequest(body)
      ) {
        if (sessions.size >= 8) return json(res, 429, { error: 'Too many sessions' });
        const mcp = new Server(
          { name: 'vibespace-desktop-link', version: '0.1.0' },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => {
          const list = await client.listTools();
          return { ...list, tools: [...list.tools, browserTool] };
        });
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (!setup?.isEnabled()) throw Error('Desktop Link is off.');
          if (request.params.name !== 'set_config_value')
            return call(request.params.name, request.params.arguments ?? {});
          if (changing) throw Error('Configuration is being edited. Reload before retrying.');
          changing = true;
          try {
            validateSetting(request.params.arguments?.key, request.params.arguments?.value);
            return await call(request.params.name, request.params.arguments ?? {});
          } finally {
            changing = false;
          }
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, { transport, mcp }),
        });
        transport.onclose = () => sessions.delete(transport.sessionId);
        await mcp.connect(transport);
        entry = { transport, mcp };
      }
      if (!entry) return json(res, 404, { error: 'Unknown MCP session' });
      await entry.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent)
        json(res, 400, {
          error: req.url === '/config' ? String(error.message).slice(0, 200) : 'MCP request failed',
        });
      else res.end();
    } finally {
      active--;
    }
  });
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  server.timeout = 65000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await client.close();
    await unlock();
    throw error;
  }
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  setup = await createSetupRuntime({
    stateDir,
    base,
    endpoint,
    token,
    getTools: async () => {
      const listed = await client.listTools();
      return { tools: [...listed.tools, browserTool] };
    },
  });
  await mkdir(stateDir, { recursive: true });
  const connectionFile = path.join(stateDir, 'connection.json');
  await writeFile(
    connectionFile,
    JSON.stringify({ version: 1, endpoint, token, pid: process.pid }),
    { mode: 0o600 },
  );
  const close = async () => {
    await setup.close();
    for (const entry of sessions.values()) await entry.mcp.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await client.close();
    try {
      const saved = JSON.parse(await readFile(connectionFile, 'utf8'));
      if (saved.token === token) await unlink(connectionFile);
    } catch {}
    await unlock();
  };
  return { endpoint, token, connectionFile, close };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startGateway({
    port: Number(process.env.VIBESPACE_CONNECTOR_PORT ?? 52643),
    stateDir: process.env.VIBESPACE_CONNECTOR_STATE_DIR || path.join(base, 'state'),
  });
  console.log(
    `Desktop Commander ready. In VibeSpace Browser Agent setup, select: ${instance.connectionFile}`,
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.connected) {
    process.once('disconnect', stop);
    process.on('message', (message) => {
      if (message === 'shutdown') void stop();
    });
  }
}
