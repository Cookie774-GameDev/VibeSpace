/**
 * Mock provider - canned word-by-word streaming so the app feels real without
 * any API keys. Keeps the offline dev loop tight and is the safety net the
 * router falls back to when a real provider errors.
 *
 * Behaviour:
 * - Picks a short ack ("Got it. ", "Sure. ", ...) deterministically from the
 *   user's last message so repeated runs of the same prompt feel stable.
 * - Picks a longer paragraph the same way.
 * - Streams word-by-word over ~2 seconds (target) with light jitter.
 * - Honors `signal` between words.
 */
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateInputTokens } from '../types';
import { sleep } from '@/lib/utils';

const ACKS = [
  'Got it. ',
  'Sure. ',
  "Here's what I found: ",
  'Looking into it. ',
  'Quick take: ',
  'Right. ',
  'Understood. ',
  'On it. ',
];

const PARAGRAPHS = [
  "Based on the question, the most relevant context appears to be the recent project notes you shared. The pattern showing up is the same one we discussed last week - small surface, big leverage. I'd start by isolating the core change, validating it against your existing tests, and iterating from there. Worth a quick end-to-end check before you merge.",
  'There are a few angles to consider here. The simplest path keeps the existing structure intact and layers a thin adapter where the new behaviour lives. That keeps the blast radius small. The trade-off is a small bit of indirection going forward. The alternative is a fuller refactor, which would be cleaner long-term but costs more now. I lean toward the adapter unless you have a specific reason to redesign.',
  "Looking at the shape of this, my read is that you're trying to minimise friction while keeping the option to swap implementations later. That points at a strategy pattern with a small registry. You can ship the first concrete implementation now and add the others as needed without breaking callers.",
  "Plain answer: yes, with a caveat. The approach works for the common case, but there's an edge case around concurrent updates that's worth handling now rather than later. A short lock or version field on the row keeps you out of trouble. Otherwise, ship it.",
  "Two things to flag. First, this is solidly within scope - no architecture change needed. Second, the obvious implementation has a sneaky O(n^2) in the inner loop; swap the array for a Map keyed on id and you're back to linear. Want me to draft the patch?",
];

/** Cheap deterministic pick from an array based on a string. */
function pick<T>(items: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h * 31) + seed.charCodeAt(i)) | 0;
  }
  return items[Math.abs(h) % items.length] as T;
}

/** Build the canned reply for a given user message. */
function buildReply(userText: string): string {
  return pick(ACKS, userText) + pick(PARAGRAPHS, userText);
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
    const reply = buildReply(userText);
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
