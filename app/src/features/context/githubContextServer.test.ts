import { describe, expect, it, vi } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import { createGitHubContextProxy } from '../../../../supabase/functions/_shared/githubContextProxy';
import { createGitHubContextServerExecutor } from './githubContextAuth';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function serverDependencies(overrides: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    getInstallation: vi.fn(async () => ({
      id: 42,
      account: { id: 7, type: 'User' },
      permissions: { contents: 'read', metadata: 'read' },
    })),
    createInstallationToken: vi.fn(async ({ repositoryIds }: { repositoryIds?: string[] }) => ({
      token: 'ghs_________________________',
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      repositories: (repositoryIds ?? ['101']).map((id) => ({
        id,
        full_name: 'octo/example',
      })),
    })),
    githubRequest: vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith('/installation/repositories')) {
        return {
          total_count: 1,
          repositories: [
            {
              id: 101,
              name: 'example',
              full_name: 'octo/example',
              private: true,
              default_branch: 'main',
            },
          ],
        };
      }
      if (path.includes('/git/trees/')) {
        return {
          sha: 'a'.repeat(40),
          truncated: false,
          tree: [
            {
              path: 'src/index.ts',
              mode: '100644',
              type: 'blob',
              sha: 'b'.repeat(40),
              size: 42,
            },
          ],
        };
      }
      return {
        sha: 'b'.repeat(40),
        encoding: 'base64',
        content: 'ZXhwb3J0IGNvbnN0IG9rID0gdHJ1ZTs=',
        size: 23,
      };
    }),
    ...overrides,
  };
}

