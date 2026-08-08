import { describe, expect, it, vi } from 'vitest';
import type { ToolDef } from '@/lib/mcp/registry';
import {
  buildBridgeRegistrationFrame,
  getBridgeWorkspaceGrant,
  invokeBridgeReadTool,
  setBridgeWorkspaceGrant,
  validateBridgeToolCallFrame,
} from './BridgeClient';

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

describe('Browser Chat read-only bridge protocol', () => {
  it('keeps an explicit workspace grant in session memory and revokes it', () => {
    setBridgeWorkspaceGrant({
      id: 'grant_1234567890abcdef',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    expect(getBridgeWorkspaceGrant()).toEqual({
      id: 'grant_1234567890abcdef',
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    setBridgeWorkspaceGrant();
    expect(getBridgeWorkspaceGrant()).toBeUndefined();
  });

  it('advertises only bounded read tools and never transmits an absolute workspace root', () => {
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
      token: 'jwt-test-value',
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
