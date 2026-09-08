import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  flush: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@/lib/persistence/workspaceFlush', () => ({
  flushWorkspacePersistence: mocks.flush,
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: mocks.relaunch,
  exit: mocks.exit,
}));

import {
  checkForAppUpdate,
  compareReleaseVersions,
  installPreparedAppUpdate,
  normalizeUpdateNotes,
  prepareAppUpdate,
} from './updates';
import { MONOCHROME_VISUAL_TEST } from './runtimeProfile';

describe('checkForAppUpdate persistence gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.relaunch.mockResolvedValue(undefined);
    mocks.exit.mockResolvedValue(undefined);
  });

  it('saves edits after the download, awaits persistence before install and again before relaunch', async () => {
    let releaseDownload: (() => void) | undefined;
    let releaseInstallFlush: (() => void) | undefined;
    let releaseRelaunchFlush: (() => void) | undefined;
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDownload = resolve;
        }),
    );
    const install = vi.fn();
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'synthetic update',
      download,
      install,
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
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(mocks.flush).not.toHaveBeenCalled();
    releaseDownload?.();
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith('pre-update-install'));
    expect(install).not.toHaveBeenCalled();

    releaseInstallFlush?.();
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith('pre-update-relaunch'));
    expect(mocks.relaunch).not.toHaveBeenCalled();

    releaseRelaunchFlush?.();
    await expect(pending).resolves.toMatchObject({ available: true, installed: true });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});

describe('deferred updater lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.flush.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
    mocks.relaunch.mockResolvedValue(undefined);
    mocks.exit.mockResolvedValue(undefined);
  });

  it('downloads a verified update without installing or relaunching it', async () => {
    const download = vi.fn(async (onEvent: (event: { event: string }) => void) => {
      onEvent({ event: 'Finished' });
    });
    const install = vi.fn();
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'Safe release notes',
      download,
      install,
    });

    await expect(prepareAppUpdate({ expectedVersion: '9.9.9' })).resolves.toMatchObject({
      available: true,
      prepared: true,
      installed: false,
      version: '9.9.9',
    });

    expect(download).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it('installs the prepared update on natural close and exits without a forced relaunch', async () => {
    const download = vi.fn();
    const install = vi.fn();
    mocks.check.mockResolvedValue({ version: '9.9.8', body: 'Notes', download, install });
    await prepareAppUpdate({ expectedVersion: '9.9.8' });

    await expect(installPreparedAppUpdate({ relaunch: false })).resolves.toMatchObject({
      installed: true,
      version: '9.9.8',
    });

    expect(mocks.flush).toHaveBeenCalledWith('pre-update-install');
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('waits for verified persistence even when a native flush was already requested', async () => {
    const download = vi.fn();
    const install = vi.fn();
    mocks.check.mockResolvedValue({ version: '9.9.7', body: 'Notes', download, install });
    await prepareAppUpdate({ expectedVersion: '9.9.7' });

    await installPreparedAppUpdate({ relaunch: false, persistenceAlreadyRequested: true });

    expect(mocks.flush).toHaveBeenCalledWith('pre-update-install');
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    { completed: 0, failed: 1, timedOut: false },
    { completed: 0, failed: 0, timedOut: true },
    {
      completed: 1,
      failed: 0,
      timedOut: false,
      canvas: { completed: 0, failed: 1, timedOut: false },
    },
  ])('does not install when workspace persistence is incomplete: %j', async (result) => {
    const install = vi.fn();
    mocks.check.mockResolvedValue({ version: '9.9.6', download: vi.fn(), install });
    await prepareAppUpdate({ expectedVersion: '9.9.6' });
    mocks.flush.mockResolvedValue(result);
    await expect(installPreparedAppUpdate({ relaunch: true })).rejects.toThrow(/workspace.*saved/i);
    expect(install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('refuses to stage a different version than the one shown to the user', async () => {
    const download = vi.fn();
    mocks.check.mockResolvedValue({ version: '10.0.0', body: 'Different', download });

    await expect(prepareAppUpdate({ expectedVersion: '9.9.9' })).rejects.toThrow(
      /changed while preparing/i,
    );
    expect(download).not.toHaveBeenCalled();
  });
});

describe('normalizeUpdateNotes', () => {
  it('returns bounded readable release notes and a truthful fallback', () => {
    expect(normalizeUpdateNotes('  Security fixes.\u0000\nFaster startup.  ', '2.0.0')).toBe(
      'Security fixes.\nFaster startup.',
    );
    expect(normalizeUpdateNotes('   ', '2.0.0')).toContain('Release notes for VibeSpace v2.0.0');
    expect(normalizeUpdateNotes('x'.repeat(10_000), '2.0.0').length).toBeLessThanOrEqual(2_004);
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

  it('ordinary mode downloads, saves, installs and relaunches', async () => {
    const download = vi.fn();
    const install = vi.fn();
    mocks.check.mockResolvedValue({ version: '9.9.9', body: 'synthetic', download, install });
    mocks.flush.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
    await expect(checkForAppUpdate({ install: true })).resolves.toMatchObject({
      available: true,
      installed: true,
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
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
    const download = vi.fn(async (onEvent: (event: { event: string }) => void) => {
      onEvent({ event: 'Finished' });
    });
    mocks.check.mockResolvedValue({
      version: '9.9.9',
      body: 'synthetic update',
      download,
      install: vi.fn(),
    });
    mocks.flush.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
    await expect(checkForAppUpdate({ install: true })).resolves.toMatchObject({
      available: true,
      installed: true,
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledWith('pre-update-install');
    expect(mocks.flush).toHaveBeenCalledWith('pre-update-relaunch');
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
