import type {
  GitHubContextServerRepository,
  GitHubContextServerResult,
} from './githubContextAuth';
import type { ContextTreeNode, ProjectContextTree } from './tree';

type GitHubTreeResult = Extract<GitHubContextServerResult, { operation: 'read_tree' }>;

interface MutableContextTreeNode extends ContextTreeNode {
  children: MutableContextTreeNode[];
}

function stablePathId(repositoryId: string, path: string): string {
  let hash = 2_166_136_261;
  const value = `${repositoryId}:${path}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `github-${(hash >>> 0).toString(36)}`;
}

function titleFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

export function buildGitHubProjectContextTree(input: {
  projectId: string | null;
  repository: GitHubContextServerRepository;
  result: GitHubTreeResult;
  generatedAt?: number;
}): ProjectContextTree {
  if (input.result.repositoryId !== input.repository.id) {
    throw new Error('github_context_repository_mismatch');
  }
  const generatedAt = input.generatedAt ?? Date.now();
  const repositoryUrl = `https://github.com/${input.repository.fullName}/tree/${input.result.sha}`;
  const root: MutableContextTreeNode = {
    id: stablePathId(input.repository.id, ''),
    title: input.repository.fullName,
    kind: 'root',
    summary: `Read-only GitHub repository map at ${input.result.sha.slice(0, 12)}.`,
    path: repositoryUrl,
    children: [],
  };
  const nodesByPath = new Map<string, MutableContextTreeNode>([['', root]]);
  const sortedEntries = [...input.result.entries].sort(
    (left, right) =>
      left.path.split('/').length - right.path.split('/').length ||
      left.path.localeCompare(right.path),
  );
  let fileCount = 0;
  let totalBytes = 0;

  const ensureFolder = (path: string): MutableContextTreeNode => {
    const existing = nodesByPath.get(path);
    if (existing) return existing;
    const separator = path.lastIndexOf('/');
    const parentPath = separator < 0 ? '' : path.slice(0, separator);
    const parent = ensureFolder(parentPath);
    const folder: MutableContextTreeNode = {
      id: stablePathId(input.repository.id, `folder:${path}`),
      title: titleFromPath(path),
      kind: 'area',
      summary: `Folder in ${input.repository.fullName}.`,
      path: `${repositoryUrl}/${path}`,
      children: [],
    };
    nodesByPath.set(path, folder);
    parent.children.push(folder);
    return folder;
  };

  for (const entry of sortedEntries) {
    const cleanPath = entry.path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
    if (!cleanPath || cleanPath.includes('/../') || cleanPath.startsWith('../')) continue;
    if (entry.type === 'tree') {
      ensureFolder(cleanPath);
      continue;
    }
    const separator = cleanPath.lastIndexOf('/');
    const parentPath = separator < 0 ? '' : cleanPath.slice(0, separator);
    const parent = ensureFolder(parentPath);
    const sizeBytes = entry.size ?? 0;
    const node: MutableContextTreeNode = {
      id: stablePathId(input.repository.id, `${entry.type}:${cleanPath}`),
      title: titleFromPath(cleanPath),
      kind: 'file',
      summary:
        entry.type === 'commit'
          ? `Git submodule reference in ${input.repository.fullName}.`
          : `Repository file in ${input.repository.fullName}.`,
      path: `${repositoryUrl}/${cleanPath}`,
      ...(entry.size === undefined ? {} : { sizeBytes }),
      children: [],
    };
    parent.children.push(node);
    fileCount += 1;
    totalBytes += sizeBytes;
  }

  const recommendedEntryPoints = sortedEntries
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        /(^|\/)(readme(?:\.[^/]+)?|package\.json|cargo\.toml|pyproject\.toml|go\.mod)$/iu.test(
          entry.path,
        ),
    )
    .map((entry) => `${repositoryUrl}/${entry.path}`)
    .slice(0, 20);

  return {
    version: 1,
    projectId: input.projectId,
    rootDir: repositoryUrl,
    generatedAt,
    model: 'github-context',
    fileCount,
    totalBytes,
    summary: `${input.repository.fullName}: ${fileCount} repository files mapped${
      input.result.truncated ? ' (GitHub returned a truncated tree)' : ''
    }.`,
    nodes: [root],
    recommendedEntryPoints,
  };
}
