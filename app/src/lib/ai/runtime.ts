/**
 * Runtime listener that bridges the chat composer (subagent A3) to the
 * provider router. The composer dispatches a `jarvis:send` CustomEvent on
 * window; we catch it, append a user message + an empty assistant placeholder,
 * stream the agent's response into the placeholder, and update token/cost
 * counters when the run completes.
 *
 * Cancellation: any consumer can dispatch `jarvis:cancel` with
 * `{ messageId }` to abort the in-flight stream for a specific assistant
 * message, or with no detail to abort everything in flight.
 *
 * Why dependency injection: this module needs DB access (messageRepo and
 * agent lookups) but those repositories are owned by a sibling subagent.
 * Threading them in via `bindings` keeps this file independently buildable
 * and lets the consumer wire up the real repo at app boot time.
 */
import type { Agent, AgentId, Message, MessageId, Part } from '@/types';
import type { ChatId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { runAgent } from './router';
import type { LLMMessage } from './types';
import { applyPersona } from '@/features/agents/personas';

/**
 * Bindings the runtime needs from the host app. Implementations are typically
 * thin wrappers around `messageRepo` / `agentRepo` (subagent A2's territory).
 */
export interface RuntimeBindings {
  /** Resolve an agent by id. */
  getAgentById: (id: AgentId) => Agent | null | undefined;
  /** Resolve an agent by slug (for @mentions in user text). */
  getAgentBySlug: (slug: string) => Agent | null | undefined;
  /** Pick the active agent for a chat (first id in `chat.active_agent_ids`). */
  getAgentForChat: (chatId: ChatId | string) => Agent | null | undefined;
  /** Read message history for a chat in chronological order. */
  getMessages: (chatId: ChatId | string) => Promise<Message[]> | Message[];
  /** Append a new message; returns the saved message (with id + timestamps). */
  appendMessage: (
    msg: Omit<Message, 'id' | 'created_at' | 'updated_at'>,
  ) => Promise<Message>;
  /** Apply a partial update to an existing message. */
  updateMessage: (id: MessageId, patch: Partial<Omit<Message, 'id'>>) => Promise<void>;
}

/** The shape of the `jarvis:send` event detail. */
export interface SendDetail {
  /** Chat the message belongs to. */
  chatId: string;
  /** Raw user text. */
  text: string;
  /** Optional agent override (otherwise routed by @mention or chat default). */
  agentId?: AgentId;
}

/** The shape of the `jarvis:cancel` event detail. */
export interface CancelDetail {
  /** The assistant placeholder message id to cancel. Omit to cancel everything. */
  messageId?: MessageId;
}

export interface RuntimeOptions {
  /** Override the event name (default: `jarvis:send`). */
  eventName?: string;
  /** Override the cancel event name (default: `jarvis:cancel`). */
  cancelEventName?: string;
  /**
   * Throttle for streaming DB writes during chunk delivery. Default 50 ms gives
   * smooth visible streaming without saturating the message store.
   */
  flushIntervalMs?: number;
}

/** Detect a leading `@slug ` mention in user text. Returns the slug or null. */
function detectMention(text: string): string | null {
  const m = /^@([A-Za-z][A-Za-z0-9_]*)\s/.exec(text);
  return m ? m[1]! : null;
}

/** Flatten Message[] -> LLMMessage[] for the provider call. */
function toLLMMessages(history: Message[], excludeId?: MessageId): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of history) {
    if (excludeId && m.id === excludeId) continue;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'agent') continue;
    const content = m.parts
      .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (content.length === 0) continue;
    out.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content,
    });
  }
  return out;
}

/**
 * Subscribe to the chat composer events. Returns an unsubscribe function that
 * removes listeners and aborts any in-flight runs.
 */
