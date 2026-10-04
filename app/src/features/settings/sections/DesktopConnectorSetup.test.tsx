import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopConnectorSetup } from './DesktopConnectorSetup';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
it('offers Windows startup independently before tunnel setup is complete', async () => {
  let startup = false;
  invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_connector_setup') {
      startup = args.action === 'startup-on';
      return;
    }
    return {
      packaged: true,
      connectionDetected: false,
      status: 'disconnected',
      toolCount: 0,
      setupComplete: false,
      startOnComputer: startup,
    };
  });
  render(<DesktopConnectorSetup />);
  const toggle = await screen.findByRole('switch', { name: 'Start with computer' });
  expect((toggle as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'startup-on' });
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'connect' });
});
it('opens in-app setup only on explicit action and displays verified tool status', async () => {
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? { packaged: true, connectionDetected: true, status: 'ready', toolCount: 45, hasKey: true }
      : undefined,
  );
  render(<DesktopConnectorSetup />);
  await screen.findByText('Tunnel ready · 45 tools detected');
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup');
  fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'prepare' }),
  );
  expect(await screen.findByRole('dialog', { name: 'WebMCP setup' })).toBeTruthy();
  expect(screen.getByText(/Setup complete/)).toBeTruthy();
});
it('keeps setup guidance available without claiming missing resources are preloaded', async () => {
  invoke.mockResolvedValue({ packaged: false, status: 'disconnected', connectionDetected: false });
  render(<DesktopConnectorSetup />);
  await screen.findByText('Connector package is not included in this build.');
  expect((screen.getByRole('button', { name: 'Setup' }) as HTMLButtonElement).disabled).toBe(false);
});
it('ends initial checking on a failed status request and lets setup retry', async () => {
  invoke.mockRejectedValue(new Error('native status unavailable'));
  render(<DesktopConnectorSetup />);
  await screen.findByText('Connection status unavailable · checking again');
  expect(screen.queryByText('Checking connection…')).toBeNull();
  const setup = screen.getByRole('button', { name: 'Setup' });
  expect((setup as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(setup);
  expect(await screen.findByRole('dialog', { name: 'WebMCP setup' })).toBeTruthy();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'prepare' }),
  );
});
it('offers setup while the initial status request has not replied', () => {
  invoke.mockReturnValue(new Promise(() => {}));
  render(<DesktopConnectorSetup />);
  expect((screen.getByRole('button', { name: 'Setup' }) as HTMLButtonElement).disabled).toBe(false);
});
it('makes verified local tools available without requiring tunnel credentials', async () => {
  invoke.mockResolvedValue({
    packaged: true,
    connectionDetected: true,
    connectionFile: 'C:/local/state/connection.json',
    status: 'disconnected',
    toolCount: 54,
    hasKey: false,
    setupComplete: false,
  });
  const onConnectionReady = vi.fn();
  render(<DesktopConnectorSetup onConnectionReady={onConnectionReady} />);
  await waitFor(() =>
    expect(onConnectionReady).toHaveBeenCalledWith('C:/local/state/connection.json'),
  );
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'connect' });
});
it('retains setup progress without claiming a saved key is a verified connection', async () => {
  invoke.mockResolvedValue({ packaged: true, hasKey: true, status: 'connecting', toolCount: 45 });
  render(<DesktopConnectorSetup />);
  await screen.findByRole('button', { name: 'Resume setup' });
  expect(screen.queryByText(/Setup complete/)).toBeNull();
});
it('applies Off through the native controller and displays its readback', async () => {
  let enabled = true;
  invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_connector_setup') {
      enabled = args.action !== 'disconnect';
      return;
    }
    return {
      packaged: true,
      hasKey: true,
      setupComplete: true,
      status: enabled ? 'ready' : 'off',
      toolCount: 45,
      enabled,
      watchdog: true,
      startOnComputer: false,
    };
  });
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable Desktop Link MCP' }));
  await screen.findByText('MCP is off · automatic recovery paused');
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'disconnect' });
  expect(screen.getByRole('button', { name: 'Connection settings' })).toBeTruthy();
});
it('does not claim a failed change succeeded', async () => {
  invoke.mockImplementation(async (command) => {
    if (command === 'desktop_connector_setup') throw Error('fixture failure');
    return { packaged: true, setupComplete: true, status: 'ready', toolCount: 45, enabled: true };
  });
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable Desktop Link MCP' }));
  await screen.findByRole('alert');
  expect(
    screen.getByRole('switch', { name: 'Enable Desktop Link MCP' }).getAttribute('aria-checked'),
  ).toBe('true');
});

it('does not describe a Windows startup failure as a tunnel setup failure', async () => {
  invoke.mockImplementation(async (command) => {
    if (command === 'desktop_connector_setup') throw new Error('fixture Windows registry denial');
    return {
      packaged: true,
      connectionDetected: true,
      setupComplete: true,
      status: 'ready',
      toolCount: 54,
      enabled: true,
      hasKey: true,
      startOnComputer: false,
    };
  });
  render(<DesktopConnectorSetup />);
  await screen.findByText('Tunnel ready · 54 tools detected');
  fireEvent.click(await screen.findByRole('switch', { name: 'Start with computer' }));
  const message = await screen.findByRole('alert');
  expect(message.textContent).toMatch(/Windows.+startup.+permissions/i);
  expect(
    screen.getByRole('switch', { name: 'Start with computer' }).getAttribute('aria-checked'),
  ).toBe('false');
  expect(screen.getByText('Connection status unavailable · checking again')).toBeTruthy();
  fireEvent.focus(window);
  expect(await screen.findByText('Tunnel ready · 54 tools detected')).toBeTruthy();
});
