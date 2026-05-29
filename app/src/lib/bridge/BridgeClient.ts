/**
 * BridgeClient — long-lived WS to phone-jarvis-cloud /bridge endpoint.
 *
 * This is the cloud<->desktop tool dispatcher. While Jarvis is open and the
 * user is signed into Supabase, we keep one WSS open to the cloud so that
 * when the AI on a phone call (Path A) or in-app call (Path C) emits a
 * tool_use, the cloud can route it here and we can answer using the local
 * MCP registry. Files never leave the user's machine.
 *
 * Frame protocol: see phone-jarvis/cloud/bridge.py
 *
 * Lifecycle:
 *   start(jwt) -> opens WSS, sends register frame with MCP tool schema
 *   while connected: heartbeat every 15s, dispatch tool_calls to MCP
 *   on close: exp-backoff reconnect (250ms..5s), reset on 60s of stable
 *   stop(): clean deregister + close, no more reconnects
 *
 * The bridge is a SINGLETON. Treat the BridgeClient as a global service.
 */

import { toolRegistry, type ToolDef } from '@/lib/mcp/registry';

export type BridgeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface BridgeFrame {
  kind: string;
  [key: string]: unknown;
}

export interface BridgeClientOptions {
  /** Cloud bridge URL, e.g. wss://phone-jarvis-cloud.fly.dev/bridge */
  url: string;
  /** Supabase JWT — sent in the register frame */
  jwt: string;
  /** Workspace root for tool path resolution. Default: undefined (no root). */
  workspaceRoot?: string;
  /** Daemon version string (defaults to app version). */
  daemonVersion?: string;
  /** Platform string (defaults to navigator.platform). */
  platform?: string;
  /** Heartbeat interval ms (default 15s). */
  heartbeatMs?: number;
  /** Max reconnect backoff ms (default 5000). */
  maxBackoffMs?: number;
  /** Called on every status change. */
  onStatus?: (status: BridgeStatus) => void;
  /** Called on every inbound frame after kind=register handshake. */
  onFrame?: (frame: BridgeFrame) => void;
}

interface PendingRegister {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Convert the in-process MCP registry to the schema shape the cloud expects.
 *
 * We use OpenAI-compatible function calling shape since most LLMs (Claude,
 * Llama, Groq) accept it. The cloud forwards this list straight to the LLM
 * service via Pipecat's tool catalog parameter.
 */
function toToolSchema(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private status: BridgeStatus = 'idle';
  private opts: BridgeClientOptions;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private wantsConnected = false;
  private connectedAt = 0;
  private registerPending: PendingRegister | null = null;
  private sessionId: string | null = null;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
  }

  /** Open the bridge. Resolves once the cloud sends `kind:registered`. */
  async start(): Promise<void> {
    if (this.wantsConnected) return;
    this.wantsConnected = true;
    return this.connect();
  }

