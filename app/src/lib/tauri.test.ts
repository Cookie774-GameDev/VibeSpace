import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), info: vi.fn() }));

vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/components/ui/toast', () => ({ toast: { info: mocks.info } }));

import { notify } from './tauri';

describe('native notification branding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return true;
      return undefined;
    });
  });

  it('routes a granted desktop notification through the VibeSpace native identity', async () => {
    const result = await notify('Jarvis task failed', 'Open VibeSpace to review the failure.', {
      silent: true,
    });

    expect(result.channel).toBe('native');
    expect(mocks.invoke).toHaveBeenCalledWith('vibespace_notify', {
      title: 'Jarvis task failed',
      body: 'Open VibeSpace to review the failure.',
      silent: true,
      variant: null,
    });
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === 'plugin:notification|notify'),
    ).toBe(false);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('passes the task artwork choice to the native command', async () => {
    await notify('Task complete', 'Chat: Design review', { variant: 'task_completed' });
    expect(mocks.invoke).toHaveBeenCalledWith('vibespace_notify', {
      title: 'Task complete',
      body: 'Chat: Design review',
      silent: false,
      variant: 'task_completed',
    });
  });

  it.each(['task_failed', 'task_stopped', 'task_attention'] as const)(
    'passes the %s artwork choice to the native command',
    async (variant) => {
      const result = await notify('Jarvis task update', 'Chat: Design review', { variant });
      expect(result.channel).toBe('native');
      expect(mocks.invoke).toHaveBeenCalledWith('vibespace_notify', {
        title: 'Jarvis task update',
        body: 'Chat: Design review',
        silent: false,
        variant,
      });
    },
  );

  it('keeps the in-app fallback when branded OS delivery fails', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return true;
      if (command === 'vibespace_notify') throw new Error('OS toast unavailable');
    });

    const result = await notify('Jarvis task failed', 'Review the failure.');
    expect(result.channel).toBe('toast');
    expect(mocks.info).toHaveBeenCalledWith('Jarvis task failed', 'Review the failure.');
  });

  it('shows an in-app notification when desktop permission is denied', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return false;
      if (command === 'plugin:notification|request_permission') return 'denied';
    });
    const result = await notify('Stopped: Workbench polish', 'Chat: Design review', {
      variant: 'task_stopped',
      fallbackToast: true,
    });
    expect(result.channel).toBe('toast');
    expect(mocks.info).toHaveBeenCalledWith('Stopped: Workbench polish', 'Chat: Design review');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vibespace_notify')).toBe(false);
  });
});
