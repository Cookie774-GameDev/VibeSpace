import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { DesktopConnectorSetup } from './DesktopConnectorSetup';
import { WebMcpSetupPanel } from './WebMcpSetupPanel';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
  localStorage.clear();
});
it('shares preparation across development effect replay instead of reporting a competing owner', async () => {
  let release!: () => void;
  let preparing = false;
  let ready = false;
  invoke.mockImplementation((command, args) => {
    if (command === 'desktop_connector_status')
      return Promise.resolve({ packaged: true, status: 'disconnected', connectionDetected: ready });
    if (args?.action === 'prepare') {
      if (preparing) return Promise.reject('CONNECTOR_LOCK_IN_USE');
      preparing = true;
      return new Promise<void>((resolve) => {
        release = () => {
          ready = true;
          resolve();
        };
      });
    }
    return Promise.resolve();
  });
  render(
    <StrictMode>
      <WebMcpSetupPanel onStatus={vi.fn()} onClose={vi.fn()} />
    </StrictMode>,
  );
  await act(async () => {});
  const requests = invoke.mock.calls.filter(
    ([command, args]) => command === 'desktop_connector_setup' && args?.action === 'prepare',
  );
  await act(async () => release());
  await waitFor(() => expect(screen.queryByText(/Preparing your packaged tools/)).toBeNull());
  expect(requests).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('shows both tutorials and ChatGPT instructions while native preparation is pending', async () => {
  invoke.mockImplementation((command) =>
    command === 'desktop_connector_status'
      ? Promise.resolve({ packaged: true, status: 'disconnected', connectionDetected: false })
      : new Promise(() => {}),
  );
  render(<WebMcpSetupPanel onStatus={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByLabelText('Tunnel setup tutorial')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Tunnel ID' }) as HTMLInputElement).disabled).toBe(
    false,
  );
  expect((screen.getByLabelText('Runtime API key') as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'API key video' }));
  expect(screen.getByLabelText('Runtime API key tutorial')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Add to ChatGPT/ }));
  expect(screen.getByText('One last step in ChatGPT')).toBeTruthy();
  const plugins = screen.getByRole('link', { name: 'Open ChatGPT Plugins' });
  expect(plugins.getAttribute('href')).toBe('https://chatgpt.com/plugins');
  fireEvent.click(plugins);
  expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'open-chatgpt' });
  expect(
    (screen.getByRole('button', { name: 'Connect tunnel' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('ends a stuck preparation with a retryable error and ignores a late reply after closing', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const onStatus = vi.fn();
  const view = render(<WebMcpSetupPanel onStatus={onStatus} onClose={vi.fn()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240000);
  });
  expect(screen.getByRole('alert').textContent).toMatch(/timed out/i);
  expect(screen.getByRole('button', { name: 'Retry preparation' })).toBeTruthy();
  view.unmount();
  await act(async () => release());
  expect(onStatus).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it('reports an interrupted connector lock and offers an explicit repair without silently reconnecting', async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_connector_status') return { packaged: true, status: 'disconnected' };
    if (args?.action === 'prepare') throw 'CONNECTOR_LOCK_INVALID';
  });
  render(<WebMcpSetupPanel onStatus={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/interrupted.*startup/i);
  fireEvent.click(screen.getByRole('button', { name: 'Repair interrupted setup' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('desktop_connector_setup', { action: 'repair' }),
  );
  expect(invoke).not.toHaveBeenCalledWith('desktop_connector_setup', { action: 'connect' });
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
  const setupButton = await screen.findByRole('button', { name: 'Setup' });
  await waitFor(() => expect((setupButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(setupButton);
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
it('accepts credentials during preparation, preserves them and saves only after readiness', async () => {
  const server = backend();
  const backendInvoke = invoke.getMockImplementation()!;
  let release!: () => void;
  invoke.mockImplementation((command, args) =>
    args?.action === 'prepare'
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : backendInvoke(command, args),
  );
  render(<WebMcpSetupPanel onStatus={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Tunnel ID'), {
    target: { value: 'tunnel_entered_12345678' },
  });
  fireEvent.change(screen.getByLabelText('Runtime API key'), {
    target: { value: 'synthetic-runtime-key' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'WebMCP app name' }), {
    target: { value: 'Entered while preparing' },
  });
  expect(invoke).not.toHaveBeenCalledWith(
    'desktop_connector_setup',
    expect.objectContaining({ action: 'save' }),
  );
  await act(async () => release());
  await waitFor(() => expect(server.getStatus().tunnelId).toBe('tunnel_entered_12345678'));
  expect((screen.getByLabelText('Tunnel ID') as HTMLInputElement).value).toBe(
    'tunnel_entered_12345678',
  );
  expect(server.getStatus().displayName).toBe('Entered while preparing');
  expect(server.getStatus().hasKey).toBe(true);
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-runtime-key');
});
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