export function startRuntimeListener(
  bindings: RuntimeBindings,
  options: RuntimeOptions = {},
): () => void {
  const sendEventName = options.eventName ?? 'jarvis:send';
  const cancelEventName = options.cancelEventName ?? 'jarvis:cancel';
  const flushIntervalMs = options.flushIntervalMs ?? 50;

  const inFlight = new Map<MessageId, AbortController>();

  const handleSend = async (e: Event) => {
    const detail = (e as CustomEvent<SendDetail>).detail;
    if (!detail || !detail.chatId || typeof detail.text !== 'string') return;
    const { chatId, text } = detail;

    // Resolve agent: explicit agentId > leading @mention > chat's active agent.
    let agent: Agent | null | undefined;
    if (detail.agentId) agent = bindings.getAgentById(detail.agentId);
    if (!agent) {
      const slug = detectMention(text);
      if (slug) agent = bindings.getAgentBySlug(slug);
    }
    if (!agent) agent = bindings.getAgentForChat(chatId);
    if (!agent) {
      // Loud-but-not-crashy: surface the misconfiguration so it's visible in
      // dev console; the UI will likely show no response.
      console.warn('[jarvis runtime] no agent resolvable for chat', chatId);
      return;
    }

    // Apply the active persona preset to Jarvis only. Other agents pass through.
    let runnable = agent;
    if (agent.slug === 'jarvis') {
      const preset = useAuthStore.getState().personaPreset;
      runnable = applyPersona(agent, preset);
    }

    let placeholderId: MessageId | null = null;
    const controller = new AbortController();

    // Throttled-flush state. Lifted out of the try block so the catch path can
    // cancel a pending timer before stamping the error suffix - otherwise a
    // late flush would overwrite "[cancelled]" with the partial accumulator.
    let acc = '';
    let lastFlush = 0;
    let pending = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending = false;
      lastFlush = Date.now();
      if (placeholderId) {
        // Fire-and-forget: ordering of writes is preserved by the underlying
        // store; the final awaited write below stamps the canonical version.
        void bindings.updateMessage(placeholderId, {
          parts: [{ kind: 'text', text: acc }],
        });
      }
    };

    const scheduleFlush = () => {
      const now = Date.now();
      const since = now - lastFlush;
      if (since >= flushIntervalMs) {
        flushNow();
        return;
      }
      if (!pending) {
        pending = true;
        flushTimer = setTimeout(flushNow, flushIntervalMs - since);
      }
    };

    const cancelPendingFlush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending = false;
    };

    try {
      // Append the user message first so history is correct before we run.
      await bindings.appendMessage({
        chat_id: chatId as ChatId,
        role: 'user',
        parts: [{ kind: 'text', text }],
      });

      // Empty assistant placeholder we'll stream into.
      const placeholder = await bindings.appendMessage({
        chat_id: chatId as ChatId,
        role: 'assistant',
        agent_id: agent.id,
        parts: [{ kind: 'text', text: '' }],
      });
      placeholderId = placeholder.id;
      inFlight.set(placeholder.id, controller);

      // Read the now-current history; pass it (sans placeholder) to the model.
      const history = await bindings.getMessages(chatId);
      const llmMessages = toLLMMessages(history, placeholder.id);

      useAgentStore.getState().setRunState(agent.id, 'streaming');
      useAgentStore.getState().setVerb(agent.id, 'thinking');

      const response = await runAgent({
        agent: runnable,
        messages: llmMessages,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (chunk.delta && chunk.delta.length > 0) {
            acc += chunk.delta;
            scheduleFlush();
          }
          if (chunk.done) flushNow();
        },
      });

      // Make sure no scheduled flush fires after the canonical write below.
      cancelPendingFlush();

      // Force a final write with whatever the provider says is canonical.
      const finalText = response.text || acc;
      await bindings.updateMessage(placeholder.id, {
        parts: [{ kind: 'text', text: finalText }],
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cost_usd: response.usage.cost_usd,
          provider: response.provider,
          model: response.model,
        },
      });

      useAgentStore.getState().setRunState(agent.id, 'done');
      useAgentStore.getState().setVerb(agent.id, undefined);
    } catch (err) {
      // Cancel any pending flush before stamping the suffix or it'll overwrite us.
      cancelPendingFlush();

      const aborted =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err as Error)?.name === 'AbortError';

      if (placeholderId) {
        const suffix = aborted
          ? '_[cancelled]_'
          : `_Error: ${(err as Error)?.message ?? 'unknown'}_`;
        const sep = acc.length > 0 ? '\n\n' : '';
        await bindings.updateMessage(placeholderId, {
          parts: [{ kind: 'text', text: acc + sep + suffix }],
        });
      }
      useAgentStore.getState().setRunState(agent.id, aborted ? 'idle' : 'error');
      useAgentStore.getState().setVerb(agent.id, undefined);
    } finally {
      if (placeholderId) inFlight.delete(placeholderId);
    }
  };

  const handleCancel = (e: Event) => {
    const detail = (e as CustomEvent<CancelDetail>).detail;
    if (!detail || !detail.messageId) {
      for (const c of inFlight.values()) c.abort();
      inFlight.clear();
      return;
    }
    const c = inFlight.get(detail.messageId);
    if (c) {
      c.abort();
      inFlight.delete(detail.messageId);
    }
  };

  window.addEventListener(sendEventName, handleSend as EventListener);
  window.addEventListener(cancelEventName, handleCancel as EventListener);

  return () => {
    window.removeEventListener(sendEventName, handleSend as EventListener);
    window.removeEventListener(cancelEventName, handleCancel as EventListener);
    for (const c of inFlight.values()) c.abort();
    inFlight.clear();
  };
}
