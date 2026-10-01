import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeLocalStorage } from './safeLocalStorage';

describe('safeLocalStorage theme fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it.each([
    ['light', 'monochrome'],
    ['dark', 'default'],
    ['system', 'default'],
    ['unknown', 'warm'],
    ['vibespace', 'warm'],
    ['sakura', 'warm'],
    ['origami', 'warm'],
    ['jarvis', 'jarvis'],
    ['default', 'default'],
    ['warm', 'warm'],
    ['monochrome', 'monochrome'],
  ])('writes a version-5 canonical fallback for %s', (storedTheme, expectedTheme) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const writes: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      })
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      })
      .mockImplementationOnce((_name, value) => {
        writes.push(value);
      });

    safeLocalStorage.setItem(
      'jarvis-ui',
      JSON.stringify({
        state: {
          activeChatId: 'chat-sentinel',
          activeProjectId: 'project-sentinel',
          route: 'tools',
          navOpen: false,
          theme: storedTheme,
        },
        version: 4,
      }),
    );

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      state: {
        activeChatId: 'chat-sentinel',
        activeProjectId: 'project-sentinel',
        route: 'tools',
        navOpen: false,
        theme: expectedTheme,
      },
      version: 5,
    });
  });
});
