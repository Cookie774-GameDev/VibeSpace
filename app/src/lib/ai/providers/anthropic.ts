/**
 * Anthropic Messages API client with streaming.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Docs: https://docs.anthropic.com/en/api/messages
 *
 * Browser fetches need the dangerous-direct-browser-access header. We accept
 * that risk for V1 (BYOK desktop app); a future server-side proxy will remove
 * it. The API key is read from `useAuthStore` rather than threaded through
 * every call site, so configuration changes in settings take effect on the
 * very next request.
 *
 * SSE shape we care about (Anthropic 2023-06-01):
 *  - event: message_start         payload includes input usage
 *  - event: content_block_delta   delta.text is the text we stream
 *  - event: message_delta         payload includes stop_reason + output usage
 *  - event: message_stop          end-of-stream sentinel
 *  - event: error                 surface and abort
 *  - event: ping                  keepalive, ignore
 */
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from '../types';
import { estimateCost, estimateInputTokens } from '../types';
import { useAuthStore } from '@/stores/auth';
import { parseSSE } from './sse';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Default Anthropic model used when an agent is `mock-default`-flagged but the
 *  user has an Anthropic key. Centralised so the router and provider agree. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Map our flat LLMMessage list to Anthropic's `system` + `messages` schema.
 * Anthropic requires the system prompt to live in a top-level field; system
 * roles inside `messages` will 400. We collapse adjacent same-role messages
 * because Anthropic also requires strict alternation.
 */
function toAnthropicPayload(req: LLMRequest): {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
} {
  const system = req.agent.system_prompt;
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue; // safety: shouldn't happen, but ignore
    const role = m.role;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content += '\n\n' + m.content;
    } else {
      out.push({ role, content: m.content });
    }
  }
  // Anthropic requires the conversation to start with a user turn. If for any
  // reason the first turn is `assistant`, prepend an empty user turn.
  if (out.length === 0 || out[0]?.role !== 'user') {
    out.unshift({ role: 'user', content: '' });
  }
  return { system, messages: out };
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  name: 'Anthropic',

  isAvailable() {
    const key = useAuthStore.getState().apiKeys.anthropic;
    return typeof key === 'string' && key.length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = useAuthStore.getState().apiKeys.anthropic;
    if (!apiKey) throw new Error('Anthropic API key not set');

    const model = req.agent.model.model || ANTHROPIC_DEFAULT_MODEL;
    const { system, messages } = toAnthropicPayload(req);

    const body = {
      model,
      max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
      temperature: req.temperature ?? req.agent.temperature ?? 0.7,
      system,
      messages,
      stream: true,
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        // Required for browser fetches as of late 2024. Without this Anthropic
        // returns 401 with a clear "set this header" error.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    }
    if (!res.body) throw new Error('Anthropic returned an empty body');

    let acc = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let first = true;

    for await (const evt of parseSSE(res.body, req.signal)) {
      if (req.signal?.aborted) break;
      if (!evt.event) continue;

      if (evt.event === 'error') {
        const parsed = safeJSON(evt.data);
        const msg = parsed?.error?.message || 'unknown error';
        throw new Error(`Anthropic stream error: ${msg}`);
      }
      if (evt.event === 'ping') continue;

      const data = safeJSON(evt.data);
      if (!data) continue;

      switch (evt.event) {
        case 'message_start': {
          const u = data.message?.usage;
          if (u?.input_tokens) inputTokens = u.input_tokens;
          break;
        }
        case 'content_block_delta': {
          // Anthropic also emits 'thinking_delta' here for extended thinking;
          // we surface only text_delta as visible output.
          const d = data.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            acc += d.text;
            req.onChunk?.({ delta: d.text, first });
            first = false;
          }
          break;
        }
        case 'message_delta': {
          const u = data.usage;
          if (u?.output_tokens) outputTokens = u.output_tokens;
          if (data.delta?.stop_reason) finishReason = data.delta.stop_reason;
          break;
        }
        case 'message_stop':
          // terminal; the loop will end on next read
          break;
        default:
          // ignore content_block_start / content_block_stop / etc.
          break;
      }
    }

    if (req.signal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    // Fall back to estimates if Anthropic didn't report usage (rare, but happens
    // on some abrupt stops).
    if (inputTokens === 0) {
      const inputText = system + '\n' + messages.map((m) => m.content).join('\n');
      inputTokens = estimateInputTokens(inputText);
    }
    if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

    req.onChunk?.({ delta: '', done: true });

    return {
      text: acc,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost('anthropic', model, inputTokens, outputTokens),
      },
      provider: 'anthropic',
      model,
      finish_reason: finishReason,
    };
  },
};

function safeJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
