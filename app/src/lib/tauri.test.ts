import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  info: vi.fn(),
  listen: vi.fn(),
  nativeClick: null as
    ((event: { payload: { id: string; title: string; body?: string } }) => void) | null,
}));

vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@/components/ui/toast', () => ({ toast: { info: mocks.info } }));

import { notify } from './tauri';

describe('native notification branding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockImplementation(async (_event, handler) => {
      mocks.nativeClick = handler;
      return vi.fn();
    });
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
      clickId: expect.any(String),
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
      clickId: expect.any(String),
    });
  });

  it('routes the activated native notification to its click handler and browser event', async () => {
    const onClick = vi.fn();
    const browserEvent = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    window.addEventListener('jarvis:notification-click', browserEvent);
    try {
      const result = await notify('Task complete', 'Chat: Design review', { onClick });
      expect(result.channel).toBe('native');
      const args = mocks.invoke.mock.calls.find(([command]) => command === 'vibespace_notify')?.[1];
      expect(typeof args?.clickId).toBe('string');
      expect(mocks.nativeClick).toBeTypeOf('function');

      mocks.nativeClick?.({
        payload: { id: args.clickId, title: 'Task complete', body: 'Chat: Design review' },
      });
      expect(focus).toHaveBeenCalledOnce();
      expect(onClick).toHaveBeenCalledOnce();
      expect(browserEvent).toHaveBeenCalledOnce();
      expect((browserEvent.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        title: 'Task complete',
        body: 'Chat: Design review',
      });
    } finally {
      window.removeEventListener('jarvis:notification-click', browserEvent);
      focus.mockRestore();
    }
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
        clickId: expect.any(String),
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
