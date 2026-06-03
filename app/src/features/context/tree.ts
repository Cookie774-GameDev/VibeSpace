import { readTextFile, listDirectory, writeTextFile, type FsEntry } from '@/lib/fs';
import { basename, extension, isPopularTextFile } from '@/features/files/projectFiles';

export const CONTEXT_MIME = 'application/x-jarvis-context';
export const CONTEXT_STORAGE_PREFIX = 'jarvis-context-tree-v1';
export const CONTEXT_MAP_COLLECTION_PREFIX = 'jarvis-context-maps-v1';
export const CONTEXT_SELECTED_FILE_PREFIX = 'jarvis-context-selected-file-v1';
export const MAX_ACTIVE_CONTEXT_MAPS = 5;

export type ContextGenerationProvider = 'local' | 'google' | 'groq' | 'openai' | 'anthropic';

export const CONTEXT_PROVIDER_OPTIONS: Record<ContextGenerationProvider, {
  label: string;
  shortLabel: string;
  model: string;
}> = {
  local: { label: 'Local fallback', shortLabel: 'Local', model: 'local-fallback' },
  google: { label: 'Google Gemini', shortLabel: 'Gemini', model: 'gemini-2.5-flash-lite' },
  groq: { label: 'Groq Llama', shortLabel: 'Groq', model: 'llama-3.3-70b-versatile' },
  openai: { label: 'OpenAI', shortLabel: 'OpenAI', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic Claude', shortLabel: 'Claude', model: 'claude-3-5-sonnet-20241022' },
};

export type ContextNodeKind = 'root' | 'area' | 'file' | 'symbol' | 'note';

export interface ContextTreeNode {
  id: string;
  title: string;
  kind: ContextNodeKind;
  summary: string;
  path?: string;
  tags?: string[];
  importance?: number;
  sizeBytes?: number;
  createdAt?: number;
  modifiedAt?: number;
  children?: ContextTreeNode[];
}

export interface ProjectContextTree {
  version: 1;
  projectId: string | null;
  rootDir: string;
  generatedAt: number;
  model: string;
  fileCount: number;
  totalBytes: number;
  summary: string;
  nodes: ContextTreeNode[];
  recommendedEntryPoints?: string[];
}

export type ContextMapStatus = 'active' | 'deleted';

export interface ContextMapRecord {
  id: string;
  projectId: string | null;
  rootDir: string;
  filePath?: string;
  name: string;
  status: ContextMapStatus;
  createdAt: number;
  updatedAt: number;
  tree: ProjectContextTree;
}

export interface ProjectContextMapCollection {
  version: 1;
  projectId: string | null;
  selectedMapId: string | null;
  maps: ContextMapRecord[];
}

export interface ContextAttachment {
  projectId: string | null;
  rootDir: string;
  generatedAt: number;
  nodeId: string;
  title: string;
  kind: ContextNodeKind;
  summary: string;
  path?: string;
  tags?: string[];
  sizeBytes?: number;
  createdAt?: number;
  modifiedAt?: number;
  childrenCount?: number;
}

export interface GenerateContextOptions {
  projectId: string | null;
  rootDir: string;
  provider?: ContextGenerationProvider;
  apiKey?: string;
  onProgress?: (message: string) => void;
}

interface ScannedContextFile {
  path: string;
  relativePath: string;
  extension: string;
  size: number;
  createdMs?: number;
  modifiedMs?: number;
  content: string;
  truncated: boolean;
}

const MAX_SCAN_FILES = 120;
const MAX_SCAN_DEPTH = 6;
const MAX_FILE_SAMPLE_CHARS = 12_000;
const MAX_TOTAL_SAMPLE_CHARS = 260_000;
const MAX_PROMPT_CHARS = 280_000;
const CONTEXT_OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const CONTEXT_GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CONTEXT_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', 'target', 'dist', 'build',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.cache', '.parcel-cache',
  'out', 'release', 'releases', 'bin', 'obj', 'vendor', '__pycache__', '.pytest_cache',
]);

const IGNORED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'tiff', 'avif', 'mp4', 'mov',
  'mp3', 'wav', 'flac', 'ogg', 'zip', '7z', 'rar', 'tar', 'gz', 'xz', 'bz2', 'pdf', 'exe',
  'dll', 'dylib', 'so', 'jar', 'class', 'wasm', 'pdb', 'sqlite', 'db', 'lockb', 'msi',
]);

export function contextStorageKey(projectId: string | null): string {
  return `${CONTEXT_STORAGE_PREFIX}:${projectId ?? '__default__'}`;
}

