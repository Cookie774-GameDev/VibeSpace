import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDef } from '@/lib/mcp/registry';
import type { BrowserChatPermissionProfile } from '@/features/browser-chat/permissionRegistry';
import {
  browserChatToolActivityStore,
  clearBrowserChatToolActivity,
} from '@/features/browser-chat/browserChatToolActivity';
import { toolRegistry } from '@/lib/mcp/registry';
import {
  buildBridgeRegistrationFrame,
  BridgeClient,
  getBridgeWorkspaceGrant,
  invokeBridgeReadTool,
  setBridgeWorkspaceGrant,
  validateBridgeToolCallFrame,
} from './BridgeClient';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const tools: ToolDef[] = [
  {
    name: 'fs.read',
    description: 'Read one file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    invoke: vi.fn(),
  },
  {
    name: 'fs.list',
    description: 'List one folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    invoke: vi.fn(),
  },
  {
    name: 'shell.run',
    description: 'Run a command.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    invoke: vi.fn(),
  },
];

function permissionProfile(
  plan: BrowserChatPermissionProfile['plan'],
): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    plan,
    overrides: {},
    updatedAt: 1,
  };
}

describe('Browser Chat read-only bridge protocol', () => {
  it('keeps an explicit workspace grant in session memory and revokes it', () => {
    setBridgeWorkspaceGrant({
      id: 'grant_1234567890abcdef',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    expect(getBridgeWorkspaceGrant()).toEqual({
      id: 'grant_1234567890abcdef',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    expect(getBridgeWorkspaceGrant('account-b', 'workspace-a', 'project-a')).toBeUndefined();
    expect(getBridgeWorkspaceGrant('account-a', 'workspace-b', 'project-a')).toBeUndefined();
    expect(getBridgeWorkspaceGrant('account-a', 'workspace-a', 'project-b')).toBeUndefined();
    expect(getBridgeWorkspaceGrant('account-a', 'workspace-a', 'project-a')).toMatchObject({
      root: 'C:\\Users\\viper\\Projects\\Safe',
    });
    setBridgeWorkspaceGrant();
    expect(getBridgeWorkspaceGrant()).toBeUndefined();
  });

  it('advertises only bounded read tools without transmitting the account token or absolute root', () => {
    const frame = buildBridgeRegistrationFrame({
      jwt: 'jwt-test-value',
      tools,
      workspaceRoot: 'C:\\Users\\viper\\Projects\\Safe',
      workspaceGrant: {
        id: 'grant_1234567890abcdef',
        displayName: 'Safe',
      },
      clientNonce: 'nonce_1234567890123456',
      daemonVersion: '1.5.0',
      platform: 'win32',
    });

    expect(frame).toMatchObject({
      kind: 'register',
      protocol_version: 2,
      client_nonce: 'nonce_1234567890123456',
      writable: false,
      shell_enabled: false,
      workspace_grant: {
        id: 'grant_1234567890abcdef',
        display_name: 'Safe',
      },
    });
    expect(frame.tools.map((entry) => (entry.function as Record<string, unknown>).name)).toEqual([
      'fs.list',
      'fs.read',
    ]);
    expect(JSON.stringify(frame)).not.toContain('C:\\\\Users\\\\viper');
    expect(frame).not.toHaveProperty('token');
    expect(frame).not.toHaveProperty('workspace_root');
  });

  it('advertises no local tools without an explicit absolute workspace root', () => {
    const frame = buildBridgeRegistrationFrame({
      jwt: 'jwt-test-value',
      tools,
      clientNonce: 'nonce_1234567890123456',
    });
    expect(frame.tools).toEqual([]);
  });

  it('derives the read catalog from the active permission profile and fails closed', () => {
    const makeFrame = (profile: BrowserChatPermissionProfile) =>
      buildBridgeRegistrationFrame({
        jwt: 'jwt-test-value',
        tools,
        workspaceRoot: 'C:\\Users\\viper\\Projects\\Safe',
        workspaceGrant: {
          id: 'grant_1234567890abcdef',
          displayName: 'Safe',
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          permissionProfile: profile,
        },
        clientNonce: 'nonce_1234567890123456',
      });

    expect(makeFrame(permissionProfile('off')).tools).toEqual([]);
    expect(
      makeFrame(permissionProfile('read')).tools.map(
        (entry) => (entry.function as Record<string, unknown>).name,
      ),
    ).toEqual(['fs.list', 'fs.read']);
    expect(
      makeFrame({
        ...permissionProfile('custom'),
        overrides: { 'files.read': 'auto' },
      }).tools.map((entry) => (entry.function as Record<string, unknown>).name),
    ).toEqual(['fs.read']);
    expect(
      makeFrame({
        ...permissionProfile('read'),
        accountId: 'wrong-account',
      }).tools,
    ).toEqual([]);
  });

  it('accepts one current session-bound call and rejects replay, expiry, and unadvertised tools', () => {
    const base = {
      kind: 'tool_call',
      session_id: 'br_1234567890abcdef',
      call_id: 'tc_1234567890ab',
      name: 'fs.read',
      args: { path: 'README.md' },
      sequence: 1,
      issued_at_ms: 10_000,
      expires_at_ms: 20_000,
      deadline_ms: 8_000,
    };
    const context = {
      sessionId: 'br_1234567890abcdef',
      workspaceRoot: 'C:\\Users\\viper\\Projects\\Safe',
      advertisedTools: new Set(['fs.read', 'fs.list']),
      nowMs: 15_000,
      lastSequence: 0,
      seenCallIds: new Set<string>(),
    };

    expect(validateBridgeToolCallFrame(base, context)).toMatchObject({
      callId: 'tc_1234567890ab',
      name: 'fs.read',
      path: 'C:\\Users\\viper\\Projects\\Safe\\README.md',
      sequence: 1,
    });
    expect(() =>
      validateBridgeToolCallFrame(base, {
        ...context,
        lastSequence: 1,
        seenCallIds: new Set(['tc_1234567890ab']),
      }),
    ).toThrow(/replayed/i);
    expect(() => validateBridgeToolCallFrame({ ...base, expires_at_ms: 14_999 }, context)).toThrow(
      /expired/i,
    );
    expect(() => validateBridgeToolCallFrame({ ...base, name: 'shell.run' }, context)).toThrow(
      /not advertised/i,
    );
  });

  it('rejects traversal, a wrong session, malformed arguments, and oversized calls', () => {
    const context = {
      sessionId: 'br_1234567890abcdef',
      workspaceRoot: 'C:\\Users\\viper\\Projects\\Safe',
      advertisedTools: new Set(['fs.read', 'fs.list']),
      nowMs: 15_000,
      lastSequence: 0,
      seenCallIds: new Set<string>(),
    };
    const base = {
      kind: 'tool_call',
      session_id: 'br_1234567890abcdef',
      call_id: 'tc_1234567890ab',
      name: 'fs.read',
      args: { path: 'C:\\Users\\viper\\Projects\\Safe\\README.md' },
      sequence: 1,
      issued_at_ms: 10_000,
      expires_at_ms: 20_000,
      deadline_ms: 8_000,
    };

    expect(() =>
      validateBridgeToolCallFrame({ ...base, args: { path: '..\\secret.txt' } }, context),
    ).toThrow(/outside/i);
    expect(() =>
      validateBridgeToolCallFrame({ ...base, session_id: 'br_wrongwrongwrong' }, context),
    ).toThrow(/session/i);
    expect(() => validateBridgeToolCallFrame({ ...base, args: [] }, context)).toThrow(/arguments/i);
    expect(() =>
      validateBridgeToolCallFrame(
        { ...base, args: { path: `${'x'.repeat(70_000)}.txt` } },
        context,
      ),
    ).toThrow(/large/i);
  });

  it('uses the strict native root boundary and returns only bounded read data', async () => {
    const readText = vi.fn(async () => ({
      ok: true as const,
      path: 'C:\\Users\\viper\\Projects\\Safe\\README.md',
      content: 'hello',
    }));
    const list = vi.fn(async () => ({
      ok: true as const,
      path: 'C:\\Users\\viper\\Projects\\Safe',
      entries: [
        { name: 'README.md', path: 'ignored remotely', isDir: false, size: 5 },
        { name: '.env', path: 'never exposed', isDir: false, size: 20 },
        { name: '.git', path: 'never exposed', isDir: true },
      ],
    }));

    await expect(
      invokeBridgeReadTool(
        {
          callId: 'tc_1234567890ab',
          name: 'fs.read',
          path: 'C:\\Users\\viper\\Projects\\Safe\\README.md',
          sequence: 1,
        },
        'C:\\Users\\viper\\Projects\\Safe',
        { readText, list },
      ),
    ).resolves.toEqual({ path: 'README.md', content: 'hello' });
    expect(readText).toHaveBeenCalledWith('C:\\Users\\viper\\Projects\\Safe\\README.md', 48_000, {
      root: 'C:\\Users\\viper\\Projects\\Safe',
      strictProjectBoundary: true,
    });

    await expect(
      invokeBridgeReadTool(
        {
          callId: 'tc_1234567890ac',
          name: 'fs.list',
          path: 'C:\\Users\\viper\\Projects\\Safe',
          sequence: 2,
        },
        'C:\\Users\\viper\\Projects\\Safe',
        { readText, list },
      ),
    ).resolves.toEqual({
      path: '.',
      entries: [{ name: 'README.md', isDir: false, size: 5 }],
    });
    expect(list).toHaveBeenCalledWith('C:\\Users\\viper\\Projects\\Safe', {
      root: 'C:\\Users\\viper\\Projects\\Safe',
      strictProjectBoundary: true,
    });
  });

  it('returns a fixed safe failure instead of native paths or raw provider errors', async () => {
    await expect(
      invokeBridgeReadTool(
        {
          callId: 'tc_1234567890ab',
          name: 'fs.read',
          path: 'C:\\Users\\viper\\Projects\\Safe\\secret.txt',
          sequence: 1,
        },
        'C:\\Users\\viper\\Projects\\Safe',
        {
          readText: vi.fn(async () => ({
            ok: false as const,
            path: 'C:\\Users\\viper\\Projects\\Safe\\secret.txt',
            error: { code: 'outside_root' as const, raw: 'C:\\Users\\viper\\.ssh\\id_ed25519' },
          })),
          list: vi.fn(),
        },
      ),
    ).rejects.toThrow('Local read request was denied.');
  });

  it('blocks credential files and secret-shaped content before either can leave the device', async () => {
    const context = {
      sessionId: 'br_1234567890abcdef',
      workspaceRoot: 'C:\\Users\\viper\\Projects\\Safe',
      advertisedTools: new Set(['fs.read']),
      nowMs: 15_000,
      lastSequence: 0,
      seenCallIds: new Set<string>(),
    };
    expect(() =>
      validateBridgeToolCallFrame(
        {
          kind: 'tool_call',
          session_id: context.sessionId,
          call_id: 'tc_1234567890ab',
          name: 'fs.read',
          args: { path: '.env.local' },
          sequence: 1,
          issued_at_ms: 10_000,
          expires_at_ms: 20_000,
          deadline_ms: 8_000,
        },
        context,
      ),
    ).toThrow(/outside/i);

    await expect(
      invokeBridgeReadTool(
        {
          callId: 'tc_1234567890ac',
          name: 'fs.read',
          path: 'C:\\Users\\viper\\Projects\\Safe\\notes.txt',
          sequence: 2,
        },
        context.workspaceRoot,
        {
          readText: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Users\\viper\\Projects\\Safe\\notes.txt',
            content: ['OPENAI_API_KEY=', 'sk-', 'this-is-a-secret-value'].join(''),
          })),
          list: vi.fn(),
        },
      ),
    ).rejects.toThrow('Local read request was denied.');
  });
});

describe('BridgeClient connection ownership and liveness', () => {
  afterEach(() => {
    clearBrowserChatToolActivity();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances.length = 0;
  });

  it('publishes an account-scoped catalog and bounded live tool result truth', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const priorRead = toolRegistry.get('fs.read');
    const priorList = toolRegistry.get('fs.list');
    const unregisterRead = toolRegistry.register(tools[0]!);
    const unregisterList = toolRegistry.register(tools[1]!);
    const client = new BridgeClient({
      url: 'wss://relay.example/bridge',
      jwt: 'jwt',
      mode: 'browser_chat',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      workspaceGrant: {
        id: 'grant_1234567890abcdef',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        root: 'C:\\Users\\viper\\Projects\\Safe',
        displayName: 'Safe',
        permissionProfile: permissionProfile('read'),
      },
    });

    try {
      const start = client.start();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({
        kind: 'registered',
        protocol_version: 2,
        session_id: 'session_1234567890abcdef',
        server_nonce: 'nonce_1234567890123456',
      });
      await start;
      expect(browserChatToolActivityStore.getSnapshot()).toMatchObject({
        accountId: 'account-a',
        advertisedTools: ['fs.list', 'fs.read'],
      });

      const now = Date.now();
      socket.message({
        kind: 'tool_call',
        protocol_version: 2,
        session_id: 'session_1234567890abcdef',
        call_id: 'call_123456789012',
        sequence: 1,
        name: 'fs.read',
        args: { path: 'README.md' },
        issued_at_ms: now,
        expires_at_ms: now + 5_000,
        deadline_ms: 5_000,
      });
      await vi.waitFor(() => {
        expect(browserChatToolActivityStore.getSnapshot().lastResult).toMatchObject({
          callId: 'call_123456789012',
          toolName: 'fs.read',
          ok: false,
          errorCode: 'LOCAL_READ_DENIED',
        });
      });
      expect(browserChatToolActivityStore.getSnapshot().activeCalls).toEqual([]);

      await client.stop();
      expect(browserChatToolActivityStore.getSnapshot().accountId).toBeNull();
    } finally {
      unregisterRead();
      unregisterList();
      if (priorRead) toolRegistry.register(priorRead);
      if (priorList) toolRegistry.register(priorList);
    }
  });

  it('abandons a socket that never acknowledges registration and schedules one replacement', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses: string[] = [];
    const client = new BridgeClient({
      url: 'wss://relay.example/bridge',
      jwt: 'jwt',
      mode: 'browser_chat',
      registrationTimeoutMs: 20,
      maxBackoffMs: 10,
      onStatus: (status) => statuses.push(status),
    });

    const start = client.start();
    FakeWebSocket.instances[0]?.open();
    await vi.advanceTimersByTimeAsync(21);
    await start;
    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(statuses).toContain('error');
    await client.stop();
  });

  it('requires heartbeat acknowledgements and ignores the replaced socket generation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new BridgeClient({
      url: 'wss://relay.example/bridge',
      jwt: 'jwt',
      mode: 'browser_chat',
      heartbeatMs: 10,
      heartbeatTimeoutMs: 25,
      maxBackoffMs: 1,
    });

    const start = client.start();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message({
      kind: 'registered',
      protocol_version: 2,
      session_id: 'session_1234567890abcdef',
      server_nonce: 'nonce_1234567890123456',
    });
    await start;
    await vi.advanceTimersByTimeAsync(20);
    first.message({ kind: 'heartbeat_ack', ts: Date.now() });
    await vi.advanceTimersByTimeAsync(20);
    expect(first.readyState).toBe(FakeWebSocket.OPEN);

    client.requestReconnect();
    await vi.advanceTimersByTimeAsync(0);
    const second = FakeWebSocket.instances[1]!;
    first.message({
      kind: 'registered',
      protocol_version: 2,
      session_id: 'session_stale123456789',
      server_nonce: 'nonce_stale1234567890',
    });
    expect(client.isConnected()).toBe(false);
    second.open();
    second.message({
      kind: 'registered',
      protocol_version: 2,
      session_id: 'session_abcdef1234567890',
      server_nonce: 'nonce_abcdef1234567890',
    });
    expect(client.isConnected()).toBe(true);
    await client.stop();
  });

  it('re-registers immediately when only the permission profile changes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const baseGrant = {
      id: 'grant_1234567890abcdef',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    };
    const client = new BridgeClient({
      url: 'wss://relay.example/bridge',
      jwt: 'jwt',
      mode: 'browser_chat',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      workspaceGrant: {
        ...baseGrant,
        permissionProfile: permissionProfile('read'),
      },
      maxBackoffMs: 1,
    });

    const start = client.start();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message({
      kind: 'registered',
      protocol_version: 2,
      session_id: 'session_1234567890abcdef',
      server_nonce: 'nonce_1234567890123456',
    });
    await start;

    client.setWorkspaceGrant({
      ...baseGrant,
      permissionProfile: permissionProfile('off'),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await client.stop();
  });
});
