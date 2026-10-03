import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WebMcpSetupPanel } from './WebMcpSetupPanel';
import { DesktopConnectorSetup } from './DesktopConnectorSetup';
import { webMcpConnectionReady, type WebMcpStatus } from './webMcpSetupClient';
const fixture = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
const ready: WebMcpStatus = {
  packaged: true, connectionDetected: true, status: 'ready', toolCount: 54, hasKey: true,
  displayName: 'Disposable health fixture', tunnelId: 'tunnel_health_fixture', guideTab: 'tunnel',
  step: 1, setupComplete: true, enabled: true, watchdog: true,
};
afterEach(() => { cleanup(); vi.useRealTimers(); fixture.invoke.mockReset(); });

it('requires a fresh actual connection rather than saved completion or an unavailable last-ready snapshot', () => {
  expect(webMcpConnectionReady(ready, true)).toBe(true);
  expect(webMcpConnectionReady(ready, false)).toBe(false);
  expect(webMcpConnectionReady({ ...ready, connectionDetected: false }, true)).toBe(false);
  expect(webMcpConnectionReady({ ...ready, enabled: false }, true)).toBe(false);
  expect(webMcpConnectionReady({ ...ready, status: 'disconnected' }, true)).toBe(false);
  expect(webMcpConnectionReady({ ...ready, toolCount: 0 }, true)).toBe(false);
});

it('makes a failed panel status poll visibly unverified and restores readiness only after a successful read, without reconnecting', async () => {
  vi.useFakeTimers();
  let reachable = true;
  fixture.invoke.mockImplementation(async (command: string) => {
    if (command !== 'desktop_connector_status') return undefined;
    if (!reachable) throw new Error('private diagnostic never displayed');
    return { ...ready };
  });
  await act(async () => {
    render(<WebMcpSetupPanel onStatus={vi.fn()} onClose={vi.fn()} />);
    await Promise.resolve();
  });
  expect(screen.getByText('Tunnel ready')).toBeTruthy();
  reachable = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('Connection status unavailable')).toBeTruthy();
  expect(screen.queryByText('Tunnel ready')).toBeNull();
  expect(screen.queryByText(/private diagnostic/)).toBeNull();
  reachable = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('Tunnel ready')).toBeTruthy();
  expect(screen.queryByText('Connection status unavailable')).toBeNull();
  expect(fixture.invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'connect' });
  expect(fixture.invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'disconnect' });
});

it('does not advertise a ready desktop link after status loss and clears the unavailable projection on recovery', async () => {
  vi.useFakeTimers();
  let reachable = true;
  fixture.invoke.mockImplementation(async () => {
    if (!reachable) throw new Error('synthetic unavailable');
    return { ...ready };
  });
  await act(async () => { render(<DesktopConnectorSetup />); await Promise.resolve(); });
  expect(screen.getByRole('status').textContent).toContain('Tunnel ready');
  reachable = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole('status').textContent).toContain('Connection status unavailable');
  expect(screen.getByRole('status').textContent).not.toContain('Tunnel ready');
  reachable = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole('status').textContent).toContain('Tunnel ready');
  expect(screen.queryByText(/Connection status is available in the installed Windows app/)).toBeNull();
});
