import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createEngine } from '@relaycast/engine';
import { createNodeRuntime, FILE_ROUTE_PREFIX } from '@relaycast/engine/adapters/node';

const LOOPBACK = '127.0.0.1';

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch { /* Socket already closed. */ }
}

function tokenFrom(req, url) {
  const query = url.searchParams.get('token')?.trim();
  if (query) return query;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1]?.trim() || undefined;
}

function originIsLoopback(origin) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch { return false; }
}

async function startLoopbackServer(fetch, port) {
  const server = serve({ fetch, hostname: LOOPBACK, port, overrideGlobalObjects: false });
  try {
    if (!server.listening) await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== LOOPBACK) throw new Error('Relay host did not bind exclusively to 127.0.0.1; startup refused');
    return server;
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

/**
 * Start the pinned upstream Relaycast engine on IPv4 loopback only.
 * `host` is deliberately not configurable. `port: 0` is useful for local tests;
 * production callers should provide a stable local port for signed file URLs.
 */
export async function startRelayRuntime({ dbPath, port = 8787, fileDir, fileSecret, auth, config } = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) throw new TypeError('dbPath is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
  const baseUrl = `http://${LOOPBACK}:${port}`;
  const runtime = createNodeRuntime({ dbPath, baseUrl, fileDir, fileSecret, auth, config });
  const engine = createEngine(runtime.deps);
  const app = new Hono();
  app.all(FILE_ROUTE_PREFIX, (c) => runtime.fileHandler(c.req.raw));
  app.route('/', engine);
  const wss = new WebSocketServer({ noServer: true });
  let server;
  try { server = await startLoopbackServer(app.fetch, port); } catch (error) { runtime.close(); wss.close(); throw error; }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url ?? '/', baseUrl); } catch { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    if (!originIsLoopback(req.headers.origin)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    if (url.pathname !== '/v1/ws' && url.pathname !== '/v1/node/ws') { rejectUpgrade(socket, 426, 'Upgrade Required'); return; }
    const token = tokenFrom(req, url);
    if (!token) { rejectUpgrade(socket, 401, 'Unauthorized'); return; }
    void (async () => {
      const required = url.pathname === '/v1/node/ws' ? 'node' : 'observer';
      const result = await runtime.deps.auth.authenticate({ token, require: required, db: runtime.deps.db });
      if (!result.ok || (required === 'node' && !result.node) || (required === 'observer' && (!result.observerToken || !result.observerToken.scopes.includes('stream:read')))) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const engineSocket = { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) };
        const handle = required === 'node'
          ? runtime.realtime.attachNodeSocket(result.node.workspaceId, result.node.id, engineSocket)
          : runtime.realtime.attachWorkspaceSocket(result.workspace.id, engineSocket, result.observerToken);
        ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
        ws.on('close', () => { void handle.handleClose(); });
      });
    })().catch(() => rejectUpgrade(socket, 500, 'Internal Server Error'));
  });



  let stopped = false;
  return {
    host: LOOPBACK,
    port: server.address().port,
    baseUrl: `http://${LOOPBACK}:${server.address().port}`,
    server,
    runtime,
    async stop() {
      if (stopped) return;
      stopped = true;
      runtime.close();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export { LOOPBACK as RELAY_LOOPBACK_HOST, startLoopbackServer };
