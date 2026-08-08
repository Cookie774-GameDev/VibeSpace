import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  flush: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@/lib/persistence/workspaceFlush', () => ({
  flushWorkspacePersistence: mocks.flush,
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));

import { checkForAppUpdate, compareReleaseVersions } from './updates';
import { MONOCHROME_VISUAL_TEST } from './runtimeProfile';

describe('checkForAppUpdate persistence gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.relaunch.mockResolvedValue(undefined);
  });

  it('awaits persistence before install and again before relaunch', async () => {
    let releaseInstallFlush: (() => void) | undefined;
    let releaseRelaunchFlush: (() => void) | undefined;
    const downloadAndInstall = vi.fn(async (onEvent: (event: { event: string }) => void) => {
      onEvent({ event: 'Finished' });
    });
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'synthetic update',
      downloadAndInstall,
    });
    mocks.flush
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseInstallFlush = () => resolve({ completed: 1, failed: 0, timedOut: false });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRelaunchFlush = () => resolve({ completed: 1, failed: 0, timedOut: false });
          }),
      );

    const pending = checkForAppUpdate({ install: true });
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith('pre-update-install'));
    expect(downloadAndInstall).not.toHaveBeenCalled();

    releaseInstallFlush?.();
    await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith('pre-update-relaunch'));
    expect(mocks.relaunch).not.toHaveBeenCalled();

    releaseRelaunchFlush?.();
    await expect(pending).resolves.toMatchObject({ available: true, installed: true });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});

describe('compareReleaseVersions', () => {
  it('compares numeric versions without lexicographic mistakes', () => {
    expect(compareReleaseVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('v1.5.0', '1.5.0')).toBe(0);
    expect(compareReleaseVersions('1.5.0-beta.2', '1.5.0')).toBeLessThan(0);
  });
});

describe('checkForAppUpdate runtime-profile effect guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.relaunch.mockResolvedValue(undefined);
  });

  it('ordinary mode calls every effect adapter exactly as before', async () => {
    const downloadAndInstall = vi.fn();
    mocks.check.mockResolvedValue({ version: '9.9.9', body: 'synthetic', downloadAndInstall });
    mocks.flush.mockResolvedValue(undefined);
    await expect(checkForAppUpdate({ install: true })).resolves.toMatchObject({
      available: true,
      installed: true,
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it('does not allow a caller-supplied plan or adapters to override compile-time authority', async () => {
    vi.stubEnv('VITE_VIBESPACE_RUNTIME_PROFILE', MONOCHROME_VISUAL_TEST);
    const callerCheck = vi.fn();
    await expect(
      checkForAppUpdate({
        install: true,
        plan: { updateEffectsEnabled: true },
        seams: { checkUpdate: callerCheck },
      } as never),
    ).rejects.toThrow(/visual-test runtime profile/i);
    expect(callerCheck).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('visual-test mode never touches the native updater/persistence/process adapters', async () => {
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'synthetic update',
      downloadAndInstall: vi.fn(),
    });
    vi.stubEnv('VITE_VIBESPACE_RUNTIME_PROFILE', MONOCHROME_VISUAL_TEST);
    await expect(checkForAppUpdate({ install: true })).rejects.toThrow(/denied/i);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('ordinary mode invokes the native updater, persistence, and process adapters', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (event: { event: string }) => void) => {
      onEvent({ event: 'Finished' });
    });
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'synthetic update',
      downloadAndInstall,
    });
    mocks.flush.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
    await expect(checkForAppUpdate({ install: true })).resolves.toMatchObject({
      available: true,
      installed: true,
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledWith('pre-update-install');
    expect(mocks.flush).toHaveBeenCalledWith('pre-update-relaunch');
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
