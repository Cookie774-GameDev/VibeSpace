import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';
import { fetchOpenCodeCommandCatalog, parseOpenCodeCommandCatalog, useOpenCodeCommandCatalog } from './openCodeCommandCatalog';

vi.mock('@/lib/harness/openCodeNativeTransport', () => ({ nativeOpenCodeRequest: vi.fn() }));

describe('OpenCode command catalog', () => {
  it('never exposes another generation or disabled backend commands, including late replies', async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(nativeOpenCodeRequest).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const seen: Array<{ generation: string; enabled: boolean; names: string[] }> = [];
    const view = renderHook(({ generation, enabled }) => {
      const state = useOpenCodeCommandCatalog(generation, enabled);
      seen.push({ generation, enabled, names: state.commands.map(command => command.name) });
      return state;
    }, { initialProps: { generation: 'first', enabled: true } });
    const response = (name: string) => new Response(JSON.stringify([{ name }]));
    await act(async () => pending[0]!(response('init')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['init']);
    view.rerender({ generation: 'second', enabled: true });
    expect(seen.filter(row => row.generation === 'second').every(row => row.names.length === 0)).toBe(true);
    view.rerender({ generation: 'third', enabled: true });
    await act(async () => pending[1]!(response('stale')));
    expect(view.result.current.commands).toEqual([]);
    await act(async () => pending[2]!(response('review')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['review']);
    view.rerender({ generation: 'third', enabled: false });
    expect(seen.filter(row => !row.enabled).every(row => row.names.length === 0)).toBe(true);
    view.unmount();
  });
  it('accepts the live envelope and keeps only safe command metadata', () => {
    expect(parseOpenCodeCommandCatalog({
      data: [
        { name: ' Init ', description: 'Initialize', template: 'private template', source: 'command' },
        { name: 'init', description: 'replacement' },
        { name: 'bad name', description: 'ignore' },
        { name: 'my_command', description: 'keep underscores' },
        null,
      ],
    })).toEqual([
      { name: 'init', description: 'replacement' },
      { name: 'my_command', description: 'keep underscores' },
    ]);
  });

  it('rejects a malformed or failed live query instead of retaining stale commands', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    await expect(fetchOpenCodeCommandCatalog('generation-1', request)).rejects.toThrow('(503)');
    await expect(fetchOpenCodeCommandCatalog(
      'generation-2',
      vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 200 })),
    )).rejects.toThrow('malformed');
  });
});
