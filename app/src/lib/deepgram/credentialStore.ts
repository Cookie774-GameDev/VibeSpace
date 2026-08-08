import { isTauri } from '@/lib/utils';

export const DEEPGRAM_CREDENTIAL_EVENT = 'vibespace:deepgram-credential-changed';
export const DEEPGRAM_CREDENTIAL_ID = 'deepgram';
export const DEEPGRAM_LEGACY_CREDENTIAL_IDS = [
  'deepgram_voice',
  'plugin-deepgram-api_key',
] as const;

export type DeepgramCredentialHealth =
  | 'missing'
  | 'unknown'
  | 'connected'
  | 'invalid'
  | 'unreachable';
export type DeepgramCredentialErrorCode =
  | 'invalid_key'
  | 'permission'
  | 'network'
  | 'provider_error'
  | 'storage';

export interface DeepgramCredentialSnapshot {
  configured: boolean;
  health: DeepgramCredentialHealth;
  source?: 'canonical' | 'migration' | 'saved' | 'test' | 'removed';
  projectId?: string;
  projectName?: string;
  checkedAt?: string;
  errorCode?: DeepgramCredentialErrorCode;
}

export interface DeepgramCredentialAdapter {
  read(id: string): Promise<string | undefined>;
  write(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}

type SafeFetcher = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

interface DeepgramCredentialServiceOptions {
  adapter: DeepgramCredentialAdapter;
  fetcher?: SafeFetcher;
  publish?: (snapshot: DeepgramCredentialSnapshot) => void;
  now?: () => Date;
}

interface DeepgramProjectsResponse {
  projects?: Array<{ project_id?: unknown; name?: unknown }>;
}

const browserSessionVault = new Map<string, string>();

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

const platformAdapter: DeepgramCredentialAdapter = {
  async read(id) {
    if (isTauri) {
      const value = await invoke<string | null>('credential_get', { provider: id });
      return value?.trim() || undefined;
    }
    return browserSessionVault.get(id);
  },
  async write(id, value) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Deepgram key is required.');
    if (isTauri) {
      await invoke('credential_set', { provider: id, key: trimmed });
    } else {
      browserSessionVault.set(id, trimmed);
    }
  },
  async remove(id) {
    if (isTauri) {
      await invoke('credential_delete', { provider: id });
    } else {
      browserSessionVault.delete(id);
    }
  },
};

function defaultPublish(snapshot: DeepgramCredentialSnapshot): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DEEPGRAM_CREDENTIAL_EVENT, { detail: snapshot }));
}

function safeProject(value: unknown): { projectId?: string; projectName?: string } {
  const candidate = (value as DeepgramProjectsResponse | null)?.projects?.[0];
  return {
    projectId:
      typeof candidate?.project_id === 'string' && candidate.project_id.trim()
        ? candidate.project_id.trim()
        : undefined,
    projectName:
      typeof candidate?.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : undefined,
  };
}

