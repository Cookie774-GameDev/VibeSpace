/**
 * Mock provider - canned word-by-word streaming so the app feels real without
 * any API keys. Keeps the offline dev loop tight and is the safety net the
 * router falls back to when a real provider errors.
 *
 * Behaviour:
 * - Honors simple deterministic system-prompt contracts used in QA
 *   ("Always answer with APPLE", "respond with the code word APPLE").
 * - Picks a short ack ("Got it. ", "Sure. ", ...) deterministically from the
 *   user's last message so repeated runs of the same prompt feel stable.
 * - Picks a longer paragraph the same way.
 * - Streams word-by-word over ~2 seconds (target) with light jitter.
 * - Honors `signal` between words.
 */
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateInputTokens } from '../types';
import { sleep } from '@/lib/utils';

/** Extract a direct QA/code-word response contract from the system prompt. */
function forcedSystemReply(systemPrompt: string): string | null {
  const prompt = systemPrompt.trim();
  if (!prompt) return null;

  const wordPatterns = [
    /(?:always\s+)?(?:answer|reply|respond)\s+(?:only\s+)?(?:with|using)\s+(?:the\s+)?(?:code\s+word\s+)?["'“”`]*([A-Za-z0-9][A-Za-z0-9_-]{1,63})["'“”`]*(?=[\s.!?,;:)]|$)/gi,
    /(?:code\s+word|keyword)\s*(?:is|:)\s*["'“”`]*([A-Za-z0-9][A-Za-z0-9_-]{1,63})["'“”`]*(?=[\s.!?,;:)]|$)/gi,
  ];
  let forced: { value: string; index: number } | null = null;
  for (const pattern of wordPatterns) {
    for (const match of prompt.matchAll(pattern)) {
      const value = match[1]?.trim();
      const index = typeof match.index === 'number' ? match.index : -1;
      if (value && (!forced || index >= forced.index)) forced = { value, index };
    }
  }
  if (forced) return forced.value;

  const phrasePatterns = [
    /(?:answer|reply|respond)\s+(?:only\s+)?with\s+(?:the\s+)?(?:exact\s+)?(?:text|phrase)\s*[:=]?\s*["“]([^"”\n]{1,120})["”]/gi,
  ];
  for (const pattern of phrasePatterns) {
    for (const match of prompt.matchAll(pattern)) {
      const value = match[1]?.trim();
      const index = typeof match.index === 'number' ? match.index : -1;
      if (value && (!forced || index >= forced.index)) forced = { value, index };
    }
  }
  return forced?.value ?? null;
}

/** Build the reply for a given user message and system prompt. */
function buildReply(userText: string, systemPrompt: string): string {
  const forced = forcedSystemReply(systemPrompt);
  if (forced) return forced;
  if (/\b(?:what(?:'s| is) your name|who are you)\b/i.test(userText)) {
    return 'I am Jarvis. I am currently running in demo mode, so configure a real provider and model for full AI responses.';
  }
  return 'Jarvis is currently using the mock demo provider, which cannot analyze this request reliably. Open the model picker, choose a configured real provider and model, then send the request again.';
}

/**
 * Split keeping whitespace so we re-emit the original spacing on stream.
 * E.g. "hello there" -> ["hello", " ", "there"].
 */
function splitForStream(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0);
}

export const mockProvider: LLMProvider = {
  id: 'mock',
  name: 'Mock',
  isAvailable: () => true,

  async run(req: LLMRequest): Promise<LLMResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser?.content ?? '';
    const reply = buildReply(userText, req.agent.system_prompt);
    const tokens = splitForStream(reply);

    // Aim for ~2s total. With ~50 words that's ~40ms/word; jitter keeps it
    // from feeling robotic.
    const baseDelay = Math.max(20, Math.min(50, Math.floor(2000 / Math.max(1, tokens.length))));

    let acc = '';
    let first = true;
    let cancelled = false;

    for (const tok of tokens) {
      if (req.signal?.aborted) {
        cancelled = true;
        break;
      }
      // light jitter +/- 40%
      const delay = baseDelay + Math.floor((Math.random() - 0.5) * baseDelay * 0.8);
      await sleep(Math.max(5, delay));
      if (req.signal?.aborted) {
        cancelled = true;
        break;
      }

      acc += tok;
      // Whitespace-only chunks count as deltas too (preserves spacing).
      req.onChunk?.({ delta: tok, first });
      first = false;
    }

    if (cancelled) {
      // Match the cloud-provider contract: throw on cancellation so the runtime
      // sees an AbortError and renders a "[cancelled]" suffix rather than
      // claiming a clean completion.
      throw new DOMException('Aborted by user', 'AbortError');
    }

    req.onChunk?.({ delta: '', done: true });

    const inputText =
      req.agent.system_prompt + '\n' + req.messages.map((m) => m.content).join('\n');
    const input_tokens = estimateInputTokens(inputText);
    const output_tokens = estimateInputTokens(acc);

    return {
      text: acc,
      usage: {
        input_tokens,
        output_tokens,
        cost_usd: 0,
      },
      provider: 'mock',
      model: req.agent.model.model || 'mock-default',
      finish_reason: 'stop',
    };
  },
};
