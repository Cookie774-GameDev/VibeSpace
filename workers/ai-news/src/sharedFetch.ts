import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  RETRY_DELAYS_MS,
  safeHttpsUrl,
} from './sharedTypes';

export interface BoundedFetchOptions {
  headers?: HeadersInit;
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  attempts?: number;
  accept?: string;
}

export interface BoundedFetchResult {
  response: Response;
  body: string;
  finalUrl: string;
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Source timed out', 'AbortError');
      const part = await reader.read();
      if (part.done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response_too_large');
      }
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation releases it asynchronously */ }
  }
}

export async function fetchBoundedText(
  rawUrl: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const initial = safeHttpsUrl(rawUrl);
  if (!initial) throw new Error('invalid_https_url');
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 3));
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
    let current = initial;
    let redirects = 0;
    try {
      while (true) {
        const headers = new Headers(options.headers);
        if (options.accept && !headers.has('accept')) headers.set('accept', options.accept);
        if (!headers.has('user-agent')) {
          headers.set('user-agent', 'VibeSpaceIntelligence/1.0 (+https://vibespaceos.com)');
        }
        const response = await fetch(current, {
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location || redirects >= (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)) {
            throw new Error('redirect_limit');
          }
          const next = safeHttpsUrl(location, current.toString());
          if (!next) throw new Error('invalid_redirect');
          current = next;
          redirects += 1;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const error = new Error(`http_${response.status}`);
          if (!retryable(response.status) || attempt === attempts - 1) throw error;
          lastError = error;
          break;
        }
        const size = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(size) && size > options.maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('response_too_large');
        }
        return {
          response,
          body: await readBounded(response, options.maxBytes, controller.signal),
          finalUrl: current.toString(),
        };
      }
    } catch (error) {
      lastError = error;
      const canRetry =
        error instanceof DOMException ||
        error instanceof TypeError ||
        (error instanceof Error && /^http_(408|425|429|5\d\d)$/.test(error.message));
      if (!canRetry || attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 1_000);
  }
  throw lastError instanceof Error ? lastError : new Error('source_request_failed');
}

export async function fetchBoundedJson(
  url: string,
  options: BoundedFetchOptions,
): Promise<{ data: unknown; response: Response; finalUrl: string }> {
  const result = await fetchBoundedText(url, options);
  const type = result.response.headers.get('content-type') ?? '';
  const trimmed = result.body.trimStart();
  if (
    (!type.includes('json') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) ||
    /^<!doctype html|^<html/i.test(trimmed)
  ) throw new Error('unexpected_non_json_response');
  try {
    return { data: JSON.parse(result.body) as unknown, response: result.response, finalUrl: result.finalUrl };
  } catch {
    throw new Error('malformed_json_response');
  }
}

export function boundedErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  if (error instanceof TypeError) return 'network_error';
  if (!(error instanceof Error)) return 'unknown_error';
  if (/^http_\d{3}$/.test(error.message)) return error.message;
  const allowed = new Set([
    'invalid_https_url', 'redirect_limit', 'invalid_redirect', 'response_too_large',
    'unexpected_non_json_response', 'malformed_json_response', 'missing_source_credential',
    'source_anomaly', 'empty_dataset', 'duplicate_row_identity', 'invalid_source_timestamp',
    'lease_lost',
  ]);
  return allowed.has(error.message) ? error.message : 'source_response_failed';
}
