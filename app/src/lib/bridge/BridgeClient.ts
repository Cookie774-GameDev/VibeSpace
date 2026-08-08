/**
 * BridgeClient — long-lived WS to phone-jarvis-cloud /bridge endpoint.
 *
 * This is the cloud<->desktop tool dispatcher. While Jarvis is open and the
 * user is signed into Supabase, we keep one WSS open to the cloud so that
 * when the AI on a phone call (Path A) or in-app call (Path C) emits a
 * tool_use, the cloud can route a bounded read request here. Only content
 * from an explicitly granted project root may leave the device.
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
import { listDirectory, readTextFileSample, type FsListResult, type FsReadResult } from '@/lib/fs';
import { isPathInsideRoot, normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import { applySecretPolicy } from '@/lib/security/secretDetector';

const BRIDGE_PROTOCOL_VERSION = 2;
const SAFE_READ_TOOLS = new Set(['fs.list', 'fs.read']);
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_DEADLINE_MS = 30_000;
const MAX_RESULT_ENTRIES = 500;
const MAX_SEEN_CALLS = 256;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{12,96}$/u;

type ReadToolName = 'fs.list' | 'fs.read';

interface BridgeRegistrationOptions {
  jwt: string;
  tools: ToolDef[];
  workspaceRoot?: string;
  workspaceGrant?: BridgeWorkspaceGrantMetadata;
  clientNonce: string;
  daemonVersion?: string;
  platform?: string;
}

export interface BridgeWorkspaceGrantMetadata {
  id: string;
  displayName: string;
}

export interface BridgeWorkspaceGrant extends BridgeWorkspaceGrantMetadata {
  root: string;
}

interface BridgeToolCallContext {
  sessionId: string;
  workspaceRoot: string;
  advertisedTools: ReadonlySet<string>;
  nowMs: number;
  lastSequence: number;
  seenCallIds: ReadonlySet<string>;
}

export interface ValidatedBridgeReadCall {
  callId: string;
  name: ReadToolName;
  path: string;
  sequence: number;
}

interface BridgeReadDependencies {
  readText: (
    path: string,
    maxBytes: number,
    options: { root: string; strictProjectBoundary: true },
  ) => Promise<FsReadResult>;
  list: (
    path: string,
    options: { root: string; strictProjectBoundary: true },
  ) => Promise<FsListResult>;
}

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
  /** Optional authenticated one-time URL resolver for hosted relay gateways. */
  resolveUrl?: (jwt: string) => Promise<string>;
  /** Supabase JWT — sent in the register frame */
  jwt: string;
  /** Explicit session-only read grant. Its local root is never transmitted. */
  workspaceGrant?: BridgeWorkspaceGrant;
  /** Phone/Voice is the compatibility default; Browser Chat is isolated. */
  mode?: 'phone_voice' | 'browser_chat';
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

function safeWorkspaceRoot(root: string | undefined): string | null {
  return root ? normalizePortableAbsolutePath(root) : null;
}

function safeWorkspaceGrant(
  grant: BridgeWorkspaceGrant | undefined,
): BridgeWorkspaceGrant | undefined {
  const root = safeWorkspaceRoot(grant?.root);
  const id = grant?.id.trim() ?? '';
  const displayName = grant?.displayName.trim() ?? '';
  if (
    !root ||
    !SAFE_IDENTIFIER.test(id) ||
    !displayName ||
    displayName.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    return undefined;
  }
  return { id, root, displayName };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function relativePortablePath(path: string, root: string): string {
  const normalizedPath = normalizePortableAbsolutePath(path);
  const normalizedRoot = normalizePortableAbsolutePath(root);
  if (!normalizedPath || !normalizedRoot || !isPathInsideRoot(normalizedPath, normalizedRoot)) {
    throw new Error('Local read request was denied.');
  }
  if (normalizedPath === normalizedRoot) return '.';
  return normalizedPath
    .slice(normalizedRoot.length)
    .replace(/^[\\/]+/u, '')
    .replace(/\\/gu, '/');
}

function isBlockedPathSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    segment.includes(':') ||
    name === '.git' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'target' ||
    name === '.ssh' ||
    name === '.gnupg' ||
    name === '.aws' ||
    name === '.azure' ||
    name === '.kube' ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === '.netrc'
  );
}

