/**
 * Skill / agent loader.
 *
 * Reads built-in `.md` files (shipped with the app under `app/.jarvis/`)
 * via Vite's `import.meta.glob` so they're bundled at build time and
 * available offline. Explicit project/user roots are discovered through an
 * injected, root-bounded filesystem capability backed by the existing Tauri
 * filesystem commands in production.
 */

import {
  listDirectory,
  readTextFileSample,
  type FsAccessOptions,
  type FsListResult,
  type FsReadResult,
} from '@/lib/fs';
import { parseFrontmatter } from './parseFrontmatter';

export type SkillManifestSource = 'builtin' | 'project' | 'user';

export interface SkillPackageResource {
  readonly kind: 'scripts' | 'references' | 'assets' | 'tests';
  readonly path: string;
}

export interface SkillManifest {
  name: string;
  title: string;
  /** Short picker blurb (built-in presets + custom skills). */
  description?: string;
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
  source: SkillManifestSource;
  filePath: string;
  /** Stable catalog id (preset id or custom id). */
  catalogId?: string;
  isPreset?: boolean;
  colorHue?: number;
  emoji?: string;
  /** Runtime instruction block injected via /skills. */
  systemPromptAddendum?: string;
  /** SPDX expression or human-readable upstream license declaration. */
  license?: string;
  /** Resource directories are discovered by name and loaded only on demand. */
  resources?: readonly SkillPackageResource[];
  /** SHA-256 of an imported manifest; built-ins rely on the signed app bundle. */
  manifestSha256?: `sha256:${string}`;
}

export interface SkillDiscoveryFilesystem {
  listDirectory(path: string, options: FsAccessOptions): Promise<FsListResult>;
  readTextFile(path: string, maxBytes: number, options: FsAccessOptions): Promise<FsReadResult>;
}

export type SkillDiscoveryRejectionCode =
  | 'collision'
  | 'disabled'
  | 'invalid_path'
  | 'malformed'
  | 'oversized'
  | 'symlink_blocked'
  | 'untrusted';

export interface SkillDiscoveryRejection {
  source: Exclude<SkillManifestSource, 'builtin'>;
  code: SkillDiscoveryRejectionCode;
}