export function contextMapCollectionKey(projectId: string | null): string {
  return `${CONTEXT_MAP_COLLECTION_PREFIX}:${projectId ?? '__default__'}`;
}

export function contextSelectedFileKey(projectId: string | null): string {
  return `${CONTEXT_SELECTED_FILE_PREFIX}:${projectId ?? '__default__'}`;
}

export function loadStoredContextTree(projectId: string | null): ProjectContextTree | null {
  const collection = loadContextMapCollection(projectId);
  const selected = collection.maps.find((map) => map.id === collection.selectedMapId && map.status === 'active')
    ?? collection.maps.find((map) => map.status === 'active')
    ?? null;
  return selected?.tree ?? readLegacyContextTree(projectId);
}

export function loadStoredContextMaps(projectId: string | null): ContextMapRecord[] {
  return loadContextMapCollection(projectId).maps;
}

export function loadSelectedContextMap(projectId: string | null): ContextMapRecord | null {
  const collection = loadContextMapCollection(projectId);
  return collection.maps.find((map) => map.id === collection.selectedMapId)
    ?? collection.maps.find((map) => map.status === 'active')
    ?? collection.maps[0]
    ?? null;
}

export function getStoredContextSelectedFile(projectId: string | null): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(contextSelectedFileKey(projectId)) ?? '';
}

export function setStoredContextSelectedFile(projectId: string | null, path: string, emit = true): void {
  if (typeof window === 'undefined') return;
  const clean = path.trim();
  if (!clean) return;
  window.localStorage.setItem(contextSelectedFileKey(projectId), clean);
  if (!emit) return;
  window.dispatchEvent(new CustomEvent('jarvis:context:select-file', {
    detail: { projectId, path: clean },
  }));
}

export function activeContextMapCount(projectId: string | null): number {
  return loadContextMapCollection(projectId).maps.filter((map) => map.status === 'active').length;
}

export function saveContextTree(tree: ProjectContextTree, options: { name?: string; mapId?: string } = {}): ContextMapRecord | null {
  if (typeof window === 'undefined') return null;
  const collection = loadContextMapCollection(tree.projectId);
  const existingIndex = options.mapId
    ? collection.maps.findIndex((map) => map.id === options.mapId)
    : -1;
  const activeCount = collection.maps.filter((map, index) => map.status === 'active' && index !== existingIndex).length;
  if (existingIndex === -1 && activeCount >= MAX_ACTIVE_CONTEXT_MAPS) {
    throw new Error(`You can keep up to ${MAX_ACTIVE_CONTEXT_MAPS} active Context maps. Delete one before creating another.`);
  }

  const now = Date.now();
  const existing = existingIndex >= 0 ? collection.maps[existingIndex] : null;
  const record: ContextMapRecord = {
    id: existing?.id ?? uniqueContextMapId(tree, collection.maps),
    projectId: tree.projectId,
    rootDir: tree.rootDir,
    filePath: contextMapFilePath(tree.rootDir),
    name: options.name?.trim() || existing?.name || contextMapName(tree),
    status: 'active',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    tree,
  };

  const maps = existingIndex >= 0
    ? collection.maps.map((map, index) => (index === existingIndex ? record : map))
    : [record, ...collection.maps];

  persistContextMapCollection({
    ...collection,
    selectedMapId: record.id,
    maps: sortContextMaps(maps),
  });
  writeLegacyContextTree(tree);
  dispatchContextMapsUpdated(tree.projectId, tree.rootDir, record.id);
  return record;
}

export function selectStoredContextMap(projectId: string | null, mapId: string): ContextMapRecord | null {
  const collection = loadContextMapCollection(projectId);
  const record = collection.maps.find((map) => map.id === mapId) ?? null;
  if (!record) return null;
  persistContextMapCollection({ ...collection, selectedMapId: record.id });
  if (record.status === 'active') writeLegacyContextTree(record.tree);
  dispatchContextMapsUpdated(projectId, record.rootDir, record.id);
  return record;
}

export function deleteStoredContextMap(projectId: string | null, mapId: string): ContextMapRecord | null {
  const collection = loadContextMapCollection(projectId);
  const target = collection.maps.find((map) => map.id === mapId);
  if (!target) return null;
  const deleted: ContextMapRecord = { ...target, status: 'deleted', updatedAt: Date.now() };
  const maps = collection.maps.map((map) => (map.id === mapId ? deleted : map));
  const nextSelected = collection.selectedMapId === mapId
    ? mapId
    : collection.selectedMapId;
  persistContextMapCollection({ ...collection, selectedMapId: nextSelected, maps: sortContextMaps(maps) });
  const active = maps.find((map) => map.status === 'active');
  if (active) writeLegacyContextTree(active.tree);
  dispatchContextMapsUpdated(projectId, deleted.rootDir, deleted.id);
  return deleted;
}

