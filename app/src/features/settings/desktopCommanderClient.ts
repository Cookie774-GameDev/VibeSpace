import { readTextFileSample } from '@/lib/fs';
import { nativeFetch } from '@/lib/nativeFetch';

export interface DesktopCommanderConfig {
  blockedCommands: string[];
  allowedDirectories: string[];
  defaultShell: string;
  telemetryEnabled: boolean;
  fileReadLineLimit: number;
  fileWriteLineLimit: number;
}
export interface DesktopCommanderSnapshot {
  config: DesktopCommanderConfig;
  availableShells: string[];
}
export interface DesktopCommanderClient {
  load(signal?: AbortSignal): Promise<DesktopCommanderSnapshot>;
  save<K extends keyof DesktopCommanderConfig>(
    key: K,
    value: DesktopCommanderConfig[K],
    previous: DesktopCommanderConfig[K],
    signal?: AbortSignal,
  ): Promise<DesktopCommanderSnapshot>;
}

export function parseDesktopCommanderSnapshot(value: unknown): DesktopCommanderSnapshot {
  const data = value as DesktopCommanderSnapshot | undefined;
  const config = data?.config;
  const stringList = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length <= 500 &&
    list.every((item) => typeof item === 'string' && item.length <= 4096);
  if (
    !config ||
    !stringList(config.blockedCommands) ||
    !stringList(config.allowedDirectories) ||
    typeof config.defaultShell !== 'string' ||
    !config.defaultShell.trim() ||
    config.defaultShell.length > 4096 ||
    typeof config.telemetryEnabled !== 'boolean' ||
    ![config.fileReadLineLimit, config.fileWriteLineLimit].every(
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 1000000,
    ) ||
    !stringList(data.availableShells)
  )
    throw new Error('Invalid Desktop Commander configuration response.');
  return data;
}

async function readDesktopCommanderConnection(
  connectionPath: string,
): Promise<{ endpoint: string; authorization: string }> {
  const file = await readTextFileSample(connectionPath, 16 * 1024);
  if (!file.ok)
    throw new Error(
      'Cannot read the connection file. Start the packaged gateway and select its state/connection.json.',
    );
  let connection: { version?: unknown; endpoint?: unknown; token?: unknown };
  try {
    connection = JSON.parse(file.content);
  } catch {
    throw new Error('Invalid Desktop Commander connection file.');
  }
  if (
    connection.version !== 1 ||
    typeof connection.endpoint !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(connection.endpoint) ||
    Number(new URL(connection.endpoint).port) > 65535 ||
    typeof connection.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(connection.token)
  ) {
    throw new Error('Select a connection file from the local VibeSpace Desktop Commander package.');
  }
  const endpoint = connection.endpoint;
  const authorization = `Bearer ${connection.token}`;
  return { endpoint, authorization };
}

export async function connectDesktopCommander(
  connectionPath: string,
): Promise<DesktopCommanderClient> {
  await readDesktopCommanderConnection(connectionPath);
  async function request(method: 'GET' | 'PATCH', body?: unknown, signal?: AbortSignal) {
    // A recovered gateway rotates its port and bearer. Validate the current file, never stale credentials.
    const { endpoint, authorization } = await readDesktopCommanderConnection(connectionPath);
    const response = await nativeFetch(`${endpoint}/config`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      timeoutMs: 25000,
      allowRetry: false,
    });
    if (!response.ok) {
      if (response.status === 409)
        throw new Error('This setting changed elsewhere. Reload before saving.');
      if (response.status === 401)
        throw new Error('Connection expired. Select the current connection file again.');
      throw new Error('Desktop Commander could not confirm the change. Reload before retrying.');
    }
    return parseDesktopCommanderSnapshot(await response.json());
  }
  return {
    load: (signal) => request('GET', undefined, signal),
    save: (key, value, previous, signal) => request('PATCH', { key, value, previous }, signal),
  };
}
