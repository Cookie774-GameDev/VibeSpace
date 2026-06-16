import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, ChevronDown, Sparkles, Mic, MicOff, FileText, X, Network, Terminal } from 'lucide-react';
import { PLUGIN_CATALOG } from '@/features/plugins/catalog';
import { extractPluginMentions } from '@/features/plugins/mentions';
import { PluginLogo } from '@/features/plugins/PluginLogo';
import { usePluginStore } from '@/features/plugins/store';
import {
  Button,
  Hint,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { cn, isTauri, renderHotkey } from '@/lib/utils';
import { HOTKEYS } from '@/lib/hotkeys';
import { buildUsageSummary } from '@/lib/usage/usageSummary';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { VoiceService } from '@/features/voice/VoiceService';
import { MicWaveform } from './MicWaveform';
import {
  cleanupAudioRecorder,
  encodeWav,
  FasterWhisperManager,
  getAudioContextCtor,
  getComposerSttProvider,
  getFasterWhisperModel,
  isSystemSttAvailable,
  startBatchAudioRecorder,
  STT_INACTIVITY_MS,
  STT_ACTIVITY_RMS,
  transcribeFasterWhisper,
  transcribeGroq as transcribeGroqApi,
  triggerWindowsNativeDictation,
  type FasterWhisperRecorder,
} from '@/features/composer-stt';
import { JARVIS_COMMAND_CATALOG } from '@/features/assistant/commands';
import { toast } from '@/components/ui/toast';
import type { Agent, AgentId, ChatId, ProviderId } from '@/types';
import {
  parseTerminalRef,
  terminalRefKey,
  terminalRefLabel,
  type TerminalRef,
} from '@/features/terminals/terminalRefs';
import {
  parseTerminalScheduleRequest,
  scheduleTerminalCommandFromChat,
} from '@/features/terminals/terminalScheduler';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import {
  CONTEXT_MIME,
  parseContextAttachment,
  serializeContextAttachment,
  loadStoredContextMaps,
  contextMapSlashOptions,
  resolveContextMapRecord,
  type ContextAttachment,
  type ContextMapRecord,
} from '@/features/context/tree';
import { MentionTypeahead } from './MentionTypeahead';
import { SlashCommandTypeahead, SLASH_COMMANDS, orderSlashCommandsForDisplay, type SlashCommandDef, type SlashCommandTypeaheadRef } from './SlashCommandTypeahead';
import { SlashCommandOptionPicker, type SlashCommandOption, type SlashCommandOptionPickerRef } from './SlashCommandOptionPicker';
import {
  ModelPickerTypeahead,
  type ModelPickerTypeaheadRef,
} from './ModelPickerTypeahead';
import { StackPicker } from './StackPicker';
import { InputToken, TokenList } from './InputToken';
import { getChatDragKind, getChatDropPayload } from './dropPayload';
import { SKILLS } from '@/lib/agents/skills';
import {
  REAL_CHAT_PROVIDERS,
  selectLocalModelForChat,
  defaultModelForProvider,
  getAccessibleModelOptions,
  getAccessibleProviders,
  syncDiscoveredOllamaModels,
  useOllamaModelOptions,
} from '@/lib/ai/models';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';

export interface ComposerProps {
  chatId: ChatId | string;
  /** Optional placeholder override */
  placeholder?: string;
  /** Compact right-sidebar rendering. */
  compact?: boolean;
  /** Disable slash commands that navigate the main canvas. */
  disableRouteSlashCommands?: boolean;
}

const LINE_HEIGHT = 20; // px - matches body type scale
const PADDING_Y = 16; // px - 8px top + 8px bottom
const MIN_LINES = 1;
const MAX_LINES = 8;
const MIN_HEIGHT = MIN_LINES * LINE_HEIGHT + PADDING_Y;
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT + PADDING_Y;
const COMPOSER_IDLE_PLUGIN_CONNECTIONS = {} as ReturnType<
  typeof usePluginStore.getState
>['connections'];

const COMPOSER_IDLE_TERMINAL_SESSIONS = {} as ReturnType<
  typeof useTerminalTranscriptStore.getState
>['sessions'];

const PROVIDERS: ProviderId[] = [...REAL_CHAT_PROVIDERS];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  together: 'Together',
  ollama: 'Ollama (local)',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  fireworks: 'Fireworks',
  replicate: 'Replicate',
  hyperbolic: 'Hyperbolic',
  novita: 'Novita',
  lambda: 'Lambda',
  azure: 'Azure OpenAI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  bedrock: 'AWS Bedrock',
  mock: 'Mock',
  local: 'Local',
};

type MentionContext = { start: number; query: string };
type SlashContext = { start: number; query: string };
type OptionPickerContext = { cmd: SlashCommandDef; query: string };

interface ConfirmedCommand {
  cmd: string;
  value?: string;
  label: string;
}

const WINDOWS_FILE_PATH_RE =
  /[A-Za-z]:\\[^\r\n<>:"|?*]+?\.(?:json|cs|ts|tsx|js|jsx|md|txt|html|css|scss|py|rs|go|java|cpp|c|h|hpp|xml|yaml|yml|toml|ini|sql)\b/gi;

export function extractAbsoluteFilePaths(text: string): string[] {
  return Array.from(new Set(text.match(WINDOWS_FILE_PATH_RE) ?? [])).slice(0, 8);
}

/**
 * Find an active "@xxx" mention being typed at the caret.
 * Triggers when '@' is at position 0 or directly after whitespace.
 */
function getMentionContext(value: string, caret: number): MentionContext | null {
  let i = caret - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '@') {
      if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i--;
  }
  return null;
}

/**
 * Find an active "/xxx" slash command being typed at the caret.
 * Triggers when '/' is at position 0 or directly after whitespace.
 * Only activates if the query contains no spaces (single token).
 */
function getSlashContext(value: string, caret: number): SlashContext | null {
  let i = caret - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '/') {
      if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
        const query = value.slice(i + 1, caret);
        // Only trigger if no spaces in the query (single token command)
        if (!/\s/.test(query)) {
          return { start: i, query };
        }
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i--;
  }
  return null;
}

/**
 * Fuzzy-match a query against a string. Returns a score (higher = better match).
 * Simple scoring: prefix match > starts-with > includes > no match.
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 50;
  // Character-by-character fuzzy: all query chars must appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 20 : 0;
}

/**
 * Pull all `@slug` tokens from a string and resolve them to known AgentIds.
 *
 * Defensive against a sparse or partially-corrupt agent map: any entry
 * without a slug is skipped rather than crashing the loop. The
 * Composer's `handleSend` calls this synchronously inside a try/catch,
 * but a defensive guard here keeps the dispatch path simple even when
 * an agent gets registered without all of its expected fields.
 */
