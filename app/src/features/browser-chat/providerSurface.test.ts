import { describe, expect, it, vi } from 'vitest';
import type { WebviewOptions } from '@tauri-apps/api/webview';

import { browserChatProvider } from './providerRegistry';
import {
  createNativeManagedProviderSurface,
  createProviderSurfaceController,
  type ManagedProviderSurface,
  type ProviderSurfacePlatform,
} from './providerSurface';

function fakeWindow(label: string): ManagedProviderSurface {
  return {
    label,
    show: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    setFocus: vi.fn(async () => undefined),
    setPosition: vi.fn(async () => undefined),
    setSize: vi.fn(async () => undefined),
  };
}

function platform(desktop = true) {
  const windows = new Map<string, ManagedProviderSurface>();
  const created: Array<{ label: string; options: WebviewOptions }> = [];
  const opened: string[] = [];
  const implementation: ProviderSurfacePlatform = {
    desktop,
    async getSurface(label) {
      return windows.get(label) ?? null;
    },
    createSurface(label, options) {
      const window = fakeWindow(label);
      windows.set(label, window);
      created.push({ label, options });
      return window;
    },
    async openExternal(url) {
      opened.push(url);
    },
  };
  return { implementation, windows, created, opened };
}

describe('Browser Chat managed provider surface', () => {
  it('routes native provider geometry through the guarded Browser Chat command', async () => {
    const invoke = vi.fn(async () => undefined);
    const surface = createNativeManagedProviderSurface('browser-chat-chatgpt', invoke);

    await surface.setPosition({ x: 120, y: 90 });
    await surface.setSize({ width: 880, height: 620 });
    await surface.show();

    expect(invoke).toHaveBeenCalledWith('browser_chat_surface_open', {
      providerId: 'chatgpt',
      bounds: { x: 120, y: 90, width: 880, height: 620 },
    });
    await surface.hide();
    expect(invoke).toHaveBeenLastCalledWith('browser_chat_surface_hide', {
      providerId: 'chatgpt',
    });
  });

  it('creates a child surface with registry-owned HTTPS and main-relative bounds', async () => {
    const fake = platform();
    const controller = createProviderSurfaceController(fake.implementation);

    const result = await controller.openManaged(browserChatProvider('chatgpt'), {
      x: 100,
      y: 80,
      width: 900,
      height: 640,
    });

    expect(result.kind).toBe('managed');
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      label: 'browser-chat-chatgpt',
      options: {
        url: 'https://chatgpt.com/',
        dataDirectory: 'browser-chat/chatgpt',
        x: 100,
        y: 80,
        width: 900,
        height: 640,
        focus: false,
      },
    });
    expect(fake.created[0]?.options).not.toHaveProperty('decorations');
    expect(fake.created[0]?.options).not.toHaveProperty('skipTaskbar');
    expect(fake.created[0]?.options).not.toHaveProperty('alwaysOnTop');
    expect(fake.created[0]?.options).not.toHaveProperty('focused');
    expect(fake.created[0]?.options).not.toHaveProperty('initializationScript');
  });

  it('hides other provider surfaces before showing the selected provider', async () => {
    const fake = platform();
    const chatgpt = fakeWindow('browser-chat-chatgpt');
    const claude = fakeWindow('browser-chat-claude');
    fake.windows.set(chatgpt.label, chatgpt);
    fake.windows.set(claude.label, claude);
    const controller = createProviderSurfaceController(fake.implementation);

    await controller.openManaged(browserChatProvider('claude'), {
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });

    expect(chatgpt.hide).toHaveBeenCalledOnce();
    expect(claude.show).toHaveBeenCalledOnce();
    expect(claude.setFocus).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent opens so only one child surface is created per provider', async () => {
    const fake = platform();
    const originalCreate = fake.implementation.createSurface;
    fake.implementation.createSurface = async (label, options) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalCreate(label, options);
    };
    const controller = createProviderSurfaceController(fake.implementation);
    const bounds = { x: 20, y: 30, width: 800, height: 600 };

    const [first, second] = await Promise.all([
      controller.openManaged(browserChatProvider('chatgpt'), bounds),
      controller.openManaged(browserChatProvider('chatgpt'), bounds),
    ]);

    expect(first).toEqual({ kind: 'managed', providerId: 'chatgpt' });
    expect(second).toEqual(first);
    expect(fake.created).toHaveLength(1);
  });

  it('uses a truthful system-browser fallback outside the desktop shell', async () => {
    const fake = platform(false);
    const controller = createProviderSurfaceController(fake.implementation);

    const result = await controller.openManaged(browserChatProvider('gemini'), {
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });

    expect(result).toEqual({ kind: 'system_browser', providerId: 'gemini' });
    expect(fake.created).toHaveLength(0);
    expect(fake.opened).toEqual(['https://gemini.google.com/']);
  });

  it('delegates ChatGPT sign-in to the OS default browser without a Chrome-specific launcher', async () => {
    const fake = platform();
    const controller = createProviderSurfaceController(fake.implementation);

    await controller.openSystemBrowser(browserChatProvider('chatgpt'));

    expect(fake.opened).toEqual(['https://chatgpt.com/']);
  });

  it('rejects zero-sized or non-finite overlay bounds', async () => {
    const fake = platform();
    const controller = createProviderSurfaceController(fake.implementation);

    await expect(
      controller.openManaged(browserChatProvider('chatgpt'), {
        x: Number.NaN,
        y: 0,
        width: 0,
        height: 400,
      }),
    ).rejects.toThrow(/browser chat bounds/i);
    expect(fake.created).toHaveLength(0);
  });
});
