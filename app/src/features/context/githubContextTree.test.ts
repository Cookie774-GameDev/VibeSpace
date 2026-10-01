import { describe, expect, it } from 'vitest';
import { buildGitHubProjectContextTree } from './githubContextTree';

describe('buildGitHubProjectContextTree', () => {
  it('creates a deterministic nested tree with exact GitHub file locations', () => {
    const tree = buildGitHubProjectContextTree({
      projectId: 'project-1',
      repository: {
        id: '42',
        owner: 'viper',
        name: 'vibespace',
        fullName: 'viper/vibespace',
        private: true,
        defaultBranch: 'main',
      },
      result: {
        operation: 'read_tree',
        repositoryId: '42',
        sha: 'a'.repeat(40),
        truncated: false,
        entries: [
          { path: 'src', mode: '040000', type: 'tree', sha: 'b'.repeat(40) },
          {
            path: 'src/main.ts',
            mode: '100644',
            type: 'blob',
            sha: 'c'.repeat(40),
            size: 120,
          },
          {
            path: 'README.md',
            mode: '100644',
            type: 'blob',
            sha: 'd'.repeat(40),
            size: 80,
          },
        ],
      },
      generatedAt: 123,
    });

    expect(tree.fileCount).toBe(2);
    expect(tree.totalBytes).toBe(200);
    expect(tree.rootDir).toBe(`https://github.com/viper/vibespace/tree/${'a'.repeat(40)}`);
    expect(tree.nodes[0]?.children?.map((node) => node.title)).toEqual(['README.md', 'src']);
    expect(tree.nodes[0]?.children?.[1]?.children?.[0]?.path).toContain('/src/main.ts');
    expect(tree.recommendedEntryPoints?.[0]).toContain('/README.md');
  });

  it('rejects a tree returned for a different repository', () => {
    expect(() =>
      buildGitHubProjectContextTree({
        projectId: null,
        repository: {
          id: '42',
          owner: 'viper',
          name: 'vibespace',
          fullName: 'viper/vibespace',
          private: false,
          defaultBranch: 'main',
        },
        result: {
          operation: 'read_tree',
          repositoryId: '43',
          sha: 'a'.repeat(40),
          truncated: false,
          entries: [],
        },
      }),
    ).toThrow('github_context_repository_mismatch');
  });
});
