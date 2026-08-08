import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { capabilityCatalog } from './catalog';
import type { Env, RelayInvocationResult, RelayStatus } from './contracts';

const MAX_PATH_CHARS = 4_096;
const MAX_OUTPUT_CHARS = 96_000;

const capabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  classification: z.string(),
  available: z.boolean(),
  approval_required: z.boolean(),
  unavailable_reason: z.string().optional(),
});

const workspaceSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  read_only: z.literal(true),
});

function relayFor(env: Env, subject: string) {
  return env.USER_RELAY.getByName(subject);
}

async function relayStatus(env: Env, subject: string): Promise<RelayStatus> {
  const response = await relayFor(env, subject).fetch('https://relay.internal/internal/status');
  if (!response.ok) return { connected: false, tools: [] };
  return (await response.json()) as RelayStatus;
}

async function invokeRelay(
  env: Env,
  subject: string,
  name: 'fs.list' | 'fs.read',
  args: Record<string, unknown>,
): Promise<RelayInvocationResult> {
  const response = await relayFor(env, subject).fetch('https://relay.internal/internal/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const result = (await response.json()) as RelayInvocationResult;
  return response.ok
    ? result
    : { ok: false, error: result.error ?? 'The local relay is unavailable.' };
}

function textResult(value: unknown) {
  const text = JSON.stringify(value);
  return {
    content: [
      {
        type: 'text' as const,
        text:
          text.length <= MAX_OUTPUT_CHARS ? text : JSON.stringify({ error: 'Result too large.' }),
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function createVibeSpaceMcpServer(env: Env, authInfo: AuthInfo): McpServer {
  const subject = authInfo.extra?.sub;
  if (typeof subject !== 'string' || !subject) throw new Error('Authentication is required.');

  const server = new McpServer(
    {
      name: 'VibeSpace MCP',
      version: '1.0.0',
      title: 'VibeSpace MCP',
      description:
        'Securely routes account-scoped VibeSpace tools through the signed-in desktop app.',
      icons: [
        {
          src: 'https://vibespaceos.com/favicon.svg',
          mimeType: 'image/svg+xml',
        },
      ],
    },
    { capabilities: { tools: { listChanged: false } } },
  );

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    'vibespace.get_capabilities',
    {
      title: 'Get VibeSpace capabilities',
      description:
        'Report the connected VibeSpace desktop workspace and the truthful availability and approval state of every gateway capability.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        connected: z.boolean(),
        workspace: workspaceSchema.optional(),
        tools: z.array(z.string()),
        catalog: z.array(capabilitySchema),
        writes_enabled: z.literal(false),
        terminal_enabled: z.literal(false),
      }),
      annotations: readOnly,
    },
    async () => {
      const status = await relayStatus(env, subject);
      const output = {
        connected: status.connected,
        ...(status.connected && status.workspace
          ? {
              workspace: {
                id: status.workspace.id,
                display_name: status.workspace.displayName,
                read_only: true as const,
              },
            }
          : {}),
        tools: [
          'vibespace.get_capabilities',
          'vibespace.list_workspaces',
          'vibespace.list_directory',
          'vibespace.read_file',
        ],
        catalog: capabilityCatalog(status.connected, status.tools),
        writes_enabled: false as const,
        terminal_enabled: false as const,
      };
      return textResult(output);
    },
  );

  server.registerTool(
    'vibespace.list_workspaces',
    {
      title: 'List approved VibeSpace workspaces',
      description:
        'List the one project the user explicitly granted to this signed-in VibeSpace desktop session.',
      inputSchema: z.object({}),
      outputSchema: z.object({ workspaces: z.array(workspaceSchema) }),
      annotations: readOnly,
    },
    async () => {
      const status = await relayStatus(env, subject);
      const output = {
        workspaces:
          status.connected && status.workspace
            ? [
                {
                  id: status.workspace.id,
                  display_name: status.workspace.displayName,
                  read_only: true as const,
                },
              ]
            : [],
      };
      return textResult(output);
    },
  );

  server.registerTool(
    'vibespace.list_directory',
    {
      title: 'List a project directory',
      description:
        'List one relative directory inside the currently approved VibeSpace project. Absolute paths and sensitive directories are denied on-device.',
      inputSchema: z.object({
        workspace_id: z.string().min(12).max(96),
        path: z.string().min(1).max(MAX_PATH_CHARS).default('.'),
      }),
      outputSchema: z.object({
        workspace_id: z.string(),
        path: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            is_directory: z.boolean(),
            size: z.number().int().nonnegative().optional(),
          }),
        ),
      }),
      annotations: readOnly,
    },
    async ({ workspace_id, path }) => {
      const status = await relayStatus(env, subject);
      if (!status.connected || status.workspace?.id !== workspace_id) {
        return errorResult('The requested VibeSpace workspace is unavailable.');
      }
      const response = await invokeRelay(env, subject, 'fs.list', { path });
      if (!response.ok || !response.result || typeof response.result !== 'object') {
        return errorResult(response.error ?? 'The local read was denied.');
      }
      const result = response.result as Record<string, unknown>;
      const rawEntries = Array.isArray(result.entries) ? result.entries : [];
      const output = {
        workspace_id,
        path: typeof result.path === 'string' ? result.path : path,
        entries: rawEntries
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
          )
          .map((entry) => ({
            name: String(entry.name ?? ''),
            is_directory: entry.isDir === true,
            ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
          })),
      };
      return textResult(output);
    },
  );

  server.registerTool(
    'vibespace.read_file',
    {
      title: 'Read a project file',
      description:
        'Read one bounded text file inside the approved VibeSpace project. Secrets and paths outside the grant are denied on-device.',
      inputSchema: z.object({
        workspace_id: z.string().min(12).max(96),
        path: z.string().min(1).max(MAX_PATH_CHARS),
      }),
      outputSchema: z.object({
        workspace_id: z.string(),
        path: z.string(),
        content: z.string(),
      }),
      annotations: readOnly,
    },
    async ({ workspace_id, path }) => {
      const status = await relayStatus(env, subject);
      if (!status.connected || status.workspace?.id !== workspace_id) {
        return errorResult('The requested VibeSpace workspace is unavailable.');
      }
      const response = await invokeRelay(env, subject, 'fs.read', { path });
      if (!response.ok || !response.result || typeof response.result !== 'object') {
        return errorResult(response.error ?? 'The local read was denied.');
      }
      const result = response.result as Record<string, unknown>;
      if (typeof result.content !== 'string') return errorResult('The local read was denied.');
      return textResult({
        workspace_id,
        path: typeof result.path === 'string' ? result.path : path,
        content: result.content,
      });
    },
  );

  return server;
}

export function createMcpRequestHandler(env: Env) {
  return createMcpHandler((context) => {
    if (!context.authInfo) throw new Error('Authentication is required.');
    return createVibeSpaceMcpServer(env, context.authInfo);
  });
}
