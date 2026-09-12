import { describe, expect, it, vi } from 'vitest';
import { createRlmOpenCodeTool } from './rlmOpenCodeTool';

const response = {
  route: 'retrieval' as const,
  promptBlock: 'bounded evidence',
  evidenceCount: 1,
  childCalls: 0,
  maxDepth: 0,
  truncated: false,
  trace: [],
};

describe('vibespace_context.query tool', () => {
  it('uses the authenticated active project instead of model-selected scope', async () => {
    const query = vi.fn(async () => response);
    const tool = createRlmOpenCodeTool({
      resolveScope: async () => ({ accountId: 'account-1', projectId: 'project-1' }),
      query,
    });
    await expect(tool.invoke({ question: 'What was the previous decision?' })).resolves.toEqual(
      response,
    );
    expect(query).toHaveBeenCalledWith({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'What was the previous decision?',
      performance: 'quality',
    });
  });

  it('rejects cross-project scope supplied by a model', async () => {
    const tool = createRlmOpenCodeTool({
      resolveScope: async () => ({ accountId: 'account-1', projectId: 'project-1' }),
      query: vi.fn(async () => response),
    });
    await expect(
      tool.invoke({ question: 'Search it', projectId: 'other-project' }),
    ).rejects.toThrow('active authenticated project scope');
  });
});
