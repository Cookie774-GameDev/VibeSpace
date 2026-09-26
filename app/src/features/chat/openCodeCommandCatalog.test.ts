import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';
import { fetchOpenCodeCommandCatalog, parseOpenCodeCommandCatalog, useOpenCodeCommandCatalog } from './openCodeCommandCatalog';

vi.mock('@/lib/harness/openCodeNativeTransport', () => ({ nativeOpenCodeRequest: vi.fn() }));

describe('OpenCode command catalog', () => {
  it('queries commands in the exact project directory', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify([{ name: 'project-only' }])));
    await fetchOpenCodeCommandCatalog('generation-1', request, 'D:/Fixture Root/project');
    expect(request).toHaveBeenCalledWith('generation-1', '/command?directory=D%3A%2FFixture%20Root%2Fproject');
  });

  it('does not expose commands from another project directory on the same runtime', async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(nativeOpenCodeRequest).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const seen: Array<{ directory: string; names: string[] }> = [];
    const view = renderHook(({ directory }) => {
      const state = useOpenCodeCommandCatalog('same-generation', true, directory);
      seen.push({ directory, names: state.commands.map(command => command.name) });
      return state;
    }, { initialProps: { directory: 'D:/project-a' } });
    const response = (name: string) => new Response(JSON.stringify([{ name }]));
    await act(async () => pending[0]!(response('project-a-only')));
    view.rerender({ directory: 'D:/project-b' });
    expect(seen.filter(row => row.directory === 'D:/project-b').every(row => row.names.length === 0)).toBe(true);
    view.rerender({ directory: 'D:/project-c' });
    await act(async () => pending[1]!(response('stale-project-b')));
    expect(view.result.current.commands).toEqual([]);
    await act(async () => pending[2]!(response('project-c-only')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['project-c-only']);
    view.unmount();
  });

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
  it('preserves exact identifiers and source-separated commands without exposing templates', () => {
    expect(
      parseOpenCodeCommandCatalog({
        data: [
          {
            name: 'Init',
            description: 'Initialize',
            template: 'private template',
            source: 'command',
          },
          { name: 'init', description: 'Prompt', source: 'mcp' },
          { name: 'Init', description: 'Duplicate', source: 'command' },
          { name: 'bad name', description: 'not a slash token', source: 'command' },
          { name: 'my_command', description: 'keep underscores', source: 'skill' },
          null,
        ],
      }),
    ).toEqual([
      {
        name: 'Init',
        identifier: 'Init',
        identity: 'opencode:command:Init',
        source: 'command',
        executionCapability: 'session-command',
        description: 'Initialize',
      },
      {
        name: 'init',
        identifier: 'init',
        identity: 'opencode:mcp:init',
        source: 'mcp',
        executionCapability: 'session-command',
        description: 'Prompt',
      },
      {
        name: 'bad name',
        identifier: 'bad name',
        identity: 'opencode:command:bad%20name',
        source: 'command',
        executionCapability: 'requires-native-cli-ui',
        description: 'not a slash token',
      },
      {
        name: 'my_command',
        identifier: 'my_command',
        identity: 'opencode:skill:my_command',
        source: 'skill',
        executionCapability: 'session-command',
        description: 'keep underscores',
      },
    ]);
  });

  it('keeps catalogs larger than the old picker cap intact', () => {
    const commands = Array.from({ length: 140 }, (_, index) => ({
      name: `command-${index}`,
      source: 'command',
    }));

    expect(parseOpenCodeCommandCatalog(commands)).toHaveLength(140);
  });

  it('contains malformed UTF-16 identifiers to one disabled catalog entry', () => {
    const [command] = parseOpenCodeCommandCatalog([{ name: '\uD800', source: 'future' }]);

    expect(command).toMatchObject({
      identity: 'opencode:future:utf16-d800',
      source: 'future',
      executionCapability: 'requires-native-cli-ui',
    });
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
