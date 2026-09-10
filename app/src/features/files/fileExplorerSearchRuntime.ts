/**
 * Module-level mini-Jarvis file search for the themed File Explorer.
 *
 * Runs outside the dialog React tree so closing the explorer does not
 * cancel an in-flight scan, and reopening restores hits + status.
 *
 * Does not touch main Chat / Jarvis composer sessions.
 */
import type { Agent, ProviderId } from '@/types';
import { runAgent } from '@/lib/ai/router';
import { applyChatModelSelectionToAgent } from '@/lib/ai/modelSelection';
import {
  describeSearchClues,
  parseAiPathList,
  parseSearchClues,
  scoreEntriesLocally,
  walkEntries,
  walkMany,
  type SearchHit,
} from './fileExplorerSearch';

export interface ExplorerSearchState {
  query: string;
  status: string;
  busy: boolean;
  hits: SearchHit[];
  panelOpen: boolean;
  provider: string;
  model: string;
  /** Monotonic generation; bumped to invalidate stale async work. */
  generation: number;
  /** Absolute folder(s) the active/last search used. */
  scopePath: string;
  accessRoot: string | null;
  /** Parsed clue summary for UI. */
  clueSummary: string;
}

export interface StartExplorerSearchOptions {
  query: string;
  /** Current open folder in the explorer. */
  scopePath: string;
  accessRoot?: string | null;
  /** Optional place labels for `in:documents` style path hints + wide search. */
  placePaths?: Array<{ id: string; label: string; path: string }>;
  jarvisAgent?: Agent | null;
  provider?: string;
  model?: string;
}

const listeners = new Set<() => void>();

let state: ExplorerSearchState = {
  query: '',
  status: '',
  busy: false,
  hits: [],
  panelOpen: false,
  provider: '',
  model: '',
  generation: 0,
  scopePath: '',
  accessRoot: null,
  clueSummary: '',
};

function emit(): void {
  for (const listener of listeners) listener();
}

function patch(partial: Partial<ExplorerSearchState>): void {
  state = { ...state, ...partial };
  emit();
}

export function getExplorerSearchState(accessRoot?: string | null): ExplorerSearchState {
  if (accessRoot !== undefined && (accessRoot?.trim() || null) !== state.accessRoot) {
    return { ...state, hits: [], busy: false, status: '', scopePath: '', clueSummary: '' };
  }
  return state;
}

export function subscribeExplorerSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setExplorerSearchPanelOpen(open: boolean): void {
  if (state.panelOpen === open) return;
  patch({ panelOpen: open });
}

export function setExplorerSearchQuery(query: string): void {
  if (state.query === query) return;
  patch({ query });
}

export function setExplorerSearchModel(provider: string, model: string): void {
  if (state.provider === provider && state.model === model) return;
  patch({ provider, model });
}

/** Clear listed hits (does not cancel a running job — use start or cancel for that). */
export function clearExplorerSearchHits(): void {
  patch({
    hits: [],
    status: state.busy ? state.status : '',
    clueSummary: state.busy ? state.clueSummary : '',
  });
}

/** Invalidate the current generation so in-flight work stops publishing. */
export function cancelExplorerSearchJob(): void {
  const generation = state.generation + 1;
  patch({
    generation,
    busy: false,
    status: state.hits.length
      ? `Found ${state.hits.length} file${state.hits.length === 1 ? '' : 's'} (stopped)`
      : 'Search stopped',
  });
}

/**
 * Resolve which folders to walk for a multi-clue search.
 * Default: wide (Home + Documents + Desktop + Downloads + current).
 * `in:documents` / pathHint → that place (+ current if different).
 * `hereOnly` → current folder only.
 */
export function resolveSearchRoots(options: {
  scopePath: string;
  pathHint?: string;
  hereOnly?: boolean;
  placePaths?: Array<{ id: string; label: string; path: string }>;
}): string[] {
  const current = options.scopePath.trim();
  if (options.hereOnly && current) return [current];

  const places = options.placePaths ?? [];
  if (options.pathHint) {
    const hint = options.pathHint.toLowerCase();
    const matched = places.filter(
      (p) =>
        p.label.toLowerCase().includes(hint) ||
        p.id.includes(hint) ||
        p.path.toLowerCase().includes(hint),
    );
    const roots = matched.map((p) => p.path);
    if (current && !roots.some((r) => r.toLowerCase() === current.toLowerCase())) {
      roots.unshift(current);
    }
    return roots.length ? roots : current ? [current] : [];
  }

  // Wide search: user Places that usually hold personal files
  const preferredIds = ['home', 'documents', 'desktop', 'downloads'];
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const k = p.replace(/[\\/]+$/, '').toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    roots.push(p);
  };

  if (current) add(current);
  for (const id of preferredIds) {
    const place = places.find((p) => p.id === id);
    if (place) add(place.path);
  }
  // Also include any other non-drive places (Pictures/Videos skipped for content-heavy default —
  // still include them if query might be image-name only? User said pictures can't content-search.
  // Include Pictures for name-only matches of screenshots etc.)
  for (const place of places) {
    if (place.id === 'drive' || place.id === 'c' || place.id === 'root') continue;
    add(place.path);
  }

  return roots;
}

/**
 * Start (or restart) a background search. Safe to call after the dialog
 * unmounts — results land in this store for the next open.
 */
