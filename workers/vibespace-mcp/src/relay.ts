import { DurableObject } from 'cloudflare:workers';

import { SAFE_RELAY_TOOLS } from './catalog';
import type {
  Env,
  RelayInvocation,
  RelayInvocationResult,
  RelayStatus,
  RelayWorkspace,
} from './contracts';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{12,96}$/u;

type PendingCall = {
  resolve: (value: RelayInvocationResult) => void;
  timeout: number;
};

type Registration = {
  protocol_version: 2;
  client_nonce: string;
  workspace_grant: { id: string; display_name: string };
  tools: Array<{ function?: { name?: string } }>;
};

type SocketAttachment = {
  sessionId: string;
  registered: boolean;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseRegistration(value: unknown): Registration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const grant = frame.workspace_grant;
  if (
    frame.kind !== 'register' ||
    frame.protocol_version !== 2 ||
    typeof frame.client_nonce !== 'string' ||
    !SAFE_IDENTIFIER.test(frame.client_nonce) ||
    !grant ||
    typeof grant !== 'object' ||
    Array.isArray(grant)
  ) {
    return null;
  }
  const workspace = grant as Record<string, unknown>;
  if (
    typeof workspace.id !== 'string' ||
    !SAFE_IDENTIFIER.test(workspace.id) ||
    typeof workspace.display_name !== 'string' ||
    !workspace.display_name.trim() ||
    workspace.display_name.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(workspace.display_name) ||
    !Array.isArray(frame.tools)
  ) {
    return null;
  }
  const toolNames = frame.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return '';
    const fn = (tool as Record<string, unknown>).function;
    return fn && typeof fn === 'object' && !Array.isArray(fn)
      ? String((fn as Record<string, unknown>).name ?? '')
      : '';
  });
  if (
    toolNames.some((name) => !SAFE_RELAY_TOOLS.has(name)) ||
    new Set(toolNames).size !== toolNames.length
  ) {
    return null;
  }
  return frame as unknown as Registration;
}

function connectionState(ws: WebSocket): SocketAttachment {
  return (
    (ws.deserializeAttachment() as SocketAttachment | null) ?? {
      sessionId: '',
      registered: false,
    }
  );
}

