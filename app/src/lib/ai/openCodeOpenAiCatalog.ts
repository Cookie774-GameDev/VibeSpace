import type { ConnectionModelOption } from './adapters/catalog';

const OPENAI_MODEL_LINE =
  /^(?:openai\/)?([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u;
const MAX_DISCOVERED_MODELS = 200;

let discovered: readonly Readonly<ConnectionModelOption>[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function labelOpenAiSubscriptionModel(id: string): string {
  const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return leaf
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) return part.toUpperCase();
      if (part.toLowerCase() === 'gpt') return 'GPT';
      if (part.toLowerCase() === 'codex') return 'Codex';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function parseOpenCodeOpenAiModels(stdout: string): readonly Readonly<ConnectionModelOption>[] {
  const seen = new Set<string>();
  const models: Readonly<ConnectionModelOption>[] = [];
  for (const rawLine of stdout.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('error')) continue;
    const match = OPENAI_MODEL_LINE.exec(line.replace(/\s+.+$/u, ''));
    const id = match?.[1];
    if (!id || seen.has(id) || models.length >= MAX_DISCOVERED_MODELS) continue;
    seen.add(id);
    models.push(Object.freeze({ id, label: labelOpenAiSubscriptionModel(id) }));
  }
  return Object.freeze(models);
}

export function setDiscoveredOpenAiSubscriptionModels(
  models: readonly Readonly<ConnectionModelOption>[],
): void {
  discovered = Object.freeze(models.map((model) => Object.freeze({ ...model })));
  notify();
}

export function getDiscoveredOpenAiSubscriptionModels(): readonly Readonly<ConnectionModelOption>[] {
  return discovered;
}

export function subscribeDiscoveredOpenAiSubscriptionModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resolveOpenAiSubscriptionModels(
  fallback: readonly Readonly<ConnectionModelOption>[] | undefined,
): readonly Readonly<ConnectionModelOption>[] {
  return discovered.length > 0 ? discovered : (fallback ?? []);
}

export function isOpenAiSubscriptionModelAllowed(
  modelId: string,
  fallback: readonly Readonly<ConnectionModelOption>[] | undefined,
): boolean {
  return resolveOpenAiSubscriptionModels(fallback).some((model) => model.id === modelId);
}

export function formatOpenCodeModelRef(modelId: string, reasoningEffort?: string): string {
  const trimmed = modelId.trim();
  const qualified = trimmed.includes('/') ? trimmed : `openai/${trimmed}`;
  if (!reasoningEffort) return qualified;
  if (qualified.includes('#')) return qualified;
  return `${qualified}#${reasoningEffort}`;
}
