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

// The generation/directory stays fixed: these are overlapping periodic refreshes.
it.each([
  { label: 'older success after newer success', olderFails: false, newerFails: false },
  { label: 'older failure after newer success', olderFails: true, newerFails: false },
  { label: 'older success after newer failure', olderFails: false, newerFails: true },
])('keeps the latest catalog result for $label', async ({ olderFails, newerFails }) => {
  vi.useFakeTimers();
  const pending: Array<{ resolve(response: Response): void; reject(error: Error): void }> = [];
  vi.mocked(nativeOpenCodeRequest).mockReset().mockImplementation(() => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  const response = (name: string) => new Response(JSON.stringify([{ name, source: 'command' }]));
  const view = renderHook(() => useOpenCodeCommandCatalog('stable-generation', true, 'C:/synthetic-catalog'));
  try {
    expect(pending).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pending).toHaveLength(2);
    await act(async () => {
      if (newerFails) pending[1]!.resolve(new Response('Unavailable', { status: 503 }));
      else pending[1]!.resolve(response('current-command'));
    });
    const latest = view.result.current;
    if (newerFails) {
      expect(latest.commands).toEqual([]);
      expect(latest.error).toContain('(503)');
    } else {
      expect(latest.commands.map(command => command.name)).toEqual(['current-command']);
      expect(latest.error).toBeUndefined();
    }
    await act(async () => {
      if (olderFails) pending[0]!.reject(new Error('Older transport failure'));
      else pending[0]!.resolve(response('stale-command'));
    });
    expect(view.result.current).toEqual(latest);
    // A later genuine refresh still recovers normally after ignored stale IO.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pending).toHaveLength(3);
    await act(async () => pending[2]!.resolve(response('recovered-command')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['recovered-command']);
    expect(view.result.current.error).toBeUndefined();
    expect(vi.mocked(nativeOpenCodeRequest).mock.calls).toEqual(Array.from({ length: 3 }, () => [
      'stable-generation', '/command?directory=C%3A%2Fsynthetic-catalog',
    ]));
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(nativeOpenCodeRequest).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it('keeps a useful earlier catalog while the next periodic refresh is still pending', async () => {
  vi.useFakeTimers();
  const pending: Array<(response: Response) => void> = [];
  vi.mocked(nativeOpenCodeRequest).mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const view = renderHook(() => useOpenCodeCommandCatalog('stable-generation', true));
  const response = (name: string) => new Response(JSON.stringify([{ name }]));
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pending).toHaveLength(2);
    await act(async () => pending[0]!(response('first-valid-command')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['first-valid-command']);
    await act(async () => pending[1]!(response('latest-valid-command')));
    expect(view.result.current.commands.map(command => command.name)).toEqual(['latest-valid-command']);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
