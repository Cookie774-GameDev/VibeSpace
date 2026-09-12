import { nativeFetch } from '@/lib/nativeFetch';
import type { ConnectionPickerState } from './connectionState';

export const QWEN_COMPATIBLE_BASE_URLS = Object.freeze([
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'https://coding-intl.dashscope.aliyuncs.com/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
] as const);

let activeQwenBaseUrl: (typeof QWEN_COMPATIBLE_BASE_URLS)[number] | undefined;
let verifiedQwenBaseUrl: (typeof QWEN_COMPATIBLE_BASE_URLS)[number] | undefined;
let qwenProbeGeneration = 0;

export function activeQwenCompatibleBaseUrl(): string {
  if (!activeQwenBaseUrl) {
    throw new Error('Qwen has no authenticated endpoint for the current credential.');
  }
  return activeQwenBaseUrl;
}

export function verifiedQwenCompatibleBaseUrl(): string | undefined {
  return verifiedQwenBaseUrl;
}

export type QwenBillingMode = 'payg' | 'coding-plan' | 'token-plan' | 'unknown';

export interface QwenCatalogIdentity {
  region: 'ap-southeast-1' | 'us' | 'cn' | 'intl' | 'unknown';
  billingMode: QwenBillingMode;
  endpoint: string;
}

export function qwenCatalogIdentity(baseUrl = verifiedQwenCompatibleBaseUrl()): QwenCatalogIdentity | null {
  if (!baseUrl) return null;
  if (baseUrl.includes('token-plan')) {
    return { region: 'ap-southeast-1', billingMode: 'token-plan', endpoint: baseUrl };
  }
  if (baseUrl.includes('coding-intl')) {
    return { region: 'intl', billingMode: 'coding-plan', endpoint: baseUrl };
  }
  if (baseUrl.includes('dashscope-us')) {
    return { region: 'us', billingMode: 'payg', endpoint: baseUrl };
  }
  if (baseUrl.includes('dashscope-intl')) {
    return { region: 'intl', billingMode: 'payg', endpoint: baseUrl };
  }
  if (baseUrl.includes('dashscope.aliyuncs.com')) {
    return { region: 'cn', billingMode: 'payg', endpoint: baseUrl };
  }
  return { region: 'unknown', billingMode: 'unknown', endpoint: baseUrl };
}

export function setActiveQwenCompatibleBaseUrlForTests(
  url: (typeof QWEN_COMPATIBLE_BASE_URLS)[number] | undefined,
): void {
  activeQwenBaseUrl = url;
  verifiedQwenBaseUrl = url;
}

export function resetActiveQwenCompatibleBaseUrlForTests(): void {
  qwenProbeGeneration += 1;
  activeQwenBaseUrl = undefined;
  verifiedQwenBaseUrl = undefined;
}

export async function probeQwenApiCredential(
  apiKey: string,
  fetcher: typeof nativeFetch = nativeFetch,
): Promise<ConnectionPickerState> {
  const probeGeneration = ++qwenProbeGeneration;
  verifiedQwenBaseUrl = undefined;
  activeQwenBaseUrl = undefined;
  if (!apiKey.trim()) return { available: false, auth: 'unauthenticated' };
  let sawIndeterminateResult = false;
  for (const baseUrl of QWEN_COMPATIBLE_BASE_URLS) {
    try {
      // The Coding Plan catalog is publicly readable, so /models cannot prove
      // authentication. A one-token completion reaches the credential gate.
      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3.7-plus',
          messages: [{ role: 'user', content: 'Reply OK' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (probeGeneration !== qwenProbeGeneration) {
        return { available: false, auth: 'unknown' };
      }
      if (response.ok) {
        activeQwenBaseUrl = baseUrl;
        verifiedQwenBaseUrl = baseUrl;
        return { available: true, auth: 'authenticated' };
      }
      if (response.status !== 401 && response.status !== 403) {
        sawIndeterminateResult = true;
      }
    } catch {
      if (probeGeneration !== qwenProbeGeneration) {
        return { available: false, auth: 'unknown' };
      }
      sawIndeterminateResult = true;
    }
  }
  return sawIndeterminateResult
    ? { available: false, auth: 'unknown' }
    : { available: false, auth: 'unauthenticated' };
}

export function reconcileNativeProbeState(
  previous: ConnectionPickerState | undefined,
  next: ConnectionPickerState,
): ConnectionPickerState {
  if (previous?.auth === 'unauthenticated' && next.auth === 'unknown') return previous;
  return next;
}
