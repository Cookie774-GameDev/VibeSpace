import {
  inspectOllamaModel,
  probeOllamaToolCalling,
  type OllamaModelDetails,
  type OllamaToolProbe,
} from './providers/ollama';

export type LocalAgentCompatibility = 'agent_ready' | 'chat_only' | 'unsupported' | 'unknown';

export interface LocalAgentCompatibilityResult {
  model: string;
  digest?: string;
  status: LocalAgentCompatibility;
  reason: string;
  contextWindowTokens?: number;
  cached: boolean;
}

export interface OllamaCompatibilityDependencies {
  inspect(model: string): Promise<OllamaModelDetails | null>;
  probeTools(model: string): Promise<OllamaToolProbe>;
  storage?: Storage;
}

interface CacheRecord {
  version: 1;
  model: string;
  digest: string;
  status: LocalAgentCompatibility;
  reason: string;
  contextWindowTokens?: number;
  checkedAt: number;
}

const CACHE_KEY = 'vibespace:ollama-agent-compatibility:v1';
const MAX_CACHE_RECORDS = 256;
const AGENT_CONTEXT_TARGET = 64_000;

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readCache(storage: Storage | undefined): CacheRecord[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CACHE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CacheRecord => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Partial<CacheRecord>;
        return (
          record.version === 1 &&
          typeof record.model === 'string' &&
          typeof record.digest === 'string' &&
          typeof record.status === 'string' &&
          ['agent_ready', 'chat_only', 'unsupported', 'unknown'].includes(record.status) &&
          typeof record.reason === 'string' &&
          typeof record.checkedAt === 'number'
        );
      })
      .slice(-MAX_CACHE_RECORDS);
  } catch {
    return [];
  }
}

function writeCache(storage: Storage | undefined, records: CacheRecord[]): void {
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(records.slice(-MAX_CACHE_RECORDS)));
  } catch {
    // Private browsing and quota failures make the cache optional.
  }
}

export function clearOllamaCompatibilityCache(storage = defaultStorage()): void {
  try {
    storage?.removeItem(CACHE_KEY);
  } catch {
    // The compatibility scan still works without persistence.
  }
}

function resultFromRecord(record: CacheRecord, cached: boolean): LocalAgentCompatibilityResult {
  return {
    model: record.model,
    digest: record.digest,
    status: record.status,
    reason: record.reason,
    ...(record.contextWindowTokens ? { contextWindowTokens: record.contextWindowTokens } : {}),
    cached,
  };
}

async function classifyFresh(
  model: string,
  details: OllamaModelDetails,
  probeTools: OllamaCompatibilityDependencies['probeTools'],
): Promise<CacheRecord> {
  const capabilities = new Set(details.capabilities.map((item) => item.trim().toLowerCase()));
  let status: LocalAgentCompatibility;
  let reason: string;

  if (capabilities.size > 0 && !capabilities.has('completion')) {
    status = 'unsupported';
    reason = 'This model does not expose chat completion capability.';
  } else if (capabilities.size > 0 && !capabilities.has('tools')) {
    status = 'chat_only';
    reason = 'This model does not advertise tool calling, so agent actions are disabled.';
  } else {
    const probe = await probeTools(model);
    if (probe.supported) {
      status = 'agent_ready';
      reason =
        details.contextWindowTokens && details.contextWindowTokens < AGENT_CONTEXT_TARGET
          ? `Tool calling passed; ${details.contextWindowTokens.toLocaleString()} tokens is below the preferred 64K agent context.`
          : 'Tool calling passed for the safe structured roundtrip.';
    } else {
      status = 'chat_only';
      reason = probe.reason || 'The safe tool roundtrip did not produce a tool call.';
    }
  }

  return {
    version: 1,
    model,
    digest: details.digest,
    status,
    reason,
    ...(details.contextWindowTokens ? { contextWindowTokens: details.contextWindowTokens } : {}),
    checkedAt: Date.now(),
  };
}

export async function classifyOllamaModel(
  model: string,
  dependencies: OllamaCompatibilityDependencies = {
    inspect: inspectOllamaModel,
    probeTools: probeOllamaToolCalling,
    storage: defaultStorage(),
  },
): Promise<LocalAgentCompatibilityResult> {
  const normalizedModel = model.trim();
  const details = await dependencies.inspect(normalizedModel);
  if (!details) {
    return {
      model: normalizedModel,
      status: 'unknown',
      reason: 'Ollama is not reachable or model details are unavailable.',
      cached: false,
    };
  }

  const cache = readCache(dependencies.storage);
  const cached = cache.find(
    (record) => record.model === normalizedModel && record.digest === details.digest,
  );
  if (cached) return resultFromRecord(cached, true);

  const record = await classifyFresh(normalizedModel, details, dependencies.probeTools);
  const withoutOldModelDigests = cache.filter((item) => item.model !== normalizedModel);
  writeCache(dependencies.storage, [...withoutOldModelDigests, record]);
  return resultFromRecord(record, false);
}

export async function classifyOllamaModels(
  models: readonly string[],
  dependencies?: OllamaCompatibilityDependencies,
): Promise<LocalAgentCompatibilityResult[]> {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const results: LocalAgentCompatibilityResult[] = [];
  for (const model of unique) {
    results.push(await classifyOllamaModel(model, dependencies));
  }
  return results;
}
