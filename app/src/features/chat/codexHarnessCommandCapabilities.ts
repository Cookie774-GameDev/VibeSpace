/**
 * Local evidence-backed Codex harness capabilities.
 *
 * The installed codex-cli 0.153.4 app-server schema exposes
 * `mcpServerStatus/list`, but this module does not assume the connected server
 * implements it. The caller must pass methods actually exposed by its live
 * Codex connection before dispatching. No slash text is ever converted to a
 * prompt or executed as a CLI command here.
 */
export const CODEX_HARNESS_SCHEMA_VERSION = '0.153.4';

export const CODEX_HARNESS_COMMAND_MANIFEST = Object.freeze([
  Object.freeze({
    slashCommand: '/mcp',
    appServerMethod: 'mcpServerStatus/list',
    operation: 'list-mcp-server-status' as const,
    source: 'installed-codex-app-server-schema' as const,
  }),
]);

export type CodexHarnessCommandResolution =
  | {
      readonly status: 'app-server-supported';
      readonly operation: 'list-mcp-server-status';
      readonly appServerMethod: 'mcpServerStatus/list';
    }
  | {
      readonly status: 'unsupported';
      readonly reason: 'not-in-app-server-capability-manifest';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'live-app-server-method-not-exposed';
    };

/**
 * Resolve an exact slash action only when the connected app-server exposes its
 * native method. Unknown commands fail closed and must not be sent as prose.
 */
export function resolveCodexHarnessCommand(
  input: string,
  exposedAppServerMethods: ReadonlySet<string>,
): CodexHarnessCommandResolution {
  const normalized = input.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  const capability = CODEX_HARNESS_COMMAND_MANIFEST.find(
    (entry) => normalized === entry.slashCommand,
  );

  if (!capability) {
    return {
      status: 'unsupported',
      reason: 'not-in-app-server-capability-manifest',
    };
  }

  if (!exposedAppServerMethods.has(capability.appServerMethod)) {
    return { status: 'unavailable', reason: 'live-app-server-method-not-exposed' };
  }

  return {
    status: 'app-server-supported',
    operation: capability.operation,
    appServerMethod: capability.appServerMethod,
  };
}