function loadContextMapCollection(projectId: string | null): ProjectContextMapCollection {
  const empty: ProjectContextMapCollection = {
    version: 1,
    projectId,
    selectedMapId: null,
    maps: [],
  };
  if (typeof window === 'undefined') return empty;

  const raw = window.localStorage.getItem(contextMapCollectionKey(projectId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ProjectContextMapCollection>;
      if (parsed?.version === 1 && Array.isArray(parsed.maps)) {
        const maps = parsed.maps
          .map((map) => normalizeContextMapRecord(map, projectId))
          .filter((map): map is ContextMapRecord => Boolean(map));
        const selectedMapId = typeof parsed.selectedMapId === 'string' && maps.some((map) => map.id === parsed.selectedMapId)
          ? parsed.selectedMapId
          : maps.find((map) => map.status === 'active')?.id ?? maps[0]?.id ?? null;
        return { version: 1, projectId, selectedMapId, maps: sortContextMaps(maps) };
      }
    } catch {
      // Fall through to legacy migration below.
    }
  }

  const legacy = readLegacyContextTree(projectId);
  if (!legacy) return empty;
  const migrated: ContextMapRecord = {
    id: uniqueContextMapId(legacy, []),
    projectId: legacy.projectId,
    rootDir: legacy.rootDir,
    name: contextMapName(legacy),
    status: 'active',
    createdAt: legacy.generatedAt,
    updatedAt: legacy.generatedAt,
    tree: legacy,
  };
  return { version: 1, projectId, selectedMapId: migrated.id, maps: [migrated] };
}

function normalizeContextMapRecord(raw: unknown, projectId: string | null): ContextMapRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<ContextMapRecord>;
  const tree = normalizeStoredTree(record.tree);
  if (!tree) return null;
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : tree.generatedAt;
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt;
  const id = typeof record.id === 'string' && record.id.trim()
    ? record.id
    : uniqueContextMapId(tree, []);
  return {
    id,
    projectId,
    rootDir: typeof record.rootDir === 'string' && record.rootDir.trim() ? record.rootDir : tree.rootDir,
    filePath: typeof record.filePath === 'string' && record.filePath.trim()
      ? record.filePath.trim()
      : contextMapFilePath(typeof record.rootDir === 'string' && record.rootDir.trim() ? record.rootDir : tree.rootDir),
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : contextMapName(tree),
    status: record.status === 'deleted' ? 'deleted' : 'active',
    createdAt,
    updatedAt,
    tree,
  };
}

function readLegacyContextTree(projectId: string | null): ProjectContextTree | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(contextStorageKey(projectId));
  if (!raw) return null;
  try {
    return normalizeStoredTree(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeStoredTree(raw: unknown): ProjectContextTree | null {
  const parsed = raw as ProjectContextTree | null;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null;
  return parsed;
}

function persistContextMapCollection(collection: ProjectContextMapCollection): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(contextMapCollectionKey(collection.projectId), JSON.stringify({
    ...collection,
    maps: sortContextMaps(collection.maps),
  }));
}

function writeLegacyContextTree(tree: ProjectContextTree): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(contextStorageKey(tree.projectId), JSON.stringify(tree));
}

function dispatchContextMapsUpdated(projectId: string | null, rootDir: string, mapId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('jarvis:context-tree-updated', {
    detail: { projectId, rootDir, mapId },
  }));
}

function sortContextMaps(maps: ContextMapRecord[]): ContextMapRecord[] {
  return [...maps].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

function uniqueContextMapId(tree: ProjectContextTree, existing: ContextMapRecord[]): string {
  const base = stableId(`map-${tree.rootDir}-${tree.generatedAt}`);
  let id = base;
  let suffix = 2;
  const used = new Set(existing.map((map) => map.id));
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function contextMapName(tree: ProjectContextTree): string {
  const normalized = tree.rootDir.replace(/[\\/]$/g, '');
  const rootName = normalized.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  return `${rootName} Context Map`;
}

export function contextMapFilePath(rootDir: string): string {
  const cleanRoot = rootDir.trim().replace(/[\\/]$/g, '');
  const separator = cleanRoot.includes('\\') ? '\\' : '/';
  return `${cleanRoot}${separator}context_map.json`;
}

export function serializeContextAttachment(attachment: ContextAttachment): string {
  return JSON.stringify(attachment);
}

export function parseContextAttachment(raw: string): ContextAttachment | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ContextAttachment>;
    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') return null;
    return {
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      rootDir: typeof parsed.rootDir === 'string' ? parsed.rootDir : '',
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
      nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : stableId(parsed.title),
      title: parsed.title,
      kind: isContextKind(parsed.kind) ? parsed.kind : 'note',
      summary: parsed.summary,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : undefined,
      sizeBytes: typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
      modifiedAt: typeof parsed.modifiedAt === 'number' ? parsed.modifiedAt : undefined,
      childrenCount: typeof parsed.childrenCount === 'number' ? parsed.childrenCount : undefined,
    };
  } catch {
    return null;
  }
}

