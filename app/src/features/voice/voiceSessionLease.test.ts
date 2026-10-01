import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireVoiceSession,
  getVoiceSessionOwner,
  revokeActiveVoiceSession,
  resetVoiceSessionLeaseForTests,
} from './voiceSessionLease';

describe('voice session lease', () => {
  beforeEach(() => resetVoiceSessionLeaseForTests());

  it('allows only one active microphone owner', () => {
    const mainRevoked = vi.fn();
    const main = acquireVoiceSession('main', mainRevoked);
    const pet = acquireVoiceSession('pet', vi.fn());

    expect(mainRevoked).toHaveBeenCalledWith('handoff');
    expect(main.isActive()).toBe(false);
    expect(pet.isActive()).toBe(true);
    expect(getVoiceSessionOwner()).toBe('pet');
  });

  it('treats a second lease from the same surface as a replacement', () => {
    const revoked = vi.fn();
    const stale = acquireVoiceSession('main', revoked);
    const current = acquireVoiceSession('main', vi.fn());

    expect(revoked).toHaveBeenCalledWith('replaced');
    stale.release();
    expect(current.isActive()).toBe(true);
  });

  it('does not let a stale lease release the current owner', () => {
    const stale = acquireVoiceSession('main', vi.fn());
    const current = acquireVoiceSession('pet', vi.fn());

    stale.release();
    expect(getVoiceSessionOwner()).toBe('pet');
    expect(current.isActive()).toBe(true);
  });

  it('supports an explicit cross-window handoff revocation', () => {
    const revoked = vi.fn();
    const lease = acquireVoiceSession('main', revoked);

    revokeActiveVoiceSession('handoff');

    expect(revoked).toHaveBeenCalledWith('handoff');
    expect(lease.isActive()).toBe(false);
    expect(getVoiceSessionOwner()).toBeNull();
  });
});
