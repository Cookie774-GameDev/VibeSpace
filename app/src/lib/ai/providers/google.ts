/**
 * Google Gemini client with streaming.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:streamGenerateContent?alt=sse
 * Auth: `x-goog-api-key` header (never the `?key=` query param, which leaks into logs).
 * Docs: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
 *
 * Gemini's API uses `?alt=sse` to opt into Server-Sent Events. Without it,
 * the response is a JSON array streamed in one big buffer, which is harder to
 * consume incrementally.
 *
 * Schema notes:
 *  - Roles are `user` / `model` (not `assistant`).
 *  - The system prompt is `systemInstruction.parts[0].text`, not a message.
 *  - Each chunk is `{ candidates: [{ content: { parts: [{ text }] } }],
 *      usageMetadata?: { promptTokenCount, candidatesTokenCount } }`.
 */
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from '../types';
import { estimateCost, estimateInputTokens } from '../types';
import { useAuthStore } from '@/stores/auth';
import { parseSSE } from './sse';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Default Gemini model. Flash Lite is the fastest + cheapest in the
 *  2.5 family and has a generous free tier on AI Studio (no card),
 *  which is why Jarvis ships pinned to it for the Free plan. */
export const GOOGLE_DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/** Convert our role -> Gemini role. Gemini doesn't have `system` in messages. */
function geminiRole(role: LLMMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

export const googleProvider: LLMProvider = {
  id: 'google',
  name: 'Google',

  isAvailable() {
    const key = useAuthStore.getState().apiKeys.google;
    return typeof key === 'string' && key.length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = useAuthStore.getState().apiKeys.google;
    if (!apiKey) throw new Error('Google API key not set');

    const model = req.agent.model.model || GOOGLE_DEFAULT_MODEL;

    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: geminiRole(m.role),
        parts: [{ text: m.content }],
      }));

    // Gemini requires the first turn to be `user`. If for any reason it's not,
    // prepend an empty user turn (parallels what Anthropic needs).
    if (contents.length === 0 || contents[0]?.role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: '' }] });
    }

    const body = {
      contents,
      systemInstruction: {
        parts: [{ text: req.agent.system_prompt }],
      },
      generationConfig: {
        temperature: req.temperature ?? req.agent.temperature ?? 0.7,
        maxOutputTokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
      },
    };

    // Send the key via header instead of `?key=` so it never appears in
    // URLs (DevConsole fetch log, proxies, browser devtools network tab).
    const url = `${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    }
    if (!res.body) throw new Error('Google returned an empty body');

    let acc = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let first = true;

    for await (const evt of parseSSE(res.body, req.signal)) {
      if (req.signal?.aborted) break;
      if (!evt.data) continue;

      const data = safeJSON(evt.data);
      if (!data) continue;

      if (data.error) {
        const msg = data.error.message ?? 'unknown error';
        throw new Error(`Google stream error: ${msg}`);
      }

      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p?.text === 'string' && p.text.length > 0) {
            acc += p.text;
            req.onChunk?.({ delta: p.text, first });
            first = false;
          }
        }
      }
      if (cand?.finishReason) finishReason = cand.finishReason;

      const u = data.usageMetadata;
      if (u) {
        if (u.promptTokenCount) inputTokens = u.promptTokenCount;
        if (u.candidatesTokenCount) outputTokens = u.candidatesTokenCount;
      }
    }

    if (req.signal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    if (inputTokens === 0) {
      const inputText = req.agent.system_prompt + '\n' + req.messages.map((m) => m.content).join('\n');
      inputTokens = estimateInputTokens(inputText);
    }
    if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

    req.onChunk?.({ delta: '', done: true });

    return {
      text: acc,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost('google', model, inputTokens, outputTokens),
      },
      provider: 'google',
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
