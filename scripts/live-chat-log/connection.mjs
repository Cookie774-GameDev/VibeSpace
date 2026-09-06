import { chooseNativeTarget } from './capture.mjs';

/** One CDP connection for the recorder lifetime; reconnect only after loss. */
export class NativeConnection {
  constructor(port = 9223) { this.port = port; this.serial = 0; this.pending = new Map(); }
  close() {
    this.socket?.close(); this.socket = null;
    for (const finish of this.pending.values()) finish(new Error('Native connection lost'));
    this.pending.clear();
  }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const target = chooseNativeTarget(await response.json());
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.hostname !== '127.0.0.1' || url.port !== String(this.port)) throw new Error('Unexpected native debugger');
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      try { const message = JSON.parse(data); const finish = this.pending.get(message.id); if (finish) finish(message.error || message.result?.exceptionDetails ? new Error('Native evaluation unavailable') : null, message.result?.result?.value); } catch { this.close(); }
    });
    socket.addEventListener('close', () => { if (this.socket === socket) this.close(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Connection timed out')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Connection failed')); }, { once: true });
    });
  }
  async evaluate(expression) {
    await this.connect();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.close(); reject(new Error('Read timed out')); }, 15000);
      this.pending.set(id, (error, value) => { clearTimeout(timer); this.pending.delete(id); error ? reject(error) : resolve(value); });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
}

export async function captureAppActivity(cursor = {}) {
  if (!window.__TAURI_INTERNALS__) throw new Error('Native app required');
  const { appActivityLog } = await import('/src/lib/diagnostics/appActivityLog.ts');
  const identity = appActivityLog.snapshot(Number.MAX_SAFE_INTEGER).instanceId;
  return { ...appActivityLog.snapshot(identity === cursor.instanceId ? cursor.sequence : 0), capturedAt: Date.now(), coverage: [
    'Live events across model router, scoped public Codex protocol, raw OpenCode events, OpenCode harness (including RLM child calls), semantic tool gateway, and terminal CLI command host.',
    'observedAt is local receipt time in epoch milliseconds; monotonicMs/durationMs use the renderer monotonic clock. Neither proves exact remote CLI receipt time.',
    'Only provider-reported reasoning, usage, tool output and file-change events are available. Uninstrumented external CLI internals are not visible.',
    '16,000 characters per string, 64,000 per record, and 2,000-event memory buffer. Truncation and buffer gaps are explicit. Disk log rotates at 32 MiB and keeps one previous file.',
    'Recording begins with this renderer instrumentation. Prior activity is available in the separate historical chat view. Credentials are redacted; content remains private.',
  ] };
}
