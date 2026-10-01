import type { TokenBossProviderId } from './providers';

export const TOKEN_BOSS_REQUEST_EVENT = 'jarvis:token-boss:request';

export interface TokenBossRequest {
  chatId: string;
  providerId: TokenBossProviderId;
  restoreFocus?: HTMLElement | null;
  allowAudio?: boolean;
}

export function requestTokenBoss(request: TokenBossRequest): void {
  window.dispatchEvent(
    new CustomEvent<TokenBossRequest>(TOKEN_BOSS_REQUEST_EVENT, { detail: request }),
  );
}
