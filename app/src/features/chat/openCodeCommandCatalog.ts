import { useEffect, useState } from 'react';
import { nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';

export interface OpenCodeCommandDescriptor {
  readonly name: string;
  readonly description?: string;
}

export interface OpenCodeCommandCatalogState {
  readonly generation?: string;
  readonly commands: readonly OpenCodeCommandDescriptor[];
  readonly error?: string;
}

const EMPTY_COMMANDS: readonly OpenCodeCommandDescriptor[] = Object.freeze([]);
const EMPTY_STATE: OpenCodeCommandCatalogState = Object.freeze({ commands: EMPTY_COMMANDS });
const MAX_COMMANDS = 128;
const MAX_NAME_LENGTH = 64;
const COMMAND_CATALOG_TTL_MS = 30_000;

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
  const commands = data.slice(0, MAX_COMMANDS).flatMap((entry): OpenCodeCommandDescriptor[] => {
    if (!entry || typeof entry !== 'object') return [];
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name.trim().toLowerCase()
      : '';
    if (name.length > MAX_NAME_LENGTH || !/^[a-z][a-z0-9_-]*$/u.test(name)) return [];
    const description = typeof (entry as { description?: unknown }).description === 'string'
      ? (entry as { description: string }).description.trim().slice(0, 512)
      : undefined;
    return [{ name, ...(description ? { description } : {}) }];
  });
  return Object.freeze(Array.from(new Map(commands.map((command) => [command.name, command])).values()));
}

export async function fetchOpenCodeCommandCatalog(
  generation: string,
  request: (generation: string, path: string) => Promise<Response> = nativeOpenCodeRequest,
): Promise<readonly OpenCodeCommandDescriptor[]> {
  const response = await request(generation, '/command');
  if (!response.ok) throw new Error(`OpenCode command catalog request failed (${response.status}).`);
  return parseOpenCodeCommandCatalog(await response.json());
}

export function useOpenCodeCommandCatalog(
  generation: string | undefined,
  enabled: boolean,
): OpenCodeCommandCatalogState {
  const [state, setState] = useState<OpenCodeCommandCatalogState>(EMPTY_STATE);
  useEffect(() => {
    let active = true;
    if (!enabled || !generation) {
      setState(EMPTY_STATE);
      return () => { active = false; };
    }
    setState({ generation, commands: EMPTY_COMMANDS });
    const refresh = () => void fetchOpenCodeCommandCatalog(generation).then(
      (commands) => {
        if (active) setState({ generation, commands });
      },
      (error: unknown) => {
        if (active) setState({ generation, commands: EMPTY_COMMANDS, error: boundedError(error) });
      },
    );
    refresh();
    const timer = window.setInterval(refresh, COMMAND_CATALOG_TTL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, generation]);
  return enabled && generation && state.generation === generation ? state : EMPTY_STATE;
}
