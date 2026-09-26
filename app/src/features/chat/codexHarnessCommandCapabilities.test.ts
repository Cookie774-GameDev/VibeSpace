import { describe, expect, it } from 'vitest';
import {
  CODEX_HARNESS_COMMAND_MANIFEST,
  CODEX_HARNESS_SCHEMA_VERSION,
  resolveCodexHarnessCommand,
} from './codexHarnessCommandCapabilities';

describe('Codex harness command capabilities', () => {
  it('binds MCP status to the native app-server method only when live-exposed', () => {
    expect(CODEX_HARNESS_SCHEMA_VERSION).toBe('0.153.4');
    expect(CODEX_HARNESS_COMMAND_MANIFEST).toEqual([
      {
        slashCommand: '/mcp',
        appServerMethod: 'mcpServerStatus/list',
        operation: 'list-mcp-server-status',
        source: 'installed-codex-app-server-schema',
      },
    ]);
    expect(resolveCodexHarnessCommand('/mcp', new Set(['mcpServerStatus/list']))).toEqual({
      status: 'app-server-supported',
      operation: 'list-mcp-server-status',
      appServerMethod: 'mcpServerStatus/list',
    });
  });

  it('fails closed if the connected server does not expose MCP status', () => {
    expect(resolveCodexHarnessCommand('/mcp', new Set())).toEqual({
      status: 'unavailable',
      reason: 'live-app-server-method-not-exposed',
    });
  });

  it('does not infer execution support for other or malformed slash commands', () => {
    const exposed = new Set(['mcpServerStatus/list']);
    for (const input of ['/mcp status', '/mcp add', '/help', '/unknown', 'show /mcp']) {
      expect(resolveCodexHarnessCommand(input, exposed)).toEqual({
        status: 'unsupported',
        reason: 'not-in-app-server-capability-manifest',
      });
    }
  });
});