export class UserRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingCall>();
  private sequence = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        connected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_tickets (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/bridge') return this.acceptBridge(request);
    if (url.pathname === '/internal/status' && request.method === 'GET') {
      return json(this.status());
    }
    if (url.pathname === '/internal/invoke' && request.method === 'POST') {
      return this.invoke(request);
    }
    return json({ error: 'Not found.' }, 404);
  }

  private acceptBridge(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required.' }, 426);
    }
    const jti = request.headers.get('x-vibespace-ticket-id') ?? '';
    const subject = request.headers.get('x-vibespace-user') ?? '';
    const expiresAt = Number(request.headers.get('x-vibespace-ticket-expiry'));
    if (!SAFE_IDENTIFIER.test(jti) || !subject || !Number.isSafeInteger(expiresAt)) {
      return json({ error: 'Invalid relay ticket.' }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec('DELETE FROM used_tickets WHERE expires_at < ?', now);
    const inserted = [
      ...this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO used_tickets (jti, expires_at) VALUES (?, ?) RETURNING jti',
        jti,
        expiresAt,
      ),
    ];
    if (inserted.length !== 1) return json({ error: 'Relay ticket already used.' }, 409);

    for (const socket of this.ctx.getWebSockets('desktop')) {
      try {
        socket.close(4000, 'replaced');
      } catch {
        // The replacement connection remains authoritative.
      }
    }
    this.failPending('The VibeSpace desktop relay reconnected.');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return json({ error: 'Unable to open relay socket.' }, 500);
    const sessionId = `session_${crypto.randomUUID().replace(/-/gu, '')}`;
    server.serializeAttachment({ sessionId, registered: false } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, ['desktop']);
    this.ctx.storage.sql.exec(
      `INSERT INTO relay_state
       (singleton, user_id, workspace_id, workspace_name, tools_json, connected_at)
       VALUES (1, ?, '', '', '[]', ?)
       ON CONFLICT(singleton) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = '',
         workspace_name = '',
         tools_json = '[]',
         connected_at = excluded.connected_at`,
      subject,
      Date.now(),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text =
      typeof message === 'string' ? message : new TextDecoder().decode(new Uint8Array(message));
    if (text.length > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'message too large');
      return;
    }
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      frame = parsed as Record<string, unknown>;
    } catch {
      ws.close(4002, 'invalid frame');
      return;
    }
    const attachment = connectionState(ws);
    if (!attachment.registered) {
      const registration = parseRegistration(frame);
      if (!registration) {
        ws.close(4002, 'invalid registration');
        return;
      }
      const tools = registration.tools.map((tool) => String(tool.function?.name ?? ''));
      this.ctx.storage.sql.exec(
        `UPDATE relay_state
         SET workspace_id = ?, workspace_name = ?, tools_json = ?, connected_at = ?
         WHERE singleton = 1`,
        registration.workspace_grant.id,
        registration.workspace_grant.display_name.trim(),
        JSON.stringify(tools),
        Date.now(),
      );
      ws.serializeAttachment({ ...attachment, registered: true } satisfies SocketAttachment);
      ws.send(
        JSON.stringify({
          kind: 'registered',
          protocol_version: 2,
          session_id: attachment.sessionId,
          server_nonce: `nonce_${crypto.randomUUID().replace(/-/gu, '')}`,
          server_time: Date.now(),
        }),
      );
      return;
    }
    if (frame.kind === 'heartbeat') return;
    if (frame.kind === 'deregister') {
      ws.close(1000, 'shutdown');
      return;
    }
    if (frame.kind !== 'tool_result') return;
    const callId = typeof frame.call_id === 'string' ? frame.call_id : '';
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    clearTimeout(pending.timeout);
    if (frame.ok === true && byteLength(frame.result) <= MAX_RESULT_BYTES) {
      pending.resolve({ ok: true, result: frame.result });
    } else {
      pending.resolve({
        ok: false,
        error: frame.ok === true ? 'The relay result is too large.' : 'The local tool was denied.',
      });
    }
  }

  webSocketClose(): void {
    this.failPending('The VibeSpace desktop relay disconnected.');
  }

  webSocketError(): void {
    this.failPending('The VibeSpace desktop relay disconnected.');
  }

  private status(): RelayStatus {
    const sockets = this.ctx
      .getWebSockets('desktop')
      .filter((socket) => connectionState(socket).registered);
    const row = [
      ...this.ctx.storage.sql.exec<{
        workspace_id: string;
        workspace_name: string;
        tools_json: string;
        connected_at: number;
      }>(
        'SELECT workspace_id, workspace_name, tools_json, connected_at FROM relay_state WHERE singleton = 1',
      ),
    ][0];
    if (!row || sockets.length !== 1 || !row.workspace_id) {
      return { connected: false, tools: [] };
    }
    let tools: string[] = [];
    try {
      const parsed = JSON.parse(row.tools_json);
      tools = Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === 'string')
        : [];
    } catch {
      tools = [];
    }
    return {
      connected: true,
      workspace: { id: row.workspace_id, displayName: row.workspace_name },
      tools,
      connectedAt: row.connected_at,
    };
  }

  private async invoke(request: Request): Promise<Response> {
    const status = this.status();
    if (!status.connected)
      return json({ ok: false, error: 'The VibeSpace desktop relay is offline.' }, 503);
    let invocation: RelayInvocation;
    try {
      invocation = (await request.json()) as RelayInvocation;
    } catch {
      return json({ ok: false, error: 'Invalid tool request.' }, 400);
    }
    if (
      !SAFE_RELAY_TOOLS.has(invocation.name) ||
      !status.tools.includes(invocation.name) ||
      !invocation.args ||
      typeof invocation.args !== 'object' ||
      Array.isArray(invocation.args) ||
      byteLength(invocation.args) > MAX_ARGUMENT_BYTES
    ) {
      return json({ ok: false, error: 'The requested tool is unavailable.' }, 403);
    }
    const socket = this.ctx
      .getWebSockets('desktop')
      .find((candidate) => connectionState(candidate).registered);
    if (!socket) return json({ ok: false, error: 'The VibeSpace desktop relay is offline.' }, 503);
    const attachment = connectionState(socket);
    const callId = `call_${crypto.randomUUID().replace(/-/gu, '')}`;
    this.sequence += 1;
    const now = Date.now();
    const result = await new Promise<RelayInvocationResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, error: 'The local tool timed out.' });
      }, REQUEST_TIMEOUT_MS) as unknown as number;
      this.pending.set(callId, { resolve, timeout });
      socket.send(
        JSON.stringify({
          kind: 'tool_call',
          session_id: attachment.sessionId,
          call_id: callId,
          name: invocation.name,
          args: invocation.args,
          sequence: this.sequence,
          issued_at_ms: now,
          expires_at_ms: now + REQUEST_TIMEOUT_MS,
          deadline_ms: REQUEST_TIMEOUT_MS,
        }),
      );
    });
    return json(result, result.ok ? 200 : 502);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: message });
      this.pending.delete(id);
    }
  }
}

export function workspaceFromStatus(status: RelayStatus): RelayWorkspace | undefined {
  return status.connected ? status.workspace : undefined;
}
