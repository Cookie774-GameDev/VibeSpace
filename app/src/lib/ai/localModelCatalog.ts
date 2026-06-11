/** Curated Ollama models shown in Settings → Local Models (catalog only, no custom names). */
export interface LocalCatalogModel {
  name: string;
  size: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

export const LOCAL_MODEL_CATALOG: readonly LocalCatalogModel[] = [
  {
    name: 'qwen3:0.6b',
    size: '523 MB',
    label: 'Smallest',
    blurb: 'Very fast basic chat for constrained devices.',
  },
  {
    name: 'gemma3:1b',
    size: '815 MB',
    label: 'Fast',
    blurb: 'Compact multilingual assistant for quick everyday replies.',
  },
  {
    name: 'llama3.2:1b',
    size: '1.3 GB',
    label: 'Low memory',
    blurb: 'Reliable lightweight assistant for summaries and rewriting.',
  },
  {
    name: 'llama3.2',
    size: '2.0 GB',
    label: 'Recommended',
    blurb: 'Balanced 3B default with tool use and strong instruction following.',
    recommended: true,
  },
  {
    name: 'qwen3:4b',
    size: '2.5 GB',
    label: 'Reasoning',
    blurb: 'Stronger reasoning, coding, and multilingual work.',
  },
  {
    name: 'gemma3',
    size: '3.3 GB',
    label: 'Vision',
    blurb: 'Capable 4B text-and-image model with a large context window.',
  },
  {
    name: 'qwen3:8b',
    size: '5.2 GB',
    label: 'High quality',
    blurb: 'Higher-quality local reasoning for machines with more memory.',
  },
] as const;

export function isCatalogModelName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/:latest$/, '');
  return LOCAL_MODEL_CATALOG.some(
    (entry) =>
      entry.name.toLowerCase() === normalized ||
      normalized.startsWith(`${entry.name.toLowerCase()}:`),
  );
}