export function createDeepgramCredentialService(options: DeepgramCredentialServiceOptions) {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const publish = options.publish ?? defaultPublish;
  const now = options.now ?? (() => new Date());
  let current: DeepgramCredentialSnapshot = { configured: false, health: 'missing' };

  const emit = (snapshot: DeepgramCredentialSnapshot): DeepgramCredentialSnapshot => {
    current = Object.freeze({ ...snapshot });
    publish(current);
    return current;
  };

  const validate = async (
    key: string,
    configured: boolean,
    source: DeepgramCredentialSnapshot['source'],
  ): Promise<DeepgramCredentialSnapshot> => {
    try {
      const response = await fetcher('https://api.deepgram.com/v1/projects', {
        method: 'GET',
        headers: { Authorization: `Token ${key}` },
      });
      const checkedAt = now().toISOString();
      if (response.status === 401 || response.status === 403) {
        return emit({
          configured,
          health: response.status === 401 ? 'invalid' : 'invalid',
          source,
          checkedAt,
          errorCode: response.status === 401 ? 'invalid_key' : 'permission',
        });
      }
      if (!response.ok) {
        return emit({
          configured,
          health: 'unreachable',
          source,
          checkedAt,
          errorCode: 'provider_error',
        });
      }
      const project = safeProject(await response.json().catch(() => null));
      return emit({
        configured,
        health: 'connected',
        source,
        checkedAt,
        ...project,
      });
    } catch {
      return emit({
        configured,
        health: 'unreachable',
        source,
        checkedAt: now().toISOString(),
        errorCode: 'network',
      });
    }
  };

  const save = async (key: string): Promise<DeepgramCredentialSnapshot> => {
    const trimmed = key.trim();
    if (!trimmed) {
      return emit({ configured: false, health: 'invalid', errorCode: 'invalid_key' });
    }
    const validated = await validate(trimmed, false, 'saved');
    if (validated.health !== 'connected') return validated;
    try {
      await options.adapter.write(DEEPGRAM_CREDENTIAL_ID, trimmed);
      for (const legacyId of DEEPGRAM_LEGACY_CREDENTIAL_IDS) {
        await options.adapter.remove(legacyId);
      }
      return emit({ ...validated, configured: true, source: 'saved' });
    } catch {
      return emit({
        configured: false,
        health: 'unreachable',
        source: 'saved',
        errorCode: 'storage',
      });
    }
  };

  return Object.freeze({
    snapshot(): DeepgramCredentialSnapshot {
      return current;
    },
    async getKey(): Promise<string | undefined> {
      return (await options.adapter.read(DEEPGRAM_CREDENTIAL_ID))?.trim() || undefined;
    },
    async load(): Promise<DeepgramCredentialSnapshot> {
      try {
        const canonical = (await options.adapter.read(DEEPGRAM_CREDENTIAL_ID))?.trim();
        if (canonical) {
          return emit({ configured: true, health: 'unknown', source: 'canonical' });
        }
        for (const legacyId of DEEPGRAM_LEGACY_CREDENTIAL_IDS) {
          const legacy = (await options.adapter.read(legacyId))?.trim();
          if (!legacy) continue;
          await options.adapter.write(DEEPGRAM_CREDENTIAL_ID, legacy);
          await options.adapter.remove(legacyId);
          return emit({ configured: true, health: 'unknown', source: 'migration' });
        }
        return emit({ configured: false, health: 'missing' });
      } catch {
        return emit({
          configured: false,
          health: 'unreachable',
          errorCode: 'storage',
        });
      }
    },
    save,
    async migratePlaintext(key: string): Promise<DeepgramCredentialSnapshot> {
      const existing = await options.adapter.read(DEEPGRAM_CREDENTIAL_ID);
      if (existing?.trim()) {
        return emit({ configured: true, health: 'unknown', source: 'canonical' });
      }
      return save(key);
    },
    async test(): Promise<DeepgramCredentialSnapshot> {
      try {
        const key = (await options.adapter.read(DEEPGRAM_CREDENTIAL_ID))?.trim();
        if (!key) return emit({ configured: false, health: 'missing', source: 'test' });
        return validate(key, true, 'test');
      } catch {
        return emit({
          configured: false,
          health: 'unreachable',
          source: 'test',
          errorCode: 'storage',
        });
      }
    },
    async remove(): Promise<DeepgramCredentialSnapshot> {
      try {
        await options.adapter.remove(DEEPGRAM_CREDENTIAL_ID);
        for (const legacyId of DEEPGRAM_LEGACY_CREDENTIAL_IDS) {
          await options.adapter.remove(legacyId);
        }
        return emit({ configured: false, health: 'missing', source: 'removed' });
      } catch {
        return emit({
          configured: true,
          health: 'unreachable',
          source: 'removed',
          errorCode: 'storage',
        });
      }
    },
  });
}

const deepgramCredentialService = createDeepgramCredentialService({ adapter: platformAdapter });

export const loadDeepgramCredential = () => deepgramCredentialService.load();
export const getDeepgramApiKey = () => deepgramCredentialService.getKey();
export const saveDeepgramCredential = (key: string) => deepgramCredentialService.save(key);
export const testDeepgramCredential = () => deepgramCredentialService.test();
export const removeDeepgramCredential = () => deepgramCredentialService.remove();
export const migrateDeepgramPlaintextCredential = (key: string) =>
  deepgramCredentialService.migratePlaintext(key);
