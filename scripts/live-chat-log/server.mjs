import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readNativeSnapshot } from './capture.mjs';

export async function startLiveLog({ port = 42841, debugPort = 9223, readSnapshot = readNativeSnapshot } = {}) {
  const token = randomBytes(24).toString('hex');
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
  return { server, url: `http://127.0.0.1:${server.address().port}/${token}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startLiveLog({ port: Number(process.env.VIBESPACE_LOG_PORT ?? 42841), debugPort: Number(process.env.VIBESPACE_DEBUG_PORT ?? 9223) });
  const output = process.argv[2];
  if (output) await writeFile(output, `<!doctype html><meta charset="utf-8"><title>VibeSpace Live Chat Log</title><meta http-equiv="refresh" content="0;url=${url}"><p>Open the <a href="${url}">live HTML log</a>. The local log service and native development app must be running.</p>`, 'utf8');
  console.log('Standalone HTML log service listening on loopback. Launcher ready.');
}
