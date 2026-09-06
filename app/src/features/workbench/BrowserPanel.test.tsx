// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { BrowserPanel } from './BrowserPanel';
import type { WorkbenchPanel } from './types';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/lib/tauri', () => ({ openExternal: native.openExternal }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isTauri: true,
}));

function panel(url: string): WorkbenchPanel {
  return {
    id: 'browser-1',
    kind: 'browser',
    title: 'Browser',
    x: 0,
    y: 0,
    width: 680,
    height: 440,
    z: 1,
    minimized: false,
    status: 'ready',
    settings: { url },
  };
}

describe('Workbench BrowserPanel delivery', () => {
  beforeEach(() => {
    useUIStore.setState({ route: 'workbench' });
    native.invoke.mockReset();
    native.openExternal.mockReset();
    native.openExternal.mockResolvedValue(undefined);
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: args?.url,
          loading: true,
          error: null,
        };
      }
      if (command === 'workbench_browser_surface_status') {
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: 'https://example.com/',
          loading: false,
          error: null,
        };
      }
      return undefined;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 80,
      top: 80,
      left: 20,
      right: 660,
      bottom: 480,
      width: 640,
      height: 400,
      toJSON: () => ({}),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('keeps the address readable in the warm theme', () => {
    render(<BrowserPanel panel={panel('http://localhost:5173/')} onUpdate={vi.fn()} />);
    const address = screen.getByLabelText('Browser address');
    expect(address.className).toContain('[html[data-theme=warm]_&]:bg-background');
    expect(address.className).toContain('[html[data-theme=warm]_&]:text-foreground');
    expect(address.className).toContain('[html[data-theme=warm]_&]:caret-foreground');
  });

  it.each(['Back', 'Forward', 'Reload browser', 'Stop loading'])(
    'reconciles native status after %s',
    async (control) => {
      render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith(
          'workbench_browser_surface_status',
          expect.anything(),
        ),
      );
      await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
      const before = native.invoke.mock.calls.filter(
        ([command]) => command === 'workbench_browser_surface_status',
      ).length;
      fireEvent.click(screen.getByRole('button', { name: control }));
      await waitFor(() =>
        expect(
          native.invoke.mock.calls.filter(
            ([command]) => command === 'workbench_browser_surface_status',
          ).length,
        ).toBeGreaterThan(before),
      );
      await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    },
  );

  it('keeps localhost interactive inside Workbench', () => {
    render(<BrowserPanel panel={panel('http://localhost:5173/')} onUpdate={vi.fn()} />);
    expect(screen.getByTitle('Browser web page').getAttribute('src')).toBe(
      'http://localhost:5173/',
    );
    expect(native.invoke).not.toHaveBeenCalledWith(
      'workbench_browser_surface_open',
      expect.anything(),
    );
  });

  it('keeps ordinary remote navigation in a bounded native child and accepts native link state', async () => {
    const onUpdate = vi.fn();
    let nativeUrl = 'https://example.com/';
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        nativeUrl = String(args?.url);
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: nativeUrl,
          loading: true,
          error: null,
        };
      }
      if (command === 'workbench_browser_surface_status') {
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: nativeUrl === 'https://github.com/' ? 'https://github.com/openai/' : nativeUrl,
          loading: false,
          error: null,
        };
      }
      return undefined;
    });
    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={onUpdate} />);

    expect(screen.queryByTitle('Browser web page')).toBeNull();
    expect(screen.getByTestId('workbench-browser-native-surface')).toBeTruthy();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({
          panelId: 'browser-1',
          url: 'https://example.com/',
          bounds: { x: 20, y: 80, width: 640, height: 400 },
        }),
      ),
    );

    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'https://github.com/' },
    });
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);

    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ url: 'https://github.com/' }),
      ),
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ url: 'https://github.com/' }),
      }),
    );
    const openCall = native.invoke.mock.calls.find(
      ([command]) => command === 'workbench_browser_surface_open',
    );
    const openedOperationId = openCall?.[1]?.operationId;
    expect(openedOperationId).toEqual(expect.any(String));

    await waitFor(() =>
      expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
        'https://github.com/openai/',
      ),
    );

    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ url: 'https://github.com/openai/' }),
      ),
    );
  });

  it('preserves website navigation when layout changes and does not flash loading', async () => {
    let liveUrl = 'https://example.com/';
    let left = 20;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => ({
      x: left,
      y: 80,
      top: 80,
      left,
      right: left + 640,
      bottom: 480,
      width: 640,
      height: 400,
      toJSON: () => ({}),
    }));
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        if (!args?.preserveNavigation) liveUrl = String(args?.url);
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: liveUrl,
          loading: false,
          error: null,
        };
      }
      return undefined;
    });
    const initial = panel(liveUrl);
    const view = render(<BrowserPanel panel={initial} onUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    await act(async () => Promise.resolve());
    liveUrl = 'https://example.com/search?q=hello';
    left = 40;
    view.rerender(<BrowserPanel panel={{ ...initial, x: 20 }} onUpdate={vi.fn()} />);
    await act(async () => Promise.resolve());
    expect(liveUrl).toBe('https://example.com/search?q=hello');
    expect(screen.queryByText('Loading…')).toBeNull();
    const before = native.invoke.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Browser address'), { target: { value: 'draft' } });
    await act(async () => Promise.resolve());
    expect(native.invoke.mock.calls.length).toBe(before);
    liveUrl = 'https://example.com/another-link';
    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'https://example.com/search?q=hello' },
    });
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);
    await act(async () => Promise.resolve());
    expect(liveUrl).toBe('https://example.com/search?q=hello');
  });

  it('keeps an explicit Go queued behind an in-flight layout refresh', async () => {
    let finishLayout: (() => void) | undefined;
    let deferLayout = false;
    let liveUrl = 'https://example.com/';
    native.invoke.mockImplementation(async (command, args) => {
      if (command !== 'workbench_browser_surface_open') return undefined;
      if (args?.preserveNavigation && deferLayout) {
        deferLayout = false;
        await new Promise<void>((resolve) => {
          finishLayout = resolve;
        });
      }
      if (!args?.preserveNavigation) liveUrl = String(args?.url);
      return {
        panelId: args?.panelId,
        operationId: args?.operationId,
        url: liveUrl,
        loading: false,
      };
    });
    const initial = panel(liveUrl);
    const view = render(<BrowserPanel panel={initial} onUpdate={vi.fn()} />);
    await act(async () => Promise.resolve());
    liveUrl = 'https://example.com/a-link';
    deferLayout = true;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 40,
      y: 80,
      top: 80,
      left: 40,
      right: 680,
      bottom: 480,
      width: 640,
      height: 400,
      toJSON: () => ({}),
    });
    view.rerender(<BrowserPanel panel={{ ...initial, x: 20 }} onUpdate={vi.fn()} />);
    await waitFor(() => expect(finishLayout).toBeTypeOf('function'));
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);
    await act(async () => {
      await Promise.resolve();
      finishLayout?.();
    });
    expect(liveUrl).toBe('https://example.com/');
  });

  it('coalesces concurrent mount and bounds opens for the same native child', async () => {
    let finishOpen: (() => void) | undefined;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        await new Promise<void>((resolve) => {
          finishOpen = resolve;
        });
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: args?.url,
          loading: false,
          error: null,
        };
      }
      return undefined;
    });

    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);

    await waitFor(() => expect(finishOpen).toEqual(expect.any(Function)));
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'workbench_browser_surface_open'),
    ).toHaveLength(1);
    act(() => finishOpen?.());
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_browser_surface_open',
        ),
      ).toHaveLength(1),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reconciles terminal native state without a renderer event callback', async () => {
    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);

    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_status',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not replace a user-edited address when stale native status settles', async () => {
    let finishStatus: ((payload: unknown) => void) | undefined;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: 'https://example.com/',
          loading: true,
          error: null,
        };
      }
      if (command === 'workbench_browser_surface_status') {
        return new Promise((resolve) => {
          finishStatus = resolve;
        });
      }
      return undefined;
    });

    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
    await waitFor(() => expect(finishStatus).toEqual(expect.any(Function)));

    const address = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: 'https://wikipedia.org/wiki/Browser' } });
    act(() =>
      finishStatus?.({
        panelId: 'browser-1',
        operationId: native.invoke.mock.calls.find(
          ([command]) => command === 'workbench_browser_surface_open',
        )?.[1]?.operationId,
        url: 'https://example.com/',
        loading: false,
        error: null,
      }),
    );

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(address.value).toBe('https://wikipedia.org/wiki/Browser');
  });

  it('does not reopen a settled native surface for unchanged resize bounds', async () => {
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: args?.url,
          loading: false,
          error: null,
        };
      }
      return undefined;
    });

    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_browser_surface_open',
        ),
      ).toHaveLength(1),
    );

    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));

    await act(async () => Promise.resolve());
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'workbench_browser_surface_open'),
    ).toHaveLength(1);
  });

  it('retires the native child immediately when the immediate route leaves Workbench', async () => {
    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );

    act(() => useUIStore.setState({ route: 'context' }));

    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_hide',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );
  });

  it('retires the native child while minimized and recreates it after restore', async () => {
    const initialPanel = panel('https://example.com/');
    const view = render(<BrowserPanel panel={initialPanel} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_browser_surface_open',
        ),
      ).toHaveLength(1),
    );

    view.rerender(<BrowserPanel panel={{ ...initialPanel, minimized: true }} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_hide',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );

    view.rerender(<BrowserPanel panel={initialPanel} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_browser_surface_open',
        ),
      ).toHaveLength(2),
    );
  });

  it('synchronizes React-driven panel movement without waiting for resize or scroll', async () => {
    let left = 20;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: left,
      y: 80,
      top: 80,
      left,
      right: left + 640,
      bottom: 480,
      width: 640,
      height: 400,
      toJSON: () => ({}),
    }));
    const initialPanel = panel('https://example.com/');
    const view = render(<BrowserPanel panel={initialPanel} onUpdate={vi.fn()} />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ bounds: expect.objectContaining({ x: 20 }) }),
      ),
    );

    left = 140;
    view.rerender(
      <BrowserPanel
        panel={{ ...initialPanel, x: 120, title: 'Moved browser' }}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ bounds: expect.objectContaining({ x: 140 }) }),
      ),
    );
  });

  it('retires a native child that moves outside the visible Workbench canvas', async () => {
    let surfaceLeft = 40;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('workbench-canvas')) {
        return {
          x: 0,
          y: 40,
          top: 40,
          left: 0,
          right: 800,
          bottom: 640,
          width: 800,
          height: 600,
          toJSON: () => ({}),
        };
      }
      return {
        x: surfaceLeft,
        y: 80,
        top: 80,
        left: surfaceLeft,
        right: surfaceLeft + 640,
        bottom: 480,
        width: 640,
        height: 400,
        toJSON: () => ({}),
      };
    });
    const initialPanel = panel('https://example.com/');
    const view = render(
      <div className="workbench-canvas">
        <BrowserPanel panel={initialPanel} onUpdate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_open',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );

    surfaceLeft = 240;
    view.rerender(
      <div className="workbench-canvas">
        <BrowserPanel panel={{ ...initialPanel, x: 200 }} onUpdate={vi.fn()} />
      </div>,
    );

    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_hide',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );
  });

  it('retains an explicit external-browser action for any valid address draft', async () => {
    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
    const address = screen.getByLabelText('Browser address');
    fireEvent.change(address, { target: { value: 'wikipedia.org/wiki/Browser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open in external browser' }));

    await waitFor(() =>
      expect(native.openExternal).toHaveBeenCalledWith('https://wikipedia.org/wiki/Browser'),
    );
  });

  it('shows an exact native string rejection instead of masking it', async () => {
    native.invoke.mockImplementation(async (command) => {
      if (command === 'workbench_browser_surface_open') {
        throw 'workbench_browser_webview_unavailable';
      }
    });

    render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'workbench_browser_webview_unavailable',
      ),
    );
  });

  it('closes a child only after an in-flight open settles during unmount', async () => {
    let finishOpen: (() => void) | undefined;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_browser_surface_open') {
        await new Promise<void>((resolve) => {
          finishOpen = resolve;
        });
        return {
          panelId: args?.panelId,
          operationId: args?.operationId,
          url: args?.url,
          loading: false,
          error: null,
        };
      }
      return undefined;
    });

    const view = render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
    await waitFor(() => expect(finishOpen).toEqual(expect.any(Function)));
    view.unmount();
    expect(native.invoke).not.toHaveBeenCalledWith(
      'workbench_browser_surface_hide',
      expect.anything(),
    );

    act(() => finishOpen?.());
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_browser_surface_hide',
        expect.objectContaining({ panelId: 'browser-1' }),
      ),
    );
  });
});
