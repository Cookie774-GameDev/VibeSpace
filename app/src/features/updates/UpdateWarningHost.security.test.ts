import fs from 'node:fs';
import path from 'node:path';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateWarningHost } from './UpdateWarningHost';

const mocks = vi.hoisted(() => ({
  checkForAppUpdate: vi.fn(),
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/updates', () => ({
  checkForAppUpdate: mocks.checkForAppUpdate,
  getAutoUpdateEnabled: () => true,
}));

vi.mock('@/lib/persistence/workspaceFlush', () => ({
  flushWorkspacePersistence: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: mocks.toast,
}));

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isTauri: true,
}));

describe('UpdateWarningHost error boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never presents or logs raw updater errors', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'UpdateWarningHost.tsx'), 'utf8');

    expect(source).not.toMatch(/err instanceof Error \? err\.message/);
    expect(source).not.toMatch(/console\.warn\([^)]*,\s*err\s*\)/);
    expect(source).toContain('The signed update could not be installed. Please try again.');
  });

  it('does not expose arbitrary updater rejection detail through toast or console outputs', async () => {
    const sentinel = 'UPDATER_REJECTION_SENTINEL_7e07bba2';
    const rejection = new Error(sentinel);
    mocks.checkForAppUpdate.mockRejectedValue(rejection);
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    render(createElement(UpdateWarningHost));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mocks.checkForAppUpdate).toHaveBeenCalledWith({ install: false });

    const outputs = [
      ...Object.values(mocks.toast).flatMap((spy) => spy.mock.calls.flat()),
      ...consoleSpies.flatMap((spy) => spy.mock.calls.flat()),
    ];
    expect(outputs).not.toContain(rejection);
    expect(outputs.map((value) => String(value)).join('\n')).not.toContain(sentinel);
    expect(console.warn).toHaveBeenCalledWith('[updates] Background update check failed.');
  });
});
