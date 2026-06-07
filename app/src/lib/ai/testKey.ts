/**
 * Real provider key validation.
 *
 * Each adapter sends one cheap, no-billing-impact request to the provider
 * to confirm:
 *   - the key parses on their side (format / signature),
 *   - the network path actually reaches them (not just CORS-dead),
 *   - the response shape is what we expect (so the chat path will work
 *     once the user clicks Send).
 *
 * Cost policy: every check uses an endpoint that is either free
 * (`/models` listings on OpenAI / Anthropic / Groq, model `:get` on
 * Gemini) or runs locally (`/api/tags` on Ollama). No tokens billed.
 *
 * Each check returns a discriminated union the Settings UI renders
 * directly. The `kind` field lets the toast / inline status pick the
 * right tone:
 *
 *   ok           green check + saved badge
 *   invalid      red cross + "the provider rejected this key"
 *   network      amber + "couldn't reach <provider>"
 *   unconfigured grey + "no key entered"
 *   unsupported  grey + "validation lands when the adapter does"
 *
 * The runner stays out of the chat path entirely, so a paused-network
 * laptop never blocks the chat UI on a validation timeout.
 *
 * Ollama is special-cased: we route its probe through `nativeFetch` so
 * a packaged Tauri build (which can't speak to `http://localhost:11434`
 * because of CORS on `tauri://localhost`) gets the same green check the
 * dev build does. Cloud providers ship with permissive CORS already so
 * we keep using browser fetch for them.
 */

import type { ProviderId } from '@/types/common';
import { nativeFetch } from '@/lib/nativeFetch';

export type ProviderTestResult =
  | { kind: 'ok'; provider: ProviderId; detail?: string }
  | { kind: 'invalid'; provider: ProviderId; status?: number; detail: string }
  | { kind: 'network'; provider: ProviderId; detail: string }
  | { kind: 'unconfigured'; provider: ProviderId }
  | { kind: 'unsupported'; provider: ProviderId };

const TIMEOUT_MS = 8000;

/**
 * Bound the ambient `fetch` against a hard timeout so a slow provider
 * doesn't strand the Test button forever. We layer the timeout on top
 * of any caller-supplied AbortSignal — whichever fires first wins.
 */
async function timedFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  return timedFetchVia(globalThis.fetch.bind(globalThis), url, init);
}

/**
 * Same as `timedFetch` but parameterised on the underlying fetch
 * implementation. Used by the Ollama check so it can hop through the
 * Tauri HTTP plugin while every other provider keeps using browser
 * fetch (cloud APIs ship with proper CORS).
 */
async function timedFetchVia(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT_MS);
  const composite = init.signal
    ? mergeSignals(controller.signal, init.signal)
    : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal: composite });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Merge two AbortSignals into one. The composite aborts when either
 * input does. Used so callers can still cancel via their own signal
 * even though `timedFetch` adds its own internal timeout signal.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return ctrl.signal;
}

/**
 * Shorten a provider error response to something the toast can show
 * without flooding the layout. Strips JSON wrappers when present so
 * "{ error: { message: 'Invalid API key' } }" comes out as
 * "Invalid API key".
 */
function summariseError(text: string): string {
  if (!text) return '';
  const t = text.trim();
  // Try to extract a nested `.error.message` from JSON responses (OpenAI,
  // Groq, Anthropic, Gemini all use this shape).
  if (t.startsWith('{')) {
    try {
      const json = JSON.parse(t) as {
        error?: { message?: string } | string;
        message?: string;
      };
      if (typeof json.error === 'string') return json.error;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {
      // fall through and return the raw string
    }
  }
  return t.slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/*  Per-provider checks                                                       */
/* -------------------------------------------------------------------------- */

async function testOpenAI(
  key: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  try {
    const res = await timedFetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (res.ok) return { kind: 'ok', provider: 'openai' };
    const body = await res.text().catch(() => '');
    return {
      kind: 'invalid',
      provider: 'openai',
      status: res.status,
      detail: summariseError(body) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      kind: 'network',
      provider: 'openai',
      detail: (err as Error).message || 'unreachable',
    };
  }
}

async function testAnthropic(
  key: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  try {
    const res = await timedFetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required to call Anthropic from a browser origin. The adapter
        // already sends this on real chat calls; matching it here avoids
        // a CORS-only "valid key, blocked browser" misclassification.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal,
    });
    if (res.ok) return { kind: 'ok', provider: 'anthropic' };
    const body = await res.text().catch(() => '');
    // Anthropic returns 401 for bad key, 403 when the org disables
    // direct browser access. Both are user-actionable; surface the
    // message verbatim.
    return {
      kind: 'invalid',
      provider: 'anthropic',
      status: res.status,
      detail: summariseError(body) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      kind: 'network',
      provider: 'anthropic',
      detail: (err as Error).message || 'unreachable',
    };
  }
}

