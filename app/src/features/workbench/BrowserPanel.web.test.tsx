// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BrowserPanel } from './BrowserPanel';
import { useUIStore } from '@/stores/ui';
import type { WorkbenchPanel } from './types';

const native = vi.hoisted(() => ({ invoke: vi.fn(), openExternal: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/lib/tauri', () => ({ openExternal: native.openExternal }));
vi.mock('@/lib/utils', async (original) => ({
  ...(await original<typeof import('@/lib/utils')>()),
  isTauri: false,
}));

function panel(url: string): WorkbenchPanel {
  return {
    id: 'web-browser-test',
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

beforeEach(() => {
  useUIStore.setState({ route: 'workbench' });
  native.invoke.mockReset();
  native.openExternal.mockReset().mockResolvedValue(undefined);
});

it('keeps an unembeddable website in Workbench without opening a tab automatically', () => {
  render(<BrowserPanel panel={panel('https://amazon.com/')} onUpdate={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Open in browser tab' })).toBeTruthy();
  expect(native.openExternal).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Browser address'), { target: { value: 'YouTube.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  expect(native.openExternal).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(screen.queryByTitle('Browser web page')).toBeNull();
  expect(screen.queryByText('Loading…')).toBeNull();
  expect(screen.getByText(/desktop VibeSpace browser/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload browser' }));
  expect(native.openExternal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open in browser tab' }));
  expect(native.openExternal).toHaveBeenCalledWith('https://youtube.com/');
});

it('keeps a verified embeddable page inside the Workbench iframe', () => {
  render(<BrowserPanel panel={panel('https://example.com/')} onUpdate={vi.fn()} />);
  expect(screen.getByTitle('Browser web page').getAttribute('src')).toBe('https://example.com/');
  expect(native.openExternal).not.toHaveBeenCalled();
});

it('renders official YouTube video embeds with a referrer and no native IPC', () => {
  render(<BrowserPanel panel={panel('https://youtu.be/abc123')} onUpdate={vi.fn()} />);
  const frame = screen.getByTitle('Browser web page');
  expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abc123');
  expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
  expect(native.invoke).not.toHaveBeenCalled();
});

it('rejects unsafe addresses before opening a tab', () => {
  render(<BrowserPanel panel={panel('https://amazon.com/')} onUpdate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Browser address'), {
    target: { value: 'javascript:alert(1)' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  expect(native.openExternal).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('Only HTTP and HTTPS');
});
