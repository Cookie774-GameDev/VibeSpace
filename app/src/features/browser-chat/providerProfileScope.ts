const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_.:@-]{1,256}$/u;
const PROFILE_KEY = /^profile_[a-f0-9]{64}$/u;
const STORAGE_PREFIX = 'vibespace.browser-chat.account-profile.v1.';

export type BrowserChatAccountProfileKey = `profile_${string}`;

export function isBrowserChatAccountProfileKey(
  value: unknown,
): value is BrowserChatAccountProfileKey {
  return typeof value === 'string' && PROFILE_KEY.test(value);
}

export function getOrCreateBrowserChatAccountProfileKey(
  accountId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): BrowserChatAccountProfileKey {
  if (!SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error('browser_chat_profile_account_invalid');
  }
  const storageKey = `${STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
  const existing = storage.getItem(storageKey);
  if (isBrowserChatAccountProfileKey(existing)) return existing;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const key = `profile_${hex}`;
  if (!isBrowserChatAccountProfileKey(key)) {
    throw new Error('browser_chat_profile_derivation_failed');
  }
  storage.setItem(storageKey, key);
  return key;
}

export function scopedProviderProfileKey(
  providerProfileKey: string,
  accountProfileKey: BrowserChatAccountProfileKey,
): string {
  if (
    !/^browser-chat\/(?:chatgpt|claude|gemini)$/u.test(providerProfileKey) ||
    !isBrowserChatAccountProfileKey(accountProfileKey)
  ) {
    throw new Error('browser_chat_provider_profile_invalid');
  }
  return `${providerProfileKey}/${accountProfileKey}`;
}
