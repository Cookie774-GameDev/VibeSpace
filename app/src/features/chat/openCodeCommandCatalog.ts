import { useEffect, useState } from 'react';
import { nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';

export interface OpenCodeCommandDescriptor {
  /** Exact identifier supplied by OpenCode. */
  readonly name: string;
  readonly identifier: string;
  /** Owner/source/name key; equal names from different sources remain distinct. */
  readonly identity: string;
  /** OpenCode's command, MCP prompt, skill, or future source label. */
  readonly source: string;
  readonly executionCapability: 'session-command' | 'requires-native-cli-ui';
  readonly description?: string;
}

export interface OpenCodeCommandCatalogState {
  readonly generation?: string;
  readonly workingDirectory?: string;
  readonly commands: readonly OpenCodeCommandDescriptor[];
  readonly error?: string;
}

const EMPTY_COMMANDS: readonly OpenCodeCommandDescriptor[] = Object.freeze([]);
const EMPTY_STATE: OpenCodeCommandCatalogState = Object.freeze({ commands: EMPTY_COMMANDS });
const MAX_NAME_LENGTH = 256;
const MAX_SOURCE_LENGTH = 64;
const COMMAND_CATALOG_TTL_MS = 30_000;
const EXECUTABLE_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/iu;
const KNOWN_COMMAND_SOURCES = new Set(['command', 'mcp', 'skill']);

function encodeIdentityPart(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    // JSON can contain lone UTF-16 surrogates; preserve their identity without
    // letting one malformed label invalidate the full native catalog.
    const codeUnits = Array.from({ length: value.length }, (_, index) =>
      value.charCodeAt(index).toString(16).padStart(4, '0'),
    );
    return `utf16-${codeUnits.join('-')}`;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'OpenCode command catalog unavailable.';
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 240);
}

export function parseOpenCodeCommandCatalog(payload: unknown): readonly OpenCodeCommandDescriptor[] {
  const data =
    payload && typeof payload === 'object' && 'data' in payload
      ? (payload as { data?: unknown }).data
      : payload;
  if (!Array.isArray(data)) throw new Error('OpenCode command catalog response is malformed.');
  const commands = data.flatMap((entry): OpenCodeCommandDescriptor[] => {
    if (!entry || typeof entry !== 'object') return [];
    const rawName = (entry as { name?: unknown }).name;
    const name = typeof rawName === 'string' ? rawName : '';
    if (
      !name ||
      name.length > MAX_NAME_LENGTH ||
      name !== name.trim() ||
      /[\u0000-\u001f\u007f]/u.test(name)
    )
      return [];
    const rawSource = (entry as { source?: unknown }).source;
    const source =
      typeof rawSource === 'string' &&
      rawSource.length <= MAX_SOURCE_LENGTH &&
      rawSource === rawSource.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(rawSource)
        ? rawSource
        : rawSource === undefined
          ? 'command'
          : 'unknown';
    const description =
      typeof (entry as { description?: unknown }).description === 'string'
        ? (entry as { description: string }).description
            .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
            .trim()
            .slice(0, 512)
        : undefined;
    const executionCapability =
      KNOWN_COMMAND_SOURCES.has(source) && EXECUTABLE_COMMAND_NAME.test(name)
        ? 'session-command'
        : 'requires-native-cli-ui';
    return [
      {
        name,
        identifier: name,
        identity: `opencode:${encodeIdentityPart(source)}:${encodeIdentityPart(name)}`,
        source,
        executionCapability,
        ...(description ? { description } : {}),
      },
    ];
  });
  const uniqueCommands = new Map<string, OpenCodeCommandDescriptor>();
  for (const command of commands) {
    if (!uniqueCommands.has(command.identity)) uniqueCommands.set(command.identity, command);
  }
  return Object.freeze(Array.from(uniqueCommands.values()));
}

export async function fetchOpenCodeCommandCatalog(
  generation: string,
  request: (generation: string, path: string) => Promise<Response> = nativeOpenCodeRequest,
  workingDirectory?: string | null,
): Promise<readonly OpenCodeCommandDescriptor[]> {
  const directory = workingDirectory?.trim();
  const path = directory ? `/command?directory=${encodeURIComponent(directory)}` : '/command';
  const response = await request(generation, path);
  if (!response.ok) throw new Error(`OpenCode command catalog request failed (${response.status}).`);
  return parseOpenCodeCommandCatalog(await response.json());
}

export function useOpenCodeCommandCatalog(
  generation: string | undefined,
  enabled: boolean,
  workingDirectory?: string | null,
): OpenCodeCommandCatalogState {
  const directory = workingDirectory?.trim() || undefined;
  const [state, setState] = useState<OpenCodeCommandCatalogState>(EMPTY_STATE);
  useEffect(() => {
    let active = true;
    if (!enabled || !generation) {
      setState(EMPTY_STATE);
      return () => { active = false; };
    }
    setState({ generation, workingDirectory: directory, commands: EMPTY_COMMANDS });
    const refresh = () => void fetchOpenCodeCommandCatalog(generation, nativeOpenCodeRequest, directory).then(
      (commands) => {
        if (active) setState({ generation, workingDirectory: directory, commands });
      },
      (error: unknown) => {
        if (active) setState({ generation, workingDirectory: directory, commands: EMPTY_COMMANDS, error: boundedError(error) });
      },
    );
    refresh();
    const timer = window.setInterval(refresh, COMMAND_CATALOG_TTL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, generation, directory]);
  return enabled && generation && state.generation === generation && state.workingDirectory === directory ? state : EMPTY_STATE;
}