export function nodeToAttachment(tree: ProjectContextTree, node: ContextTreeNode): ContextAttachment {
  return {
    projectId: tree.projectId,
    rootDir: tree.rootDir,
    generatedAt: tree.generatedAt,
    nodeId: node.id,
    title: node.title,
    kind: node.kind,
    summary: node.summary,
    path: node.id === '__jarvis-context-root__' ? contextMapFilePath(tree.rootDir) : node.path,
    tags: node.tags,
    sizeBytes: node.sizeBytes,
    createdAt: node.createdAt,
    modifiedAt: node.modifiedAt,
    childrenCount: node.children?.length,
  };
}

export function contextNodeFilePath(tree: ProjectContextTree, node: ContextTreeNode): string | undefined {
  if (node.kind !== 'file' || !node.path) return undefined;
  const path = node.path.trim();
  if (!path) return undefined;
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path;
  const root = tree.rootDir.replace(/[\\/]$/g, '');
  if (!root) return path;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${path.replace(/^[\\/]/, '')}`;
}

export function flattenContextNodes(nodes: ContextTreeNode[]): ContextTreeNode[] {
  const out: ContextTreeNode[] = [];
  const walk = (node: ContextTreeNode) => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

export function findContextNode(tree: ProjectContextTree | null, id: string): ContextTreeNode | null {
  if (!tree) return null;
  return flattenContextNodes(tree.nodes).find((node) => node.id === id) ?? null;
}

export function findContextFileNodeByPath(tree: ProjectContextTree | null, path: string): ContextTreeNode | null {
  if (!tree || !path.trim()) return null;
  const wanted = normalizeMetaPath(path.trim());
  const root = normalizeMetaPath(tree.rootDir);
  const relative = root && wanted.startsWith(`${root}/`) ? wanted.slice(root.length + 1) : wanted;
  return flattenContextNodes(tree.nodes).find((node) => {
    if (node.kind !== 'file' || !node.path) return false;
    const nodeRelative = normalizeMetaPath(node.path);
    if (nodeRelative === wanted || nodeRelative === relative) return true;
    const absolute = contextNodeFilePath(tree, node);
    return absolute ? normalizeMetaPath(absolute) === wanted : false;
  }) ?? null;
}

export function formatContextAttachmentForPrompt(attachment: ContextAttachment): string {
  const meta = [
    `kind=${attachment.kind}`,
    attachment.path ? `path=${attachment.path}` : '',
    typeof attachment.sizeBytes === 'number' ? `size=${attachment.sizeBytes} bytes` : '',
    attachment.createdAt ? `created=${new Date(attachment.createdAt).toISOString()}` : '',
    attachment.modifiedAt ? `modified=${new Date(attachment.modifiedAt).toISOString()}` : '',
    attachment.tags?.length ? `tags=${attachment.tags.join(',')}` : '',
  ].filter(Boolean).join(' ');
  return [
    `--- context:${attachment.title} ---`,
    meta,
    attachment.summary,
  ].join('\n');
}

export function formatContextAttachmentForTerminal(attachment: ContextAttachment): string {
  const lines = [
    '### Jarvis Context Power-Up',
    `Title: ${attachment.title}`,
    `Kind: ${attachment.kind}`,
    attachment.path ? `Path: ${attachment.path}` : null,
    typeof attachment.sizeBytes === 'number' ? `Size: ${attachment.sizeBytes} bytes` : null,
    attachment.createdAt ? `Created: ${new Date(attachment.createdAt).toLocaleString()}` : null,
    attachment.modifiedAt ? `Modified: ${new Date(attachment.modifiedAt).toLocaleString()}` : null,
    attachment.tags?.length ? `Tags: ${attachment.tags.join(', ')}` : null,
    '',
    attachment.summary,
    '',
  ].filter((line): line is string => line !== null);
  return lines.map((line) => (line ? `# ${line}` : '#')).join('\n');
}