  /** Close the bridge cleanly. No reconnect after this. */
  async stop(): Promise<void> {
    this.wantsConnected = false;
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ kind: 'deregister', reason: 'shutdown' }));
      } catch {
        // ignore
      }
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.setStatus('closed');
  }

  /** Update the JWT (e.g. after Supabase auth refresh) and reconnect. */
  setJwt(jwt: string): void {
    this.opts.jwt = jwt;
    if (this.wantsConnected) {
      this.reconnect();
    }
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  // -- private --

  private setStatus(s: BridgeStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private async connect(): Promise<void> {
    if (!this.wantsConnected) return;

    this.clearReconnect();
    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    try {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;

      const registerPromise = new Promise<void>((resolve, reject) => {
        this.registerPending = { resolve, reject };
      });

      ws.onopen = () => {
        const tools = toolRegistry.list();
        const registerFrame = {
          kind: 'register',
          token: this.opts.jwt,
          daemon_version: this.opts.daemonVersion ?? 'jarvis-app/0.1.0',
          platform: this.opts.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : 'unknown'),
          workspace_root: this.opts.workspaceRoot,
          tools: toToolSchema(tools),
          writable: false,
          shell_enabled: false,
        };
        try {
          ws.send(JSON.stringify(registerFrame));
        } catch (e) {
          this.registerPending?.reject(new Error(`register send failed: ${e}`));
          this.registerPending = null;
        }
      };

      ws.onmessage = (ev) => this.handleMessage(ev.data as string);
      ws.onerror = () => {
        // onerror fires before onclose; let onclose handle the reconnect.
      };
      ws.onclose = (ev) => {
        const wasConnected = this.status === 'connected';
        this.ws = null;
        this.clearHeartbeat();

        if (this.registerPending) {
          this.registerPending.reject(new Error(`bridge closed before register: code=${ev.code}`));
          this.registerPending = null;
        }

        if (this.wantsConnected) {
          this.scheduleReconnect(wasConnected);
        } else {
          this.setStatus('closed');
        }
      };

      await registerPromise;
    } catch (e) {
      console.error('[BridgeClient] connect failed:', e);
      this.setStatus('error');
      if (this.wantsConnected) {
        this.scheduleReconnect(false);
      }
    }
  }

  private handleMessage(data: string): void {
    let frame: BridgeFrame;
    try {
      frame = JSON.parse(data) as BridgeFrame;
    } catch {
      console.warn('[BridgeClient] non-JSON frame; ignoring');
      return;
    }

    switch (frame.kind) {
      case 'registered':
        this.sessionId = String(frame.session_id ?? '');
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        this.startHeartbeat();
        this.registerPending?.resolve();
        this.registerPending = null;
        break;

      case 'tool_call':
        void this.handleToolCall(frame);
        break;

      case 'heartbeat':
        // server-initiated heartbeat; we'll respond on our own interval
        break;

      default:
        this.opts.onFrame?.(frame);
        break;
    }
  }

  /**
   * Dispatch a tool_call frame to the local MCP registry and reply with
   * a tool_result. Catches all errors so a buggy tool can't kill the bridge.
   */
  private async handleToolCall(frame: BridgeFrame): Promise<void> {
    const callId = String(frame.call_id ?? '');
    const name = String(frame.name ?? '');
    const args = (frame.args ?? {}) as Record<string, unknown>;
    const confirmed = Boolean(frame.confirmed);

    const start = performance.now();
    let result: unknown = null;
    let ok = true;
    let error: { code: string; message: string } | undefined;

    try {
      // Confirm-tier guard. The cloud upstream is supposed to gate these by
      // verbal yes already, but defense in depth: refuse if not confirmed.
      if (this.requiresConfirmation(name) && !confirmed) {
        ok = false;
        error = {
          code: 'CONFIRM_REQUIRED',
          message: `Tool "${name}" requires explicit user confirmation; cloud did not flag confirmed=true`,
        };
      } else {
        result = await toolRegistry.invoke(name, args);
      }
    } catch (e) {
      ok = false;
      const err = e as Error;
      error = {
        code: 'TOOL_ERROR',
        message: err?.message ?? String(e),
      };
    }

    const elapsedMs = Math.round(performance.now() - start);
    const reply = ok
      ? { kind: 'tool_result', call_id: callId, ok: true, result, elapsed_ms: elapsedMs }
      : { kind: 'tool_result', call_id: callId, ok: false, error, elapsed_ms: elapsedMs };

    try {
      this.ws?.send(JSON.stringify(reply));
    } catch (e) {
      console.error('[BridgeClient] failed to send tool_result:', e);
    }
  }

  private requiresConfirmation(name: string): boolean {
    return /^(fs\.write|fs\.edit|fs\.delete|shell\.)/.test(name);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const interval = this.opts.heartbeatMs ?? 15000;
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ kind: 'heartbeat', ts: Date.now() }));
        } catch {
          // ignore
        }
      }
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(wasConnected: boolean): void {
    if (!this.wantsConnected) return;
    this.clearReconnect();

    // Reset attempt count if we were connected for at least 60s before drop.
    if (wasConnected && Date.now() - this.connectedAt > 60_000) {
      this.reconnectAttempt = 0;
    }

    const max = this.opts.maxBackoffMs ?? 5000;
    const delay = Math.min(max, 250 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;

    this.reconnectTimer = window.setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private reconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, 'reconnect');
      } catch {
        // ignore
      }
    }
    void this.connect();
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let singleton: BridgeClient | null = null;

export function getBridgeClient(opts?: BridgeClientOptions): BridgeClient {
  if (!singleton) {
    if (!opts) {
      throw new Error('BridgeClient.getBridgeClient: must pass options on first call');
    }
    singleton = new BridgeClient(opts);
  }
  return singleton;
}

export function resetBridgeClient(): void {
  void singleton?.stop();
  singleton = null;
}