export interface SkillLoadOptions {
  projectRoot?: string;
  /** User discovery is opt-in and requires `trustUserRoot: true`. */
  userRoot?: string;
  trustProjectRoot?: boolean;
  trustUserRoot?: boolean;
  fs?: SkillDiscoveryFilesystem;
  onReject?: (event: SkillDiscoveryRejection) => void;
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

const MAX_DISCOVERY_ENTRIES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const PACKAGE_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const TRIGGER_VALUES = new Set<NonNullable<SkillManifest['trigger']>>([
  'on_message_received',
  'on_message_sent',
  'on_chat_open',
  'on_terminal_output',
  'manual',
]);
const SEVERITY_VALUES = new Set<NonNullable<SkillManifest['severity']>>([
  'info',
  'low',
  'med',
  'high',
  'crit',
]);

const DEFAULT_FILESYSTEM: SkillDiscoveryFilesystem = {
  listDirectory: (path, options) => listDirectory(path, options),
  readTextFile: (path, maxBytes, options) => readTextFileSample(path, maxBytes, options),
};

function fileBaseName(filePath: string): string {
  const last = filePath.split(/[\\/]/).pop() ?? 'unnamed.md';
  return last.replace(/\.md$/i, '');
}

function manifestFromRaw(
  filePath: string,
  raw: string,
  defaultKind: 'skill' | 'agent',
  source: SkillManifestSource,
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
    description: typeof meta.description === 'string' ? meta.description : undefined,
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
    license: typeof meta.license === 'string' ? meta.license : undefined,
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

function loadEmbedded(
  files: Record<string, string>,
  defaultKind: 'skill' | 'agent',
): SkillManifest[] {
  const out: SkillManifest[] = [];
  for (const [path, raw] of Object.entries(files)) {
    try {
      out.push(manifestFromRaw(path, raw, defaultKind, 'builtin'));
    } catch (err) {
      console.warn(`${defaultKind} manifest parse failed for`, path, err);
    }
  }
  return out;
}

function canonicalPackageId(value: string): string | undefined {
  const canonical = value.trim().toLowerCase();
  return PACKAGE_ID_RE.test(canonical) ? canonical : undefined;
}

function isAbsoluteRoot(value: string): boolean {
  return (
    /^\/(?!\/)/u.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
  );
}

function joinRoot(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${parts.join(separator)}`;
}

function safeReject(
  opts: SkillLoadOptions,
  source: Exclude<SkillManifestSource, 'builtin'>,
  code: SkillDiscoveryRejectionCode,
): void {
  try {
    opts.onReject?.({ source, code });
  } catch {
    // Rejection observers are diagnostics only and cannot affect discovery.
  }
}

function rejectionForFilesystemError(code: string): SkillDiscoveryRejectionCode | undefined {
  if (code === 'symlink_blocked') return 'symlink_blocked';
  if (code === 'outside_root' || code === 'other_user_folder' || code === 'not_absolute') {
    return 'invalid_path';
  }
  return undefined;
}

function validStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function strictExternalManifest(
  filePath: string,
  packageId: string,
  raw: string,
  defaultKind: 'skill' | 'agent',
  source: Exclude<SkillManifestSource, 'builtin'>,
): SkillManifest | 'disabled' | 'malformed' | 'oversized' {
  if (new TextEncoder().encode(raw).byteLength > MAX_MANIFEST_BYTES) return 'oversized';
  const normalized = raw.replace(/\r\n/gu, '\n');
  if (!/^---\n[\s\S]*?\n---(?:\n|$)/u.test(normalized)) return 'malformed';

  const { meta, body } = parseFrontmatter(normalized);
  const declaredName = typeof meta.name === 'string' ? canonicalPackageId(meta.name) : undefined;
  if (!declaredName || declaredName !== packageId || !body.trim()) return 'malformed';
  if (meta.enabled === false) return 'disabled';
  if (meta.enabled !== undefined && meta.enabled !== true) return 'malformed';
  if (meta.kind !== undefined && meta.kind !== defaultKind) return 'malformed';
  if (meta.title !== undefined && typeof meta.title !== 'string') return 'malformed';
  if (meta.description !== undefined && typeof meta.description !== 'string') return 'malformed';
  if (meta.license !== undefined && typeof meta.license !== 'string') return 'malformed';
  if (
    !validStringArray(meta.when) ||
    !validStringArray(meta.tools) ||
    !validStringArray(meta.tags)
  ) {
    return 'malformed';
  }
  if (
    meta.trigger !== undefined &&
    (typeof meta.trigger !== 'string' ||
      !TRIGGER_VALUES.has(meta.trigger as NonNullable<SkillManifest['trigger']>))
  ) {
    return 'malformed';
  }
  if (
    meta.severity !== undefined &&
    (typeof meta.severity !== 'string' ||
      !SEVERITY_VALUES.has(meta.severity as NonNullable<SkillManifest['severity']>))
  ) {
    return 'malformed';
  }

  const manifest = manifestFromRaw(filePath, normalized, defaultKind, source);
  return {
    ...manifest,
    name: packageId,
    catalogId: packageId,
    enabled: true,
  };
}

interface DiscoveryCandidate {
  id: string;
  filePath: string;
  size: number;
  resources: readonly SkillPackageResource[];
}

const RESOURCE_DIRECTORIES = new Set<SkillPackageResource['kind']>([
  'scripts',
  'references',
  'assets',
  'tests',
]);

async function sha256Text(value: string): Promise<`sha256:${string}` | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

async function discoverSource(
  opts: SkillLoadOptions,
  root: string,
  source: Exclude<SkillManifestSource, 'builtin'>,
  defaultKind: 'skill' | 'agent',
): Promise<SkillManifest[]> {
  if (!isAbsoluteRoot(root) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(root) || root.includes('\0')) {
    safeReject(opts, source, 'invalid_path');
    return [];
  }

  const filesystem = opts.fs ?? DEFAULT_FILESYSTEM;
  const directoryName = defaultKind === 'skill' ? 'skills' : 'agents';
  const packageFileName = defaultKind === 'skill' ? 'SKILL.md' : 'AGENT.md';
  const directory = joinRoot(root, '.jarvis', directoryName);
  const access = { root, strictProjectBoundary: true } satisfies FsAccessOptions;
  let listed: FsListResult;
  try {
    listed = await filesystem.listDirectory(directory, access);
  } catch {
    return [];
  }
  if (!listed.ok) {
    const rejection = rejectionForFilesystemError(listed.error.code);
    if (rejection) safeReject(opts, source, rejection);
    return [];
  }
  if (listed.entries.length > MAX_DISCOVERY_ENTRIES) {
    safeReject(opts, source, 'oversized');
    return [];
  }

  const candidates: DiscoveryCandidate[] = [];
  const sortedEntries = [...listed.entries].sort(
    (left, right) =>
      left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
      left.name.localeCompare(right.name),
  );

  for (const entry of sortedEntries) {
    if (entry.isDir) {
      const id = canonicalPackageId(entry.name);
      if (!id) {
        safeReject(opts, source, 'invalid_path');
        continue;
      }
      const packageDirectory = joinRoot(directory, entry.name);
      let packageListing: FsListResult;
      try {
        packageListing = await filesystem.listDirectory(packageDirectory, access);
      } catch {
        continue;
      }
      if (!packageListing.ok) {
        const rejection = rejectionForFilesystemError(packageListing.error.code);
        if (rejection) safeReject(opts, source, rejection);
        continue;
      }
      if (packageListing.entries.length > MAX_DISCOVERY_ENTRIES) {
        safeReject(opts, source, 'oversized');
        continue;
      }
      const manifests = packageListing.entries.filter(
        (candidate) => !candidate.isDir && candidate.name === packageFileName,
      );
      if (manifests.length !== 1) {
        safeReject(opts, source, 'malformed');
        continue;
      }
      const manifest = manifests[0]!;
      if (
        typeof manifest.size !== 'number' ||
        !Number.isSafeInteger(manifest.size) ||
        manifest.size < 0
      ) {
        safeReject(opts, source, 'malformed');
        continue;
      }
      if (manifest.size > MAX_MANIFEST_BYTES) {
        safeReject(opts, source, 'oversized');
        continue;
      }
      candidates.push({
        id,
        filePath: joinRoot(packageDirectory, packageFileName),
        size: manifest.size,
        resources: Object.freeze(
          packageListing.entries
            .filter(
              (candidate) =>
                candidate.isDir &&
                RESOURCE_DIRECTORIES.has(candidate.name as SkillPackageResource['kind']),
            )
            .map((candidate) => {
              const kind = candidate.name as SkillPackageResource['kind'];
              return Object.freeze({
                kind,
                path: joinRoot(packageDirectory, kind),
              });
            }),
        ),
      });
      continue;
    }

    const directMatch = /^([a-z0-9][a-z0-9_-]{0,63})\.md$/iu.exec(entry.name);
    if (!directMatch) {
      if (/\.md$/iu.test(entry.name)) safeReject(opts, source, 'invalid_path');
      continue;
    }
    const id = canonicalPackageId(directMatch[1]!);
    if (
      !id ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      safeReject(opts, source, id ? 'malformed' : 'invalid_path');
      continue;
    }
    if (entry.size > MAX_MANIFEST_BYTES) {
      safeReject(opts, source, 'oversized');
      continue;
    }
    candidates.push({
      id,
      filePath: joinRoot(directory, entry.name),
      size: entry.size,
      resources: Object.freeze([]),
    });
  }

  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  const collided = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  if (collided.size > 0) safeReject(opts, source, 'collision');

  const manifests: SkillManifest[] = [];
  for (const candidate of candidates) {
    if (collided.has(candidate.id)) continue;
    let read: FsReadResult;
    try {
      read = await filesystem.readTextFile(candidate.filePath, MAX_MANIFEST_BYTES, access);
    } catch {
      continue;
    }
    if (!read.ok) {
      const rejection = rejectionForFilesystemError(read.error.code);
      if (rejection) safeReject(opts, source, rejection);
      continue;
    }
    const parsed = strictExternalManifest(
      candidate.filePath,
      candidate.id,
      read.content,
      defaultKind,
      source,
    );
    if (typeof parsed === 'string') {
      safeReject(opts, source, parsed);
      continue;
    }
    const manifestSha256 = await sha256Text(read.content);
    manifests.push({
      ...parsed,
      resources: candidate.resources,
      ...(manifestSha256 ? { manifestSha256 } : {}),
    });
  }
  return manifests;
}

function mergeWithPrecedence(manifests: SkillManifest[]): SkillManifest[] {
  const precedence: Record<SkillManifestSource, number> = { builtin: 0, user: 1, project: 2 };
  const selected = new Map<string, SkillManifest>();
  for (const manifest of manifests) {
    const id = canonicalPackageId(manifest.catalogId ?? manifest.name);
    if (!id) continue;
    const current = selected.get(id);
    if (!current || precedence[manifest.source] > precedence[current.source]) {
      selected.set(id, manifest);
    }
  }
  return sortManifests([...selected.values()]);
}

async function loadAll(
  files: Record<string, string>,
  defaultKind: 'skill' | 'agent',
  opts: SkillLoadOptions = {},
): Promise<SkillManifest[]> {
  const manifests = loadEmbedded(files, defaultKind);
  const projectRoot = opts.projectRoot?.trim();
  if (projectRoot) {
    if (opts.trustProjectRoot === false) safeReject(opts, 'project', 'untrusted');
    else manifests.push(...(await discoverSource(opts, projectRoot, 'project', defaultKind)));
  }

  const userRoot = opts.userRoot?.trim();
  if (userRoot) {
    if (opts.trustUserRoot !== true) safeReject(opts, 'user', 'untrusted');
    else if (projectRoot && userRoot.toLowerCase() === projectRoot.toLowerCase()) {
      safeReject(opts, 'user', 'collision');
    } else {
      manifests.push(...(await discoverSource(opts, userRoot, 'user', defaultKind)));
    }
  }
  return mergeWithPrecedence(manifests);
}

export async function loadAllSkills(opts: SkillLoadOptions = {}): Promise<SkillManifest[]> {
  return loadAll(SKILL_FILES, 'skill', opts);
}

export async function loadAllAgents(opts: SkillLoadOptions = {}): Promise<SkillManifest[]> {
  return loadAll(AGENT_FILES, 'agent', opts);
}