describe('GitHub Context authenticated server proxy', () => {
  it('lists only closed repository metadata for the verified personal installation', async () => {
    const dependencies = serverDependencies();
    const proxy = createGitHubContextProxy(dependencies);

    const result = await proxy.execute(
      { userId: 'user-1', githubUserId: '7' },
      { operation: 'list_repositories', installationId: '42', page: 1 },
    );

    expect(result).toEqual({
      operation: 'list_repositories',
      page: 1,
      hasMore: false,
      repositories: [
        {
          id: '101',
          owner: 'octo',
          name: 'example',
          fullName: 'octo/example',
          private: true,
          defaultBranch: 'main',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/ghs_|token|expires_at/i);
    expect(dependencies.createInstallationToken).toHaveBeenCalledWith({
      installationId: '42',
      repositoryIds: undefined,
    });
  });

  it('rejects a foreign or organization installation before minting a token', async () => {
    const foreign = serverDependencies({
      getInstallation: vi.fn(async () => ({
        id: 42,
        account: { id: 8, type: 'User' },
        permissions: { contents: 'read', metadata: 'read' },
      })),
    });
    await expect(
      createGitHubContextProxy(foreign).execute(
        { userId: 'user-1', githubUserId: '7' },
        { operation: 'list_repositories', installationId: '42' },
      ),
    ).rejects.toThrow('github_context_installation_forbidden');
    expect(foreign.createInstallationToken).not.toHaveBeenCalled();

    const organization = serverDependencies({
      getInstallation: vi.fn(async () => ({
        id: 42,
        account: { id: 7, type: 'Organization' },
        permissions: { contents: 'read', metadata: 'read' },
      })),
    });
    await expect(
      createGitHubContextProxy(organization).execute(
        { userId: 'user-1', githubUserId: '7' },
        { operation: 'list_repositories', installationId: '42' },
      ),
    ).rejects.toThrow('github_context_installation_forbidden');
    expect(organization.createInstallationToken).not.toHaveBeenCalled();
  });

  it('rejects expired, overlong, or over-privileged token grants', async () => {
    for (const expiresAt of [NOW, NOW + 3_600_001]) {
      const dependencies = serverDependencies({
        createInstallationToken: vi.fn(async () => ({
          token: 'ghs_________________________',
          expires_at: new Date(expiresAt).toISOString(),
          repositories: [],
        })),
      });
      await expect(
        createGitHubContextProxy(dependencies).execute(
          { userId: 'user-1', githubUserId: '7' },
          { operation: 'list_repositories', installationId: '42' },
        ),
      ).rejects.toThrow('github_context_token_invalid');
      expect(dependencies.githubRequest).not.toHaveBeenCalled();
    }

    const overPrivileged = serverDependencies({
      getInstallation: vi.fn(async () => ({
        id: 42,
        account: { id: 7, type: 'User' },
        permissions: { contents: 'write', metadata: 'read' },
      })),
    });
    await expect(
      createGitHubContextProxy(overPrivileged).execute(
        { userId: 'user-1', githubUserId: '7' },
        { operation: 'list_repositories', installationId: '42' },
      ),
    ).rejects.toThrow('github_context_permissions_invalid');
  });

  it('narrows tree and blob tokens to an authoritative repository identity', async () => {
    const dependencies = serverDependencies();
    const proxy = createGitHubContextProxy(dependencies);

    const tree = await proxy.execute(
      { userId: 'user-1', githubUserId: '7' },
      {
        operation: 'read_tree',
        installationId: '42',
        repositoryId: '101',
        ref: 'main',
      },
    );
    expect(tree).toEqual({
      operation: 'read_tree',
      repositoryId: '101',
      sha: 'a'.repeat(40),
      truncated: false,
      entries: [
        {
          path: 'src/index.ts',
          mode: '100644',
          type: 'blob',
          sha: 'b'.repeat(40),
          size: 42,
        },
      ],
    });

    const blob = await proxy.execute(
      { userId: 'user-1', githubUserId: '7' },
      {
        operation: 'read_blob',
        installationId: '42',
        repositoryId: '101',
        sha: 'b'.repeat(40),
      },
    );
    expect(blob).toEqual({
      operation: 'read_blob',
      repositoryId: '101',
      sha: 'b'.repeat(40),
      encoding: 'base64',
      content: 'ZXhwb3J0IGNvbnN0IG9rID0gdHJ1ZTs=',
      size: 23,
    });
    expect(dependencies.createInstallationToken).toHaveBeenCalledWith({
      installationId: '42',
      repositoryIds: ['101'],
    });
    expect(dependencies.githubRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/repos/octo/example/git/trees/main?recursive=1`,
      }),
    );
    expect(dependencies.githubRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/repos/octo/example/git/blobs/${'b'.repeat(40)}`,
      }),
    );
  });

  it('fails closed when a narrowed grant omits or substitutes the repository', async () => {
    const dependencies = serverDependencies({
      createInstallationToken: vi.fn(async () => ({
        token: 'ghs_________________________',
        expires_at: new Date(NOW + 3_600_000).toISOString(),
        repositories: [{ id: 999, full_name: 'other/repository' }],
      })),
    });
    await expect(
      createGitHubContextProxy(dependencies).execute(
        { userId: 'user-1', githubUserId: '7' },
        {
          operation: 'read_tree',
          installationId: '42',
          repositoryId: '101',
          ref: 'main',
        },
      ),
    ).rejects.toThrow('github_context_repository_forbidden');
    expect(dependencies.githubRequest).not.toHaveBeenCalled();
  });

  it('rejects caller authority fields, write operations, malformed refs, and extra keys', async () => {
    const proxy = createGitHubContextProxy(serverDependencies());
    for (const request of [
      {
        operation: 'list_repositories',
        installationId: '42',
        accountId: 'forged',
      },
      { operation: 'write_blob', installationId: '42' },
      {
        operation: 'read_tree',
        installationId: '42',
        repositoryId: '101',
        ref: 'main\u2028forged',
      },
    ]) {
      await expect(proxy.execute({ userId: 'user-1', githubUserId: '7' }, request)).rejects.toThrow(
        'github_context_request_invalid',
      );
    }
  });
});

describe('GitHub Context client boundary', () => {
  it('invokes only the authenticated function with an account-stable tokenless request', async () => {
    const invoke = vi.fn(async () => ({
      data: {
        operation: 'list_repositories',
        page: 1,
        hasMore: false,
        repositories: [],
      },
      error: null,
    }));
    const executor = createGitHubContextServerExecutor({
      invoke,
      getActiveAccountId: () => 'account-1',
    });

    await expect(
      executor.execute('account-1', {
        operation: 'list_repositories',
        installationId: '42',
      }),
    ).resolves.toEqual({
      operation: 'list_repositories',
      page: 1,
      hasMore: false,
      repositories: [],
    });
    expect(invoke).toHaveBeenCalledWith('github-context', {
      body: { operation: 'list_repositories', installationId: '42' },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/account-1|ghs_|private.?key/i);
  });

  it('rejects account changes, provider failures, malformed data, and token-bearing output', async () => {
    let activeAccountId = 'account-1';
    const accountChange = createGitHubContextServerExecutor({
      getActiveAccountId: () => activeAccountId,
      invoke: async () => {
        activeAccountId = 'account-2';
        return {
          data: {
            operation: 'list_repositories',
            page: 1,
            hasMore: false,
            repositories: [],
          },
          error: null,
        };
      },
    });
    await expect(
      accountChange.execute('account-1', {
        operation: 'list_repositories',
        installationId: '42',
      }),
    ).rejects.toThrow('github_context_account_changed');

    const cases = [
      { data: null, error: new Error('provider leaked detail') },
      {
        data: {
          operation: 'list_repositories',
          page: 1,
          hasMore: false,
          repositories: [],
          token: syntheticCredentialFixture('ghs_', 'SyntheticLeakedInstallationToken123456'),
        },
        error: null,
      },
      {
        data: {
          operation: 'read_blob',
          repositoryId: '101',
          sha: 'b'.repeat(40),
          encoding: 'base64',
          content: btoa(
            `token=${syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890')}`,
          ),
          size: 47,
        },
        error: null,
      },
    ];
    for (const response of cases) {
      const executor = createGitHubContextServerExecutor({
        getActiveAccountId: () => 'account-1',
        invoke: async () => response,
      });
      await expect(
        executor.execute('account-1', {
          operation: 'list_repositories',
          installationId: '42',
        }),
      ).rejects.toThrow(/^github_context_(request_failed|response_invalid)$/);
    }
  });
});