export function formatContextTreeForPrompt(tree: ProjectContextTree): string {
  const lines: string[] = [];
  let emitted = 0;
  const maxLines = 180;
  const walk = (node: ContextTreeNode, depth: number) => {
    if (emitted >= maxLines || depth > 5) return;
    emitted += 1;
    const indent = '  '.repeat(depth);
    const meta = [node.kind, node.path].filter(Boolean).join(':');
    lines.push(`${indent}- ${node.title}${meta ? ` [${meta}]` : ''}: ${clamp(node.summary, 300)}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const node of tree.nodes) walk(node, 0);

  return [
    `You are working with a generated project Context skill tree for root: ${tree.rootDir}.`,
    'Use it as a navigation map, not as a complete source dump. Identify the likely subsystem first, then ask for or use attached files when source detail is needed.',
    `Generated ${new Date(tree.generatedAt).toISOString()} from ${tree.fileCount} files using ${tree.model}.`,
    '',
    '--- project_context_tree ---',
    `Summary: ${tree.summary}`,
    tree.recommendedEntryPoints?.length ? `Entry points: ${tree.recommendedEntryPoints.join(', ')}` : '',
    ...lines,
  ].filter(Boolean).join('\n');
}

export async function generateProjectContextTree(options: GenerateContextOptions): Promise<ProjectContextTree> {
  const rootDir = options.rootDir.trim();
  if (!rootDir) throw new Error('Choose a project folder first.');
  options.onProgress?.('Scanning project files...');
  const files = await scanProjectFiles(rootDir, options.onProgress);
  if (files.length === 0) throw new Error('No readable text files found in this project folder.');

  const provider = options.provider ?? (options.apiKey ? 'google' : 'local');
  let tree: ProjectContextTree | null = null;
  if (provider !== 'local' && options.apiKey) {
    options.onProgress?.(`Asking ${CONTEXT_PROVIDER_OPTIONS[provider].label} to shape ${files.length} files into a Context map...`);
    try {
      tree = await generateProviderTree({
        provider,
        apiKey: options.apiKey,
        projectId: options.projectId,
        rootDir,
        files,
      });
    } catch {
      tree = null;
    }
  }

  if (!tree) {
    options.onProgress?.('Building deterministic local Context tree...');
    tree = buildFallbackTree(options.projectId, rootDir, files, provider !== 'local' && options.apiKey ? `local-fallback-after-${provider}` : 'local-fallback');
  }
  const mapPath = contextMapFilePath(rootDir);
  const fileWrite = await writeTextFile(mapPath, JSON.stringify({
    schema: 'jarvis.context-map',
    schemaVersion: 1,
    description: 'Generated Jarvis One project context map. Drag this file into Jarvis chat or terminals as project context.',
    tree,
  }, null, 2));
  if (!fileWrite.ok) {
    throw new Error(`Could not write Context map file at ${mapPath}: ${fileWrite.error.raw ?? fileWrite.error.code}`);
  }
  saveContextTree(tree);

  return tree;
}

async function scanProjectFiles(
  rootDir: string,
  onProgress?: (message: string) => void,
): Promise<ScannedContextFile[]> {
  const files: ScannedContextFile[] = [];
  let totalChars = 0;
  const seenDirs = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= MAX_SCAN_FILES || totalChars >= MAX_TOTAL_SAMPLE_CHARS) return;
    if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
    seenDirs.add(dir);

    const listed = await listDirectory(dir);
    if (!listed.ok) return;

    const entries = prioritizeEntries(listed.entries);
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES || totalChars >= MAX_TOTAL_SAMPLE_CHARS) break;
      if (entry.isDir) {
        if (!IGNORED_DIRS.has(entry.name.toLowerCase())) await walk(entry.path, depth + 1);
        continue;
      }
      if (!isContextCandidate(entry)) continue;
      const result = await readTextFile(entry.path);
      if (!result.ok) continue;
      const remaining = MAX_TOTAL_SAMPLE_CHARS - totalChars;
      if (remaining <= 0) break;
      const chunkLimit = Math.min(MAX_FILE_SAMPLE_CHARS, remaining);
      const content = result.content.slice(0, chunkLimit);
      totalChars += content.length;
      files.push({
        path: entry.path,
        relativePath: relativePath(rootDir, entry.path),
        extension: extension(entry.path) || 'file',
        size: entry.size ?? result.content.length,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        content,
        truncated: result.content.length > content.length,
      });
      if (files.length % 20 === 0) onProgress?.(`Scanned ${files.length} project files...`);
    }
  };

  await walk(rootDir, 0);
  return files;
}

function prioritizeEntries(entries: FsEntry[]): FsEntry[] {
  const important = new Set([
    'package.json', 'cargo.toml', 'tauri.conf.json', 'vite.config.ts', 'vite.config.js',
    'tsconfig.json', 'readme.md', 'devlog.md', 'changelog.md', 'src', 'app', 'lib',
    'components', 'features', 'pages', 'routes', 'server', 'api', 'backend', 'frontend',
  ]);
  return [...entries].sort((a, b) => {
    const ai = important.has(a.name.toLowerCase()) ? 0 : 1;
    const bi = important.has(b.name.toLowerCase()) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function isContextCandidate(entry: FsEntry): boolean {
  const ext = extension(entry.path).toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) return false;
  if (entry.size && entry.size > 1_000_000) return false;
  return isPopularTextFile(entry.path) || basename(entry.path).startsWith('.env') || ext.length <= 6;
}

async function generateProviderTree(args: {
  provider: Exclude<ContextGenerationProvider, 'local'>;
  apiKey: string;
  projectId: string | null;
  rootDir: string;
  files: ScannedContextFile[];
}): Promise<ProjectContextTree> {
  const prompt = buildProviderPrompt(args.rootDir, args.files);
  const model = CONTEXT_PROVIDER_OPTIONS[args.provider].model;
  let parsed: {
    summary?: unknown;
    nodes?: unknown;
    recommendedEntryPoints?: unknown;
  } | null = null;

  if (args.provider === 'google') {
    parsed = await requestGoogleJson(args.apiKey, model, prompt);
  } else if (args.provider === 'groq') {
    parsed = await requestOpenAiCompatibleJson(CONTEXT_GROQ_URL, args.apiKey, model, prompt, 'Groq');
  } else if (args.provider === 'openai') {
    parsed = await requestOpenAiCompatibleJson(CONTEXT_OPENAI_URL, args.apiKey, model, prompt, 'OpenAI');
  } else {
    parsed = await requestAnthropicJson(args.apiKey, model, prompt);
  }

  if (!parsed) throw new Error(`${CONTEXT_PROVIDER_OPTIONS[args.provider].label} did not return JSON.`);
  const fileMeta = fileMetadataMap(args.files);
  const nodes = normalizeNodes(parsed.nodes, args.provider, fileMeta);
  if (nodes.length === 0) throw new Error(`${CONTEXT_PROVIDER_OPTIONS[args.provider].label} returned an empty Context tree.`);
  return {
    version: 1,
    projectId: args.projectId,
    rootDir: args.rootDir,
    generatedAt: Date.now(),
    model: `${args.provider}/${model}`,
    fileCount: args.files.length,
    totalBytes: args.files.reduce((sum, file) => sum + file.size, 0),
    summary: typeof parsed.summary === 'string' ? parsed.summary : summarizeFiles(args.files),
    recommendedEntryPoints: Array.isArray(parsed.recommendedEntryPoints)
      ? parsed.recommendedEntryPoints.filter((item): item is string => typeof item === 'string').slice(0, 12)
      : undefined,
    nodes,
  };
}

async function requestGoogleJson(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ summary?: unknown; nodes?: unknown; recommendedEntryPoints?: unknown } | null> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
  return parseJsonObject(text) as {
    summary?: unknown;
    nodes?: unknown;
    recommendedEntryPoints?: unknown;
  } | null;
}

async function requestOpenAiCompatibleJson(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  label: string,
): Promise<{ summary?: unknown; nodes?: unknown; recommendedEntryPoints?: unknown } | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return strict JSON only. No markdown. No prose outside the JSON object.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseJsonObject(data.choices?.[0]?.message?.content ?? '') as {
    summary?: unknown;
    nodes?: unknown;
    recommendedEntryPoints?: unknown;
  } | null;
}

async function requestAnthropicJson(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ summary?: unknown; nodes?: unknown; recommendedEntryPoints?: unknown } | null> {
  const res = await fetch(CONTEXT_ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.2,
      system: 'Return strict JSON only. No markdown. No prose outside the JSON object.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { content?: Array<{ text?: string }> };
  const text = data.content?.map((part) => part.text ?? '').join('\n') ?? '';
  return parseJsonObject(text) as {
    summary?: unknown;
    nodes?: unknown;
    recommendedEntryPoints?: unknown;
  } | null;
}

function buildProviderPrompt(rootDir: string, files: ScannedContextFile[]): string {
  const fileBundle = files.map((file) => [
    `--- FILE ${file.relativePath} (${file.size} bytes${file.createdMs ? `, created ${new Date(file.createdMs).toISOString()}` : ''}${file.modifiedMs ? `, modified ${new Date(file.modifiedMs).toISOString()}` : ''}${file.truncated ? ', sample truncated' : ''}) ---`,
    file.content,
  ].join('\n')).join('\n\n');
  return clamp([
    'Create a project Context map for Jarvis One. Return strict JSON only, no markdown.',
    'The map should help an AI quickly choose the right subsystem and files without rereading the whole repository.',
    'Preserve project structure. Group by domain, feature, service, or package. Include important files as leaf nodes.',
    'Use short, plain-English summaries. Explain what each area or file is for; do not quote source code or write jargon-heavy implementation notes.',
    'Every file node path must exactly match the provided relative path when possible so Jarvis can attach file metadata.',
    'JSON schema:',
    '{"summary":"overall project summary","recommendedEntryPoints":["relative/path"],"nodes":[{"title":"Area","kind":"area","summary":"what this area owns","path":"optional/relative/path","tags":["tag"],"importance":1,"children":[{"title":"File.ts","kind":"file","path":"relative/path","summary":"why this file matters"}]}]}',
    `Project root: ${rootDir}`,
    '',
    fileBundle,
  ].join('\n'), MAX_PROMPT_CHARS);
}

function fileMetadataMap(files: ScannedContextFile[]): Map<string, ScannedContextFile> {
  const map = new Map<string, ScannedContextFile>();
  for (const file of files) {
    map.set(normalizeMetaPath(file.relativePath), file);
    map.set(normalizeMetaPath(file.path), file);
  }
  return map;
}

function metaForPath(fileMeta: Map<string, ScannedContextFile> | undefined, path: string | undefined): ScannedContextFile | undefined {
  if (!fileMeta || !path) return undefined;
  return fileMeta.get(normalizeMetaPath(path));
}

function normalizeMetaPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestampField(value: unknown): number | undefined {
  const num = numericField(value);
  if (typeof num === 'number') return num;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  };
  return undefined;
}

function buildFallbackTree(
  projectId: string | null,
  rootDir: string,
  files: ScannedContextFile[],
  model: string,
): ProjectContextTree {
  const groups = new Map<string, ScannedContextFile[]>();
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean);
    const group = parts.length > 1 ? parts[0]! : 'Project root';
    const list = groups.get(group) ?? [];
    list.push(file);
    groups.set(group, list);
  }

  const nodes: ContextTreeNode[] = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 18)
    .map(([group, groupFiles], index) => ({
      id: stableId(`area-${group}-${index}`),
      title: group,
      kind: 'area',
      path: group === 'Project root' ? undefined : group,
      summary: summarizeGroup(group, groupFiles),
      tags: topExtensions(groupFiles),
      importance: Math.max(1, Math.min(5, Math.ceil(groupFiles.length / 8))),
      sizeBytes: groupFiles.reduce((sum, file) => sum + file.size, 0),
      createdAt: earliestTimestamp(groupFiles.map((file) => file.createdMs)),
      modifiedAt: latestTimestamp(groupFiles.map((file) => file.modifiedMs)),
      children: groupFiles.slice(0, 16).map((file, fileIndex) => ({
        id: stableId(`file-${file.relativePath}-${fileIndex}`),
        title: basename(file.relativePath),
        kind: 'file' as const,
        path: file.relativePath,
        summary: summarizeFile(file),
        tags: [file.extension].filter(Boolean),
        importance: fileImportance(file),
        sizeBytes: file.size,
        createdAt: file.createdMs,
        modifiedAt: file.modifiedMs,
      })),
    }));

  return {
    version: 1,
    projectId,
    rootDir,
    generatedAt: Date.now(),
    model,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    summary: summarizeFiles(files),
    recommendedEntryPoints: files.slice(0, 10).map((file) => file.relativePath),
    nodes,
  };
}

function earliestTimestamp(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length ? Math.min(...filtered) : undefined;
}

function latestTimestamp(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length ? Math.max(...filtered) : undefined;
}

function summarizeFiles(files: ScannedContextFile[]): string {
  const exts = topExtensions(files).join(', ') || 'text/code';
  const roots = Array.from(new Set(files.map((file) => file.relativePath.split('/')[0]).filter(Boolean))).slice(0, 8);
  return `Project context generated from ${files.length} readable files across ${roots.join(', ') || 'the project root'} with primary file types: ${exts}.`;
}

function summarizeGroup(group: string, files: ScannedContextFile[]): string {
  const exts = topExtensions(files).join(', ') || 'mixed';
  return `${group} contains ${files.length} sampled files. Main types: ${exts}. Use this branch when questions mention ${group} paths or related implementation details.`;
}

function summarizeFile(file: ScannedContextFile): string {
  const name = basename(file.relativePath);
  const folder = file.relativePath.split('/').slice(0, -1).join('/') || 'the project root';
  const purpose = inferFilePurpose(file);
  const type = extensionLabel(file.extension);
  const truncation = file.truncated ? ' The scanned preview was shortened because the file is large.' : '';
  return clamp(`${name} ${purpose}. It lives in ${folder} and is one of the project's ${type} files.${truncation}`, 280);
}

function inferFilePurpose(file: ScannedContextFile): string {
  const name = basename(file.relativePath).toLowerCase();
  const path = file.relativePath.toLowerCase();
  if (name === 'package.json') return 'defines the app package, scripts, and JavaScript dependencies';
  if (name === 'cargo.toml') return 'defines the Rust package, features, and dependencies';
  if (name === 'tauri.conf.json') return 'controls the desktop app build, window, bundle, and updater settings';
  if (name.includes('readme')) return 'explains how the project is used or set up';
  if (name.includes('changelog')) return 'records what changed across releases';
  if (name.includes('devlog')) return 'captures development notes and implementation progress';
  if (/\.(test|spec)\./.test(name)) return 'checks that this part of the project keeps working';
  if (name.includes('config') || name.startsWith('vite.') || name.startsWith('tsconfig')) return 'configures tools that build, test, or run the project';
  if (path.includes('/components/') || /\.(tsx|jsx)$/.test(name)) return 'renders part of the user interface';
  if (path.includes('/stores/')) return 'keeps shared app state that screens and features read from';
  if (path.includes('/features/')) return 'belongs to a product feature and helps that feature run';
  if (path.includes('/lib/')) return 'provides shared support code used by other parts of the app';
  if (path.includes('/src-tauri/') || /\.(rs)$/.test(name)) return 'supports the native desktop side of the app';
  if (path.includes('/migrations/')) return 'changes database structure or security rules';
  return 'is part of the project structure and may be useful when questions mention this path';
}

function extensionLabel(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  if (!clean) return 'text';
  if (clean === 'tsx' || clean === 'jsx') return 'interface';
  if (clean === 'ts' || clean === 'js') return 'application code';
  if (clean === 'rs') return 'Rust';
  if (clean === 'json') return 'configuration';
  if (clean === 'md') return 'documentation';
  if (clean === 'sql') return 'database';
  return clean;
}

function topExtensions(files: ScannedContextFile[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ext]) => ext);
}

