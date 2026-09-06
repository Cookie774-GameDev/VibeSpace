import { describe, expect, it } from 'vitest';
import { mergeNativeAppPins, readNativeAppPins, updateNativeAppPin } from './nativeAppPins';
import type { NativeAppDescriptor } from './nativeApps';

const app: NativeAppDescriptor = {
  id: 'editor',
  name: 'Editor',
  running: false,
  pinned: false,
  launchable: true,
};

describe('native app pins', () => {
  it('persists pin and unpin overrides across catalog refreshes', () => {
    const pinned = updateNativeAppPin([], app);
    expect(mergeNativeAppPins([app], readNativeAppPins(JSON.stringify(pinned)))[0].pinned).toBe(
      true,
    );
    const unpinned = updateNativeAppPin(pinned, { ...app, pinned: true });
    expect(mergeNativeAppPins([{ ...app, pinned: true }], unpinned)[0].pinned).toBe(false);
  });

  it('keeps different custom executables separate and remembers them while closed', () => {
    const first = { ...app, id: 'custom', path: String.raw`C:\Tools\One.exe` };
    const second = { ...first, path: String.raw`C:\Tools\Two.exe` };
    const pins = updateNativeAppPin(updateNativeAppPin([], first), second);
    expect(mergeNativeAppPins([], pins).map((entry) => entry.path)).toEqual([
      first.path,
      second.path,
    ]);
    expect(mergeNativeAppPins([{ ...first, path: first.path.toUpperCase() }], pins)).toHaveLength(
      2,
    );
  });

  it('rejects corrupt persisted descriptors and does not invent installed availability', () => {
    expect(readNativeAppPins('{')).toEqual([]);
    expect(readNativeAppPins('[{"id":"../bad"}]')).toEqual([]);
    expect(mergeNativeAppPins([], [{ ...app, pinned: true, running: true }])[0]).toMatchObject({
      pinned: true,
      running: false,
      launchable: false,
    });
  });
});
