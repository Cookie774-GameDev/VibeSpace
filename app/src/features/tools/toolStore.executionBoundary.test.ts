import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_UNBOUND_SYNC_SCOPE_NAME } from '@/lib/cloudSyncQueueOwner';

const builtinRun = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, summary: 'ran' })));

vi.mock('@/lib/actions/registry', () => ({
  getBuiltinAction: (id: string) =>
    id === 'fixture.count'
      ? {
          id,
          category: 'custom',
          label: 'Count',
          description: 'Run a bounded fixture action.',
          params: [{ key: 'count', label: 'Count', type: 'number', required: true }],
          run: builtinRun,
        }
      : undefined,
}));

import { useToolStore, type CustomTool } from './toolStore';

function preset(count: unknown): CustomTool {
  return {
    slug: 'a3-count',
    name: 'A3 Count',
    description: 'Bounded fixture action.',
    baseAction: 'fixture.count',
    params: { count },
    createdAt: 1,
    updatedAt: 1,
    published: null,
  };
}

describe('custom tool execution boundary', () => {
  beforeEach(() => {
    builtinRun.mockClear();
    useToolStore.setState({
      tools: [],
      toolBuckets: {},
      activeScopeName: LOCAL_UNBOUND_SYNC_SCOPE_NAME,
    });
  });

  it('blocks an invalid saved parameter before dispatch and accepts a corrected numeric preset once', async () => {
    useToolStore.setState({ tools: [preset('not-a-number')] });
    const invalid = useToolStore.getState().resolve('custom.a3-count');
    expect(invalid).toBeDefined();
    await expect(invalid!.run({}, { source: 'user' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('count'),
    });
    expect(builtinRun).not.toHaveBeenCalled();

    useToolStore.setState({ tools: [preset('2')] });
    const corrected = useToolStore.getState().resolve('custom.a3-count');
    await expect(corrected!.run({}, { source: 'user' })).resolves.toMatchObject({ ok: true });
    expect(builtinRun).toHaveBeenCalledOnce();
    expect(builtinRun).toHaveBeenCalledWith({ count: 2 }, { source: 'user' });
  });
});
