/**
 * Skill / agent loader.
 *
 * Reads built-in `.md` files (shipped with the app under `app/.jarvis/`)
 * via Vite's `import.meta.glob` so they're bundled at build time and
 * available offline. Project-level loading from disk is deferred to a
 * follow-up wave (it requires `@tauri-apps/plugin-fs`).
 */

import { parseFrontmatter } from './parseFrontmatter';

export interface SkillManifest {
  name: string;
  title: string;
  kind: 'skill' | 'agent';
  trigger?:
    | 'on_message_received'
    | 'on_message_sent'
    | 'on_chat_open'
    | 'on_terminal_output'
    | 'manual';
  /** Provider scope: provider IDs or `*`. */
  when?: string[];
  /** Tool names allowed for this skill/agent (matched against MCP-lite). */
  tools?: string[];
  severity?: 'info' | 'low' | 'med' | 'high' | 'crit';
  tags?: string[];
  enabled?: boolean;
  /** The markdown body sans frontmatter. */
  body: string;
  source: 'builtin' | 'project';
  filePath: string;
}

const SEVERITY_ORDER: Record<NonNullable<SkillManifest['severity']>, number> = {
  crit: 0,
  high: 1,
  med: 2,
  low: 3,
  info: 4,
};

/* Vite glob: project-relative paths under app/.jarvis/. Eager so the data is
 * synchronously available the first time `loadAllSkills` is awaited. */
const SKILL_FILES = import.meta.glob('/.jarvis/skills/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const AGENT_FILES = import.meta.glob('/.jarvis/agents/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function fileBaseName(filePath: string): string {
  const last = filePath.split(/[\\/]/).pop() ?? 'unnamed.md';
  return last.replace(/\.md$/i, '');
}

function manifestFromRaw(
  filePath: string,
  raw: string,
  defaultKind: 'skill' | 'agent',
  source: 'builtin' | 'project',
): SkillManifest {
  const { meta, body } = parseFrontmatter(raw);
  const fallbackName = fileBaseName(filePath);

  // Tolerate strings vs string-arrays for `when` / `tools` / `tags`.
  const coerceArr = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return [v];
    return undefined;
  };

  return {
    name: typeof meta.name === 'string' ? meta.name : fallbackName,
    title:
      typeof meta.title === 'string'
        ? meta.title
        : fallbackName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    kind: meta.kind === 'agent' || meta.kind === 'skill' ? meta.kind : defaultKind,
    trigger: meta.trigger as SkillManifest['trigger'],
    when: coerceArr(meta.when),
    tools: coerceArr(meta.tools),
    severity: meta.severity as SkillManifest['severity'],
    tags: coerceArr(meta.tags),
    enabled: meta.enabled === false ? false : true,
    body,
    source,
    filePath,
  };
}

function sortManifests(arr: SkillManifest[]): SkillManifest[] {
  return [...arr].sort((a, b) => {
    const aSev = SEVERITY_ORDER[a.severity ?? 'info'];
    const bSev = SEVERITY_ORDER[b.severity ?? 'info'];
    if (aSev !== bSev) return aSev - bSev;
    return a.name.localeCompare(b.name);
  });
}

export async function loadAllSkills(_opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
  const out: SkillManifest[] = [];
  for (const [path, raw] of Object.entries(SKILL_FILES)) {
    try {
      out.push(manifestFromRaw(path, raw, 'skill', 'builtin'));
    } catch (err) {
      console.warn('skill manifest parse failed for', path, err);
    }
  }
  return sortManifests(out);
}

export async function loadAllAgents(_opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
  const out: SkillManifest[] = [];
  for (const [path, raw] of Object.entries(AGENT_FILES)) {
    try {
      out.push(manifestFromRaw(path, raw, 'agent', 'builtin'));
    } catch (err) {
      console.warn('agent manifest parse failed for', path, err);
    }
  }
  return sortManifests(out);
}
