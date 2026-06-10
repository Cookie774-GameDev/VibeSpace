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
import type { ChatId, ProjectId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { runAgent } from './router';
import type { LLMMessage } from './types';
import { applyPersona } from '@/features/agents/personas';
import { applyAvailableActions, parseActionBlocks } from '@/lib/actions';
import { buildAgentTerminalContext } from '@/features/terminals/agentContext';
import { getPluginContextBlock } from '@/features/plugins';
import { devConsole } from '@/features/dev-console';
import { chatRepo } from '@/lib/db';
import { getAiCompletionInstruction, notifyDone } from '@/lib/notifications';
import { speakText } from '@/features/voice/speechSynthesis';

/**
 * Read the user's selected Cloud Voice provider from local settings. Returns
 * the provider id only when it's a metered cloud provider (OpenAI / Deepgram /
 * ElevenLabs); otherwise null so the caller keeps the system-voice path.
 * Safe in non-browser/test contexts (returns null).
 */
function readSelectedCloudVoiceProvider(): string | null {
  try {
    const v = globalThis.localStorage?.getItem('jarvis.voice.cloudProvider');
    if (v === 'openai_tts' || v === 'deepgram_tts' || v === 'elevenlabs_tts') return v;
    return null;
  } catch {
    return null;
  }
}
import {
  getProjectContextBlock,
  getProjectContextTreeBlock,
  getConnectedFilesBlock,
  getExplicitContextBlock,
  getExplicitFilesBlock,
  getExplicitTerminalBlock,
} from './context';
import type { TerminalRef } from '@/features/terminals/terminalRefs';
import type { ContextAttachment } from '@/features/context/tree';

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
  getAgentForChat: (
    chatId: ChatId | string,
  ) => Agent | null | undefined | Promise<Agent | null | undefined>;
  /** Read message history for a chat in chronological order. */
  getMessages: (chatId: ChatId | string) => Promise<Message[]> | Message[];
  /** Append a new message; returns the saved message (with id + timestamps). */
  appendMessage: (msg: Omit<Message, 'id' | 'created_at' | 'updated_at'>) => Promise<Message>;
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
  /** Agent ids resolved by the composer mention/typeahead path. */
  mentionedAgentIds?: AgentId[];
  /** Absolute paths attached to this specific message. */
  filePaths?: string[];
  /** PTY session ids dragged into this specific message. Legacy field. */
  terminalSessionIds?: string[];
  /** Stable terminal references dragged into this specific message. */
  terminalRefs?: TerminalRef[];
  /** Context tree nodes dragged into this specific message. */
  contextNodes?: ContextAttachment[];
  /** Speak the final assistant reply when this send came from voice input. */
  speakReply?: boolean;
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
  const m = /(?:^|\s)@([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/.exec(text);
  return m ? m[1]! : null;
}

/**
 * Derive a short tab title from an assistant reply.
 *
 * Picks the first non-empty prose sentence (strips markdown, code
 * fences, and lists), normalises whitespace, and clamps to 48 chars.
 * Returns the empty string when nothing usable was found — callers
 * use that as the "leave the title alone" signal.
 *
 * Why this lives here (not in a separate util):
 *   It's only called once, from the post-run hook, and the rules are
 *   tightly coupled to "what makes a good chat tab". Splitting it out
 *   for testability would invite premature generalisation.
 */
function derivePaneTitle(reply: string): string {
  if (!reply) return '';
  // Drop fenced code blocks entirely; they almost never make good titles.
  let stripped = reply.replace(/```[\s\S]*?```/g, ' ');
  // Drop inline code spans (preserve content but lose backticks).
  stripped = stripped.replace(/`([^`]+)`/g, '$1');
  // Drop common markdown chrome at the start of lines.
  stripped = stripped.replace(/^\s*[#>*\-+\d.]+\s+/gm, '');
  // Collapse whitespace.
  stripped = stripped.replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  // Take the first sentence (or the whole thing when no terminator).
  const sentenceMatch = /^[^.!?\n]{3,}[.!?]/.exec(stripped);
  let title = sentenceMatch ? sentenceMatch[0] : stripped;
  title = title.replace(/[.!?]+$/, '').trim();
  // Hard cap at 48 chars; ellipsis if we cut.
  if (title.length > 48) {
    title = title.slice(0, 47).trimEnd() + '…';
  }
  // Reject titles that ended up too short to be useful.
  if (title.length < 3) return '';
  return title;
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
 * Split the assistant's final text into a `Part[]` ready to write back
 * onto the placeholder message.
 *
 * Most replies are plain prose, in which case this returns a single
 * text part — the same shape the throttled flush has been writing all
 * along, so streaming + final write stay visually identical.
 *
 * When the AI emitted one or more action blocks the result alternates:
 *   text (prose before block 1)
 *   action_proposal (block 1, status:'pending')
 *   text (prose between block 1 and 2)
 *   action_proposal (block 2, status:'pending')
 *   ...
 *
 * Malformed action blocks become inline `[Action error] …` text parts
 * with the raw block preserved verbatim — the user sees what the AI
 * wrote, and the AI sees the same context on the next turn so it can
 * self-correct rather than silently retrying broken JSON.
 */
function textToParts(text: string): Part[] {
  const result = parseActionBlocks(text);
  if (!result.hasActionBlocks) {
    return [{ kind: 'text', text }];
  }
  const parts: Part[] = [];
  for (const seg of result.segments) {
    if (seg.kind === 'prose') {
      if (seg.text.trim().length > 0) {
        parts.push({ kind: 'text', text: seg.text });
      }
      continue;
    }
    if (seg.ok) {
      parts.push({
        kind: 'action_proposal',
        call_id: seg.proposal.call_id,
        action_id: seg.proposal.action_id,
        params: seg.proposal.params,
        rationale: seg.proposal.rationale,
        status: 'pending',
      });
      continue;
    }
    parts.push({
      kind: 'text',
      text: `[Action error] ${seg.error}\n\n${seg.raw}`,
    });
  }
  // Defensive: never emit an empty parts array even if every segment
  // was filtered (shouldn't happen, but a parser change could regress).
  if (parts.length === 0) return [{ kind: 'text', text }];
  return parts;
}

function textToSpeechOutput(text: string): string {
  const result = parseActionBlocks(text);
  const prose = result.segments
    .flatMap((seg) => (seg.kind === 'prose' ? [seg.text.trim()] : []))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prose) return '';
  return prose.length <= 900 ? prose : `${prose.slice(0, 897).trimEnd()}…`;
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

    // Resolve agent: explicit agentId > composer-resolved mention >
    // textual @mention fallback > chat's active agent.
    let agent: Agent | null | undefined;
    if (detail.agentId) agent = bindings.getAgentById(detail.agentId);
    if (!agent && Array.isArray(detail.mentionedAgentIds)) {
      const mentionedAgentId = detail.mentionedAgentIds.find(Boolean);
      if (mentionedAgentId) agent = bindings.getAgentById(mentionedAgentId);
    }
    if (!agent) {
      const slug = detectMention(text);
      if (slug) agent = bindings.getAgentBySlug(slug);
    }
    if (!agent) agent = await bindings.getAgentForChat(chatId);
    if (!agent) {
      // Loud-but-not-crashy: surface the misconfiguration so it's visible in
      // dev console; the UI will likely show no response.
      console.warn('[jarvis runtime] no agent resolvable for chat', chatId);
      return;
    }

    // Apply the active persona preset to Jarvis only. Other agents pass through.
    // Same gate is reused for the action-catalogue addendum so we don't
    // inflate prompts for sub-agents (Builder/Scout/Reviewer) that don't
    // need to propose user-approved actions.
    let runnable = agent;
    if (agent.slug === 'jarvis') {
      const preset = useAuthStore.getState().personaPreset;
      runnable = applyPersona(agent, preset);
      runnable = applyAvailableActions(runnable);
    }

    // V3 — Splice in any terminal-pane transcript bound to this
    // agent's slug. The Builder pane running `claude` produces the
    // output the Builder agent will be asked about ("did the tests
    // pass?", "what did Claude propose?"). We prepend the context to
    // the agent's system_prompt rather than splicing it as a
    // mid-history `system` message — every provider strips
    // mid-history system turns (openai/anthropic/google/groq/ollama
    // adapters all filter them) so a spliced message would be
    // silently discarded. The context block is fenced + framed as
    // data so an attacker writing "ignore previous instructions"
    // into a CLI can't hijack the chat. Empty string when there's
    // nothing worth surfacing — skip the prepend in that case to
    // keep the prompt lean.
    const terminalContext = buildAgentTerminalContext(agent.slug);

    // Project + connected-files context (Projects revamp).
    //
    // Order matters here: the project blob is the most "static" /
    // long-lived knowledge ("we use Postgres, prefer pnpm, …") so it
    // sits first. The connected-files block is "you should look at
    // these specific files for this turn" — closer to the user's
    // question, so it lives after the project blob. Live terminal
    // transcripts are the freshest, so they sit last and closest to
    // the agent's own system prompt.
    //
    // Each helper returns '' when its source is empty / disabled,
    // and we skip empty bits when assembling. Failures inside either
    // helper degrade silently — neither block is on the critical
    // path, and a missing file shouldn't kill a chat turn.
    const projectId = useAuthStore.getState().projectId as ProjectId | null;
    let projectContext = '';
    let projectContextTree = '';
    let connectedFilesContext = '';
    let explicitContext = '';
    let explicitFilesContext = '';
    let explicitTerminalContext = '';
    let pluginContext = '';
    try {
      projectContext = await getProjectContextBlock(projectId);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'project context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      projectContextTree = getProjectContextTreeBlock(projectId);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'project Context tree fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      explicitContext = getExplicitContextBlock(detail.contextNodes ?? []);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'attached Context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      connectedFilesContext = await getConnectedFilesBlock(agent.slug, projectId);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'connected-files context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      explicitFilesContext = await getExplicitFilesBlock(detail.filePaths ?? []);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'attached-files context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      explicitTerminalContext = getExplicitTerminalBlock(
        detail.terminalRefs ?? detail.terminalSessionIds ?? [],
      );
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'attached-terminal context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    try {
      pluginContext = getPluginContextBlock(projectId);
    } catch (err) {
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'plugin context fetch failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    const contextBlocks = [
      projectContext,
      projectContextTree,
      pluginContext,
      explicitContext,
      explicitFilesContext,
      explicitTerminalContext,
      connectedFilesContext,
      terminalContext,
      getAiCompletionInstruction(),
    ].filter((s) => s && s.length > 0);
    if (contextBlocks.length > 0) {
      runnable = {
        ...runnable,
        system_prompt: contextBlocks.join('\n\n') + '\n\n' + (runnable.system_prompt ?? ''),
      };
    }

    let placeholderId: MessageId | null = null;
    const controller = new AbortController();
    // Hoisted so the catch / finally blocks can include it in their
    // DevConsole entries — defining it inside the try would put it
    // out of scope when the run errors before the first log call.
    const aiStart = Date.now();

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
      // The composer (`features/chat/Composer.tsx`) has already
      // persisted the user message before dispatching `jarvis:send`,
      // so we DO NOT call `bindings.appendMessage` for the user turn
      // here — doing so would produce two identical user bubbles in
      // the thread (the bug the AI-router audit flagged). We just
      // create the empty assistant placeholder and read history.
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

      // DevConsole breadcrumb — the most useful "where did the chat
      // go wrong" entry. Logged AFTER the placeholder + history are
      // ready so the detail object captures the exact prompt size
      // we're sending. Chunks themselves are not logged (would flood
      // the feed) — start/done/error/cancel are enough to bound
      // each request in the timeline.
      devConsole.log({
        channel: 'ai',
        level: 'info',
        message: `AI request → @${agent.slug} (${runnable.model.provider}/${runnable.model.model})`,
        detail: {
          chatId,
          agent: agent.slug,
          provider: runnable.model.provider,
          model: runnable.model.model,
          messageCount: llmMessages.length,
          systemPromptChars: runnable.system_prompt?.length ?? 0,
          placeholderId: placeholder.id,
        },
      });

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
      // textToParts() splits the text on action-proposal fences so the
      // chat thread renders inline Approve/Cancel cards alongside prose.
      const finalText = response.text || acc;
      await bindings.updateMessage(placeholder.id, {
        parts: textToParts(finalText),
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

      // Auto-name the chat from its first assistant reply.
      //
      // The user wanted chat tabs to take their name from "the AI
      // first response," replacing the boilerplate "New chat 3"
      // placeholder. We only rename when:
      //   1. We have a chat row to update (not all hosts use chatRepo).
      //   2. The current title looks like the placeholder ("New chat",
      //      "New chat N", or empty) — never overwrite a user-edited
      //      title even if the chat is one turn old.
      //   3. We have a non-trivial reply to derive a title from.
      //
      // The summarizer is intentionally lightweight (no extra LLM
      // call): take the first sentence of the prose, strip markdown,
      // clamp to 48 chars. That's good enough to make tabs scannable;
      // the user can rename manually any time.
      try {
        const chat = await chatRepo.getById(chatId as ChatId);
        if (chat) {
          const t = (chat.title ?? '').trim();
          const looksDefault =
            t.length === 0 ||
            t === 'New chat' ||
            /^New chat( \d+)?$/i.test(t) ||
            t.startsWith('Chat with ');
          if (looksDefault) {
            const title = derivePaneTitle(finalText);
            if (title) {
              await chatRepo.update(chat.id, { title });
            }
          }
        }
      } catch {
        // Auto-naming is best-effort; never let it break the run.
      }

      devConsole.log({
        channel: 'ai',
        level: 'info',
        message: `AI done ← @${agent.slug} (${response.usage.input_tokens}+${response.usage.output_tokens} tok, $${response.usage.cost_usd.toFixed(4)})`,
        durationMs: Date.now() - aiStart,
        detail: {
          agent: agent.slug,
          provider: response.provider,
          model: response.model,
          usage: response.usage,
          textChars: finalText.length,
          partCount: textToParts(finalText).length,
        },
      });
      void notifyDone(
        'jarvis',
        `${agent.name} done`,
        derivePaneTitle(finalText) || 'The AI response is complete.',
      );
      const voiceSettings = useAuthStore.getState();
      // Jarvis speaks ONLY when summoned by voice (clicking the J / voice panel,
      // or dictating into the composer) — never for plain typed messages.
      // `detail.speakReply` is true only for voice-initiated sends; the global
      // "speak replies" toggle can additionally mute even those.
      if (detail.speakReply && voiceSettings.speakReplies) {
        const speechText = textToSpeechOutput(finalText);
        if (speechText) {
          // If the user explicitly selected a metered cloud voice (OpenAI /
          // Deepgram / ElevenLabs) in Cloud Voice settings, route the reply
          // through TtsService so it uses that provider with automatic
          // fallback to local/system voice. Otherwise keep the lightweight
          // system-voice path unchanged.
          const cloudProvider = readSelectedCloudVoiceProvider();
          if (cloudProvider) {
            void import('@/features/voice/TtsService')
              .then(({ TtsService }) => TtsService.speak(speechText))
              .catch((speechErr) => {
                devConsole.log({
                  channel: 'ai',
                  level: 'warn',
                  message: `Cloud voice reply failed: ${speechErr instanceof Error ? speechErr.message : String(speechErr)}`,
                  detail: { agent: agent.slug, textChars: speechText.length },
                });
              });
          } else {
            void speakText(speechText, {
              voicePreset: voiceSettings.voicePreset,
              engine: voiceSettings.voiceEngine,
            }).catch((speechErr) => {
              devConsole.log({
                channel: 'ai',
                level: 'warn',
                message: `Voice reply failed: ${speechErr instanceof Error ? speechErr.message : String(speechErr)}`,
                detail: { agent: agent.slug, textChars: speechText.length },
              });
            });
          }
        }
      }
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
        try {
          await bindings.updateMessage(placeholderId, {
            parts: [{ kind: 'text', text: acc + sep + suffix }],
          });
        } catch (writeErr) {
          // The audit's medium finding: a DB failure inside the catch
          // path would propagate out of handleSend as an unhandled
          // rejection, leaving the agent stuck in 'streaming'. Keep
          // the agent-state reset below the try so a stuck cursor
          // unwinds even when the canonical error stamp couldn't be
          // written.
          devConsole.log({
            channel: 'ai',
            level: 'error',
            message: 'AI error-stamp write failed',
            detail: {
              agent: agent.slug,
              error: writeErr instanceof Error ? writeErr.message : String(writeErr),
            },
          });
        }
      }
      useAgentStore.getState().setRunState(agent.id, aborted ? 'idle' : 'error');
      useAgentStore.getState().setVerb(agent.id, undefined);

      devConsole.log({
        channel: 'ai',
        level: aborted ? 'warn' : 'error',
        message: aborted
          ? `AI cancelled @${agent.slug}`
          : `AI error @${agent.slug}: ${(err as Error)?.message ?? 'unknown'}`,
        durationMs: Date.now() - aiStart,
        detail: {
          agent: agent.slug,
          aborted,
          partialChars: acc.length,
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : String(err),
        },
      });
    } finally {
      if (placeholderId) inFlight.delete(placeholderId);
    }
  };

  const handleCancel = (e: Event) => {
    const detail = (e as CustomEvent<CancelDetail>).detail;
    if (!detail || !detail.messageId) {
      const count = inFlight.size;
      for (const c of inFlight.values()) c.abort();
      inFlight.clear();
      if (count > 0) {
        devConsole.log({
          channel: 'ai',
          level: 'warn',
          message: `AI cancel-all (${count} in flight)`,
          detail: { count },
        });
      }
      return;
    }
    const c = inFlight.get(detail.messageId);
    if (c) {
      c.abort();
      inFlight.delete(detail.messageId);
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'AI cancel',
        detail: { messageId: detail.messageId },
      });
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
