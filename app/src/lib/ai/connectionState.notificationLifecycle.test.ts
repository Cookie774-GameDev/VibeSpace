import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetConnectionSessionChecksForTests,
  writeConnectionMetadata,
} from './connectionState';

const notifications = vi.hoisted(() => ({
  moduleLoaded: vi.fn(),
  authLoss: vi.fn(),
}));

vi.mock('@/lib/notifications', async () => {
  notifications.moduleLoaded();
  await Promise.resolve();
  return { detectAndNotifyConnectorAuthLoss: notifications.authLoss };
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetConnectionSessionChecksForTests();
  window.localStorage.clear();
});

describe('connection notification import lifecycle', () => {
  it('loads notifications only for a real enabled auth loss, then settles that import', async () => {
    resetConnectionSessionChecksForTests();
    window.localStorage.clear();

    writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'unauthenticated' },
    });
    writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'authenticated' },
    });
    writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'authenticated', lastCheckedAt: 42 },
    });
    writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'unauthenticated', disabled: true },
    });
    writeConnectionMetadata({});
    writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'unauthenticated' },
    });
    const authenticated = writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'authenticated' },
    });

    await vi.dynamicImportSettled();
    expect(notifications.moduleLoaded).not.toHaveBeenCalled();
    expect(notifications.authLoss).not.toHaveBeenCalled();

    const lost = writeConnectionMetadata({
      'openai-codex': { installation: 'installed', auth: 'unauthenticated' },
    });
    await vi.dynamicImportSettled();
    expect(notifications.moduleLoaded).toHaveBeenCalledOnce();
    expect(notifications.authLoss).toHaveBeenCalledExactlyOnceWith(authenticated, lost);
  });
});
