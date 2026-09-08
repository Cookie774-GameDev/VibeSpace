import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ projectId: 'project', invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ projectId: mocks.projectId }),
    { getState: () => ({ projectId: mocks.projectId }) },
  ),
}));
vi.mock('@/features/files/projectFiles', () => ({ getStoredProjectRoot: () => 'C:\\game' }));
import { DirectOpenCodeLauncher } from './DirectOpenCodeLauncher';
beforeEach(() => {
  mocks.projectId = 'project';
  vi.clearAllMocks();
});
it('uses the detected executable directly and preserves existing terminals', async () => {
  mocks.invoke.mockResolvedValue({
    status: 'managedCompatible',
    executablePath: 'C:\\agents\\opencode.exe',
  });
  const launch = vi.fn();
  render(<DirectOpenCodeLauncher disabled={false} onLaunch={launch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Launch OpenCode' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start OpenCode terminal' }));
  await waitFor(() =>
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\agents\\opencode.exe',
        cwd: 'C:\\game',
        preserveExisting: true,
      }),
    ),
  );
  expect(launch.mock.calls[0]![0].startupCommand).toBeUndefined();
});
it('refuses shell wrappers or missing runtimes', async () => {
  mocks.invoke.mockResolvedValue({
    status: 'managedCompatible',
    executablePath: 'C:\\agents\\opencode.cmd',
  });
  const launch = vi.fn();
  render(<DirectOpenCodeLauncher disabled={false} onLaunch={launch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Launch OpenCode' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start OpenCode terminal' }));
  await screen.findByRole('alert');
  expect(launch).not.toHaveBeenCalled();
});
it('does not launch into another project if detection completes after switching', async () => {
  mocks.invoke.mockImplementation(async () => {
    mocks.projectId = 'other';
    return { status: 'managedCompatible', executablePath: 'C:\\agents\\opencode.exe' };
  });
  const launch = vi.fn();
  render(<DirectOpenCodeLauncher disabled={false} onLaunch={launch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Launch OpenCode' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start OpenCode terminal' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Start OpenCode terminal' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(launch).not.toHaveBeenCalled();
});
