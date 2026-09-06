// @vitest-environment jsdom

import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { NativeAppPanel } from './NativeAppPanel';
import type { WorkbenchPanel } from './types';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isTauri: true,
}));

function appPanel(patch: Partial<WorkbenchPanel> = {}): WorkbenchPanel {
  return {
    id: 'native-1',
    kind: 'native-app',
    title: 'ChatGPT',
    x: 20,
    y: 40,
    width: 700,
    height: 480,
    z: 1,
    minimized: false,
    status: 'idle',
    settings: {
      nativeAppId: 'chatgpt',
      nativeAppName: 'ChatGPT',
      nativeAppPath: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`,
    },
    ...patch,
  };
}

function nativeStatus(args?: Record<string, unknown>) {
  return {
    panelId: args?.panelId,
    operationId: args?.operationId,
    appId: args?.appId ?? 'chatgpt',
    name: args?.name ?? 'ChatGPT',
    embedded: true,
    running: true,
    error: null,
  };
}

describe('Workbench NativeAppPanel', () => {
  it('shows a truthful external fallback and focuses only on explicit action', async () => {
    native.invoke.mockImplementation(async (command, args) => {
      if (
        command === 'workbench_native_app_surface_open' ||
        command === 'workbench_native_app_surface_status'
      )
        return { ...nativeStatus(args), embedded: false, fallback: true, owned: false };
    });
    render(
      <div className="workbench-canvas">
        <NativeAppPanel panel={appPanel()} onUpdate={vi.fn()} />
      </div>,
    );
    const focus = await screen.findByRole('button', { name: 'Focus ChatGPT' });
    expect(screen.getByText(/separate window/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(native.invoke.mock.calls.some(([c]) => c === 'workbench_native_app_surface_focus')).toBe(
      false,
    );
    focus.click();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_native_app_surface_focus',
        expect.objectContaining({ panelId: 'native-1' }),
      ),
    );
  });

  beforeEach(() => {
    useUIStore.setState({ route: 'workbench' });
    native.invoke.mockReset();
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'workbench_native_app_surface_open') return nativeStatus(args);
      return undefined;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('workbench-canvas')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 1200,
          bottom: 800,
          width: 1200,
          height: 800,
          toJSON: () => ({}),
        };
      }
      return {
        x: 30,
        y: 90,
        top: 90,
        left: 30,
        right: 690,
        bottom: 510,
        width: 660,
        height: 420,
        toJSON: () => ({}),
      };
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('opens the exact desktop app as a bounded interactive child surface', async () => {
    const onUpdate = vi.fn();
    render(
      <div className="workbench-canvas">
        <NativeAppPanel panel={appPanel()} onUpdate={onUpdate} />
      </div>,
    );

    expect(screen.getByTestId('workbench-native-app-surface')).toBeTruthy();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_native_app_surface_open',
        expect.objectContaining({
          panelId: 'native-1',
          appId: 'chatgpt',
          name: 'ChatGPT',
          path: expect.stringContaining('ChatGPT.exe'),
          bounds: { x: 30, y: 90, width: 660, height: 420 },
          operationId: expect.any(String),
        }),
      ),
    );
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('coalesces repeated layout commits with unchanged bounds', async () => {
    const view = render(
      <div className="workbench-canvas">
        <NativeAppPanel panel={appPanel()} onUpdate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_native_app_surface_open',
        ),
      ).toHaveLength(1),
    );

    view.rerender(
      <div className="workbench-canvas">
        <NativeAppPanel panel={{ ...appPanel(), title: 'ChatGPT desktop' }} onUpdate={vi.fn()} />
      </div>,
    );
    act(() => window.dispatchEvent(new Event('resize')));
    await act(async () => Promise.resolve());

    expect(
      native.invoke.mock.calls.filter(
        ([command]) => command === 'workbench_native_app_surface_open',
      ),
    ).toHaveLength(1);
  });

  it('hides while minimized or off-route and reopens after restore', async () => {
    const base = appPanel();
    const view = render(
      <div className="workbench-canvas">
        <NativeAppPanel panel={base} onUpdate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_native_app_surface_open',
        expect.objectContaining({ panelId: 'native-1' }),
      ),
    );

    view.rerender(
      <div className="workbench-canvas">
        <NativeAppPanel panel={{ ...base, minimized: true }} onUpdate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'workbench_native_app_surface_hide',
        expect.objectContaining({ panelId: 'native-1' }),
      ),
    );

    view.rerender(
      <div className="workbench-canvas">
        <NativeAppPanel panel={base} onUpdate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_native_app_surface_open',
        ),
      ).toHaveLength(2),
    );

    act(() => useUIStore.setState({ route: 'context' }));
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_native_app_surface_hide',
        ),
      ).toHaveLength(2),
    );
  });

  it('shows the exact native failure and supports an explicit retry', async () => {
    native.invoke.mockRejectedValueOnce('workbench_native_app_window_unavailable');
    render(
      <div className="workbench-canvas">
        <NativeAppPanel panel={appPanel()} onUpdate={vi.fn()} />
      </div>,
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'workbench_native_app_window_unavailable',
    );
    screen.getByRole('button', { name: 'Retry ChatGPT' }).click();
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === 'workbench_native_app_surface_open',
        ),
      ).toHaveLength(2),
    );
  });
});
