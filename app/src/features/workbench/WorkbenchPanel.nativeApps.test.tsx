// @vitest-environment jsdom

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchPanel as WorkbenchPanelModel } from './types';

const native = vi.hoisted(() => ({ detach: vi.fn<() => Promise<void>>() }));
vi.mock('./nativeApps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nativeApps')>()),
  detachNativeAppSurface: native.detach,
}));
vi.mock('./NativeAppPanel', () => ({ NativeAppPanel: () => <div>native surface</div> }));

import { WorkbenchPanel } from './WorkbenchPanel';

const panel: WorkbenchPanelModel = {
  id: 'native-1',
  kind: 'native-app',
  title: 'ChatGPT',
  x: 0,
  y: 0,
  width: 700,
  height: 480,
  z: 1,
  minimized: false,
  status: 'ready',
  settings: { nativeAppId: 'chatgpt', nativeAppName: 'ChatGPT' },
};

describe('WorkbenchPanel native app close lifecycle', () => {
  it('keeps the panel recoverable when native cleanup fails', async () => {
    native.detach.mockReset().mockRejectedValue(new Error('cleanup unavailable'));
    const onClose = vi.fn();
    render(
      <WorkbenchPanel
        panel={panel}
        selected
        zoom={1}
        onSelect={vi.fn()}
        onBringToFront={vi.fn()}
        onUpdate={vi.fn()}
        onRuntimeUpdate={vi.fn()}
        onDuplicate={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close ChatGPT' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cleanup unavailable');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close ChatGPT' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
  it('detaches the owned window before removing the panel', async () => {
    const order: string[] = [];
    native.detach.mockReset().mockImplementation(async () => {
      order.push('detach');
    });
    const onClose = vi.fn(() => order.push('close'));
    render(
      <WorkbenchPanel
        panel={panel}
        selected
        zoom={1}
        onSelect={vi.fn()}
        onBringToFront={vi.fn()}
        onUpdate={vi.fn()}
        onRuntimeUpdate={vi.fn()}
        onDuplicate={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close ChatGPT' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(native.detach).toHaveBeenCalledWith('native-1');
    expect(order).toEqual(['detach', 'close']);
  });
});