export async function startExplorerSearch(options: StartExplorerSearchOptions): Promise<void> {
  const raw = options.query.trim();
  if (!raw) return;

  const generation = state.generation + 1;
  const provider = options.provider ?? state.provider;
  const model = options.model ?? state.model;
  const clues = parseSearchClues(raw);
  const clueSummary = describeSearchClues(clues);

  patch({
    generation,
    query: raw,
    busy: true,
    hits: [],
    status: 'Planning multi-clue search…',
    panelOpen: true,
    scopePath: options.scopePath,
    accessRoot: options.accessRoot?.trim() || null,
    provider,
    model,
    clueSummary,
  });

  const isCurrent = () => getExplorerSearchState().generation === generation;

  try {
    const roots = resolveSearchRoots({
      scopePath: options.scopePath,
      pathHint: clues.pathHint,
      hereOnly: clues.hereOnly,
      placePaths: options.placePaths,
    });

    if (!roots.length) {
      if (!isCurrent()) return;
      patch({
        busy: false,
        status: 'Open a folder first (or pick Home / Documents).',
        hits: [],
      });
      return;
    }

    if (!isCurrent()) return;
    patch({
      scopePath: roots.join(' · '),
      status: `Scanning ${roots.length} place${roots.length === 1 ? '' : 's'} (${clueSummary})…`,
    });

    const walked =
      roots.length === 1
        ? await walkEntries(roots[0]!, {
            maxDepth: 7,
            maxFiles: 3000,
            accessRoot: options.accessRoot,
            onProgress: (n) => {
              if (!isCurrent()) return;
              patch({ status: `Scanned ${n} items · ${clueSummary}` });
            },
          })
        : await walkMany(roots, {
            maxDepth: 6,
            maxFiles: 3500,
            accessRoot: options.accessRoot,
            onProgress: (n) => {
              if (!isCurrent()) return;
              patch({ status: `Scanned ~${n} items across places · ${clueSummary}` });
            },
          });

    if (!isCurrent()) return;

    patch({
      status: `Matching names & text content (${walked.length} candidates)…`,
    });
    let hits = await scoreEntriesLocally(walked, clues, options.accessRoot);
    if (!isCurrent()) return;

    // Publish local hits early so reopening mid-AI-rank still shows results.
    patch({
      hits,
      status: hits.length
        ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'} · ${clueSummary}${
            options.jarvisAgent && provider && model ? ' · ranking…' : ''
          }`
        : `No matches for ${clueSummary} — try more words, type:txt, or in:documents`,
    });

    if (options.jarvisAgent && provider && model && hits.length > 0) {
      patch({ status: `Found ${hits.length} · Jarvis ranking by clues…` });
      const top = hits.slice(0, 50);
      const allowed = new Set(top.map((h) => h.path));
      const agent = applyChatModelSelectionToAgent(
        {
          ...options.jarvisAgent,
          system_prompt: [
            "You help find files on the user's computer from a short list of candidates.",
            'The user gave MULTIPLE clues (file type, words inside the file, location).',
            'Prefer files that satisfy ALL clues (extension + content terms).',
            'Never invent paths. Return ONLY a JSON array of absolute paths (max 12).',
            'No prose.',
          ].join(' '),
          model: { provider: provider as ProviderId, model },
        },
        { mode: 'single', providerId: provider as ProviderId, modelId: model },
      );
      try {
        const response = await runAgent({
          agent,
          messages: [
            {
              role: 'user',
              content: [
                `User query: ${raw}`,
                `Parsed clues: ${clueSummary}`,
                `Required terms: ${clues.terms.join(', ') || '(none)'}`,
                `Extensions: ${clues.extensions?.join(', ') || '(any)'}`,
                '',
                'Candidates (JSON):',
                JSON.stringify(
                  top.map((h) => ({
                    path: h.path,
                    name: h.name,
                    size: h.size ?? null,
                    reason: h.reason,
                    termsMatched: h.termsMatched ?? null,
                    termsTotal: h.termsTotal ?? null,
                    snippet: h.snippet?.slice(0, 160) ?? null,
                  })),
                ),
              ].join('\n'),
            },
          ],
          max_output_tokens: 500,
          temperature: 0.1,
        });
        if (!isCurrent()) return;
        const ranked = parseAiPathList(response.text || '', allowed);
        if (ranked.length > 0) {
          const byPath = new Map(top.map((h) => [h.path, h]));
          hits = ranked
            .map((p, i) => {
              const hit = byPath.get(p);
              if (!hit) return null;
              return { ...hit, score: 1000 - i, reason: `${hit.reason}; jarvis-rank` };
            })
            .filter((h): h is SearchHit => h != null);
        }
      } catch {
        // Keep local ranking if AI fails
      }
    }

    if (!isCurrent()) return;
    patch({
      hits,
      busy: false,
      status: hits.length
        ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'} · ${clueSummary}`
        : `No matches for ${clueSummary} — try different words, type:txt, in:documents, or search here only`,
    });
  } catch (err) {
    if (!isCurrent()) return;
    const message = err instanceof Error ? err.message : 'Search failed';
    patch({
      busy: false,
      status: message,
    });
  }
}

/** Test helper — reset module state between unit tests. */
export function __resetExplorerSearchRuntimeForTests(): void {
  state = {
    query: '',
    status: '',
    busy: false,
    hits: [],
    panelOpen: false,
    provider: '',
    model: '',
    generation: 0,
    scopePath: '',
    accessRoot: null,
    clueSummary: '',
  };
  listeners.clear();
}