function resolveGrantedRelativePath(rawPath: string, root: string): string | null {
  if (
    !rawPath ||
    rawPath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(rawPath) ||
    /^[A-Za-z]:[\\/]/u.test(rawPath) ||
    /^[\\/]/u.test(rawPath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawPath)
  ) {
    return null;
  }
  const segments = rawPath.replace(/\\/gu, '/').split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const cleaned = segments.filter((segment) => segment && segment !== '.');
  if (cleaned.length > 24 || cleaned.some(isBlockedPathSegment)) {
    return null;
  }
  const separator = /^[A-Za-z]:[\\/]/u.test(root) || root.includes('\\') ? '\\' : '/';
  const candidate = cleaned.length
    ? `${root.replace(/[\\/]+$/u, '')}${separator}${cleaned.join(separator)}`
    : root;
  const normalized = normalizePortableAbsolutePath(candidate);
  return normalized && isPathInsideRoot(normalized, root) ? normalized : null;
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `nonce_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function buildBridgeRegistrationFrame(options: BridgeRegistrationOptions) {
  const workspaceRoot = safeWorkspaceRoot(options.workspaceRoot);
  const workspaceGrant =
    workspaceRoot &&
    options.workspaceGrant &&
    SAFE_IDENTIFIER.test(options.workspaceGrant.id) &&
    options.workspaceGrant.displayName.trim() &&
    options.workspaceGrant.displayName.trim().length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(options.workspaceGrant.displayName)
      ? {
          id: options.workspaceGrant.id,
          display_name: options.workspaceGrant.displayName.trim(),
        }
      : undefined;
  const safeTools =
    workspaceRoot && workspaceGrant
      ? options.tools
          .filter((tool) => SAFE_READ_TOOLS.has(tool.name))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
  return {
    kind: 'register' as const,
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    token: options.jwt,
    client_nonce: options.clientNonce,
    daemon_version: options.daemonVersion ?? 'jarvis-app/0.1.0',
    platform:
      options.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : 'unknown'),
    tools: toToolSchema(safeTools),
    writable: false,
    shell_enabled: false,
    ...(workspaceGrant ? { workspace_grant: workspaceGrant } : {}),
  };
}

export function validateBridgeToolCallFrame(
  frame: unknown,
  context: BridgeToolCallContext,
): ValidatedBridgeReadCall {
  if (!isPlainRecord(frame) || frame.kind !== 'tool_call') {
    throw new Error('Malformed tool call.');
  }
  const sessionId = typeof frame.session_id === 'string' ? frame.session_id : '';
  if (sessionId !== context.sessionId) throw new Error('Tool call session mismatch.');
  const callId = typeof frame.call_id === 'string' ? frame.call_id : '';
  if (!SAFE_IDENTIFIER.test(callId)) throw new Error('Malformed tool call identifier.');
  if (context.seenCallIds.has(callId)) throw new Error('Replayed tool call.');

  const name = typeof frame.name === 'string' ? frame.name : '';
  if (!context.advertisedTools.has(name) || !SAFE_READ_TOOLS.has(name)) {
    throw new Error('Tool was not advertised.');
  }
  if (!isPlainRecord(frame.args)) throw new Error('Malformed tool call arguments.');
  if (jsonBytes(frame.args) > MAX_ARGUMENT_BYTES)
    throw new Error('Tool call arguments are too large.');

  const sequence = frame.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) <= context.lastSequence) {
    throw new Error('Replayed tool call sequence.');
  }
  const issuedAtMs = frame.issued_at_ms;
  const expiresAtMs = frame.expires_at_ms;
  const deadlineMs = frame.deadline_ms;
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    !Number.isSafeInteger(deadlineMs)
  ) {
    throw new Error('Malformed tool call timing.');
  }
  if ((issuedAtMs as number) > context.nowMs + 5_000) throw new Error('Tool call is not current.');
  if ((expiresAtMs as number) <= context.nowMs) throw new Error('Tool call expired.');
  if (
    (expiresAtMs as number) <= (issuedAtMs as number) ||
    (expiresAtMs as number) - (issuedAtMs as number) > MAX_DEADLINE_MS
  ) {
    throw new Error('Malformed tool call expiry.');
  }
  if ((deadlineMs as number) < 100 || (deadlineMs as number) > MAX_DEADLINE_MS) {
    throw new Error('Malformed tool call deadline.');
  }

  const root = safeWorkspaceRoot(context.workspaceRoot);
  const rawPath = frame.args.path;
  const path =
    typeof rawPath === 'string' && root ? resolveGrantedRelativePath(rawPath, root) : null;
  if (!path || !root) {
    throw new Error('Tool call path is outside the granted workspace.');
  }
  return { callId, name: name as ReadToolName, path, sequence: sequence as number };
}

export async function invokeBridgeReadTool(
  call: ValidatedBridgeReadCall,
  workspaceRoot: string,
  dependencies: BridgeReadDependencies = {
    readText: readTextFileSample,
    list: listDirectory,
  },
): Promise<unknown> {
  const root = safeWorkspaceRoot(workspaceRoot);
  if (!root || !isPathInsideRoot(call.path, root)) {
    throw new Error('Local read request was denied.');
  }
  try {
    if (call.name === 'fs.read') {
      const result = await dependencies.readText(call.path, 48_000, {
        root,
        strictProjectBoundary: true,
      });
      if (!result.ok) throw new Error('denied');
      const secretPolicy = applySecretPolicy(result.content, 'exclude');
      if (secretPolicy.decision !== 'allowed' || secretPolicy.text === undefined) {
        throw new Error('denied');
      }
      return { path: relativePortablePath(call.path, root), content: secretPolicy.text };
    }
    const result = await dependencies.list(call.path, {
      root,
      strictProjectBoundary: true,
    });
    if (!result.ok) throw new Error('denied');
    return {
      path: relativePortablePath(call.path, root),
      entries: result.entries
        .filter((entry) => !isBlockedPathSegment(entry.name))
        .slice(0, MAX_RESULT_ENTRIES)
        .map((entry) => ({
          name: entry.name,
          isDir: entry.isDir,
          ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
        })),
    };
  } catch {
    throw new Error('Local read request was denied.');
  }
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
  private clientNonce = makeNonce();
  private advertisedTools = new Set<string>();
  private lastSequence = 0;
  private seenCallIds = new Set<string>();

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

  /** Apply or revoke the current explicit session-only read grant. */
  setWorkspaceGrant(workspaceGrant?: BridgeWorkspaceGrant): void {
    const normalized = safeWorkspaceGrant(workspaceGrant);
    if (
      this.opts.workspaceGrant?.id === normalized?.id &&
      this.opts.workspaceGrant?.root === normalized?.root &&
      this.opts.workspaceGrant?.displayName === normalized?.displayName
    ) {
      return;
    }
    this.opts.workspaceGrant = normalized;
    if (this.wantsConnected) this.reconnect();
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
      const resolvedUrl = this.opts.resolveUrl
        ? await this.opts.resolveUrl(this.opts.jwt)
        : this.opts.url;
      if (!/^wss?:\/\//u.test(resolvedUrl)) {
        throw new Error('The bridge URL is invalid.');
      }
      const ws = new WebSocket(resolvedUrl);
      this.ws = ws;

      const registerPromise = new Promise<void>((resolve, reject) => {
        this.registerPending = { resolve, reject };
      });

      ws.onopen = () => {
        const tools = toolRegistry.list();
        const registerFrame =
          this.opts.mode === 'browser_chat'
            ? buildBridgeRegistrationFrame({
                jwt: this.opts.jwt,
                tools,
                workspaceRoot: this.opts.workspaceGrant?.root,
                workspaceGrant: this.opts.workspaceGrant,
                clientNonce: this.clientNonce,
                daemonVersion: this.opts.daemonVersion,
                platform: this.opts.platform,
              })
            : {
                kind: 'register' as const,
                token: this.opts.jwt,
                daemon_version: this.opts.daemonVersion ?? 'jarvis-app/0.1.0',
                platform:
                  this.opts.platform ??
                  (typeof navigator !== 'undefined' ? navigator.platform : 'unknown'),
                tools: toToolSchema(tools),
                writable: false,
                shell_enabled: false,
              };
        this.advertisedTools = new Set(
          registerFrame.tools.map((tool) =>
            String((tool.function as Record<string, unknown>).name ?? ''),
          ),
        );
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
        if (typeof frame.session_id !== 'string' || !SAFE_IDENTIFIER.test(frame.session_id)) {
          this.registerPending?.reject(new Error('Bridge registration response was invalid.'));
          this.registerPending = null;
          this.ws?.close(4002, 'invalid registration response');
          return;
        }
        if (
          this.opts.mode === 'browser_chat' &&
          (frame.protocol_version !== BRIDGE_PROTOCOL_VERSION ||
            typeof frame.server_nonce !== 'string' ||
            !SAFE_IDENTIFIER.test(frame.server_nonce))
        ) {
          this.registerPending?.reject(new Error('Bridge registration response was invalid.'));
          this.registerPending = null;
          this.ws?.close(4002, 'invalid registration response');
          return;
        }
        this.sessionId = frame.session_id;
        this.lastSequence = 0;
        this.seenCallIds.clear();
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
    if (this.opts.mode !== 'browser_chat') {
      await this.handlePhoneVoiceToolCall(frame);
      return;
    }
    const start = performance.now();
    let result: unknown = null;
    let ok = true;
    let error: { code: string; message: string } | undefined;
    let callId =
      typeof frame.call_id === 'string' && SAFE_IDENTIFIER.test(frame.call_id)
        ? frame.call_id
        : 'invalid_call';
    let sequence = Number.isSafeInteger(frame.sequence) ? Number(frame.sequence) : 0;

    try {
      if (!this.sessionId || !this.opts.workspaceGrant) {
        throw new Error('Bridge has no local grant.');
      }
      const call = validateBridgeToolCallFrame(frame, {
        sessionId: this.sessionId,
        workspaceRoot: this.opts.workspaceGrant.root,
        advertisedTools: this.advertisedTools,
        nowMs: Date.now(),
        lastSequence: this.lastSequence,
        seenCallIds: this.seenCallIds,
      });
      callId = call.callId;
      sequence = call.sequence;
      this.lastSequence = call.sequence;
      this.seenCallIds.add(call.callId);
      if (this.seenCallIds.size > MAX_SEEN_CALLS) {
        const oldest = this.seenCallIds.values().next().value;
        if (oldest) this.seenCallIds.delete(oldest);
      }
      result = await invokeBridgeReadTool(call, this.opts.workspaceGrant.root);
    } catch {
      ok = false;
      error = {
        code: 'LOCAL_READ_DENIED',
        message: 'Local read request was denied.',
      };
    }

    const elapsedMs = Math.round(performance.now() - start);
    const reply = ok
      ? {
          kind: 'tool_result',
          session_id: this.sessionId,
          call_id: callId,
          sequence,
          ok: true,
          result,
          elapsed_ms: elapsedMs,
        }
      : {
          kind: 'tool_result',
          session_id: this.sessionId,
          call_id: callId,
          sequence,
          ok: false,
          error,
          elapsed_ms: elapsedMs,
        };

    try {
      this.ws?.send(JSON.stringify(reply));
    } catch (e) {
      console.error('[BridgeClient] failed to send tool_result:', e);
    }
  }

  private async handlePhoneVoiceToolCall(frame: BridgeFrame): Promise<void> {
    const callId = String(frame.call_id ?? '');
    const name = String(frame.name ?? '');
    const args = (frame.args ?? {}) as Record<string, unknown>;
    const confirmed = Boolean(frame.confirmed);
    const start = performance.now();
    let result: unknown = null;
    let ok = true;
    let error: { code: string; message: string } | undefined;

    try {
      if (/^(fs\.write|fs\.edit|fs\.delete|shell\.)/u.test(name) && !confirmed) {
        ok = false;
        error = {
          code: 'CONFIRM_REQUIRED',
          message: `Tool "${name}" requires explicit user confirmation; cloud did not flag confirmed=true`,
        };
      } else {
        result = await toolRegistry.invoke(name, args);
      }
    } catch (cause) {
      ok = false;
      const failure = cause as Error;
      error = {
        code: 'TOOL_ERROR',
        message: failure?.message ?? String(cause),
      };
    }

    const elapsedMs = Math.round(performance.now() - start);
    const reply = ok
      ? { kind: 'tool_result', call_id: callId, ok: true, result, elapsed_ms: elapsedMs }
      : { kind: 'tool_result', call_id: callId, ok: false, error, elapsed_ms: elapsedMs };
    try {
      this.ws?.send(JSON.stringify(reply));
    } catch (cause) {
      console.error('[BridgeClient] failed to send tool_result:', cause);
    }
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
let browserChatSingleton: BridgeClient | null = null;
let pendingWorkspaceGrant: BridgeWorkspaceGrant | undefined;

export function getBridgeClient(opts?: BridgeClientOptions): BridgeClient {
  if (!singleton) {
    if (!opts) {
      throw new Error('BridgeClient.getBridgeClient: must pass options on first call');
    }
    singleton = new BridgeClient({
      ...opts,
      mode: 'phone_voice',
    });
  }
  return singleton;
}

export function resetBridgeClient(): void {
  void singleton?.stop();
  singleton = null;
}

export function getBrowserChatBridgeClient(opts?: BridgeClientOptions): BridgeClient {
  if (!browserChatSingleton) {
    if (!opts) {
      throw new Error('BridgeClient.getBrowserChatBridgeClient: must pass options on first call');
    }
    browserChatSingleton = new BridgeClient({
      ...opts,
      mode: 'browser_chat',
      workspaceGrant: pendingWorkspaceGrant ?? safeWorkspaceGrant(opts.workspaceGrant),
    });
  }
  return browserChatSingleton;
}

export function resetBrowserChatBridgeClient(): void {
  void browserChatSingleton?.stop();
  browserChatSingleton = null;
}

export function setBridgeWorkspaceGrant(workspaceGrant?: BridgeWorkspaceGrant): void {
  pendingWorkspaceGrant = safeWorkspaceGrant(workspaceGrant);
  browserChatSingleton?.setWorkspaceGrant(pendingWorkspaceGrant);
}

export function getBridgeWorkspaceGrant(): BridgeWorkspaceGrant | undefined {
  return pendingWorkspaceGrant ? { ...pendingWorkspaceGrant } : undefined;
}
