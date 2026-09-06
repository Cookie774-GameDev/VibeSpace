// @vitest-environment jsdom

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { usePluginStore } from '@/features/plugins';
import { useWorkbenchStore } from './store';
import type { NativeAppDescriptor } from './nativeApps';

const native = vi.hoisted(() => ({
  list: vi.fn<() => Promise<NativeAppDescriptor[]>>(),
  pick: vi.fn<() => Promise<NativeAppDescriptor | null>>(),
}));

vi.mock('./nativeApps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nativeApps')>()),
  listNativeApps: native.list,
  pickNativeAppExecutable: native.pick,
}));
vi.mock('./NativeAppPanel', () => ({
  NativeAppPanel: ({ panel }: { panel: { settings: { nativeAppId?: string } } }) => (
    <div data-testid="native-app-panel">{panel.settings.nativeAppId}</div>
  ),
}));
vi.mock('@/features/terminals/TerminalView', () => ({
  TerminalView: () => <div data-testid="live-terminal">terminal</div>,
}));
vi.mock('@/features/chat', () => ({
  ChatThread: () => <div>thread</div>,
  Composer: () => <div>composer</div>,
  EmptyChat: () => <div>empty</div>,
  ensureActiveChat: vi.fn(async () => 'chat-1'),
}));
vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));

import { WorkbenchPage } from './WorkbenchPage';

const chatgpt: NativeAppDescriptor = {
  id: 'chatgpt',
  name: 'ChatGPT',
  running: true,
  pinned: true,
  launchable: true,
};
const edge: NativeAppDescriptor = {
  id: 'edge',
  name: 'Microsoft Edge',
  path: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  processName: 'msedge.exe',
  running: true,
  pinned: false,
  launchable: true,
};

describe('Workbench native app integration', () => {
  it('keeps a chosen taskbar pin after remount and supports unpinning', async () => {
    const first = render(<WorkbenchPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Microsoft Edge to taskbar' }));
    first.unmount();
    render(<WorkbenchPage />);
    expect(await screen.findByRole('button', { name: 'Open Microsoft Edge' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Unpin Microsoft Edge from taskbar' }),
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Open Microsoft Edge' })).toBeNull();
  });
  it('refreshes the catalog when Apps is opened after an application becomes available', async () => {
    native.list.mockResolvedValueOnce([]).mockResolvedValue([chatgpt, edge]);
    render(<WorkbenchPage />);
    await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    expect(await screen.findByRole('button', { name: 'Open Microsoft Edge' })).toBeTruthy();
  });
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    window.localStorage.clear();
    useWorkbenchStore.getState().resetWorkbench();
    useUIStore.setState({ route: 'workbench' });
    useAuthStore.setState({ cloudSession: null, localUserId: 'local-account', projectId: null });
    usePluginStore.setState({
      connectionsByAccount: {},
      installedPluginIdsByAccount: {},
      pinnedPluginIdsByAccount: {},
    });
    native.list.mockReset().mockResolvedValue([chatgpt, edge]);
    native.pick.mockReset().mockResolvedValue(null);
  });

  it('auto-adds detected ADE icons and opens the real app panel without Space Chat', async () => {
    render(<WorkbenchPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open ChatGPT' }));
    expect((await screen.findByTestId('native-app-panel')).textContent).toContain('chatgpt');
    expect(useWorkbenchStore.getState().panels.at(-1)).toMatchObject({
      kind: 'native-app',
      title: 'ChatGPT',
      settings: { nativeAppId: 'chatgpt', nativeAppName: 'ChatGPT' },
    });
    expect(screen.queryByTestId('workbench-chatgpt-ade')).toBeNull();
  });

  it('opens any detected app or a picked executable from the custom app dialog', async () => {
    const custom: NativeAppDescriptor = {
      id: 'custom',
      name: 'Demo',
      path: String.raw`C:\Tools\Demo.exe`,
      processName: 'Demo.exe',
      running: false,
      pinned: false,
      launchable: true,
    };
    native.pick.mockResolvedValue(custom);
    render(<WorkbenchPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open app' }));
    fireEvent.click(screen.getByRole('button', { name: /Open Microsoft Edge/i }));
    expect(useWorkbenchStore.getState().panels.at(-1)).toMatchObject({
      kind: 'native-app',
      title: 'Microsoft Edge',
      settings: { nativeAppId: 'edge', nativeAppPath: edge.path },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose executable' }));
    await waitFor(() => expect(native.pick).toHaveBeenCalledOnce());
    expect(useWorkbenchStore.getState().panels.at(-1)).toMatchObject({
      kind: 'native-app',
      title: 'Demo',
      settings: { nativeAppId: 'custom', nativeAppPath: custom.path },
    });

    act(() => useUIStore.setState({ route: 'context' }));
  });
});