function fileImportance(file: ScannedContextFile): number {
  const name = basename(file.relativePath).toLowerCase();
  if (['package.json', 'cargo.toml', 'tauri.conf.json', 'vite.config.ts', 'readme.md'].includes(name)) return 5;
  if (/index\.|main\.|app\.|runtime\.|router\.|schema\.|config\./i.test(name)) return 4;
  if (/test\.|spec\./i.test(name)) return 2;
  return 3;
}

function normalizeNodes(raw: unknown, fallbackPrefix: string, fileMeta?: Map<string, ScannedContextFile>): ContextTreeNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((item, index) => normalizeNode(item, `${fallbackPrefix}-${index}`, fileMeta)).filter(Boolean) as ContextTreeNode[];
}

function normalizeNode(raw: unknown, fallbackId: string, fileMeta?: Map<string, ScannedContextFile>): ContextTreeNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!title || !summary) return null;
  const children = normalizeNodes(record.children, fallbackId, fileMeta);
  const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
  const meta = metaForPath(fileMeta, path);
  return {
    id: typeof record.id === 'string' ? stableId(record.id) : stableId(`${fallbackId}-${title}`),
    title: clamp(title, 90),
    kind: isContextKind(record.kind) ? record.kind : children.length > 0 ? 'area' : 'note',
    summary: clamp(summary, 600),
    path,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : undefined,
    importance: typeof record.importance === 'number' ? Math.max(1, Math.min(5, Math.round(record.importance))) : undefined,
    sizeBytes: numericField(record.sizeBytes) ?? numericField(record.size) ?? meta?.size,
    createdAt: timestampField(record.createdAt) ?? timestampField(record.created) ?? meta?.createdMs,
    modifiedAt: timestampField(record.modifiedAt) ?? timestampField(record.modified) ?? meta?.modifiedMs,
    children: children.length > 0 ? children : undefined,
  };
}

function isContextKind(value: unknown): value is ContextNodeKind {
  return value === 'root' || value === 'area' || value === 'file' || value === 'symbol' || value === 'note';
}

function parseJsonObject(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function relativePath(rootDir: string, path: string): string {
  const root = rootDir.replace(/[\\/]$/g, '');
  const normalized = path.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalized.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return normalized.slice(normalizedRoot.length).replace(/^\//, '') || basename(path);
  }
  return normalized;
}

function stableId(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return base || 'context-node';
}

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}...`;
}
