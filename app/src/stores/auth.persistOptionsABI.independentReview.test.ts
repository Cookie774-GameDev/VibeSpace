import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalWorkspaceRecoveryRevision, useAuthStore } from './auth';
const options = useAuthStore.persist.getOptions();
beforeEach(() => { localStorage.clear(); useAuthStore.persist.setOptions(options); });
afterEach(() => { useAuthStore.persist.setOptions(options); vi.restoreAllMocks(); });

describe('independent persist.setOptions ABI checks', () => {
  it('preserves the partial merge and storage-name behavior of setOptions', () => {
    const before = getLocalWorkspaceRecoveryRevision();
    const returned = useAuthStore.persist.setOptions({ name: 'review-other-auth', version: 77 });
    expect(returned).toBeUndefined();
    expect(getLocalWorkspaceRecoveryRevision()).toBeGreaterThan(before);
    expect(useAuthStore.persist.getOptions()).toMatchObject({ name: 'review-other-auth', version: 77, partialize: options.partialize, storage: options.storage });
    useAuthStore.getState().setDisplayName('ABI check');
    expect(JSON.parse(localStorage.getItem('review-other-auth')!).version).toBe(77);
    expect(JSON.parse(localStorage.getItem('review-other-auth')!).state.displayName).toBe('ABI check');
  });
  it('preserves monotonic revision after restoring exact prior options', () => {
    const before = getLocalWorkspaceRecoveryRevision();
    useAuthStore.persist.setOptions({ version: 22 });
    const changed = getLocalWorkspaceRecoveryRevision();
    useAuthStore.persist.setOptions(options);
    expect(changed).toBeGreaterThan(before);
    expect(getLocalWorkspaceRecoveryRevision()).toBeGreaterThan(changed);
    expect(useAuthStore.persist.getOptions()).toMatchObject(options);
  });
  it('preserves a replacement storage adapter for ordinary persistence', () => {
    const getItem = vi.fn(() => null);
    const setItem = vi.fn();
    const removeItem = vi.fn();
    useAuthStore.persist.setOptions({ storage: { getItem, setItem, removeItem } });
    useAuthStore.getState().setDisplayName('Adapter check');
    expect(setItem).toHaveBeenCalledWith('jarvis-auth', expect.objectContaining({ version: 21, state: expect.objectContaining({ displayName: 'Adapter check' }) }));
    useAuthStore.persist.clearStorage();
    expect(removeItem).toHaveBeenCalledWith('jarvis-auth');
  });
});
