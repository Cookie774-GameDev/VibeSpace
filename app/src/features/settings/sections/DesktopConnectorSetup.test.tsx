import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopConnectorSetup } from './DesktopConnectorSetup';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
it('opens external setup only on explicit action and displays verified tool status', async () => {
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? { packaged: true, connectionDetected: true, status: 'ready', toolCount: 45, hasKey: true }
      : undefined,
  );
  render(<DesktopConnectorSetup />);
  await screen.findByText('Tunnel ready · 45 tools detected');
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup');
  fireEvent.click(screen.getByRole('button', { name: 'Resume setup' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_connector_setup'));
  expect(screen.getByText(/Finish adding the connector in ChatGPT/)).toBeTruthy();
});
it('does not claim missing resources are preloaded', async () => {
  invoke.mockResolvedValue({ packaged: false, status: 'disconnected', connectionDetected: false });
  render(<DesktopConnectorSetup />);
  await screen.findByText('Connector package is not included in this build.');
  expect((screen.getByRole('button', { name: 'Setup' }) as HTMLButtonElement).disabled).toBe(true);
});
