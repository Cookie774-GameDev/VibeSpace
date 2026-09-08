import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/features/plugins/openMcpManager', () => ({ requestOpenMcpManager: vi.fn() }));
import { DesktopCommanderSettings } from './DesktopCommanderSettings';
afterEach(cleanup);
it('edits all six real settings and preserves unsaved changes in other fields', async () => {
  const config = {
    blockedCommands: ['format'],
    allowedDirectories: [],
    defaultShell: 'powershell.exe',
    telemetryEnabled: false,
    fileReadLineLimit: 10000,
    fileWriteLineLimit: 50000,
  };
  const save = vi.fn(async (key: string, value: unknown) => ({
    config: { ...config, [key]: value },
    availableShells: ['powershell.exe'],
  }));
  const connect = vi
    .fn()
    .mockResolvedValue({
      load: vi.fn().mockResolvedValue({ config, availableShells: ['powershell.exe'] }),
      save,
    });
  render(<DesktopCommanderSettings connect={connect} />);
  fireEvent.change(screen.getByLabelText('Desktop Commander connection file'), {
    target: { value: 'C:\\copy\\state\\connection.json' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Desktop Commander' }));
  await screen.findByLabelText('File Read Limit');
  for (const label of [
    'Default Shell',
    'Anonymous Telemetry',
    'File Read Limit',
    'File Write Limit',
  ])
    expect(screen.getByLabelText(label)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('File Write Limit'), { target: { value: '60000' } });
  fireEvent.change(screen.getByLabelText('File Read Limit'), { target: { value: '12345' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save File Read Limit' }));
  await screen.findByText('File Read Limit saved and verified.');
  expect(save).toHaveBeenCalledWith('fileReadLineLimit', 12345, 10000, expect.any(AbortSignal));
  expect((screen.getByLabelText('File Write Limit') as HTMLInputElement).value).toBe('60000');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Blocked Commands' }));
  fireEvent.change(screen.getByLabelText('Blocked Commands'), { target: { value: 'format\n' } });
  expect((screen.getByLabelText('Blocked Commands') as HTMLTextAreaElement).value).toBe('format\n');
  fireEvent.change(screen.getByLabelText('Blocked Commands'), {
    target: { value: 'format\nshutdown' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Blocked Commands' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      'blockedCommands',
      ['format', 'shutdown'],
      ['format'],
      expect.any(AbortSignal),
    ),
  );
  await screen.findByText('Blocked Commands saved and verified.');
  fireEvent.click(screen.getByLabelText('Anonymous Telemetry'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Anonymous Telemetry' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('telemetryEnabled', true, false, expect.any(AbortSignal)));
  await screen.findByText('Anonymous Telemetry saved and verified.');
  fireEvent.change(screen.getByLabelText('Desktop Commander connection file'), {
    target: { value: 'C:\\different-copy\\state\\connection.json' },
  });
  expect(screen.queryByLabelText('File Read Limit')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reload configuration' })).toBeNull();
});
it('shows a save failure without claiming success or discarding the edit', async () => {
  const config = {
    blockedCommands: [],
    allowedDirectories: [],
    defaultShell: 'pwsh',
    telemetryEnabled: false,
    fileReadLineLimit: 10,
    fileWriteLineLimit: 50,
  };
  const connect = vi.fn().mockResolvedValue({
    load: async () => ({ config, availableShells: [] }),
    save: async () => {
      throw Error('Conflict: reload');
    },
  });
  render(<DesktopCommanderSettings connect={connect} />);
  fireEvent.change(screen.getByLabelText('Desktop Commander connection file'), {
    target: { value: 'connection.json' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Desktop Commander' }));
  await screen.findByLabelText('File Read Limit');
  fireEvent.change(screen.getByLabelText('File Read Limit'), { target: { value: '99' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save File Read Limit' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Conflict: reload');
  expect(screen.queryByText('File Read Limit saved and verified.')).toBeNull();
  expect((screen.getByLabelText('File Read Limit') as HTMLInputElement).value).toBe('99');
});
