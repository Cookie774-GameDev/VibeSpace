export type VoiceSessionOwner = 'main' | 'pet';
export type VoiceSessionRevocationReason = 'handoff' | 'replaced';

export interface VoiceSessionLease {
  readonly owner: VoiceSessionOwner;
  isActive: () => boolean;
  release: () => void;
}

interface ActiveVoiceSession {
  owner: VoiceSessionOwner;
  token: symbol;
  onRevoked: (reason: VoiceSessionRevocationReason) => void;
}

let activeSession: ActiveVoiceSession | null = null;

export function acquireVoiceSession(
  owner: VoiceSessionOwner,
  onRevoked: (reason: VoiceSessionRevocationReason) => void,
): VoiceSessionLease {
  const previous = activeSession;
  const token = Symbol(`voice-session:${owner}`);
  activeSession = { owner, token, onRevoked };

  if (previous) {
    previous.onRevoked(previous.owner === owner ? 'replaced' : 'handoff');
  }

  return {
    owner,
    isActive: () => activeSession?.token === token,
    release: () => {
      if (activeSession?.token === token) activeSession = null;
    },
  };
}

export function getVoiceSessionOwner(): VoiceSessionOwner | null {
  return activeSession?.owner ?? null;
}

export function revokeActiveVoiceSession(reason: VoiceSessionRevocationReason = 'handoff'): void {
  const previous = activeSession;
  activeSession = null;
  previous?.onRevoked(reason);
}

export function resetVoiceSessionLeaseForTests(): void {
  activeSession = null;
}