async function testGoogle(
  key: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  // Hitting `/v1beta/models` validates the key without spending tokens.
  // The list is small (a few KB) and Google routes 401 / 403 there
  // consistently with the streamGenerateContent endpoint we use for chat.
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    key,
  )}`;
  try {
    const res = await timedFetch(url, { method: 'GET', signal });
    if (res.ok) return { kind: 'ok', provider: 'google' };
    const body = await res.text().catch(() => '');
    return {
      kind: 'invalid',
      provider: 'google',
      status: res.status,
      detail: summariseError(body) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      kind: 'network',
      provider: 'google',
      detail: (err as Error).message || 'unreachable',
    };
  }
}

async function testGroq(
  key: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  try {
    const res = await timedFetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (res.ok) return { kind: 'ok', provider: 'groq' };
    const body = await res.text().catch(() => '');
    return {
      kind: 'invalid',
      provider: 'groq',
      status: res.status,
      detail: summariseError(body) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      kind: 'network',
      provider: 'groq',
      detail: (err as Error).message || 'unreachable',
    };
  }
}

async function testOllama(
  rawBaseUrl: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  // The `apiKeys.ollama` slot stores the daemon URL, not a secret. We
  // accept either an empty string (use default) or any URL. Trim it
  // the same way the adapter does so behaviour matches.
  const base =
    (rawBaseUrl.trim() || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    // Use nativeFetch so packaged Tauri builds can talk to localhost
    // without tripping CORS — same path the chat adapter takes.
    const res = await timedFetchVia(nativeFetch, `${base}/api/tags`, {
      method: 'GET',
      signal,
    });
    if (!res.ok) {
      return {
        kind: 'invalid',
        provider: 'ollama',
        status: res.status,
        detail: `Ollama returned HTTP ${res.status}`,
      };
    }
    // Verify the body parses and exposes a `models` array. A non-Ollama
    // service on the same port (rare but possible) might 200 on the URL.
    const json = (await res.json().catch(() => null)) as
      | { models?: unknown[] }
      | null;
    if (!json || !Array.isArray(json.models)) {
      return {
        kind: 'invalid',
        provider: 'ollama',
        detail: 'Reachable but did not look like an Ollama daemon',
      };
    }
    const count = json.models.length;
    return {
      kind: 'ok',
      provider: 'ollama',
      detail:
        count === 0
          ? 'Daemon up — no models pulled yet'
          : `${count} model${count === 1 ? '' : 's'} installed`,
    };
  } catch (err) {
    return {
      kind: 'network',
      provider: 'ollama',
      detail: (err as Error).message || 'unreachable',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Public dispatcher                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run the validation check for a single provider. The Settings UI calls
 * this from the inline "Test" button. Adapters not yet implemented map
 * to `unsupported` so the UI surfaces a clear "validation pending" badge
 * rather than a fake green check.
 *
 * For Ollama, `key` is treated as a base URL (the field doubles as a
 * server endpoint). Empty values map to `unconfigured` for every other
 * provider.
 */
export async function testProviderKey(
  provider: ProviderId,
  key: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  const trimmed = key.trim();

  // Ollama is an endpoint, not a secret — empty means "use default".
  if (provider !== 'ollama' && !trimmed) {
    return { kind: 'unconfigured', provider };
  }

  switch (provider) {
    case 'openai':
      return testOpenAI(trimmed, signal);
    case 'anthropic':
      return testAnthropic(trimmed, signal);
    case 'google':
      return testGoogle(trimmed, signal);
    case 'groq':
      return testGroq(trimmed, signal);
    case 'ollama':
      return testOllama(trimmed, signal);
    // Adapters in the type union but not yet wired to real endpoints.
    // Returning `unsupported` keeps the UI honest about what's verified.
    case 'xai':
    case 'openrouter':
    case 'deepseek':
    case 'mistral':
    case 'together':
    case 'cohere':
    case 'perplexity':
    case 'fireworks':
    case 'replicate':
    case 'hyperbolic':
    case 'novita':
    case 'lambda':
    case 'azure':
    case 'cerebras':
    case 'huggingface':
    case 'bedrock':
    case 'mock':
    case 'local':
      return { kind: 'unsupported', provider };
  }
}
