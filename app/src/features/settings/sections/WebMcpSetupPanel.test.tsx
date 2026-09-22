import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopConnectorSetup } from './DesktopConnectorSetup';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
  localStorage.clear();
});
it('opens a native mini panel with tutorial tabs instead of an external setup page', async () => {
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? {
          packaged: true,
          status: 'disconnected',
          connectionDetected: true,
          hasKey: false,
          toolCount: 54,
          displayName: 'VibeSpace Desktop',
          tunnelId: '',
          step: 1,
          guideTab: 'tunnel',
        }
      : undefined,
  );
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  expect(await screen.findByRole('dialog', { name: 'WebMCP setup' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Tunnel video' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'API key video' })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'prepare' });
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup');
});

function backend() {
  let status = {
    packaged: true,
    connectionDetected: true,
    status: 'disconnected',
    toolCount: 54,
    hasKey: false,
    displayName: 'VibeSpace Desktop',
    tunnelId: '',
    step: 1,
    guideTab: 'tunnel',
    enabled: true,
  };
  invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_connector_status') return { ...status };
    if (args?.action === 'save') {
      const { apiKey, ...draft } = args.draft;
      status = { ...status, ...draft, hasKey: status.hasKey || Boolean(apiKey) };
    }
  });
  return { getStatus: () => status };
}
it('saves the tunnel, selected video and name across panel close/reopen', async () => {
  const server = backend();
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'WebMCP app name' }), {
    target: { value: 'My saved plugin' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Tunnel ID' }), {
    target: { value: 'tunnel_test_12345678' },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'API key video' }));
  expect(screen.getByRole('tab', { name: 'API key video' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'WebMCP setup' })).toBeNull());
  expect(server.getStatus().guideTab).toBe('api');
  fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
  expect(
    ((await screen.findByRole('textbox', { name: 'WebMCP app name' })) as HTMLInputElement).value,
  ).toBe('My saved plugin');
  expect((screen.getByRole('textbox', { name: 'Tunnel ID' }) as HTMLInputElement).value).toBe(
    'tunnel_test_12345678',
  );
  expect(screen.getByTestId('saved-tunnel').textContent).toContain('Tunnel saved');
  expect(screen.getByRole('tab', { name: 'API key video' }).getAttribute('aria-selected')).toBe(
    'true',
  );
});
it('clears a protected key after acknowledgement and never stores it in the browser', async () => {
  backend();
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Tunnel ID' }), {
    target: { value: 'tunnel_test_12345678' },
  });
  fireEvent.change(screen.getByLabelText('Runtime API key'), {
    target: { value: 'unit-test-runtime-credential-123' },
  });
  await screen.findByText('Saved securely');
  expect(document.body.textContent).not.toContain('unit-test-runtime-credential-123');
  expect(JSON.stringify({ ...localStorage })).not.toContain('unit-test-runtime-credential-123');
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  expect((screen.getByLabelText('Runtime API key') as HTMLInputElement).value).toBe('');
});
it('retains the draft and reports failure rather than pretending a failed close saved it', async () => {
  backend();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    args?.action === 'save'
      ? Promise.reject(new Error('fixture native failure'))
      : original(command, args),
  );
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'WebMCP app name' }), {
    target: { value: 'Not yet saved' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Close WebMCP setup' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'WebMCP setup' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'WebMCP app name' }) as HTMLInputElement).value).toBe(
    'Not yet saved',
  );
});
it('keeps direct tutorial links and switches between the two local recordings', async () => {
  backend();
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  const video = await screen.findByLabelText('Tunnel setup tutorial');
  expect(video.getAttribute('src')).toContain('tunnel-setup.mp4');
  expect(video.hasAttribute('controls')).toBe(true);
  expect(screen.getByRole('link', { name: 'Open OpenAI Tunnels' }).getAttribute('href')).toBe(
    'https://platform.openai.com/settings/organization/tunnels',
  );
  fireEvent.click(screen.getByRole('tab', { name: 'API key video' }));
  expect(screen.getByLabelText('Runtime API key tutorial').getAttribute('src')).toContain(
    'api-key-setup.mp4',
  );
  fireEvent.click(screen.getByRole('link', { name: 'Create runtime API key' }));
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'open-api-keys' });
});

it('coalesces close with an in-flight autosave instead of resending a runtime credential', async () => {
  backend();
  const original = invoke.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saves = 0;
  invoke.mockImplementation(async (command, args) => {
    if (args?.action === 'save') {
      saves++;
      await gate;
    }
    return original(command, args);
  });
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  fireEvent.change(await screen.findByLabelText('Runtime API key'), {
    target: { value: 'unit-test-runtime-credential-123' },
  });
  await waitFor(() => expect(saves).toBe(1));
  fireEvent.click(screen.getByRole('button', { name: 'Close WebMCP setup' }));
  await act(async () => release());
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'WebMCP setup' })).toBeNull());
  expect(saves).toBe(1);
});

it('allows a connecting tunnel to be stopped before replacing credentials', async () => {
  invoke.mockImplementation(async (command) =>
    command === 'desktop_connector_status'
      ? {
          packaged: true,
          connectionDetected: true,
          status: 'connecting',
          hasKey: true,
          toolCount: 54,
          displayName: 'Test',
          tunnelId: 'tunnel_123456789',
          step: 1,
          guideTab: 'tunnel',
          enabled: true,
        }
      : undefined,
  );
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }));
  const stop = await screen.findByRole('button', { name: 'Stop connection' });
  fireEvent.click(stop);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'disconnect' }),
  );
});
it('keeps a credential-storage failure distinct from tunnel permission errors', async () => {
  backend();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    args?.action === 'save'
      ? Promise.reject('CREDENTIAL_STORAGE_UNAVAILABLE')
      : original(command, args),
  );
  render(<DesktopConnectorSetup />);
  fireEvent.click(await screen.findByRole('button', { name: 'Setup' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Tunnel ID' }), {
    target: { value: 'tunnel_123456789' },
  });
  fireEvent.change(screen.getByLabelText('Runtime API key'), {
    target: { value: 'synthetic-runtime-api-key-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect tunnel' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/secure.*storage/i);
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'connect' });
});
