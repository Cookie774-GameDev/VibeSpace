/** Curated Ollama models shown in Settings → Local Models (catalog only, no custom names). */
export interface LocalCatalogModel {
  name: string;
  /** Human-friendly label shown in download progress (e.g. "Llama 3.2"). */
  displayName: string;
  size: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

export const LOCAL_MODEL_CATALOG: readonly LocalCatalogModel[] = [
  {
    name: 'qwen3:0.6b',
    displayName: 'Qwen3 0.6B',
    size: '523 MB',
    label: 'Smallest',
    blurb: 'Very fast basic chat for constrained devices.',
  },
  {
    name: 'gemma3:1b',
    displayName: 'Gemma3 1B',
    size: '815 MB',
    label: 'Fast',
    blurb: 'Compact multilingual assistant for quick everyday replies.',
  },
  {
    name: 'llama3.2:1b',
    displayName: 'Llama 3.2 1B',
    size: '1.3 GB',
    label: 'Low memory',
    blurb: 'Reliable lightweight assistant for summaries and rewriting.',
  },
  {
    name: 'llama3.2',
    displayName: 'Llama 3.2',
    size: '2.0 GB',
    label: 'Recommended',
    blurb: 'Balanced 3B default with tool use and strong instruction following.',
    recommended: true,
  },
  {
    name: 'qwen3:4b',
    displayName: 'Qwen3 4B',
    size: '2.5 GB',
    label: 'Reasoning',
    blurb: 'Stronger reasoning, coding, and multilingual work.',
  },
  {
    name: 'gemma3',
    displayName: 'Gemma3',
    size: '3.3 GB',
    label: 'Vision',
    blurb: 'Capable 4B text-and-image model with a large context window.',
  },
  {
    name: 'qwen3:8b',
    displayName: 'Qwen3 8B',
    size: '5.2 GB',
    label: 'High quality',
    blurb: 'Higher-quality local reasoning for machines with more memory.',
  },
] as const;

function normalizeCatalogName(name: string): string {
  return name.trim().toLowerCase().replace(/:latest$/, '');
}

export function catalogDisplayName(name: string): string {
  const normalized = normalizeCatalogName(name);
  const entry = LOCAL_MODEL_CATALOG.find(
    (model) =>
      normalizeCatalogName(model.name) === normalized ||
      normalized.startsWith(`${normalizeCatalogName(model.name)}:`),
  );
  return entry?.displayName ?? name;
}

/** Short family label for early download phases (e.g. "Llama" for llama3.2). */
export function catalogFamilyName(name: string): string {
  const display = catalogDisplayName(name);
  const first = display.split(/\s+/)[0];
  return first || display;
}

export function isCatalogModelName(name: string): boolean {
  const normalized = normalizeCatalogName(name);
  return LOCAL_MODEL_CATALOG.some(
    (entry) =>
      normalizeCatalogName(entry.name) === normalized ||
      normalized.startsWith(`${normalizeCatalogName(entry.name)}:`),
  );
}
