import { describe, expect, it, vi } from 'vitest';
import {
  resolvePromptForgeExecutionScope,
  type PromptForgeScopeRepository,
} from './promptForgeExecutionScope';

const job = { accountId: 'account-1', chatId: 'chat-1', projectId: 'project-1' };
function repository(
  overrides: Partial<PromptForgeScopeRepository> = {},
): PromptForgeScopeRepository {
  return {
    subject: vi.fn(async () => ({ workspace_id: 'workspace-1', project_id: 'project-1' })),
    workspace: vi.fn(async () => ({ owner_id: 'account-1' })),
    project: vi.fn(async () => ({ workspace_id: 'workspace-1' })),
    ...overrides,
  };
}

describe('Prompt Forge owned execution scope', () => {
  it('derives exact ownership without reusing the source chat session', async () => {
    const repo = repository();
    const scope = await resolvePromptForgeExecutionScope(job, repo);
    expect(scope).toEqual({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(scope).not.toHaveProperty('chatId');
    expect(repo.subject).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(repo.workspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
    expect(repo.project).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('supports a terminal or chat with no project without inventing a project', async () => {
    const repo = repository({ subject: vi.fn(async () => ({ workspace_id: 'workspace-1' })) });
    expect(
      await resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal-1', projectId: null },
        repo,
      ),
    ).toEqual({ accountId: 'account-1', workspaceId: 'workspace-1' });
    expect(repo.project).not.toHaveBeenCalled();
  });

  it('resolves the existing namespaced terminal job through its owned project', async () => {
    const repo = repository({ subject: vi.fn(async () => undefined) });
    await expect(
      resolvePromptForgeExecutionScope({ ...job, chatId: 'terminal:project-1:pane-1' }, repo),
    ).resolves.toEqual({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });
  });

  it('resolves a namespaced terminal without a project only from its actual saved session', async () => {
    const repo = repository({ subject: vi.fn(async () => ({ workspace_id: 'workspace-1' })) });
    await expect(
      resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal:none:session-1', projectId: null },
        repo,
      ),
    ).resolves.toEqual({ accountId: 'account-1', workspaceId: 'workspace-1' });
    expect(repo.subject).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(repo.project).not.toHaveBeenCalled();
  });

  it('rejects a terminal project/account mismatch and an unbound global pane', async () => {
    await expect(
      resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal:project-2:pane-1' },
        repository({ subject: async () => undefined }),
      ),
    ).rejects.toThrow();
    await expect(
      resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal:project-1:pane-1' },
        repository({
          subject: async () => undefined,
          workspace: async () => ({ owner_id: 'account-2' }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal:project-1:session-1' },
        repository({
          subject: async () => ({ workspace_id: 'workspace-1', project_id: 'project-2' }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      resolvePromptForgeExecutionScope(
        { ...job, chatId: 'terminal:none:unbound', projectId: null },
        repository({ subject: async () => undefined }),
      ),
    ).rejects.toThrow();
  });

  const invalid: Array<[string, Partial<PromptForgeScopeRepository>]> = [
    ['missing source', { subject: async () => undefined }],
    ['missing workspace', { workspace: async () => undefined }],
    ['different account', { workspace: async () => ({ owner_id: 'account-2' }) }],
    [
      'changed project',
      { subject: async () => ({ workspace_id: 'workspace-1', project_id: 'project-2' }) },
    ],
    ['missing project', { project: async () => undefined }],
    ['cross-workspace project', { project: async () => ({ workspace_id: 'workspace-2' }) }],
  ];
  it.each(invalid)('rejects %s rather than guessing an active scope', async (_name, overrides) => {
    await expect(resolvePromptForgeExecutionScope(job, repository(overrides))).rejects.toThrow(
      'original owned chat or terminal workspace',
    );
  });

  it('does not read unrelated records for an empty account or source identifier', async () => {
    const repo = repository();
    for (const candidate of [
      { ...job, accountId: '' },
      { ...job, chatId: ' ' },
    ]) {
      await expect(resolvePromptForgeExecutionScope(candidate, repo)).rejects.toThrow();
    }
    expect(repo.subject).not.toHaveBeenCalled();
    expect(repo.workspace).not.toHaveBeenCalled();
  });
});