function extractMentionedAgentIds(text: string, agents: Record<string, Agent>): AgentId[] {
  const slugToId: Record<string, AgentId> = {};
  for (const a of Object.values(agents)) {
    if (!a?.slug || !a.id) continue;
    slugToId[a.slug] = a.id;
  }

  const seen = new Set<AgentId>();
  const out: AgentId[] = [];
  const re = /(?:^|\s)@([a-z0-9_-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = slugToId[(m[1] ?? '').toLowerCase()];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function pluginConnectionLabel(
  connection: { accountLabel?: string; configuredFields: string[] } | undefined,
): string | undefined {
  if (!connection) return undefined;
  return connection.accountLabel ?? `${connection.configuredFields.length} credential(s)`;
}

export function Composer({ chatId, placeholder, compact = false, disableRouteSlashCommands = false }: ComposerProps) {
  const [text, setText] = useState('');
  const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [slashCtx, setSlashCtx] = useState<SlashContext | null>(null);
  const [selectedSlashCmd, setSelectedSlashCmd] = useState<string>('');
  const [optionPickerCtx, setOptionPickerCtx] = useState<OptionPickerContext | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [confirmedCommands, setConfirmedCommands] = useState<ConfirmedCommand[]>([]);
  const [sending, setSending] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [attachedTerminals, setAttachedTerminals] = useState<TerminalRef[]>([]);
  const [attachedPlugins, setAttachedPlugins] = useState<string[]>([]);
  const [attachedContexts, setAttachedContexts] = useState<ContextAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // V2 ������ speech-to-text in the composer.
  const [sttListening, setSttListening] = useState(false);
  const [sttInterim, setSttInterim] = useState('');
  const composerSttEnabled = useUIStore((s) => s.composerStt);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashTypeaheadRef = useRef<SlashCommandTypeaheadRef>(null);
  const optionPickerRef = useRef<SlashCommandOptionPickerRef>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const wavChunksRef = useRef<Float32Array[]>([]);
  const audioSilenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAudioActivityRef = useRef(0);

  const volumeRef = useRef<number>(0);
  const webSpeechAudioContextRef = useRef<AudioContext | null>(null);
  const webSpeechStreamRef = useRef<MediaStream | null>(null);
  const webSpeechAnalyserRef = useRef<AnalyserNode | null>(null);
  const webSpeechVolumeTimerRef = useRef<number | null>(null);
  const voiceReplyRequestedRef = useRef(false);
  const batchRecorderRef = useRef<FasterWhisperRecorder | null>(null);

  const agents = useAgentStore((s) => s.agents);
  const provider = useAuthStore((s) => s.defaultProvider);
  const selectedModels = useAuthStore((s) => s.selectedModels);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);
  const setSelectedModel = useAuthStore((s) => s.setSelectedModel);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const projectId = useAuthStore((s) => s.projectId);
  const terminalPickerActive = optionPickerCtx?.cmd.cmd === 'terminal';
  const pluginPickerActive = optionPickerCtx?.cmd.cmd === 'plug';
  const pluginConnections = usePluginStore((s) =>
    pluginPickerActive ? s.connections : COMPOSER_IDLE_PLUGIN_CONNECTIONS,
  );
  const terminalSessions = useTerminalTranscriptStore((s) =>
    terminalPickerActive ? s.sessions : COMPOSER_IDLE_TERMINAL_SESSIONS,
  );
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<ModelPickerTypeaheadRef>(null);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const ollamaOptions = useOllamaModelOptions();

  const accessibleProviders = useMemo(
    () => getAccessibleProviders(apiKeys, offlineMode, plan),
    [apiKeys, offlineMode, plan, ollamaOptions],
  );

  const chatModelReady = accessibleProviders.includes(provider);

  useEffect(() => {
    if (!chatModelReady) return;
    const options = getAccessibleModelOptions(
      provider,
      apiKeys,
      offlineMode,
      defaultLocalModel,
      plan,
    );
    if (options.length === 0) return;
    const current = selectedModels[provider] || defaultModelForProvider(provider, defaultLocalModel);
    if (!options.some((option) => option.id === current)) {
      setSelectedModel(provider, options[0]!.id);
    }
  }, [
    chatModelReady,
    provider,
    apiKeys,
    offlineMode,
    defaultLocalModel,
    plan,
    selectedModels,
    setSelectedModel,
  ]);

  // Generate options for option picker based on current command
  const optionPickerOptions = useMemo<SlashCommandOption[]>(() => {
    if (!optionPickerCtx) return [];
    const cmd = optionPickerCtx.cmd.cmd;

    if (cmd === 'terminal') {
      // Get list of active terminal sessions for the current project
      const sessions = Object.values(terminalSessions)
        .filter((s) => !projectId || s.projectId === projectId)
        .sort((a, b) => b.lastWriteAt - a.lastWriteAt);
      return sessions.map((s) => ({
        id: s.sessionId,
        label: s.command || s.agentSlug || s.paneId || 'Terminal',
        description: s.agentSlug ? `Agent: ${s.agentSlug}` : undefined,
        metadata: s.paneId ? `pane:${s.paneId.slice(0, 6)}` : undefined,
      }));
    }

    if (cmd === 'contextmap') {
      const maps = projectId ? loadStoredContextMaps(projectId) : [];
      return contextMapSlashOptions(maps);
    }

    if (cmd === 'plug') {
      return PLUGIN_CATALOG.filter((plugin) => {
        const connection = pluginConnections[plugin.id];
        if (!connection || connection.state !== 'connected' || !connection.enabled) return false;
        return (
          connection.enabledProjectIds.includes('*') ||
          Boolean(projectId && connection.enabledProjectIds.includes(projectId))
        );
      }).map((plugin) => ({
        id: plugin.id,
        label: plugin.name,
        description: pluginConnectionLabel(pluginConnections[plugin.id]),
        metadata: plugin.category,
        leading: <PluginLogo plugin={plugin} size="sm" />,
      }));
    }

    if (cmd === 'skills') {
      return Object.values(SKILLS).map((skill) => ({
        id: skill.id,
        label: skill.name,
        description: skill.description,
        metadata: skill.tools.length > 0 ? skill.tools.join(', ') : 'prompt',
      }));
    }

    return [];
  }, [optionPickerCtx, terminalSessions, projectId, pluginConnections]);

  // Keep keyboard highlight on a valid option without clobbering hover/arrow nav.
  useEffect(() => {
    if (optionPickerOptions.length === 0) {
      setSelectedOptionId('');
      return;
    }
    setSelectedOptionId((current) =>
      optionPickerOptions.some((o) => o.id === current) ? current : optionPickerOptions[0]!.id,
    );
  }, [optionPickerOptions]);

  const clearAudioSilenceTimer = () => {
    if (audioSilenceTimerRef.current) clearInterval(audioSilenceTimerRef.current);
    audioSilenceTimerRef.current = null;
  };

  const stopGroqSttWithoutTranscribing = (message = 'Speech-to-text stopped after 30 seconds without voice activity.') => {
    clearAudioSilenceTimer();
    stopWebSpeechVolumeMeter();
    volumeRef.current = 0;
    batchRecorderRef.current?.stop();
    batchRecorderRef.current = null;
    const context = audioContextRef.current;
    const chunks = wavChunksRef.current;
    cleanupAudioRecorder(audioProcessorRef.current, audioSourceRef.current, audioContextRef.current, mediaStreamRef.current);
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;
    wavChunksRef.current = [];
    setSttListening(false);
    setSttInterim('');
    if (chunks.length > 0 && context) {
      void transcribeGroq(encodeWav(chunks, context.sampleRate), useAuthStore.getState().apiKeys.groq ?? '');
      return;
    }
    toast.info('Speech-to-text stopped', message);
  };

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; prompt?: string; code?: string }>).detail;
      if (!detail?.path || !detail.code) return;
      setText([
        detail.prompt?.trim() || 'Review this code.',
        '',
        `File: ${detail.path}`,
        '```',
        detail.code,
        '```',
      ].join('\n'));
      setAttachedFiles((cur) => (cur.includes(detail.path!) ? cur : [...cur, detail.path!]).slice(0, 8));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('jarvis:files:ask', onAsk as EventListener);
    return () => window.removeEventListener('jarvis:files:ask', onAsk as EventListener);
  }, []);

  // Free-tier nudge: the seeded Jarvis agent runs on Google's Gemini 2.5
  // Flash Lite by default. Until the user pastes an AI Studio key
  // (`AIza...`), the router silently falls back to mock and replies look
  // fake. Surface a one-line CTA on the composer so they know it's a
  // 30-second fix at aistudio.google.com/apikey (no card needed).
  const googleKey = useAuthStore((s) => s.apiKeys.google);
  const jarvisAgent = useMemo(
    () => Object.values(agents).find((a) => a.slug === 'jarvis'),
    [agents],
  );
  const showFreeKeyNudge =
    !compact &&
    !!jarvisAgent &&
    jarvisAgent.model.provider === 'google' &&
    !googleKey;

  // Filtered agent list for the mention typeahead (case-insensitive prefix match,
  // falling back to substring match for forgiving search).
  const filteredAgents = useMemo<Agent[]>(() => {
    const all = Object.values(agents);
    const q = (mentionCtx?.query ?? '').toLowerCase();
    if (!mentionCtx) return [];
    if (!q) return all;
    return all
      .filter((a) => a.slug.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefer slug-prefix matches first
        const aPrefix = a.slug.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.slug.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.slug.localeCompare(b.slug);
      });
  }, [agents, mentionCtx]);

  // Keep selectedSlug in sync when filtered list changes
  useEffect(() => {
    if (filteredAgents.length === 0) {
      setSelectedSlug('');
      return;
    }
    if (!filteredAgents.some((a) => a.slug === selectedSlug)) {
      setSelectedSlug(filteredAgents[0]!.slug);
    }
  }, [filteredAgents, selectedSlug]);

  // Filtered slash command list for the typeahead (fuzzy match on cmd + description).
  const filteredSlashCommands = useMemo<SlashCommandDef[]>(() => {
    const q = (slashCtx?.query ?? '').toLowerCase();
    if (!slashCtx) return [];
    const scored = SLASH_COMMANDS.map((c) => ({
      cmd: c,
      score: Math.max(
        fuzzyScore(q, c.cmd),
        fuzzyScore(q, c.description) * 0.5,
      ),
    }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.cmd.cmd.localeCompare(b.cmd.cmd))
      .map((s) => s.cmd);
    return scored;
  }, [slashCtx]);

  // Keep selectedSlashCmd in sync when filtered list changes
  useEffect(() => {
    if (filteredSlashCommands.length === 0) {
      setSelectedSlashCmd('');
      return;
    }
    const displayCommands = orderSlashCommandsForDisplay(filteredSlashCommands);
    if (!displayCommands.some((c) => c.cmd === selectedSlashCmd)) {
      setSelectedSlashCmd(displayCommands[0]!.cmd);
    }
  }, [filteredSlashCommands, selectedSlashCmd]);

  // Auto-grow the textarea up to MAX_HEIGHT, then enable internal scroll
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.max(MIN_HEIGHT, Math.min(ta.scrollHeight, MAX_HEIGHT));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const recomputeMention = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    setMentionCtx(getMentionContext(ta.value, ta.selectionStart));
  };

  const recomputeSlash = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    setSlashCtx(getSlashContext(ta.value, ta.selectionStart));
  };

  const insertSlashCommand = (cmd: SlashCommandDef) => {
    if (!slashCtx || !textareaRef.current) return;
    const ta = textareaRef.current;
    const before = text.slice(0, slashCtx.start);
    const after = text.slice(ta.selectionStart);

    // If command has options (like /terminal or /contextmap), show option picker
    if (cmd.hasOptions && (cmd.cmd === 'terminal' || cmd.cmd === 'contextmap' || cmd.cmd === 'plug' || cmd.cmd === 'skills')) {
      // Remove the typed slash command from text
      setText(before + after);
      setSlashCtx(null);
      setSelectedOptionId('');
      setOptionPickerCtx({ cmd, query: '' });
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // For commands without options, insert executable slash text. Confirmed
    // tokens are reserved for option commands that need a selected value.
    if (!cmd.takesArg) {
      const insert = `/${cmd.cmd}`;
      const next = before + insert + after;
      setText(next);
      setSlashCtx(null);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        const pos = before.length + insert.length;
        node.focus();
        node.setSelectionRange(pos, pos);
      });
      return;
    }

    // For commands that take args, insert into text
    const insert = `/${cmd.cmd} `;
    const next = before + insert + after;
    setText(next);
    setSlashCtx(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      const pos = before.length + insert.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  const selectOption = (option: SlashCommandOption) => {
    if (!optionPickerCtx) return;
    const cmd = optionPickerCtx.cmd;
    const entry: ConfirmedCommand = {
      cmd: cmd.cmd,
      value: option.id,
      label: `/${cmd.cmd}: ${option.label}`,
    };

    setConfirmedCommands((cur) => {
      if (cmd.cmd === 'skills') {
        if (cur.some((c) => c.cmd === 'skills' && c.value === option.id)) return cur;
        if (cur.filter((c) => c.cmd === 'skills').length >= 6) return cur;
        return [...cur, entry];
      }
      return [...cur.filter((c) => c.cmd !== cmd.cmd), entry];
    });
    setOptionPickerCtx(null);
    setSelectedOptionId('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const removeConfirmedCommand = (cmd: string, value?: string) => {
    setConfirmedCommands((cur) =>
      value != null
        ? cur.filter((c) => !(c.cmd === cmd && c.value === value))
        : cur.filter((c) => c.cmd !== cmd),
    );
  };

  const insertMention = (agent: Agent) => {
    if (!mentionCtx || !textareaRef.current) return;
    const ta = textareaRef.current;
    const before = text.slice(0, mentionCtx.start);
    const after = text.slice(ta.selectionStart);
    const insert = `@${agent.slug} `;
    const next = before + insert + after;
    setText(next);
    setMentionCtx(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      const pos = before.length + insert.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  const handleSlashCommand = async (trimmed: string): Promise<boolean> => {
    if (!trimmed.startsWith('/')) return false;
    const [cmdRaw, ...restParts] = trimmed.slice(1).split(/\s+/);
    const cmd = (cmdRaw ?? '').toLowerCase();
    const rest = restParts.join(' ').trim();
    const addSystem = async (msg: string) => {
      await messageRepo.create({ chat_id: chatId as ChatId, role: 'system', parts: [{ kind: 'text', text: msg }] });
      setText('');
    };
    if (cmd === 'usage') {
      const apiKey = useAuthStore.getState().apiKeys[provider];
      await addSystem(
        await buildUsageSummary({
          provider,
          apiKey,
          providerLabel: PROVIDER_LABELS[provider],
        }),
      );
      return true;
    }
    if (cmd === 'model') {
      if (!rest) {
        setText('');
        setModelPickerOpen(true);
        return true;
      }
      const [providerRaw, ...modelParts] = rest.split(/\s+/);
      const wanted = providerRaw?.toLowerCase() as ProviderId;
      if (!PROVIDERS.includes(wanted)) {
        await addSystem(`Available AI providers: ${PROVIDERS.join(', ')}.`);
        return true;
      }
      const wantedModel =
        modelParts.join(' ').trim() ||
        selectedModels[wanted] ||
        defaultModelForProvider(wanted, defaultLocalModel);
      setDefaultProvider(wanted);
      setSelectedModel(wanted, wantedModel);
      await addSystem(`AI model changed to ${PROVIDER_LABELS[wanted]} / ${wantedModel}.`);
      return true;
    }
    if (cmd === 'hive') {
      if (rest) return false;
      await addSystem(
        [
          'Hive modes:',
          '- /Hive fast   Gemini draft ��! Opus quick check',
          '- /Hive balanced   Grok X High orient ��! Opus draft ��! Gemini polish',
          '- /Hive quality   confirmed simulated Fable-beating stack (94.4)',
          '- /Hive ultra   5-step Supernova stack for critical work',
          '- /Hive custom   your Settings ��! Hive custom stack (max 5 models)',
          '',
          'Use it like: /Hive quality review this plan',
        ].join('\n'),
      );
      return true;
    }
    const routes: Record<string, string> = {
      files: 'files',
      explorer: 'files',
      terminals: 'terminal',
      terminal: 'terminal',
      kanban: 'kanban',
      context: 'context',
      contexts: 'context',
      skillspage: 'skills',
      history: 'history',
      tools: 'tools',
      agents: 'agents',
      schedule: 'schedule',
      chat: 'chat',
    };
    if (cmd in routes) {
      if (disableRouteSlashCommands) {
        await addSystem(`/${cmd} is disabled in the sidebar so this panel stays attached to the current project.`);
        return true;
      }
      useUIStore.getState().setRoute(routes[cmd] as never);
      await addSystem(`Opened ${cmd}.`);
      return true;
    }
    if (cmd === 'skills') {
      const available = Object.values(SKILLS)
        .map((skill) => `- ${skill.name} (${skill.id}) ������ ${skill.description}`)
        .join('\n');
      await addSystem(`Available skills:\n${available}\n\nType /skills and choose one from the dropdown to apply it to your next message.`);
      return true;
    }
    if (cmd === 'attach' && rest) {
      setAttachedFiles((cur) => (cur.includes(rest) ? cur : [...cur, rest]).slice(0, 8));
      setText('');
      return true;
    }
    if (cmd === 'clearfiles') {
      setAttachedFiles([]);
      await addSystem('Cleared attached files.');
      return true;
    }
    if (cmd === 'help') {
      await addSystem('Slash commands: /usage, /model <provider>, /files, /terminals, /kanban, /context, /skills, /history, /tools, /agents, /schedule, /attach <absolute path>, /clearfiles, /commands.');
      return true;
    }
    if (cmd === 'commands') {
      await addSystem(`Jarvis command catalog (${JARVIS_COMMAND_CATALOG.length}):\n${JARVIS_COMMAND_CATALOG.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
      return true;
    }
    // V3 ������ attach a context map to this chat.
    // /contextmap           ������ list available maps
    // /contextmap <name>    ������ attach the named map (prefix match)
    if (cmd === 'contextmap') {
      const projectId = useAuthStore.getState().projectId;
      const maps = projectId ? loadStoredContextMaps(projectId) : [];
      if (!rest) {
        if (maps.length === 0) {
          await addSystem('No context maps yet. Open the Context page and press "Make Context Map" to generate one.');
        } else {
          const active = maps.filter((m: ContextMapRecord) => m.status !== 'deleted');
          const list = active
            .map((m: ContextMapRecord, i: number) => `${i + 1}. ${m.name ?? 'Untitled'} (${(m.tree?.nodes ?? []).length} nodes)`)
            .join('\n');
          await addSystem(`Available context maps (${active.length}):\n${list}\n\nUse /contextmap <name> to attach one.`);
        }
        return true;
      }
      // Find by prefix match on name
      const target = rest.toLowerCase();
      const matched = maps.find((m: ContextMapRecord) => (m.name ?? '').toLowerCase().includes(target));
      if (!matched) {
        await addSystem(`No context map matching '${rest}'. Try /contextmap to see available maps.`);
        return true;
      }
      // Attach the map's root node as a context attachment
      const root = matched.tree?.nodes?.[0];
      if (!root) {
        await addSystem(`Context map '${matched.name}' has no nodes.`);
        return true;
      }
      const attachment: ContextAttachment = {
        projectId: matched.projectId,
        rootDir: matched.rootDir,
        generatedAt: matched.tree?.generatedAt ?? Date.now(),
        nodeId: root.id ?? `map:${matched.name}`,
        title: matched.name ?? 'Context Map',
        summary: matched.tree?.summary ?? '',
        path: '',
        kind: 'root',
      };
      setAttachedContexts((cur) =>
        cur.some((item) => item.nodeId === attachment.nodeId)
          ? cur
          : [...cur, attachment].slice(0, 8),
      );
      setText('');
      await addSystem(`Attached context map '${matched.name}'.`);
      return true;
    }
    // V3 ������ attach a project file to this chat.
    // /file <absolute path>  ������ attach the file
    if (cmd === 'file') {
      if (rest) {
        setAttachedFiles((cur) => (cur.includes(rest) ? cur : [...cur, rest]).slice(0, 8));
        setText('');
        await addSystem(`Attached file: ${rest}`);
        return true;
      }
      await addSystem('Use /file <absolute path> to attach a file. Example: /file C:\\Users\\you\\projects\\app.tsx\nOr drag files from the left panel into the chat.');
      return true;
    }
    await addSystem(`Unknown slash command: /${cmd}. Try /help.`);
    return true;
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    const hasConfirmedCommands = confirmedCommands.length > 0;
    if ((!trimmed && attachedFiles.length === 0 && attachedTerminals.length === 0 && attachedPlugins.length === 0 && attachedContexts.length === 0 && !hasConfirmedCommands) || sending) return;
    if (await handleSlashCommand(trimmed)) return;

    // Process confirmed commands before sending
    const skillIds = confirmedCommands
      .filter((confirmed) => confirmed.cmd === 'skills' && confirmed.value)
      .map((confirmed) => confirmed.value!)
      .slice(0, 6);
    let nextAttachedTerminals = attachedTerminals;
    let nextAttachedPlugins = attachedPlugins;
    let nextAttachedContexts = attachedContexts;
    for (const confirmed of confirmedCommands) {
      if (confirmed.cmd === 'terminal' && confirmed.value) {
        const session = useTerminalTranscriptStore.getState().sessions[confirmed.value];
        if (session) {
          const ref: TerminalRef = {
            sessionId: session.sessionId,
            paneId: session.paneId ?? undefined,
            projectId: session.projectId,
            label: session.command || session.agentSlug || 'Terminal',
            command: session.command ?? undefined,
            agentSlug: session.agentSlug,
          };
          const key = terminalRefKey(ref);
          nextAttachedTerminals = nextAttachedTerminals.some((t) => terminalRefKey(t) === key)
            ? nextAttachedTerminals
            : [...nextAttachedTerminals, ref];
        }
      } else if (confirmed.cmd === 'plug' && confirmed.value) {
        nextAttachedPlugins = nextAttachedPlugins.includes(confirmed.value!)
          ? nextAttachedPlugins
          : [...nextAttachedPlugins, confirmed.value!].slice(0, 8);
      } else if (confirmed.cmd === 'contextmap' && confirmed.value) {
        const maps = projectId ? loadStoredContextMaps(projectId) : [];
        const matched = resolveContextMapRecord(maps, confirmed.value);
        if (matched?.tree?.nodes?.[0]) {
          const root = matched.tree.nodes[0];
          const attachment: ContextAttachment = {
            projectId: matched.projectId,
            rootDir: matched.rootDir,
            generatedAt: matched.tree?.generatedAt ?? Date.now(),
            nodeId: root.id ?? `map:${matched.name}`,
            title: matched.name ?? 'Context Map',
            summary: matched.tree?.summary ?? '',
            path: '',
            kind: 'root',
          };
          nextAttachedContexts = nextAttachedContexts.some((c) => c.nodeId === attachment.nodeId)
            ? nextAttachedContexts
            : [...nextAttachedContexts, attachment];
        }
      }
    }
    setConfirmedCommands([]);

    setSending(true);
    try {
      if (nextAttachedTerminals.length > 0) {
        const scheduled = parseTerminalScheduleRequest(trimmed);
        if (scheduled) {
          scheduleTerminalCommandFromChat(nextAttachedTerminals, scheduled.command, scheduled.runAt);
          await messageRepo.create({
            chat_id: chatId as ChatId,
            role: 'system',
            parts: [{ kind: 'text', text: `Scheduled terminal message for ${new Date(scheduled.runAt).toLocaleString()}: ${scheduled.command}` }],
          });
          setText('');
          setAttachedTerminals([]);
          setMentionCtx(null);
          toast.success('Terminal message scheduled', new Date(scheduled.runAt).toLocaleString());
          return;
        }
      }
      // Repo stamps id + timestamps + bumps parent chat.updated_at.
      // The runtime listener (started in App.tsx) will read history
      // from the same store after we dispatch the event below ������ so it
      // sees the user turn we just wrote and skips creating its own
      // user message. (See runtime.ts: prior versions wrote a second
      // copy here, producing the duplicate-bubble bug surfaced in the
      // AI-router audit.)
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'user',
        parts: [
          { kind: 'text', text: trimmed || 'Attached context.' },
          ...attachedFiles.map((path) => ({ kind: 'file_ref' as const, ref: { kind: 'file' as const, id: path } })),
          ...nextAttachedTerminals.map((ref) => ({ kind: 'file_ref' as const, ref: { kind: 'memory' as const, id: `terminal:${terminalRefKey(ref)}`, excerpt: `Terminal reference: ${terminalRefLabel(ref)}` } })),
          ...nextAttachedContexts.map((context) => ({ kind: 'file_ref' as const, ref: { kind: 'memory' as const, id: `context:${context.nodeId}`, excerpt: `Context: ${context.title}` } })),
        ],
      });

      const mentionedAgentIds = extractMentionedAgentIds(trimmed, agents);
      const mentionedPluginIds = extractPluginMentions(trimmed, PLUGIN_CATALOG);
      const pluginIds = Array.from(new Set([...nextAttachedPlugins, ...mentionedPluginIds])).slice(0, 8);
      const messageFilePaths = Array.from(
        new Set([...attachedFiles, ...extractAbsoluteFilePaths(trimmed)]),
      ).slice(0, 8);
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: {
            chatId,
            text: trimmed || 'Attached context.',
            mentionedAgentIds,
            filePaths: messageFilePaths,
            terminalRefs: nextAttachedTerminals,
            contextNodes: nextAttachedContexts,
            pluginIds,
            skillIds,
            speakReply: voiceReplyRequestedRef.current || useAuthStore.getState().speakReplies,
            autoApproveActions: useAuthStore.getState().jarvisAutoApprove,
          },
        }),
      );
      voiceReplyRequestedRef.current = false;
      setText('');
      setAttachedFiles([]);
      setAttachedTerminals([]);
      setAttachedPlugins([]);
      setAttachedContexts([]);
      setMentionCtx(null);
    } catch (err) {
      // Anything thrown here (DB error, mention extraction edge case,
      // even an exception from the dispatch listener) used to bubble
      // up as an unhandled rejection because the caller is
      // `void handleSend()`. React error boundaries don't catch
      // event-handler errors, so the previous behaviour was a blank
      // window with a console message no user would ever read.
      // Surface the failure as a toast and keep the composer usable;
      // the draft text is preserved so the user can retry.
      // eslint-disable-next-line no-console
      console.error('[Composer] send failed:', err);
      toast.error(
        "Couldn't send message",
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mod+Enter always sends, regardless of any popover state
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
      return;
    }

    // Model picker navigation
    if (modelPickerOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setModelPickerOpen(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        modelPickerRef.current?.moveDown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        modelPickerRef.current?.moveUp();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        modelPickerRef.current?.selectCurrent();
        return;
      }
    }

    // Option picker navigation (highest priority when showing)
    if (optionPickerCtx) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOptionPickerCtx(null);
        setSelectedOptionId('');
        return;
      }
      if (optionPickerOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          optionPickerRef.current?.moveDown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          optionPickerRef.current?.moveUp();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          optionPickerRef.current?.selectCurrent();
          return;
        }
      }
    }

    // Slash command navigation (higher priority than mention)
    if (slashCtx) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashCtx(null);
        return;
      }
      if (filteredSlashCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashTypeaheadRef.current?.moveDown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashTypeaheadRef.current?.moveUp();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          slashTypeaheadRef.current?.selectCurrent();
          return;
        }
      }
    }

    // Mention navigation
    if (mentionCtx) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionCtx(null);
        return;
      }
      if (filteredAgents.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const i = filteredAgents.findIndex((a) => a.slug === selectedSlug);
          const next = filteredAgents[(i + 1 + filteredAgents.length) % filteredAgents.length]!;
          setSelectedSlug(next.slug);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const i = filteredAgents.findIndex((a) => a.slug === selectedSlug);
          const baseI = i === -1 ? 0 : i;
          const next =
            filteredAgents[(baseI - 1 + filteredAgents.length) % filteredAgents.length]!;
          setSelectedSlug(next.slug);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const agent =
            filteredAgents.find((a) => a.slug === selectedSlug) ?? filteredAgents[0];
          if (agent) insertMention(agent);
          return;
        }
      }
    }
  };

  const canSend = (text.trim().length > 0 || attachedFiles.length > 0 || attachedTerminals.length > 0 || attachedPlugins.length > 0 || attachedContexts.length > 0 || confirmedCommands.length > 0) && !sending;

  const addDroppedPath = useCallback((path: string) => {
    const clean = path.trim();
    if (!clean) return;
    setAttachedFiles((cur) => (cur.includes(clean) ? cur : [...cur, clean]).slice(0, 8));
    setText((cur) => {
      const separator = cur.length === 0 || /\s$/.test(cur) ? '' : ' ';
      return `${cur}${separator}${clean}`;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    const onAttachFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.path) addDroppedPath(detail.path);
    };
    window.addEventListener('jarvis:file:attach', onAttachFile as EventListener);
    return () => window.removeEventListener('jarvis:file:attach', onAttachFile as EventListener);
  }, [addDroppedPath, chatId]);

  const addDroppedTerminal = useCallback((raw: string | TerminalRef) => {
    const ref = typeof raw === 'string' ? parseTerminalRef(raw) : raw;
    if (!ref) return;
    const key = terminalRefKey(ref);
    setAttachedTerminals((cur) => (cur.some((item) => terminalRefKey(item) === key) ? cur : [...cur, ref]).slice(0, 8));
    setText((cur) => cur || `Please inspect the attached terminal: ${terminalRefLabel(ref)}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const addDroppedContext = useCallback((raw: string | ContextAttachment) => {
    const context = typeof raw === 'string' ? parseContextAttachment(raw) : raw;
    if (!context) return;
    setAttachedContexts((cur) => (
      cur.some((item) => item.nodeId === context.nodeId)
        ? cur
        : [...cur, context].slice(0, 8)
    ));
    setText((cur) => cur || `Please use the attached Context: ${context.title}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    const onAttachTerminal = (event: Event) => {
      const detail = (event as CustomEvent<{ raw?: string; ref?: TerminalRef; chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.ref) addDroppedTerminal(detail.ref);
      else if (detail?.raw) addDroppedTerminal(detail.raw);
    };
    window.addEventListener('jarvis:terminal:attach', onAttachTerminal as EventListener);
    return () => window.removeEventListener('jarvis:terminal:attach', onAttachTerminal as EventListener);
  }, [addDroppedTerminal, chatId]);

  useEffect(() => {
    const onAttachContext = (event: Event) => {
      const detail = (event as CustomEvent<{ raw?: string; context?: ContextAttachment; chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.context) addDroppedContext(detail.context);
      else if (detail?.raw) addDroppedContext(detail.raw);
    };
    window.addEventListener('jarvis:context:attach', onAttachContext as EventListener);
    return () => window.removeEventListener('jarvis:context:attach', onAttachContext as EventListener);
  }, [addDroppedContext, chatId]);

  useEffect(() => {
    const onInsertText = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.text) {
        setText((cur) => {
          const separator = cur.length === 0 || /\s$/.test(cur) ? '' : ' ';
          return cur + separator + detail.text;
        });
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener('jarvis:composer:insert-text', onInsertText as EventListener);
    return () => window.removeEventListener('jarvis:composer:insert-text', onInsertText as EventListener);
  }, [chatId]);

  // ---------- V2 ������ speech-to-text wiring ----------
  // Subscribe to VoiceService events when the user toggles STT on. We keep
  // partials in a separate state so they show as a faded preview without
  // mutating the saved draft until they finalize.
  useEffect(() => {
    if (!sttListening) return;

    const offStart = VoiceService.on('voice:start', () => {
      // intentionally empty ������ UI already reflects sttListening=true
    });
    const offPartial = VoiceService.on('voice:partial', ({ text: partial }) => {
      setSttInterim(partial);
    });
    const offFinal = VoiceService.on('voice:final', ({ text: finalText }) => {
      setSttInterim('');
      voiceReplyRequestedRef.current = true;
      setText((cur) => {
        // Append with a space if needed so each utterance flows naturally.
        const sep = cur.length === 0 || /\s$/.test(cur) ? '' : ' ';
        return cur + sep + finalText;
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    });
    const offError = VoiceService.on('voice:error', ({ kind, message }) => {
      setSttListening(false);
      setSttInterim('');
      stopWebSpeechVolumeMeter();
      if (kind === 'unsupported') {
        toast.warning('Voice unsupported', message);
      } else if (kind === 'service_not_allowed' || kind === 'permission_denied') {
        toast.error('Microphone blocked', 'Allow mic access in your browser/OS settings.');
      } else if (kind !== 'no_speech' && kind !== 'aborted') {
        toast.error('Voice error', message);
      }
    });
    const offEnd = VoiceService.on('voice:end', () => {
      // Engine ended ������ sync our flag if the user didn't already turn off.
      if (!VoiceService.isListening() && !VoiceService.wantsListening()) {
        setSttListening(false);
        stopWebSpeechVolumeMeter();
      }
    });
    const offTimeout = VoiceService.on('voice:timeout', ({ reason }) => {
      setSttListening(false);
      setSttInterim('');
      stopWebSpeechVolumeMeter();
      toast.info('Speech-to-text stopped', reason);
    });

    return () => {
      offStart();
      offPartial();
      offFinal();
      offError();
      offEnd();
      offTimeout();
    };
  }, [sttListening]);

  const startWebSpeechVolumeMeter = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      webSpeechStreamRef.current = stream;
      const AudioCtor = getAudioContextCtor();
      if (!AudioCtor) return;
      const context = new AudioCtor();
      webSpeechAudioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      webSpeechAnalyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!webSpeechAnalyserRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        volumeRef.current = Math.min(1, avg / 60);
        webSpeechVolumeTimerRef.current = requestAnimationFrame(updateVolume);
      };
      webSpeechVolumeTimerRef.current = requestAnimationFrame(updateVolume);
    } catch (err) {
      console.warn('[Composer] Web Speech volume meter failed to start', err);
    }
  };

  const stopWebSpeechVolumeMeter = () => {
    if (webSpeechVolumeTimerRef.current) {
      cancelAnimationFrame(webSpeechVolumeTimerRef.current);
      webSpeechVolumeTimerRef.current = null;
    }
    if (webSpeechAudioContextRef.current) {
      void webSpeechAudioContextRef.current.close().catch(() => {});
      webSpeechAudioContextRef.current = null;
    }
    if (webSpeechStreamRef.current) {
      webSpeechStreamRef.current.getTracks().forEach((t) => t.stop());
      webSpeechStreamRef.current = null;
    }
    webSpeechAnalyserRef.current = null;
    volumeRef.current = 0;
  };

  const startStt = () => {
    if (getComposerSttProvider() === 'faster-whisper') {
      void startFasterWhisperStt();
      return;
    }
    void startSystemStt();
  };

  const startSystemStt = async () => {
    if (isSystemSttAvailable()) {
      try {
        setSttInterim('Listening with built-in speech recognition...');
        const started = VoiceService.startListening();
        if (!started) {
          setSttListening(false);
          setSttInterim('');
          await trySystemSttFallbacks();
          return;
        }
        setSttListening(true);
        void startWebSpeechVolumeMeter();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Voice could not start.';
        toast.error('Voice error', msg);
        setSttListening(false);
        setSttInterim('');
      }
      return;
    }
    await trySystemSttFallbacks();
  };

  const trySystemSttFallbacks = async () => {
    if (isTauri) {
      const triggered = await triggerWindowsNativeDictation();
      if (triggered) {
        toast.info('Windows voice typing', 'Speak now   Windows will type into the composer.');
        return;
      }
    }
    const groqKey = useAuthStore.getState().apiKeys.groq;
    if (groqKey && typeof navigator.mediaDevices?.getUserMedia === 'function' && getAudioContextCtor()) {
      void startGroqStt(groqKey);
      return;
    }
    toast.warning(
      'Voice unsupported',
      'Free built-in speech recognition is not available. Add a Groq key or download a local model in Settings ��! Speech to Text.',
    );
  };

  const startFasterWhisperStt = async () => {
    const modelId = getFasterWhisperModel();
    const installed = isTauri ? await FasterWhisperManager.checkInstalled(modelId) : false;
    if (!installed) {
      toast.warning(
        'Local model missing',
        `Download the ${modelId} model in Settings ��! Speech to Text, or switch to system dictation.`,
      );
      void startSystemStt();
      return;
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || !getAudioContextCtor()) {
      toast.warning('Microphone unavailable', 'Could not access the microphone for local dictation.');
      void startSystemStt();
      return;
    }
    try {
      setSttInterim(`Listening with faster-whisper (${modelId})...`);
      batchRecorderRef.current = await startBatchAudioRecorder(
        (rms) => { volumeRef.current = rms; },
        () => { void stopBatchStt(true); },
      );
      setSttListening(true);
    } catch (err) {
      setSttListening(false);
      setSttInterim('');
      toast.error('Voice error', err instanceof Error ? err.message : 'Could not start microphone.');
      void startSystemStt();
    }
  };

  const appendTranscript = (finalText: string) => {
    if (!finalText) return;
    voiceReplyRequestedRef.current = true;
    setText((cur) => {
      const sep = cur.length === 0 || /[ 	]$/.test(cur) ? '' : ' ';
      return cur + sep + finalText;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const stopBatchStt = async (fromInactivity = false) => {
    clearAudioSilenceTimer();
    stopWebSpeechVolumeMeter();
    volumeRef.current = 0;
    const recorder = batchRecorderRef.current;
    batchRecorderRef.current = null;
    const wav = recorder?.captureWav() ?? null;
    recorder?.stop();
    setSttListening(false);
    if (!wav || wav.size === 0) {
      setSttInterim('');
      if (!fromInactivity) {
        toast.warning('No speech captured', 'Try again and speak for at least one second.');
      } else {
        toast.info('Speech-to-text stopped', 'Stopped after 30 seconds without voice activity.');
      }
      return;
    }
    setSttInterim('Transcribing...');
    try {
      const text = await transcribeFasterWhisper(wav, getFasterWhisperModel());
      appendTranscript(text);
    } catch (err) {
      toast.error(
        'Local transcription failed',
        err instanceof Error ? err.message : 'Falling back to system dictation.',
      );
      void startSystemStt();
    } finally {
      setSttInterim('');
    }
  };

  const startGroqStt = async (apiKey: string) => {
    try {
      setSttInterim('Listening with Groq Whisper...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      wavChunksRef.current = [];
      const AudioCtor = getAudioContextCtor();
      if (!AudioCtor) throw new Error('Audio recording is not available in this runtime.');
      const context = new AudioCtor();
      const source = context.createMediaStreamSource(stream);
      // Use smaller buffer for lower latency ������ 2048 samples at 44.1kHz ������ 46ms
      // instead of 4096 samples at ~92ms. Shorter buffers mean faster activity
      // detection and smoother waveform updates.
      const processor = context.createScriptProcessor(2048, 1, 1);
      audioContextRef.current = context;
      audioSourceRef.current = source;
      audioProcessorRef.current = processor;
      lastAudioActivityRef.current = Date.now();
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < channel.length; i += 1) {
          const sample = channel[i] ?? 0;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / Math.max(1, channel.length));
        if (rms > STT_ACTIVITY_RMS) {
          lastAudioActivityRef.current = Date.now();
        }
        volumeRef.current = Math.min(1, rms * 8);
        wavChunksRef.current.push(new Float32Array(channel));
      };
      source.connect(processor);
      processor.connect(context.destination);
      clearAudioSilenceTimer();
      audioSilenceTimerRef.current = setInterval(() => {
        if (Date.now() - lastAudioActivityRef.current >= STT_INACTIVITY_MS) {
          stopGroqSttWithoutTranscribing();
        }
      }, 1000);
      setSttListening(true);
    } catch (err) {
      clearAudioSilenceTimer();
      cleanupAudioRecorder(audioProcessorRef.current, audioSourceRef.current, audioContextRef.current, mediaStreamRef.current);
      audioProcessorRef.current = null;
      audioSourceRef.current = null;
      audioContextRef.current = null;
      mediaStreamRef.current = null;
      setSttListening(false);
      setSttInterim('');
      toast.error('Voice error', err instanceof Error ? err.message : 'Could not start microphone.');
    }
  };

  const transcribeGroq = async (blob: Blob, apiKey: string) => {
    if (blob.size === 0 || !apiKey) return;
    setSttInterim('Transcribing...');
    try {
      const finalText = await transcribeGroqApi(blob, apiKey);
      appendTranscript(finalText);
    } catch (err) {
      toast.error('Groq transcription failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSttListening(false);
      setSttInterim('');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const stopStt = () => {
    if (batchRecorderRef.current) {
      void stopBatchStt(false);
      return;
    }
    setSttListening(false);
    setSttInterim('');
    clearAudioSilenceTimer();
    stopWebSpeechVolumeMeter();
    volumeRef.current = 0;
    if (audioContextRef.current || audioProcessorRef.current || audioSourceRef.current) {
      const context = audioContextRef.current;
      const chunks = wavChunksRef.current;
      cleanupAudioRecorder(audioProcessorRef.current, audioSourceRef.current, context, mediaStreamRef.current);
      audioProcessorRef.current = null;
      audioSourceRef.current = null;
      audioContextRef.current = null;
      mediaStreamRef.current = null;
      wavChunksRef.current = [];
      if (chunks.length > 0 && context) {
        void transcribeGroq(encodeWav(chunks, context.sampleRate), useAuthStore.getState().apiKeys.groq ?? '');
      } else {
        toast.warning('No speech captured', 'Try again and speak for at least one second.');
      }
      return;
    }
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    try {
      VoiceService.stopListening();
    } catch {
      // ignore ������ engine may already be torn down
    }
  };

  const toggleStt = () => {
    if (sttListening) stopStt();
    else startStt();
  };

  // Stop listening when the chat unmounts/changes.
  useEffect(() => {
    return () => {
      if (sttListening) VoiceService.stopListening();
      clearAudioSilenceTimer();
      stopWebSpeechVolumeMeter();
      volumeRef.current = 0;
      cleanupAudioRecorder(audioProcessorRef.current, audioSourceRef.current, audioContextRef.current, mediaStreamRef.current);
    };
  }, [sttListening]);

  // Ctrl+CapsLock is dispatched globally; only the focused composer consumes it.
  useEffect(() => {
    const onToggle = (event: Event) => {
      if (!composerSttEnabled) return;
      if (document.activeElement !== textareaRef.current) return;
      event.preventDefault?.();
      toggleStt();
    };
    window.addEventListener('jarvis:stt:toggle', onToggle);
    return () => window.removeEventListener('jarvis:stt:toggle', onToggle);
  }, [composerSttEnabled, sttListening]);

  return (
    <div className={cn('border-t border-border bg-panel', compact && 'text-[12px]')}>
      {showFreeKeyNudge && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 pt-2.5',
            'text-secondary text-muted-foreground',
          )}
          role="status"
          aria-label="Free Gemini API key recommended for the Jarvis agent"
        >
          <Sparkles className="h-3.5 w-3.5 text-accent-copper shrink-0" />
          <span>
            Add a free Gemini API key to give Jarvis a real Flash Lite
            brain (no card needed).
          </span>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="text-accent-copper underline-offset-4 hover:underline"
          >
            Get key ������
          </a>
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              // Wait one task so the SettingsModal commits open=true and
              // attaches its tab-switch listener before we dispatch.
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent('jarvis:settings:tab', {
                    detail: { tab: 'providers' },
                  }),
                );
              }, 0);
            }}
            className="ml-auto text-accent-copper underline-offset-4 hover:underline"
          >
            Open Providers
          </button>
        </div>
      )}
      <div className="px-3 py-2.5">
        <Popover
          open={mentionCtx !== null || slashCtx !== null || optionPickerCtx !== null}
          onOpenChange={(open) => {
            if (!open) {
              setMentionCtx(null);
              setSlashCtx(null);
              setOptionPickerCtx(null);
            }
          }}
        >
          <PopoverAnchor asChild>
            <div
              data-terminal-drop="chat"
              data-terminal-drop-chat-id={String(chatId)}
              className={cn(
                'rounded-lg border border-input bg-background',
                'transition-colors focus-within:border-accent-cyan/40 focus-within:ring-1 focus-within:ring-ring',
              )}
            >
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value);
                  // Recompute on next tick so selectionStart reflects the new value
                  requestAnimationFrame(() => {
                    recomputeMention();
                    recomputeSlash();
                  });
                }}
                onKeyDown={onKeyDown}
                onKeyUp={() => {
                  recomputeMention();
                  recomputeSlash();
                }}
                onClick={() => {
                  recomputeMention();
                  recomputeSlash();
                }}
                onDragOver={(e) => {
                  if (getChatDragKind(e.dataTransfer.types)) {
                    e.preventDefault();
                    setDragOver(true);
                  }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  const payload = getChatDropPayload(e.dataTransfer);
                  if (!payload) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(false);
                  if (payload.kind === 'context') addDroppedContext(payload.raw);
                  else if (payload.kind === 'terminal') addDroppedTerminal(payload.raw);
                  else addDroppedPath(payload.path);
                }}
                placeholder={placeholder ?? 'Message Jarvis...   (use @ to mention an agent)'}
                aria-label="Message"
                style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
                className={cn(
                  'block w-full resize-none bg-transparent px-3 py-2 text-body text-foreground',
                  'placeholder:text-muted-foreground outline-none',
                  'scrollbar-hidden',
                  compact && 'px-2 py-1.5 text-secondary',
                  dragOver && 'bg-accent-copper/10 ring-1 ring-accent-copper/50',
                )}
              />
              {/* Confirmed command tokens (purple) */}
              {confirmedCommands.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  <TokenList>
                    {confirmedCommands.map((cmd) => (
                      <InputToken
                        key={cmd.value ? `${cmd.cmd}:${cmd.value}` : cmd.cmd}
                        type="command"
                        label={cmd.label}
                        onRemove={() => removeConfirmedCommand(cmd.cmd, cmd.value)}
                      />
                    ))}
                  </TokenList>
                </div>
              )}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedFiles.map((path) => (
                    <InputToken
                      key={path}
                      type="file"
                      label={path.split(/[/\\]/).pop() ?? path}
                      sublabel={path.includes('/') || path.includes('\\') ? '...' : undefined}
                      onRemove={() => setAttachedFiles((cur) => cur.filter((p) => p !== path))}
                    />
                  ))}
                </div>
              )}
              {attachedTerminals.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedTerminals.map((ref) => (
                    <InputToken
                      key={terminalRefKey(ref)}
                      type="terminal"
                      label={terminalRefLabel(ref)}
                      onRemove={() => setAttachedTerminals((cur) => cur.filter((p) => terminalRefKey(p) !== terminalRefKey(ref)))}
                    />
                  ))}
                </div>
              )}
              {attachedPlugins.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedPlugins.map((pluginId) => {
                    const plugin = PLUGIN_CATALOG.find((entry) => entry.id === pluginId);
                    return (
                      <InputToken
                        key={pluginId}
                        type="plugin"
                        label={plugin?.name ?? pluginId}
                        icon={plugin ? <PluginLogo plugin={plugin} size="sm" className="!h-5 !w-5" /> : undefined}
                        onRemove={() => setAttachedPlugins((cur) => cur.filter((id) => id !== pluginId))}
                      />
                    );
                  })}
                </div>
              )}
              {attachedContexts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedContexts.map((context) => (
                    <InputToken
                      key={context.nodeId}
                      type="contextmap"
                      label={context.title}
                      onRemove={() => setAttachedContexts((cur) => cur.filter((item) => item.nodeId !== context.nodeId))}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
                <ModelPicker
                  provider={provider}
                  model={
                    chatModelReady
                      ? selectedModels[provider] ||
                        defaultModelForProvider(provider, defaultLocalModel)
                      : ''
                  }
                  modelReady={chatModelReady}
                  open={modelPickerOpen}
                  onOpenChange={setModelPickerOpen}
                  pickerRef={modelPickerRef}
                  onChange={(nextProvider, nextModel) => {
                    setDefaultProvider(nextProvider);
                    setSelectedModel(nextProvider, nextModel);
                    if (nextProvider === 'ollama' || nextProvider === 'local') {
                      selectLocalModelForChat(nextModel);
                    }
                  }}
                />
                <StackPicker />
                {composerSttEnabled && (
                  <Hint
                    label={sttListening ? 'Stop dictation' : 'Voice to text'}
                    hotkey={HOTKEYS.COMPOSER_STT}
                  >
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={sttListening ? 'accent' : 'ghost'}
                      onClick={toggleStt}
                      aria-label={sttListening ? 'Stop dictation' : 'Start dictation'}
                      aria-pressed={sttListening}
                      className={cn(sttListening && 'animate-pulse')}
                    >
                      {sttListening ? <MicWaveform volumeRef={volumeRef} /> : <Mic />}
                    </Button>
                  </Hint>
                )}
                <span className="text-metadata text-muted-foreground ml-auto mr-1 hidden sm:inline">
                  {sttListening && sttInterim ? (
                    <span className="italic text-foreground/70" aria-live="polite">
                      {sttInterim}
                    </span>
                  ) : (
                    <>
                      <span className="kbd">{renderHotkey(HOTKEYS.SEND)}</span> to send
                    </>
                  )}
                </span>
                <Hint label="Send" hotkey={HOTKEYS.SEND}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={canSend ? 'accent' : 'ghost'}
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    aria-label="Send message"
                  >
                    <Send />
                  </Button>
                </Hint>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-auto p-0 max-h-[280px] overflow-hidden bg-transparent border-none shadow-none"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              // Keep the popover open while the user is interacting with the textarea
              if (textareaRef.current && textareaRef.current.contains(e.target as Node)) {
                e.preventDefault();
              }
            }}
          >
            {optionPickerCtx !== null ? (
              <SlashCommandOptionPicker
                ref={optionPickerRef}
                commandLabel={optionPickerCtx.cmd.cmd}
                commandIcon={optionPickerCtx.cmd.icon}
                options={optionPickerOptions}
                selectedId={selectedOptionId}
                query={optionPickerCtx.query}
                onHoverId={setSelectedOptionId}
                onSelect={selectOption}
              />
            ) : slashCtx !== null ? (
              <SlashCommandTypeahead
                ref={slashTypeaheadRef}
                commands={filteredSlashCommands}
                selectedCmd={selectedSlashCmd}
                query={slashCtx.query}
                onHoverCmd={setSelectedSlashCmd}
                onSelect={insertSlashCommand}
              />
            ) : (
              <MentionTypeahead
                agents={filteredAgents}
                selectedSlug={selectedSlug}
                query={mentionCtx?.query ?? ''}
                onHoverSlug={setSelectedSlug}
                onSelect={insertMention}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

interface ModelPickerProps {
  provider: ProviderId;
  model: string;
  modelReady: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (provider: ProviderId, model: string) => void;
  pickerRef: React.RefObject<ModelPickerTypeaheadRef | null>;
}

function ModelPicker({
  provider,
  model,
  modelReady,
  open,
  onOpenChange,
  onChange,
  pickerRef,
}: ModelPickerProps) {
  const { groups, flatOptions, hasAny } = useAccessibleChatModels();
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void import('@/lib/ai/providers/ollama').then(({ listOllamaModels, isOllamaReachable }) =>
      isOllamaReachable().then((connected) => {
        if (!connected || cancelled) return;
        return listOllamaModels().then((models) => {
          if (!cancelled) syncDiscoveredOllamaModels(models);
        });
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const activeId = modelReady ? `${provider}:${model}` : '';
    if (activeId && flatOptions.some((option) => option.id === activeId)) {
      setSelectedId(activeId);
      return;
    }
    setSelectedId(flatOptions[0]?.id ?? '');
  }, [open, provider, model, modelReady, flatOptions]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        pickerRef.current?.moveDown();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        pickerRef.current?.moveUp();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        pickerRef.current?.selectCurrent();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange, pickerRef]);

  const handleSelect = (nextProvider: ProviderId, nextModel: string) => {
    onChange(nextProvider, nextModel);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1 px-2 text-muted-foreground hover:text-foreground"
          aria-label="Choose model"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="text-metadata">
            {modelReady && model
              ? `${PROVIDER_LABELS[provider]} / ${model}`
              : hasAny
                ? 'Choose model'
                : 'No model selected'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ModelPickerTypeahead
          ref={pickerRef as React.Ref<ModelPickerTypeaheadRef>}
          groups={groups}
          selectedId={selectedId}
          activeProvider={modelReady ? provider : undefined}
          activeModel={modelReady ? model : undefined}
          onHoverId={setSelectedId}
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  );
}
