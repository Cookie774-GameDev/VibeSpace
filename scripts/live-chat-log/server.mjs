import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readNativeSnapshot } from './capture.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeConnection, captureAppActivity } from './connection.mjs';
import { createFileRecorder } from './recorder.mjs';

export async function startLiveLog({ port = 42841, debugPort = 9223, readSnapshot = readNativeSnapshot, directory, readActivity } = {}) {
  let token = randomBytes(24).toString('hex');
  if (directory) {
    await mkdir(directory, { recursive: true });
    try { const saved = (await readFile(join(directory, 'viewer-key'), 'utf8')).trim(); if (/^[a-f0-9]{48}$/.test(saved)) token = saved; } catch { /* first launch */ }
    await writeFile(join(directory, 'viewer-key'), token, { mode: 0o600 });
  }
  const connection = new NativeConnection(debugPort);
  const recorder = directory ? await createFileRecorder(directory) : null;
  let latest = null, timer, stopped = false, lastError = null, cursor = {};
  let recent = [];
  async function collect() {
    try {
      const next = await (readActivity ? readActivity() : connection.evaluate(`(${captureAppActivity.toString()})(${JSON.stringify(cursor)})`));
      await recorder?.accept(next);
      if (cursor.instanceId !== next.instanceId) recent = [];
      recent = [...recent, ...next.events.filter(event => event.sequence > (cursor.instanceId === next.instanceId ? cursor.sequence : 0))].slice(-2000);
      cursor = { instanceId: next.instanceId, sequence: next.sequence };
      latest = { ...next, events: recent }; lastError = null;
    } catch {
      latest = null; lastError = 'Native recorder disconnected or file write failed. Retrying automatically.';
      try { await recorder?.disconnected(); } catch { /* surfaced as disconnected */ }
    } finally { if (!stopped) timer = setTimeout(collect, 1000); }
  }
  const page = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
  let flight;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, origin);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' || request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) || !url.pathname.startsWith(`/${token}/`)) {
      response.writeHead(403).end('Forbidden'); return;
    }
    if (url.pathname === `/${token}/`) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; base-uri 'none'; form-action 'none'");
      response.end(page); return;
    }
    if (url.pathname === `/${token}/activity`) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.writeHead(latest ? 200 : 503).end(JSON.stringify(latest ? { ...latest, directory } : { error: lastError ?? 'Recorder starting' })); return;
    }
    if (url.pathname !== `/${token}/snapshot`) { response.writeHead(404).end(); return; }
    if (flight) { response.writeHead(429).end('Read in progress'); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      flight = readSnapshot((url.searchParams.get('chat') ?? '').slice(0, 200), debugPort);
      response.end(JSON.stringify(await flight));
    } catch {
      response.writeHead(503).end(JSON.stringify({ error: 'Disconnected. Open the official native development app with its local debug port enabled. Retrying automatically.' }));
    } finally { flight = undefined; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if (recorder || readActivity) void collect();
  server.on('close', () => { stopped = true; clearTimeout(timer); connection.close(); });
  return { server, url: `http://127.0.0.1:${server.address().port}/${token}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.env.VIBESPACE_LOG_DIRECTORY ?? join(process.env.LOCALAPPDATA, 'VibeSpace', 'ActivityLog');
  const { url } = await startLiveLog({ port: Number(process.env.VIBESPACE_LOG_PORT ?? 42841), debugPort: Number(process.env.VIBESPACE_DEBUG_PORT ?? 9223), directory });
  const output = process.argv[2];
  if (output) await writeFile(output, `<!doctype html><meta charset="utf-8"><title>VibeSpace Live Chat Log</title><meta http-equiv="refresh" content="0;url=${url}"><p>Open the <a href="${url}">live HTML log</a>. The local log service and native development app must be running.</p>`, 'utf8');
  console.log('Standalone HTML log service listening on loopback. Launcher ready.');
  await writeFile(join(directory, 'viewer-url.txt'), url, 'utf8');
}
