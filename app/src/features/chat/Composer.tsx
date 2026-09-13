import { openQueuedSideChat, registerQueueSideSender } from './queueSideChat';
import { useComposerQueueSession } from './composerQueueSession';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AxoMotion } from '@/components/ui/AxoMotion';
import './composer-frame.css';
import { useChatBackendAffinity } from './useChatBackendAffinity';
import { NotesPicker, type NotesPickerHandle } from '../notes/NotesPicker';
import {
  useNoteScope,
  useNotesWorkspace,
  currentNoteScope,
  getNotesWorkspace,
  openNoteReference,
} from '../notes/notesRuntime';
import {
  findNotesCommand,
  removeNotesCommand,
  mergeNoteReferences,
  buildNoteContextAttachments,
  verifyNotesContextCapacity,
  type NotesCommandSpan,
} from '../notes/notesReferences';
import {
  noteReference,
  noteReferenceKey,
  sameNoteScope,
  type NoteReference,
  type NoteSummary,
} from '../notes/notesContracts';
import {
  checkpointNotesComposer,
  notesComposerKey,
  readNotesComposerDraft,
} from '../notes/notesComposerDraft';
import {
  Send,
  Play,
  Pause,
  ChevronDown,
  Sparkles,
  Mic,
  MicOff,
  FileText,
  X,
  Network,
  Terminal,
} from 'lucide-react';
import { HiveModelIcon } from '@/components/brand';
import { PLUGIN_CATALOG } from '@/features/plugins/catalog';
import { extractPluginMentions } from '@/features/plugins/mentions';
import { PluginLogo } from '@/features/plugins/PluginLogo';
import { selectPluginConnectionsForAccount, usePluginStore } from '@/features/plugins/store';
import type { PluginConnection } from '@/features/plugins/types';
import { requestOpenMcpManager } from '@/features/plugins/openMcpManager';
import { jarvisMcpServerManager } from '@/lib/mcp/serverManager';
import {
  Button,
  Hint,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui';
import { chatRepo, messageRepo, projectRepo, taskRepo, terminalSessionRepo, workspaceRepo } from '@/lib/db';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { getCurrentSyncQueueAuthorityScope } from '@/lib/cloudSyncQueueOwner';
import { cn, isTauri, renderHotkey } from '@/lib/utils';
import { playComposerKeySound, playUiSound } from '@/lib/sfx';
import { formatUserDateTime } from '@/lib/timeFormat';
import { HOTKEYS, matchesHotkey, resolveHotkey } from '@/lib/hotkeys';
import {
  getAllUsage,
  getUsage,
  parseUsageSlashCommand,
  refreshUsage,
  resolveUsageConnection,
} from '@/lib/usage/usageService';
import { useAgentStore } from '@/stores/agents';
import { findProtectedJarvisAgent } from '@/lib/jarvis/identity';
import { requestsReadOnlyContextTool } from '@/lib/jarvis/contextToolIntent';
import { parseJarvisModelSwitchIntent } from '@/lib/jarvis/modelSwitchDecision';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { parseThemeCommandArgument, SELECTABLE_THEMES } from '@/features/appearance/themes';
import {
  CHAT_ENGINE_OPTIONS,
  storedChatEngine,
  transitionChatEngine,
} from '@/features/browser-chat/chatEngineTransition';
import {
  CONSOLE_PROFILES,
  loadConsolePreferences,
  parseChatPresentationCommand,
  updateConsolePreferences,
} from './agentic-console/preferences';
import { MicWaveform } from './MicWaveform';
import { formatComposerSendFailure } from './composerSendFailures';
import { HarnessReadinessGate, useHarnessRuntimeState } from './HarnessReadinessGate';
import { CodexReadinessGate, useCodexRuntimeState } from './CodexReadinessGate';
import { runVibeSpaceDoctor } from '@/features/doctor/vibeSpaceDoctor';

export function getThemeCommandHelp(): string {
  return `Chat console themes: ${CONSOLE_PROFILES.map((theme) => theme.label).join(', ')}. Use /theme <name>.`;
}

export function getAppearanceCommandHelp(): string {
  return `Available appearances: ${SELECTABLE_THEMES.map((theme) => theme.label).join(', ')}. Use /appearance to choose.`;
}

interface SlashComboboxMetadata {
  readonly listboxId: string;
  readonly activeDescendantId?: string;
}

interface SlashComboboxOwnerAttributes {
  readonly role?: 'combobox';
  readonly 'aria-controls'?: string;
  readonly 'aria-expanded'?: true;
  readonly 'aria-activedescendant'?: string;
  readonly 'aria-autocomplete'?: 'list';
}

export function slashComboboxOwnerAttributes(
  open: boolean,
  metadata: SlashComboboxMetadata | null,
): SlashComboboxOwnerAttributes {
  if (!open || !metadata) return {};
  return {
    role: 'combobox',
    'aria-controls': metadata.listboxId,
    'aria-expanded': true,
    'aria-activedescendant': metadata.activeDescendantId,
    'aria-autocomplete': 'list',
  };
}
import {
  COMPOSER_STT_STOP_EVENT, COMPOSER_STT_TOGGLE_EVENT,
  getComposerSttProvider, getFasterWhisperModel,
  sttVolumeRef, setSttVolumeLevel, resolveComposerSttTextarea,
} from '@/features/composer-stt';
import { readDeepgramSttOption } from '@/lib/deepgram';
import { createComposerDictationController } from '@/features/composer-stt/composerDictationController';
import { JARVIS_COMMAND_CATALOG } from '@/features/assistant/commands';
import { toast } from '@/components/ui/toast';
import type {
  Agent,
  AgentId,
  Chat,
  ChatId,
  Message,
  ProjectId,
  ProviderId,
  TerminalSessionId,
  WorkspaceId,
} from '@/types';
import { getChatActivityEvents, useChatActivityStore } from './activity/activityStore';
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
  parseContextAttachment,
  contextMapSlashOptions,
  resolveContextMapRecord,
  type ContextAttachment,
  type ContextMapRecord,
} from '@/features/context/tree';
import {
  ensureContextPersistence,
  getActiveContextPersistenceState,
} from '@/features/context/contextPersistence';
import {
  buildMapSummaryChatAttachment,
  contextAttachmentTokenView,
  contextChatAttachmentKey,
  contextChatAttachmentMatchesProject,
  normalizeContextChatAttachment,
  type ContextChatAttachment,
} from '@/features/context/contextChatIntegration';
import { MentionTypeahead } from './MentionTypeahead';
import {
  buildAccountReferenceCatalog,
  filterReferenceCatalog,
  type ReferenceCatalogEntry,
} from '@/features/references/referenceCatalog';
import {
  CAO_LEARNER_IDENTITY,
  bootstrapCaoLearning,
  projectCaoPublicStatus,
  type CaoBootstrapDecision,
  type CaoPublicStatus,
  type CaoLearnerExecutionIdentity,
} from '@/features/cao/bootstrap';
import {
  resolveCaoControlTargets,
  type CaoControlCandidate,
  type CaoControlScope,
} from '@/features/cao/controlCommand';
import type { JarvisArtifactV1 } from '@/lib/jarvis/contracts/execution';
import { jarvisArtifactRepo } from '@/lib/db/jarvisRepositories';
import {
  SlashCommandTypeahead,
  getVisibleSlashCommands,
  resolveSlashCommandSelection,
  findSlashCommandDef,
  isChatAttachSlashCmd,
  isImmediateLocalSlashCommand,
  normalizeSlashCmd,
  slashCmdMatchScore,
  type SlashCommandDef,
  type SlashCommandTypeaheadRef,
} from './SlashCommandTypeahead';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import {
  SlashCommandOptionPicker,
  type SlashCommandOption,
  type SlashCommandOptionPickerRef,
} from './SlashCommandOptionPicker';
import {
  ConsoleThemeSlashPicker,
  ThemeSlashPicker,
  isGlobalThemePickerCommand,
  type ThemeSlashPickerRef,
} from './themeSlashPicker';
import {
  ModelPickerTypeahead,
  HIVE_OPTION_ID,
  type ModelPickerTypeaheadRef,
} from './ModelPickerTypeahead';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { browserTokenOptimizationPreferences } from '@/features/token-optimizer';
import { InputToken, TokenList } from './InputToken';

import {
  extractInlineUtilitySlashCommands,
  getInlineSlashContext,
  isSafeAbsoluteAttachmentPath,
  listProjectFileOptions,
} from './slashProjectFiles';
import { buildVibeSpaceReferenceRequest, classifySlashCommand } from './slashCommandRouting';
import {
  isComposerInstantCommandSource,
  submitComposerInstantCommand,
} from './composerInstantCommand';
import {
  formatRlmStatus,
  markRlmIndexRefreshed,
  parseRlmSlashArgument,
  resolveRlmEnabled,
  RLM_SLASH_OPTIONS,
  setChatRlmEnabled,
} from '@/features/context/rlmPreferenceStore';
import {
  clearRedoStack,
  NOTHING_TO_REDO_TEXT,
  NOTHING_TO_UNDO_TEXT,
  popRedoTurn,
  pushRedoTurn,
  REDO_STATUS_TEXT,
  selectLastUndoableTurn,
  summarizeUndoTurn,
  REDO_BLOCKED_RUNNING_TEXT,
  UNDO_BLOCKED_RUNNING_TEXT,
  UNDO_STATUS_TEXT,
} from './chatUndoRedo';
import {
  MEDIA_ATTACH_EVENT,
  getChatDragKind,
  getChatDropPayload,
  hasOsFileDrag,
  type MediaAttachDetail,
} from './dropPayload';
import {
  CHAT_SEND_CONTEXT_EVENT,
  VIBESPACE_CHAT_MIME,
  readChatDragPayload,
  resolveAcceptedChatDrop,
  type ChatDragPayloadV1,
} from './chatDragPayload';
import {
  projectChatHandoff,
  renderChatHandoffPrompt,
  sanitizeChatHandoffText,
  type ChatHandoffProjectionV1,
} from './chatHandoffProjection';
import { ChatHandoffDraftCard } from './ChatHandoffDraftCard';
import { InlineChatReferenceInput } from './InlineChatReferenceInput';
import { chatReferenceToken, insertChatReference, readableReferenceText } from './inlineChatReference';
import { ComposerMediaStrip } from './ComposerMediaStrip';
import {
  MediaPreviewPanel,
  mediaTargetFromAttachment,
  type MediaPreviewTarget,
} from './MediaPreviewPanel';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import {
  MARKDOWN_DOCUMENT_OPTIONS,
  buildMarkdownCreationInstruction,
  isMarkdownDocumentKind,
  parseMarkdownSlashArgument,
} from './markdownCommand';
import {
  cleanupExpiredOversizedMessageAttachments,
  createChatTextFileAttachment,
  createOversizedMessageAttachment,
  oversizedMessageSummary,
} from './oversizedMessageAttachment';
import {
  MAX_IMAGES_PER_BATCH,
  MAX_VIDEOS_PER_BATCH,
  appendComposerMedia,
  appendComposerMediaResult,
  classifyBrowserFilesForAttach,
  imageAttachmentFromBrowserFile,
  imageAttachmentFromPath,
  readBrowserFileAsText,
  splitImageFiles,
  splitVideoFiles,
  videoAttachmentFromBrowserFile,
  visionAttachmentsForSend,
} from './imageAttachments';
import { getSkillPickerOptions, getAllCatalogSkills } from '@/features/skills/skillCatalog';
import { isSupportedImagePath, type ChatImageAttachment } from '@/lib/ai/vision';
import {
  REAL_CHAT_PROVIDERS,
  selectLocalModelForChat,
  defaultModelForProvider,
  getAccessibleModelOptions,
  getAccessibleProviders,
  useOllamaModelOptions,
} from '@/lib/ai/models';
import {
  useAccessibleChatModels,
  type ModelPickerGroup,
  type ModelPickerOption,
} from '@/lib/ai/useAccessibleChatModels';
import { openCodePersistentAdapter } from '@/lib/ai/adapters/opencodePersistent';
import type { ProviderDiscoveredModel } from '@/lib/ai/adapters/types';
import { getProviderConnectionDescriptor, PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import {
  ALL_ABOUT_ME_SLASH_OPTIONS,
  allAboutMeChatUpdateStatus,
  buildAllAboutMeSlashText,
  type AllAboutMeSlashOptionId,
} from '@/features/all-about-me/slash';
import {
  formatChatModelSelectionLabel,
  modelSelectionContextFromAuth,
  selectionFromHive,
  selectionFromOption,
  selectionOptionId,
  validateSendModelAccess,
  type ChatModelSelection,
  type ModelSelectionContext,
} from '@/lib/ai/modelSelection';
import type {
  ReasoningMode,
  ReasoningPreference,
  ReasoningSelection,
} from '@/lib/ai/reasoningControls';
import { CODEX_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import {
  ChatBackendLockedError,
  type ChatBackend,
} from '@/lib/ai/backend/chatBackend';
import {
  dexieChatBackendPersistence,
  selectPersistedChatBackend,
} from '@/lib/ai/backend/chatBackendPersistence';
import { restoreExactChatSelection, type ExactChatSelection } from './chatSelectionAuthority';
import { ModeIndicator } from '@/features/jarvis-interaction/ModeIndicator';
import { cycleInteractionMode, PERMISSION_MODE_OPTIONS } from '@/features/jarvis-interaction/modes';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import {
  formatPermissionPolicy,
  parsePermissionSlashArg,
  readPermissionAccess,
  setApproveAllForRun,
  setPermissionAccess,
} from '@/features/jarvis-interaction/permissionAccessStore';
import type { JarvisInteractionMode } from '@/features/jarvis-interaction/types';
import { requestNativeDelegation } from '@/features/jarvis-interaction/nativeDelegation';
import { shouldCancelForLiveModeRestriction } from './modeTransitionSafety';
import {
  buildReasoningSlashPickerState,
  parseReasoningEffortArgument,
  parseReasoningModeArgument,
  readChatReasoningPreference,
  writeChatReasoningEffort,
  writeChatReasoningMode,
} from './reasoningSlashStore';
import { listEffortOptions, type EffortLabel } from '@/lib/ai/catalog/modelVariants';
import {
  applyChatRuntimeCommand,
  parseChatRuntimeCommand,
} from './runtime/chatRuntimeCommandController';
import { supportedEffortPreferences } from './runtime/runtimeModelControls';
import { findFastModelRoute } from './runtime/fastRouteSelection';
import {
  clearApproveAllForRun,
  readChatRuntimePolicyState,
  writeChatRuntimePolicyState,
  type ChatRuntimePolicyState,
} from './runtime/chatRuntimeSettingsStore';
import { requestTokenBoss } from './token-boss/events';
import {
  resolveTokenBossProvider,
  type CurrentModelContext,
  type TokenBossProvider,
} from './token-boss/providers';
import {
  buildQueuedMultitaskCommand,
  dispatchQueuedMessageAfterAcceptance,
  QueuedMessagesBar,
  takeNextQueuedMessage,
  type QueuedChatMessage,
  type QueueFlushMode,
} from './QueuedMessagesBar';
import {
  createQueuedMessage,
  describeQueueToast,
  shouldDispatchNextQueuedMessage,
  shouldScheduleQueuedRunFlush,
  shouldFlushOnToolTerminal,
} from './composerQueuePolicy';
import {
  CANCELLED_BY_USER_TOAST,
  createEscapeCancelState,
  recordEscapePress,
  type EscapeCancelState,
} from './composerEscapeCancel';
import { getChatRunState } from './runtime/chatRunState';
import { CaoCommandPanel, type CaoCommandInput } from '@/features/cao/CaoCommandPanel';
import { agentSelectorOptions } from './listLiveChatAgents';
import { openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL } from '@/lib/jarvis/smoke/evidenceIds';
import { KERNEL_SMOKE_SCENARIOS } from '@/lib/jarvis/smoke/scenarios';
import {
  isKernelSmokeBindingActive,
  KERNEL_SMOKE_PROVIDER_ID,
} from '@/lib/ai/providers/kernelSmoke';
import type { StackStepSpec } from '@/lib/ai/stacks/types';
import {
  buildPromptForgeAttachmentSnapshots,
  collectPromptForgeComposerSources,
} from '@/features/prompt-forge/composerSources';
import {
  isPromptForgePluginAvailable,
  isPromptForgePluginConnected,
} from '@/features/prompt-forge/composerPluginSources';
import { promptForgeModelOptionsFromPicker } from '@/features/prompt-forge/contextPreparation';
import { PromptForgeControl } from '@/features/prompt-forge/PromptForgeControl';
import { PromptForgeRecovery } from '@/features/prompt-forge/PromptForgeRecovery';
import { PromptForgeReview } from '@/features/prompt-forge/PromptForgeReview';
import { usePromptForgeComposer } from '@/features/prompt-forge/usePromptForgeComposer';
import type { PromptForgeComposerDescriptor } from '@/features/prompt-forge/composerSources';
import type { PromptForgeSourceCandidate } from '@/features/prompt-forge/sourcePack';
import {
  buildActiveCanvasChatAttachments,
  canCaptureActiveCanvasSnapshot,
  captureActiveCanvasSnapshot,
  mergeActiveCanvasPromptForgeSources,
  readActiveCanvasAiContext,
  type ActiveCanvasSnapshot,
  type CanvasChatAttachmentMode,
} from '@/features/canvas/aiContextRegistry';

export function reasoningSelectionFromChatModel<T extends { mode: string }>(
  selection: T,
): ReasoningSelection | null {
  if (selection.mode !== 'single') return null;
  const single = selection as T & {
    providerId?: unknown;
    modelId?: unknown;
    connectionId?: unknown;
  };
  if (typeof single.providerId !== 'string' || typeof single.modelId !== 'string') return null;
  return {
    providerId: single.providerId,
    modelId: single.modelId,
    ...(typeof single.connectionId === 'string' ? { connectionId: single.connectionId } : {}),
  };
}

export function authoritativeLiveEffortsForSelection<T extends { mode: string }>(
  selection: T,
  options: readonly ModelPickerOption[],
): readonly EffortLabel[] | null {
  const id = selectionOptionId(selection as ChatModelSelection);
  if (!id) return null;
  const option = options.find((candidate) => candidate.id === id);
  if (
    !option ||
    option.available === false ||
    option.catalogSource !== 'opencode-live' ||
    option.variants === undefined
  )
    return null;
  return supportedEffortPreferences({
    connectionId:
      option.connectionId ??
      (selection.mode === 'single'
        ? (selection as T & { connectionId?: string }).connectionId
        : undefined) ??
      option.provider,
    modelId: option.modelId,
    variants: option.variants.map((variant) => ({ id: variant })),
  });
}

export function authoritativeLiveEffortsFromDiscoveredModels<T extends { mode: string }>(
  selection: T,
  models: readonly ProviderDiscoveredModel[],
): readonly EffortLabel[] | null {
  if (selection.mode !== 'single') return null;
  const single = selection as T & { connectionId?: unknown; modelId?: unknown };
  if (single.connectionId !== 'opencode-cli' || typeof single.modelId !== 'string') return null;
  const exact = models.find((model) => model.id === single.modelId);
  if (!exact || exact.variants === undefined) return null;
  return supportedEffortPreferences({
    connectionId: 'opencode-cli',
    modelId: exact.id,
    variants: exact.variants.map((variant) => ({ id: variant })),
  });
}

export function liveAuthorityRejectsEffort(
  effort: EffortLabel,
  allowed: readonly EffortLabel[] | null,
): boolean {
  return allowed !== null && !allowed.includes(effort);
}

export function liveEffortPickerState(allowed: readonly EffortLabel[], saved: EffortLabel | null) {
  return {
    options: allowed.map((effort) => ({
      id: effort,
      label: effort[0]!.toUpperCase() + effort.slice(1),
      description:
        effort === 'auto'
          ? 'Use the provider default or the active policy mode.'
          : `${effort[0]!.toUpperCase() + effort.slice(1)} reasoning effort.`,
    })),
    selectedId: saved !== null && allowed.includes(saved) ? saved : 'auto',
    error: undefined,
  };
}

export function tokenBossContextFromChatModel<T extends { mode: string }>(
  selection: T,
): CurrentModelContext | null {
  if (selection.mode !== 'single') return null;
  const single = selection as T & {
    providerId?: unknown;
    modelId?: unknown;
    connectionId?: unknown;
  };
  if (typeof single.providerId !== 'string' || typeof single.modelId !== 'string') return null;
  return {
    providerId: single.providerId,
    modelId: single.modelId,
    ...(typeof single.connectionId === 'string' ? { connectionId: single.connectionId } : {}),
    ...(single.providerId === 'ollama' || single.providerId === 'local'
      ? { runtimeId: 'ollama' }
      : {}),
  };
}

export function tokenBossProviderForMode<T extends { mode: string }>(
  mode: ReasoningMode,
  selection: T,
): TokenBossProvider | null {
  if (mode !== 'token-final-boss') return null;
  const context = tokenBossContextFromChatModel(selection);
  return context ? resolveTokenBossProvider(context) : null;
}

const TOKEN_OPTIMIZATION_MODE_FOR_REASONING: Readonly<
  Record<ReasoningMode, 'saver' | 'normal' | 'final_boss'>
> = {
  'token-saver': 'saver',
  normal: 'normal',
  'token-final-boss': 'final_boss',
};

export function applyChatReasoningMode(chatId: string, mode: ReasoningMode): void {
  writeChatReasoningMode(chatId, mode);
  browserTokenOptimizationPreferences.setChatOverride(
    chatId,
    TOKEN_OPTIMIZATION_MODE_FOR_REASONING[mode],
  );
}

export function mergeActiveCanvasSourcesForPromptForge(
  sources: readonly PromptForgeSourceCandidate[],
  accountId: string,
  projectId: string | null,
  canvasRouteActive: boolean,
): readonly PromptForgeSourceCandidate[] {
  return mergeActiveCanvasPromptForgeSources(sources, { accountId, projectId }, canvasRouteActive);
}

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

const KERNEL_SMOKE_HIVE_TEXT = KERNEL_SMOKE_SCENARIOS.hive_dispatch.safeTextFixture;
const COMPOSER_EMPTY_PROMPT_FORGE_SOURCES = Object.freeze([]);
const KERNEL_SMOKE_HIVE_STEPS: readonly StackStepSpec[] = Object.freeze([
  Object.freeze({
    id: 'kernel-smoke-hive-draft',
    label: 'Smoke draft',
    provider: KERNEL_SMOKE_PROVIDER_ID,
    model: 'kernel-smoke-v1',
    systemAppend: 'Run the fixed deterministic Hive smoke draft.',
  }),
  Object.freeze({
    id: 'kernel-smoke-hive-verify',
    label: 'Smoke verify',
    provider: KERNEL_SMOKE_PROVIDER_ID,
    model: 'kernel-smoke-v1',
    systemAppend: 'Verify the fixed deterministic Hive smoke draft.',
  }),
]);

export interface QueuedComposerAttachments {
  files: string[];
  images: ChatImageAttachment[];
  terminals: TerminalRef[];
  plugins: string[];
  contexts: ContextChatAttachment[];
  commands: ConfirmedCommand[];
  agents: ConfirmedAgentMention[];
  catalog: ConfirmedCatalogReference[];
}

export interface ComposerProps {
  chatId: ChatId | string;
  /** Optional placeholder override */
  placeholder?: string;
  /** Compact right-sidebar rendering. */
  compact?: boolean;
  /** Disable slash commands that navigate the main canvas. */
  disableRouteSlashCommands?: boolean;
}

export function buildComposerChatHandoffPayload(
  input: Readonly<{
    projection: ChatHandoffProjectionV1;
    additionalProjections?: readonly ChatHandoffProjectionV1[];
    instruction: string;
    draftText: string;
  }>,
) {
  const instruction = sanitizeChatHandoffText(
    [
      input.instruction.trim(),
      readableReferenceText(input.draftText, [
        input.projection,
        ...(input.additionalProjections ?? []),
      ]).trim(),
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  const parts = [input.projection, ...(input.additionalProjections ?? [])].map((projection) => ({
    kind: 'chat_handoff' as const,
    handoff: {
      version: 1 as const,
      sourceChatId: projection.source.chatId,
      sourceTitle: projection.source.title,
      snapshotAt: projection.snapshotAt,
      boundaryMessageId: projection.boundaryMessageId,
      instruction,
      projection,
    },
  }));
  return {
    text:
      renderChatHandoffPrompt(input.projection, instruction) +
      (input.additionalProjections ?? [])
        .map((projection) => '\n\n' + renderChatHandoffPrompt(projection, ''))
        .join(''),
    part: parts[0]!,
    parts,
  };
}

export async function resolveComposerChatHandoffDraft(
  input: Readonly<{
    payload: ChatDragPayloadV1;
    targetChatId: string;
    now?: number;
  }>,
  deps: Readonly<{
    getChat: (id: string) => Promise<Chat | undefined>;
    listMessages: (chatId: string) => Promise<readonly Message[]>;
    canAccess: (source: Chat, target: Chat) => boolean;
  }>,
): Promise<
  | Readonly<{ ok: true; projection: ChatHandoffProjectionV1 }>
  | Readonly<{
      ok: false;
      reason: 'invalid_payload' | 'same_chat' | 'chat_unavailable' | 'access_denied';
    }>
> {
  const accepted = await resolveAcceptedChatDrop(
    { payload: input.payload, targetChatId: input.targetChatId, purpose:'reference' },
    {
      getChat: (id) => deps.getChat(String(id)),
      canAccess: deps.canAccess,
    },
  );
  if (!accepted.ok) return accepted;
  const messages = await deps.listMessages(String(accepted.chat.id));
  return {
    ok: true,
    projection: projectChatHandoff({ sourceChat: accepted.chat, messages, now: input.now }),
  };
}

export function buildQueuedComposerChatHandoff(
  input: Readonly<{
    projection: ChatHandoffProjectionV1;
    additionalProjections?: readonly ChatHandoffProjectionV1[];
    instruction: string;
    draftText: string;
  }>,
) {
  const payload = buildComposerChatHandoffPayload(input);
  return Object.freeze({ text: payload.text, payload: Object.freeze(payload) });
}

export function createComposerQueuedMessage(
  input: Readonly<{
    draft: string;
    flushMode: QueueFlushMode;
    handoff: Readonly<{
      projection: ChatHandoffProjectionV1;
      additionalProjections?: readonly ChatHandoffProjectionV1[];
      instruction: string;
    }> | null;
    now?: number;
    id?: string;
  }>,
): Readonly<{
  message: QueuedChatMessage;
  payload: ReturnType<typeof buildComposerChatHandoffPayload> | null;
  visibleHandoffKey: string | null;
}> | null {
  const snapshot = input.handoff
    ? buildQueuedComposerChatHandoff({
        projection: input.handoff.projection,
        additionalProjections: input.handoff.additionalProjections,
        instruction: input.handoff.instruction,
        draftText: input.draft,
      })
    : null;
  const queueText =
    readableReferenceText(
      input.draft,
      input.handoff
        ? [input.handoff.projection, ...(input.handoff.additionalProjections ?? [])]
        : [],
    ).trim() || (snapshot ? `Handoff from ${snapshot.payload.part.handoff.sourceTitle}` : '');
  const message = createQueuedMessage(queueText, input.flushMode, input.now, input.id);
  const visibleHandoffKey = input.handoff
    ? composerChatHandoffDeliveryKey(
        buildComposerChatHandoffPayload({
          projection: input.handoff.projection,
          additionalProjections: input.handoff.additionalProjections,
          instruction: input.handoff.instruction,
          draftText: '',
        }),
      )
    : null;
  return message
    ? Object.freeze({ message, payload: snapshot?.payload ?? null, visibleHandoffKey })
    : null;
}

export function composerChatHandoffDeliveryKey(
  payload: ReturnType<typeof buildComposerChatHandoffPayload>,
): string {
  return JSON.stringify(
    payload.parts.length > 1 ? payload.parts.map((part) => part.handoff) : payload.part.handoff,
  );
}

export function shouldClearComposerHandoff(
  input: Readonly<{
    submittedHandoffKey: string | null;
    currentVisibleHandoffKey: string | null;
    handoffPayloadProvided: boolean;
  }>,
): boolean {
  if (input.submittedHandoffKey) {
    return input.currentVisibleHandoffKey === input.submittedHandoffKey;
  }
  return !input.handoffPayloadProvided;
}

export type ComposerChatHandoffDeliveryReceipt<T> = Readonly<{ key: string; value: T }>;

export async function deliverComposerChatHandoff<T>(input: {
  key: string;
  previousReceipt?: ComposerChatHandoffDeliveryReceipt<T> | null;
  persist: () => Promise<T>;
  dispatch: (value: T) => Promise<void>;
}): Promise<
  | Readonly<{ ok: true; receipt: ComposerChatHandoffDeliveryReceipt<T> }>
  | Readonly<{
      ok: false;
      receipt: ComposerChatHandoffDeliveryReceipt<T> | null;
      error: unknown;
    }>
> {
  let receipt = input.previousReceipt?.key === input.key ? input.previousReceipt : null;
  try {
    if (!receipt) receipt = Object.freeze({ key: input.key, value: await input.persist() });
    await input.dispatch(receipt.value);
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, receipt, error };
  }
}

export function resolveComposerPersistedText(
  input: Readonly<{
    sendText: string;
    handoff: boolean;
    oversizedSummary: string | null;
  }>,
): string {
  if (input.handoff) return input.sendText;
  return input.oversizedSummary ?? (input.sendText || 'Attached context.');
}

export function dispatchComposerSendWithAcceptance(
  detail: Readonly<{ chatId: string | ChatId; cancellationKey: string; text: string }> &
    Record<string, unknown>,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('jarvis:run-state', onRunState as EventListener);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const onRunState = (event: Event) => {
      const state = (
        event as CustomEvent<{ chatId?: string; cancellationKey?: string; status?: string }>
      ).detail;
      if (String(state?.chatId) !== String(detail.chatId)) return;
      if (String(state?.cancellationKey ?? '') !== String(detail.cancellationKey)) return;
      if (state?.status === 'running') finish();
      else if (state?.status === 'error' || state?.status === 'cancelled') {
        finish(new Error(`Chat handoff dispatch rejected before acceptance (${state.status}).`));
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('Chat handoff dispatch did not acknowledge runtime acceptance.')),
      timeoutMs,
    );
    window.addEventListener('jarvis:run-state', onRunState as EventListener);
    try {
      window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Chat handoff dispatch failed.'));
    }
  });
}

const LINE_HEIGHT = 20; // px - matches body type scale
const PADDING_Y = 16; // px - 8px top + 8px bottom
const MIN_LINES = 1;
const MAX_LINES = 8;
const MIN_HEIGHT = MIN_LINES * LINE_HEIGHT + PADDING_Y;
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT + PADDING_Y;
const COMPOSER_IDLE_PLUGIN_CONNECTIONS: Readonly<Record<string, PluginConnection>> = {};

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
  qwen: 'Qwen / Alibaba Cloud',
  zai: 'Z.AI / GLM',
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
  foundry: 'Model Foundry (local)',
  mock: 'Mock',
  local: 'Local',
};

type MentionContext = { start: number; query: string };
type SlashContext = { start: number; query: string };
type OptionPickerContext = { cmd: SlashCommandDef; query: string };

export interface ConfirmedCommand {
  cmd: string;
  value?: string;
  label: string;
}

export interface ConfirmedAgentMention {
  id: AgentId;
  slug: string;
  label: string;
}

export interface ConfirmedCatalogReference {
  key: string;
  kind: 'cao' | 'mcp' | 'plugin' | 'artifact';
  entityId: string;
  mention: string;
  label: string;
}

const SLASH_REFERENCE_LABELS: Record<string, string> = {
  agents: 'Agents page/editor',
  terminals: 'Terminal surface',
  hive: 'Hive Balanced',
  kanban: 'Kanban page',
  history: 'History page',
  tools: 'Tools page',
  schedule: 'Schedule page',
  chat: 'Chat page',
  canvas: 'Active Canvas',
};

export function buildConfirmedAgentMention(agent: Agent): ConfirmedAgentMention {
  return {
    id: agent.id,
    slug: agent.slug,
    label: `@${agent.slug}`,
  };
}

export function buildConfirmedCatalogReference(
  entry: Extract<ReferenceCatalogEntry, { kind: 'plugin' | 'artifact' }> | ReferenceCatalogEntry,
): ConfirmedCatalogReference {
  if (entry.kind === 'agent') {
    throw new Error('agent_reference_requires_canonical_agent');
  }
  return Object.freeze({
    key: entry.key,
    kind: entry.kind,
    entityId: entry.entityId,
    mention: entry.mention,
    label: entry.label,
  });
}

export function confirmedCatalogReferenceTextForSend(
  references: readonly ConfirmedCatalogReference[],
): string {
  const seen = new Set<string>();
  return references
    .filter((reference) => {
      if (seen.has(reference.key)) return false;
      seen.add(reference.key);
      return true;
    })
    .map((reference) => reference.mention)
    .join(' ');
}

export type ComposerCaoBootstrap = Readonly<{
  modelSelection: ChatModelSelection;
  reasoningPreference: ReasoningPreference;
  skillIds: readonly string[];
  requestedIdentity: CaoLearnerExecutionIdentity;
  publicStatus: CaoPublicStatus;
}>;

export function resolveComposerCaoControl(input: {
  decision: CaoBootstrapDecision | null;
  scope: CaoControlScope;
  candidates: readonly CaoControlCandidate[];
}) {
  return input.decision?.control
    ? resolveCaoControlTargets({
        command: input.decision.control,
        scope: input.scope,
        candidates: input.candidates,
      })
    : null;
}

export function resolveComposerCaoBootstrap(input: {
  decision: CaoBootstrapDecision | null;
  selectedModel: ChatModelSelection;
  skillIds: readonly string[];
}): ComposerCaoBootstrap | null {
  const { decision } = input;
  if (!decision) return null;
  return Object.freeze({
    modelSelection: selectionFromOption(
      CAO_LEARNER_IDENTITY.providerId,
      CAO_LEARNER_IDENTITY.modelId,
      CODEX_CLI_CONNECTION,
    ),
    reasoningPreference: Object.freeze({ mode: 'normal', effortOverride: 'high' }),
    skillIds: Object.freeze(Array.from(new Set([...input.skillIds, ...decision.skillIds]))),
    requestedIdentity: decision.requestedIdentity,
    publicStatus: projectCaoPublicStatus(decision),
  });
}

type ComposerArtifactCatalogRepository = Readonly<{
  listByAccount(accountId: string, limit?: number): Promise<JarvisArtifactV1[]>;
}>;

export async function loadComposerArtifactScope(
  repository: ComposerArtifactCatalogRepository,
  accountId: string,
): Promise<Readonly<{ accountId: string; artifacts: readonly JarvisArtifactV1[] }>> {
  if (!accountId) return Object.freeze({ accountId: '', artifacts: Object.freeze([]) });
  try {
    const artifacts = await repository.listByAccount(accountId, 100);
    return Object.freeze({ accountId, artifacts: Object.freeze([...artifacts]) });
  } catch {
    return Object.freeze({ accountId, artifacts: Object.freeze([]) });
  }
}

export function buildSlashReferenceCommand(cmd: SlashCommandDef): ConfirmedCommand {
  const canonical = normalizeSlashCmd(cmd.cmd);
  const label = SLASH_REFERENCE_LABELS[canonical] ?? cmd.description.replace(/^Open\s+/i, '');
  return {
    cmd: canonical,
    value: `reference:${canonical}`,
    label: `/${canonical}: ${label}`,
  };
}

export function resolveMentionedAgentIdsForSend(
  text: string,
  agents: Record<string, Agent>,
  confirmedMentions: ConfirmedAgentMention[] = [],
): AgentId[] {
  const seen = new Set<AgentId>();
  const out: AgentId[] = [];
  for (const mention of confirmedMentions) {
    if (seen.has(mention.id)) continue;
    seen.add(mention.id);
    out.push(mention.id);
  }
  for (const id of extractMentionedAgentIds(text, agents)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function confirmedCommandReferenceText(commands: ConfirmedCommand[]): string {
  const references = commands
    .filter((command) => command.value?.startsWith('reference:'))
    .map((command) => {
      const label = command.label.replace(/^\/[^:]+:\s*/, '').trim();
      return `/${command.cmd} references ${label}`;
    });
  if (references.length === 0) return '';
  return `Context references: ${references.join('; ')}.`;
}

export function resolveCanvasAttachmentModesForSend(
  commands: readonly ConfirmedCommand[],
  leadingText: string,
): readonly CanvasChatAttachmentMode[] {
  const modes = new Set<CanvasChatAttachmentMode>();
  for (const command of commands) {
    if (normalizeSlashCmd(command.cmd) !== 'canvas') continue;
    if (command.value === 'canvas:selection') modes.add('selection');
    if (command.value === 'canvas:frame') modes.add('frame');
    if (command.value === 'canvas:current' || command.value === 'reference:canvas') {
      modes.add('current');
    }
  }
  const leadingCommand = leadingText.trimStart().match(/^\/([^\s]+)/u)?.[1] ?? '';
  if (normalizeSlashCmd(leadingCommand) === 'canvas') modes.add('current');
  return Object.freeze([...modes]);
}

export function canvasSnapshotToImageAttachment(
  snapshot: ActiveCanvasSnapshot,
): ChatImageAttachment {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < snapshot.bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...snapshot.bytes.subarray(offset, offset + chunkSize));
  }
  return {
    id: `canvas_snapshot_${snapshot.id}`,
    name: snapshot.filename,
    mimeType: snapshot.mimeType,
    data: globalThis.btoa(binary),
    size: snapshot.bytes.byteLength,
  };
}

const WINDOWS_FILE_PATH_RE =
  /[A-Za-z]:\\[^\r\n<>:"|?*]+?\.(?:json|cs|ts|tsx|js|jsx|md|txt|html|css|scss|py|rs|go|java|cpp|c|h|hpp|xml|yaml|yml|toml|ini|sql)\b/gi;

export function extractAbsoluteFilePaths(text: string): string[] {
  return Array.from(new Set(text.match(WINDOWS_FILE_PATH_RE) ?? [])).slice(0, 8);
}

export function connectionSupportsFileAttachments(selection: {
  mode?: string;
  connectionId?: string;
  capabilities?: { files?: boolean };
}): boolean {
  if (selection.mode === 'single' && selection.connectionId) {
    try {
      const connection = getProviderConnectionDescriptor(selection.connectionId);
      if (connection.capabilities?.files === true) return true;
      if (connection.capabilities?.files === false) return false;
    } catch {
      // Fall through to the selection's own capability snapshot.
    }
  }
  return selection.capabilities?.files === true;
}

export function resolveSendFilePaths(input: {
  attachedFiles: readonly string[];
  sendText: string;
  oversizedPath?: string;
  supportsFiles: boolean;
}): string[] {
  return Array.from(
    new Set([
      ...(input.oversizedPath ? [input.oversizedPath] : []),
      ...input.attachedFiles,
      ...(input.supportsFiles ? extractAbsoluteFilePaths(input.sendText) : []),
    ]),
  ).slice(0, 8);
}

export function getQueuedMessageNotice(
  draft: string,
  flushMode: QueueFlushMode = 'after-run',
): Readonly<{ title: string; body: string }> {
  if (parseJarvisModelSwitchIntent(draft)) {
    return {
      title: 'Model switch queued',
      body: 'The current reply keeps its captured model. Leave this queued to review and apply on the next turn, or stop the current reply and resend to restart sooner.',
    };
  }
  return describeQueueToast(flushMode);
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
 * Works at the start, middle (after space/punctuation), or end of a message.
 */
function getSlashContext(value: string, caret: number): SlashContext | null {
  return getInlineSlashContext(value, caret);
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
  const re = /(?:^|\s)@([a-z0-9_-]+)(?=$|\s|[.,!?;])/gi;
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

export function FreeKeyNudge({ onOpenProviders }: { onOpenProviders: () => void }) {
  return (
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
        Add a free Gemini API key to give Jarvis a real Flash Lite brain (no card needed).
      </span>
      <a
        href="https://aistudio.google.com/apikey"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center text-accent-copper underline-offset-4 hover:underline [html[data-theme=sakura]_&]:min-h-6"
      >
        Get key →
      </a>
      <button
        type="button"
        onClick={onOpenProviders}
        className="ml-auto inline-flex items-center text-accent-copper underline-offset-4 hover:underline [html[data-theme=sakura]_&]:min-h-6"
      >
        Open Providers
      </button>
    </div>
  );
}

export function Composer({
  chatId,
  placeholder,
  compact = false,
  disableRouteSlashCommands = false,
}: ComposerProps) {
  const noteScope = useNoteScope();
  const [caoCommandInput, setCaoCommandInput] = useState<CaoCommandInput>();
  const [text, setText] = useState(() => readNotesComposerDraft(noteScope, String(chatId)).text);
  const [notesCtx, setNotesCtx] = useState<NotesCommandSpan | null>(null);
  const [attachedNotes, setAttachedNotes] = useState<NoteReference[]>(
    () => readNotesComposerDraft(noteScope, String(chatId)).references,
  );
  const notesPickerRef = useRef<NotesPickerHandle>(null);
  const dismissedNotesRef = useRef<string | null>(null);
  const notesSendingRef = useRef(false);
  const { workspace: notesWorkspace, snapshot: notesSnapshot } = useNotesWorkspace(
    noteScope,
    notesCtx !== null,
  );
  const notesDraftKey = notesComposerKey(noteScope, String(chatId));
  const [notesDraftStateKey, setNotesDraftStateKey] = useState(notesDraftKey);
  const notesScopeRef = useRef(notesDraftKey);
  useEffect(() => {
    if (notesScopeRef.current === notesDraftKey) return;
    notesScopeRef.current = notesDraftKey;
    const saved = readNotesComposerDraft(noteScope, String(chatId));
    setAttachedNotes(saved.references);
    setNotesCtx(null);
    dismissedNotesRef.current = null;
    setNotesDraftStateKey(notesDraftKey);
    if (saved.references.length || attachedNotes.length) setText(saved.text);
  }, [notesDraftKey]);
  useEffect(() => {
    if (notesDraftStateKey === notesDraftKey)
      checkpointNotesComposer(noteScope, String(chatId), text, attachedNotes);
  }, [notesDraftStateKey, notesDraftKey, text, attachedNotes]);
  const attachedNotesRef = useRef(attachedNotes);
  attachedNotesRef.current = attachedNotes;
  const cancelNotes = () => {
    dismissedNotesRef.current = text;
    setNotesCtx(null);
    setSlashCtx(null);
  };
  const confirmNotes = (notes: NoteSummary[]) => {
    if (!notesCtx || !noteScope) return;
    try {
      const next = removeNotesCommand(text, notesCtx);
      setAttachedNotes((current) =>
        mergeNoteReferences(current, notes.map(noteReference), noteScope),
      );
      setText(next);
      setNotesCtx(null);
      setSlashCtx(null);
      dismissedNotesRef.current = next;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(notesCtx.start, notesCtx.start);
      });
    } catch (error) {
      toast.error(
        'Cannot attach notes',
        error instanceof Error ? error.message : 'Reopen /notes and retry.',
      );
    }
  };
  const textRef = useRef(text);
  textRef.current = text;
  const handoffDraftEditRevisionRef = useRef(0);
  const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
  const [selectedReferenceKey, setSelectedReferenceKey] = useState<string>('');
  const [slashCtx, setSlashCtx] = useState<SlashContext | null>(null);
  const [selectedSlashCmd, setSelectedSlashCmd] = useState<string>('');
  const [optionPickerCtx, setOptionPickerCtx] = useState<OptionPickerContext | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const interactionMode = useJarvisInteractionStore((s) => s.modeForChat(chatId));
  const setInteractionMode = useJarvisInteractionStore((s) => s.setChatMode);
  const [reasoningPreference, setReasoningPreference] = useState(() =>
    readChatReasoningPreference(String(chatId)),
  );
  const [runtimePolicy, setRuntimePolicy] = useState<ChatRuntimePolicyState>(() =>
    readChatRuntimePolicyState(String(chatId)),
  );
  const [confirmedCommands, setConfirmedCommands] = useState<ConfirmedCommand[]>([]);
  const [confirmedAgentMentions, setConfirmedAgentMentions] = useState<ConfirmedAgentMention[]>([]);
  const [confirmedCatalogReferences, setConfirmedCatalogReferences] = useState<
    ConfirmedCatalogReference[]
  >([]);
  const [artifactReferenceScope, setArtifactReferenceScope] = useState<
    Readonly<{ accountId: string; artifacts: readonly JarvisArtifactV1[] }>
  >({ accountId: '', artifacts: [] });
  const artifactRefreshGenerationRef = useRef(0);
  const artifactLoadedAccountRef = useRef('');
  const [sending, setSending] = useState(false);
  const harnessRuntimeState = useHarnessRuntimeState();
  const harnessBlocked = harnessRuntimeState.kind !== 'ready';
  const codexRuntimeState = useCodexRuntimeState();
  const [jarvisRunning, setJarvisRunning] = useState(
    () => getChatRunState(String(chatId))?.status === 'running',
  );
  const [stoppedRequest, setStoppedRequest] = useState(
    () => getChatRunState(String(chatId))?.status === 'cancelled',
  );
  const queueScope = useAuthStore((state) => JSON.stringify([
    resolveAccountIdentity(state)?.accountId ?? '', state.workspaceId, state.projectId, String(chatId),
  ]));
  const queueSession = useComposerQueueSession(queueScope);
  const { messages: queuedMessages, setMessages: setQueuedMessages } = queueSession;
  const escapeCancelRef = useRef<EscapeCancelState>(createEscapeCancelState());
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [attachedImages, setAttachedImages] = useState<ChatImageAttachment[]>([]);
  const [attachedTerminals, setAttachedTerminals] = useState<TerminalRef[]>([]);
  const [attachedPlugins, setAttachedPlugins] = useState<string[]>([]);
  const [attachedContexts, setAttachedContexts] = useState<ContextChatAttachment[]>([]);
  const [mediaPreview, setMediaPreview] = useState<MediaPreviewTarget | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pendingHandoff, setPendingHandoff] = useState<ChatHandoffProjectionV1 | null>(null);
  const pendingHandoffRef = useRef<ChatHandoffProjectionV1 | null>(null);
  const [additionalHandoffs, setAdditionalHandoffs] = useState<readonly ChatHandoffProjectionV1[]>(
    [],
  );
  const additionalHandoffsRef = useRef<readonly ChatHandoffProjectionV1[]>([]);
  const [expandedReferenceId, setExpandedReferenceId] = useState<string | null>(null);
  const inlineReferences = useMemo(
    () => (pendingHandoff ? [pendingHandoff, ...additionalHandoffs] : []),
    [pendingHandoff, additionalHandoffs],
  );
  const retainHandoffs = (draft: string) => {
    const retained = [pendingHandoffRef.current, ...additionalHandoffsRef.current].filter(
      (projection): projection is ChatHandoffProjectionV1 =>
        !!projection && draft.includes(chatReferenceToken(projection.source.chatId)),
    );
    if (
      retained.length ===
      (pendingHandoffRef.current ? 1 : 0) + additionalHandoffsRef.current.length
    )
      return;
    pendingHandoffRef.current = retained[0] ?? null;
    setPendingHandoff(retained[0] ?? null);
    additionalHandoffsRef.current = retained.slice(1);
    setAdditionalHandoffs(retained.slice(1));
  };
  useEffect(() => {
    retainHandoffs(text);
  }, [text]);
  useEffect(
    () =>
      useAuthStore.subscribe((next, previous) => {
        if (
          next.workspaceId === previous.workspaceId &&
          resolveAccountIdentity(next)?.accountId === resolveAccountIdentity(previous)?.accountId
        )
          return;
        const refs = [pendingHandoffRef.current, ...additionalHandoffsRef.current].filter(
          (item): item is ChatHandoffProjectionV1 => !!item,
        );
        const draft = readableReferenceText(textRef.current, refs);
        pendingHandoffRef.current = null;
        setPendingHandoff(null);
        additionalHandoffsRef.current = [];
        setAdditionalHandoffs([]);
        setExpandedReferenceId(null);
        textRef.current = draft;
        setText(draft);
      }),
    [],
  );

  const pendingHandoffDeliveriesRef = useRef(
    new Map<string, ComposerChatHandoffDeliveryReceipt<Message>>(),
  );
  const [handoffInstruction, setHandoffInstruction] = useState(
    'Review this context and continue from the latest truthful state.',
  );
  const handoffInstructionRef = useRef(handoffInstruction);
  handoffInstructionRef.current = handoffInstruction;
  // V2 — speech-to-text in the composer.
  const composerSttEnabled = useUIStore((s) => s.composerStt);
  const setComposerSttListening = useUIStore((s) => s.setComposerSttListening);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashTypeaheadRef = useRef<SlashCommandTypeaheadRef>(null);
  const [slashComboboxMetadata, setSlashComboboxMetadata] = useState<SlashComboboxMetadata | null>(
    null,
  );

  useEffect(() => {
    setRuntimePolicy(readChatRuntimePolicyState(String(chatId)));
  }, [chatId]);

  useEffect(() => {
    cleanupExpiredOversizedMessageAttachments();
  }, []);
  const optionPickerRef = useRef<SlashCommandOptionPickerRef>(null);
  const themePickerRef = useRef<ThemeSlashPickerRef>(null);
  const volumeRef = sttVolumeRef;
  const voiceReplyRequestedRef = useRef(false);
  const sttController = useMemo(() => createComposerDictationController({
    field: () => textareaRef.current,
    scope: () => JSON.stringify([chatId, resolveAccountIdentity(useAuthStore.getState())?.accountId,
      getComposerSttProvider(), getFasterWhisperModel(), readDeepgramSttOption()]),
    onLevel: setSttVolumeLevel,
    commit: (value, caret) => {
      voiceReplyRequestedRef.current = true;
      setText(value);
      const field = textareaRef.current;
      requestAnimationFrame(() => {
        if (field && textareaRef.current === field && field.isConnected && field.value === value) {
          field.focus(); field.setSelectionRange(caret, caret);
        }
      });
    },
  }), [chatId]);
  const sttView = useSyncExternalStore(sttController.subscribe, sttController.getSnapshot);
  const sttListening = sttView.phase === 'listening';
  const sttTranscribing = sttView.phase === 'transcribing';
  const sttInterim = sttView.text;
  useEffect(() => {
    const route = () => JSON.stringify([resolveAccountIdentity(useAuthStore.getState())?.accountId,
      getComposerSttProvider(), getFasterWhisperModel(), readDeepgramSttOption()]);
    let previous = route();
    const off = useAuthStore.subscribe(() => {
      const next = route();
      if (next !== previous) { previous = next; sttController.cancel(); }
    });
    // Cancel is replay-safe under React StrictMode; no old stream survives remount.
    return () => { off(); sttController.cancel(); };
  }, [sttController]);

  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const queuedHandoffsRef = queueSession.handoffs;
  const sendingRef = useRef(sending);
  const instantCommandInFlightRef = useRef(false);
  sendingRef.current = sending;
  const activeCancellationKeyRef = useRef<string | null>(null);
  const queuedDispatchInFlightRef = queueSession.dispatchInFlight;
  const queuedInterruptInFlightRef = queueSession.interruptInFlight;
  /** When true, a user Esc×3 cancel must not auto-drain the queue. */
  const suppressQueueFlushOnUserCancelRef = queueSession.suppressCancelFlush;
  const interruptQueuedRef = useRef<(id: string) => void>(() => {});
  /** Latest auto-flush implementation (set after handleSend exists). */
  const flushNextQueuedRef = useRef<() => void>(() => {});
  /**
   * Prompt Forge upgrade-for-send (wired after the hook mounts). Used so
   * handleSend can await upgrades without reordering the huge send path.
   */
  const promptForgeUpgradeForSendRef = useRef<
    | ((draft: string) => Promise<
        Readonly<{
          text: string;
          upgraded: boolean;
          requiresReview?: boolean;
          reason?: string;
        }>
      >)
    | null
  >(null);
  const promptForgeAutoUpgradeRef = useRef(false);

  const applyInteractionMode = useCallback(
    (nextMode: JarvisInteractionMode) => {
      const previousMode = useJarvisInteractionStore.getState().modeForChat(chatId);
      setPermissionAccess(String(chatId), nextMode === 'agent' ? 'full' : 'read');
      setApproveAllForRun(String(chatId), false);
      setInteractionMode(chatId, nextMode);
      const cancellationKey = activeCancellationKeyRef.current;
      if (
        shouldCancelForLiveModeRestriction({
          previousMode,
          nextMode,
          running: jarvisRunning,
          cancellationKey,
        })
      ) {
        window.dispatchEvent(
          new CustomEvent('jarvis:cancel', { detail: { messageId: cancellationKey } }),
        );
        toast.info(
          'Current reply stopped',
          `${nextMode === 'ask' ? 'Ask' : 'Plan'} Mode is active. The restricted turn was cancelled before more actions could run.`,
        );
      }
    },
    [chatId, jarvisRunning, setInteractionMode],
  );

  useEffect(() => {
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const retained = getChatRunState(String(chatId));
    setJarvisRunning(retained?.status === 'running');
    setStoppedRequest(retained?.status === 'cancelled');
    activeCancellationKeyRef.current =
      retained?.status === 'running' ? (retained.cancellationKey ?? null) : null;
    const onRunState = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; status?: string }>).detail;
      if (String(detail?.chatId) !== String(chatId)) return;
      const status = detail?.status;
      if (status === 'running') {
        setJarvisRunning(true);
        setStoppedRequest(false);
        return;
      }
      setJarvisRunning(false);
      activeCancellationKeyRef.current = null;
      // Esc×3 cancel: keep the queue for resume/resend (do not auto-drain).
      if (status === 'cancelled' && suppressQueueFlushOnUserCancelRef.current) {
        suppressQueueFlushOnUserCancelRef.current = false;
        setStoppedRequest(true);
        return;
      }
      setStoppedRequest(false);
      // When the previous full reply finishes (or fails/cancels), send the next
      // queued message automatically — FIFO order.
      if (!shouldScheduleQueuedRunFlush(status, queuedInterruptInFlightRef.current !== null))
        return;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNextQueuedRef.current();
      }, 60);
    };
    window.addEventListener('jarvis:run-state', onRunState as EventListener);
    return () => {
      window.removeEventListener('jarvis:run-state', onRunState as EventListener);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [chatId, queueScope]);

  // After-tool: flush when a tool finishes (not when a new tool starts).
  useEffect(
    () =>
      useChatActivityStore.subscribe((state, previous) => {
        if (!jarvisRunning || queuedInterruptInFlightRef.current) return;
        const queued = queuedMessagesRef.current[0];
        if (!queued || queued.flushMode !== 'after-tool') return;
        const current = state.eventsByChat[String(chatId)] ?? [];
        const before = previous.eventsByChat[String(chatId)] ?? [];
        const beforeById = new Map(before.map((event) => [event.id, event]));
        const toolFinished = current.find((event) => {
          if (event.kind !== 'tool' || event.ts < queued.createdAt) return false;
          if (!shouldFlushOnToolTerminal(queued, event.status)) return false;
          const prev = beforeById.get(event.id);
          // New terminal event, or status transitioned into terminal.
          return !prev || prev.status !== event.status;
        });
        if (toolFinished) interruptQueuedRef.current(queued.id);
      }),
    [chatId, queueScope, jarvisRunning],
  );

  const enqueueCurrentMessage = (draft: string, flushMode: QueueFlushMode = 'after-run') => {
    if (attachedNotes.length) {
      toast.warning(
        'Notes are ready',
        'Wait for this response to finish before sending note references.',
      );
      return false;
    }
    const queued = createComposerQueuedMessage({
      draft,
      flushMode,
      handoff: pendingHandoff
        ? { projection: pendingHandoff, additionalProjections:additionalHandoffs, instruction: handoffInstruction }
        : null,
    });
    if (!queued) return false;
    const item = { ...queued.message, attachments: structuredClone(currentComposerAttachments) };
    if (queued.payload && queued.visibleHandoffKey) {
      queuedHandoffsRef.current.set(item.id, {
        payload: queued.payload,
        visibleHandoffKey: queued.visibleHandoffKey,
      });
    }
    setQueuedMessages((current) => {
      const next = [...current, item];
      queuedMessagesRef.current = next;
      return next;
    });
    setText('');
    setAttachedFiles([]);
    setAttachedImages([]);
    setAttachedTerminals([]);
    setAttachedPlugins([]);
    setAttachedContexts([]);
    setConfirmedCommands([]);
    setConfirmedAgentMentions([]);
    setConfirmedCatalogReferences([]);
    const notice = getQueuedMessageNotice(item.text, flushMode);
    toast.info(notice.title, notice.body);
    return true;
  };

  const editQueuedMessage = (id: string) => {
    setQueuedMessages((current) => {
      const queued = current.find((message) => message.id === id);
      if (queued) {
        setText(queued.text);
        if (queued.attachments) {
          const a = queued.attachments;
          setAttachedFiles(a.files);
          setAttachedImages(a.images);
          setAttachedTerminals(a.terminals);
          setAttachedPlugins(a.plugins);
          setAttachedContexts(a.contexts);
          setConfirmedCommands(a.commands);
          setConfirmedAgentMentions(a.agents);
          setConfirmedCatalogReferences(a.catalog);
        }
      }
      queuedHandoffsRef.current.delete(id);
      return current.filter((message) => message.id !== id);
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const deleteQueuedMessage = (id: string) => {
    queuedHandoffsRef.current.delete(id);
    setQueuedMessages((current) => current.filter((message) => message.id !== id));
  };

  const agents = useAgentStore((s) => s.agents);
  const provider = useAuthStore((s) => s.defaultProvider);
  const selectedModels = useAuthStore((s) => s.selectedModels);
  const globalChatModelSelection = useAuthStore((s) => s.chatModelSelection);
  const setChatModelSelection = useAuthStore((s) => s.setChatModelSelection);
  const [modelSelectionReadyChatId, setModelSelectionReadyChatId] = useState('');
  const [retainedExactChatSelection, setRetainedExactChatSelection] =
    useState<ExactChatSelection | null>(null);
  const chatBackendAffinity = useChatBackendAffinity(String(chatId));
  const backendRuntimeBlocked =
    chatBackendAffinity?.backend === 'codex' ? codexRuntimeState.kind !== 'ready' : harnessBlocked;
  const chatModelSelection = useMemo(
    () => restoreExactChatSelection(globalChatModelSelection, retainedExactChatSelection),
    [globalChatModelSelection, retainedExactChatSelection],
  );
  const promptForgeModelSelection = useAuthStore((s) => s.promptForgeModelSelection);
  const setPromptForgeModelSelection = useAuthStore((s) => s.setPromptForgeModelSelection);
  const promptForgeAutoUpgradeOnSend = useAuthStore((s) => s.promptForgeAutoUpgradeOnSend);
  promptForgeAutoUpgradeRef.current = promptForgeAutoUpgradeOnSend;
  const setPromptForgeAutoUpgradeOnSend = useAuthStore((s) => s.setPromptForgeAutoUpgradeOnSend);
  const stackCustomSteps = useAuthStore((s) => s.stackCustomSteps);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);
  const setSelectedModel = useAuthStore((s) => s.setSelectedModel);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const [contextMaps, setContextMaps] = useState<readonly ContextMapRecord[]>([]);
  const pluginAccountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? '');
  const mentionDiscoveryOpen = mentionCtx !== null;
  useEffect(() => {
    if (!mentionDiscoveryOpen && artifactLoadedAccountRef.current === pluginAccountId) return;
    const generation = artifactRefreshGenerationRef.current + 1;
    artifactRefreshGenerationRef.current = generation;
    void loadComposerArtifactScope(jarvisArtifactRepo, pluginAccountId).then((scope) => {
      if (artifactRefreshGenerationRef.current !== generation) return;
      artifactLoadedAccountRef.current = scope.accountId;
      setArtifactReferenceScope(scope);
    });
    return () => {
      if (artifactRefreshGenerationRef.current === generation) {
        artifactRefreshGenerationRef.current += 1;
      }
    };
  }, [mentionDiscoveryOpen, pluginAccountId]);
  const terminalPickerActive = normalizeSlashCmd(optionPickerCtx?.cmd.cmd ?? '') === 'terminals';
  const pluginPickerActive = optionPickerCtx?.cmd.cmd === 'plug';
  const themePickerActive = isGlobalThemePickerCommand(optionPickerCtx?.cmd.cmd ?? '');
  const consoleThemePickerActive = optionPickerCtx?.cmd.cmd === 'theme';
  const anyThemePickerActive = themePickerActive || consoleThemePickerActive;
  const pluginConnections = usePluginStore((s) =>
    pluginPickerActive || mentionDiscoveryOpen
      ? selectPluginConnectionsForAccount(s, pluginAccountId)
      : COMPOSER_IDLE_PLUGIN_CONNECTIONS,
  );
  const terminalSessions = useTerminalTranscriptStore((s) =>
    terminalPickerActive ? s.sessions : COMPOSER_IDLE_TERMINAL_SESSIONS,
  );
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<ModelPickerTypeaheadRef>(null);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const ollamaOptions = useOllamaModelOptions();
  const accessibleChatModels = useAccessibleChatModels();
  const optionLiveEfforts = useMemo(
    () =>
      modelSelectionReadyChatId === String(chatId)
        ? authoritativeLiveEffortsForSelection(chatModelSelection, accessibleChatModels.flatOptions)
        : null,
    [accessibleChatModels.flatOptions, chatId, chatModelSelection, modelSelectionReadyChatId],
  );
  const selectionId = selectionOptionId(chatModelSelection);
  const [fetchedLiveEffortAuthority, setFetchedLiveEffortAuthority] = useState<{
    chatId: string;
    selectionId: string;
    efforts: readonly EffortLabel[];
  } | null>(null);
  useEffect(() => {
    setFetchedLiveEffortAuthority(null);
    if (
      modelSelectionReadyChatId !== String(chatId) ||
      optionLiveEfforts !== null ||
      !selectionId ||
      chatModelSelection.mode !== 'single' ||
      chatModelSelection.connectionId !== 'opencode-cli'
    ) {
      return;
    }
    let cancelled = false;
    const expectedChatId = String(chatId);
    const expectedSelectionId = selectionId;
    void (openCodePersistentAdapter.listModels?.() ?? Promise.resolve([]))
      .then((models) => {
        const efforts = authoritativeLiveEffortsFromDiscoveredModels(chatModelSelection, models);
        if (cancelled || efforts === null) return;
        setFetchedLiveEffortAuthority({
          chatId: expectedChatId,
          selectionId: expectedSelectionId,
          efforts,
        });
      })
      .catch(() => {
        // The provider adapter remains authoritative when live catalog discovery is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, chatModelSelection, modelSelectionReadyChatId, optionLiveEfforts, selectionId]);
  const authoritativeLiveEfforts =
    optionLiveEfforts ??
    (fetchedLiveEffortAuthority?.chatId === String(chatId) &&
    fetchedLiveEffortAuthority.selectionId === selectionId
      ? fetchedLiveEffortAuthority.efforts
      : null);
  const [projectFileOptions, setProjectFileOptions] = useState<SlashCommandOption[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesError, setProjectFilesError] = useState<string | undefined>(undefined);
  const reasoningSelection = useMemo(
    () => reasoningSelectionFromChatModel(chatModelSelection),
    [chatModelSelection],
  );
  const reasoningPickerState = useMemo(() => {
    const command = normalizeSlashCmd(optionPickerCtx?.cmd.cmd ?? '');
    if (command !== 'effort' && command !== 'mode') return null;
    const staticState = buildReasoningSlashPickerState({
      command,
      selection: reasoningSelection,
      preference: reasoningPreference,
    });
    return command === 'effort' && authoritativeLiveEfforts !== null
      ? liveEffortPickerState(authoritativeLiveEfforts, reasoningPreference.effortOverride)
      : staticState;
  }, [authoritativeLiveEfforts, optionPickerCtx, reasoningPreference, reasoningSelection]);

  useEffect(() => {
    setReasoningPreference(readChatReasoningPreference(String(chatId)));
  }, [chatId]);

  useEffect(() => {
    const saved = reasoningPreference.effortOverride;
    const runtimeEffort = runtimePolicy.settings.effort;
    const clearSaved =
      saved !== null && liveAuthorityRejectsEffort(saved, authoritativeLiveEfforts);
    const clearRuntime = liveAuthorityRejectsEffort(runtimeEffort, authoritativeLiveEfforts);
    if (!clearSaved && !clearRuntime) return;
    if (clearSaved) {
      writeChatReasoningEffort(String(chatId), null);
      setReasoningPreference(readChatReasoningPreference(String(chatId)));
    }
    if (clearRuntime) {
      const next = writeChatRuntimePolicyState(String(chatId), {
        ...runtimePolicy,
        settings: { ...runtimePolicy.settings, effort: 'auto' },
      });
      setRuntimePolicy(next);
    }
    const rejected = clearSaved ? saved! : runtimeEffort;
    const available = authoritativeLiveEfforts?.filter((effort) => effort !== 'auto').join(', ');
    toast.warning(
      'Unsupported effort cleared',
      `The live model does not offer ${rejected}. Choose ${available || 'Auto'}.`,
    );
  }, [authoritativeLiveEfforts, chatId, reasoningPreference.effortOverride, runtimePolicy]);

  useEffect(() => {
    if (!pluginAccountId) {
      setContextMaps([]);
      return;
    }
    let active = true;
    const refresh = () => {
      const state = getActiveContextPersistenceState(projectId);
      if (active && state) setContextMaps(state.maps);
    };
    void ensureContextPersistence(projectId)
      .then(refresh)
      .catch(() => {
        if (active) setContextMaps([]);
      });
    window.addEventListener('jarvis:context-tree-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('jarvis:context-tree-updated', refresh);
    };
  }, [pluginAccountId, projectId]);

  const accessibleProviders = useMemo(
    () => getAccessibleProviders(apiKeys, offlineMode, plan),
    [apiKeys, offlineMode, plan, ollamaOptions],
  );

  const modelCtx = useMemo(
    () => modelSelectionContextFromAuth({ apiKeys, offlineMode, plan, defaultLocalModel }),
    [apiKeys, offlineMode, plan, defaultLocalModel],
  );

  // A chat's exact connection is local-only metadata. Restore it when switching chats.
  useEffect(() => {
    let cancelled = false;
    setRetainedExactChatSelection(null);
    setModelSelectionReadyChatId('');
    void chatRepo.getById(chatId as ChatId)
      .then((chat) => {
        if (cancelled || !chat) return;
        if (!chat.connection) return;
        const current = useAuthStore.getState().chatModelSelection;
        const modelId =
          chat.connection.modelId ??
          (current.mode === 'single' && current.providerId === chat.connection.providerId
            ? current.modelId
            : '') ??
          '';
        if (!modelId) return;
        // The upstream model selection stays separate from its coding backend.
        // Dispatch binds the Codex transport without changing picker authority.
        const connection = chat.connection;
        const restored = selectionFromOption(
          chat.connection.providerId as ProviderId,
          modelId,
          connection,
        );
        if (restored.mode !== 'single') return;
        setRetainedExactChatSelection(restored);
        setChatModelSelection(restored);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setModelSelectionReadyChatId(String(chatId));
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, setChatModelSelection]);

  // Account-store hydration can finish after the chat picker. Keep the exact
  // chat-scoped route selected instead of visibly reverting to Choose model.
  useEffect(() => {
    if (modelSelectionReadyChatId !== String(chatId)) return;
    const restored = restoreExactChatSelection(
      globalChatModelSelection,
      retainedExactChatSelection,
    );
    if (restored !== globalChatModelSelection) setChatModelSelection(restored);
  }, [
    chatId,
    globalChatModelSelection,
    modelSelectionReadyChatId,
    retainedExactChatSelection,
    setChatModelSelection,
  ]);

  // Generate options for option picker based on current command
  const optionPickerOptions = useMemo<SlashCommandOption[]>(() => {
    if (!optionPickerCtx) return [];
    const cmd = optionPickerCtx.cmd.cmd;
    if (isGlobalThemePickerCommand(cmd) || cmd === 'theme') return [];

    if (normalizeSlashCmd(cmd) === 'chat') {
      return CHAT_ENGINE_OPTIONS.map((option) => ({ ...option }));
    }

    if (normalizeSlashCmd(cmd) === 'cli') {
      if (!chatBackendAffinity) return [];
      if (chatBackendAffinity.locked) {
        return [
          {
            id: 'status',
            label: chatBackendAffinity.backend === 'codex' ? 'Codex' : 'OpenCode',
            description: 'Current CLI · locked for this chat',
            metadata: 'active',
          },
        ];
      }
      return [
        {
          id: 'opencode',
          label: 'OpenCode',
          description: 'Use the authenticated OpenCode backend for this chat',
          metadata: chatBackendAffinity.backend === 'opencode' ? 'active' : undefined,
        },
        {
          id: 'codex',
          label: 'Codex',
          description: 'Use Codex CLI through the same selected provider and model',
          metadata: chatBackendAffinity.backend === 'codex' ? 'active' : undefined,
        },
      ];
    }

    if (normalizeSlashCmd(cmd) === 'agent') {
      const live = useJarvisInteractionStore.getState().agentsByChat[String(chatId)] ?? [];
      return agentSelectorOptions(live).map((row) => ({
        id: row.childChatId,
        label: row.label,
        description: row.description,
        metadata: row.id,
      }));
    }

    if (normalizeSlashCmd(cmd) === 'terminals') {
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

    if (normalizeSlashCmd(cmd) === 'context') {
      const maps = projectId
        ? (getActiveContextPersistenceState(projectId)?.maps ?? contextMaps)
        : [];
      return contextMapSlashOptions(maps);
    }

    if (normalizeSlashCmd(cmd) === 'md') {
      return [...MARKDOWN_DOCUMENT_OPTIONS];
    }

    if (normalizeSlashCmd(cmd) === 'canvas') {
      const context = readActiveCanvasAiContext({
        accountId: pluginAccountId,
        projectId,
      });
      if (context === null) return [];
      const scope = { accountId: pluginAccountId, projectId };
      const selectedFrame = buildActiveCanvasChatAttachments(scope, 'frame')[0];
      return [
        {
          id: 'canvas:current',
          label: 'Current canvas',
          description: context.canvas.title,
          metadata: `${context.canvas.blockCount} objects`,
        },
        ...(context.selection.length > 0
          ? [
              {
                id: 'canvas:selection',
                label: 'Selected canvas objects',
                description: context.selection
                  .map(({ label }) => label)
                  .slice(0, 3)
                  .join(', '),
                metadata: `${context.selection.length} selected`,
              },
            ]
          : []),
        ...(selectedFrame === undefined
          ? []
          : [
              {
                id: 'canvas:frame',
                label: 'Selected presentation frame',
                description: selectedFrame.title,
                metadata: 'structured context',
              },
            ]),
        ...(canCaptureActiveCanvasSnapshot(scope)
          ? [
              {
                id: 'canvas:snapshot',
                label: 'Canvas snapshot',
                description: 'Attach a current PNG for vision-capable models',
                metadata: '1280 × 720',
              },
            ]
          : []),
      ];
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
      return getSkillPickerOptions().map((skill) => ({
        id: skill.id,
        label: skill.emoji ? `${skill.emoji} ${skill.label}` : skill.label,
        description: skill.description,
        metadata: skill.metadata,
      }));
    }

    if (cmd === 'allaboutme') {
      return ALL_ABOUT_ME_SLASH_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        icon: FileText,
      }));
    }

    if (normalizeSlashCmd(cmd) === 'file') {
      return projectFileOptions;
    }

    if (cmd === 'rlm') {
      const resolved = resolveRlmEnabled({
        chatId: String(chatId),
        workspaceId: workspaceId ?? undefined,
      });
      return RLM_SLASH_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        metadata:
          (option.id === 'on' && resolved.enabled) || (option.id === 'off' && !resolved.enabled)
            ? 'active'
            : undefined,
      }));
    }

    if ((cmd === 'effort' || cmd === 'mode') && reasoningPickerState) {
      return reasoningPickerState.options.map((option) => ({
        ...option,
        metadata: option.id === reasoningPickerState.selectedId ? 'active' : undefined,
      }));
    }

    if (normalizeSlashCmd(cmd) === 'permissions') {
      return PERMISSION_MODE_OPTIONS.map((option) => ({
        id: option.id,
        label: option.title,
        description: option.description,
        metadata: option.id === interactionMode ? 'active' : undefined,
      }));
    }

    return [];
  }, [
    chatBackendAffinity,
    optionPickerCtx,
    terminalSessions,
    projectId,
    pluginAccountId,
    pluginConnections,
    projectFileOptions,
    interactionMode,
    reasoningPickerState,
    chatId,
    workspaceId,
  ]);

  // Load project files when /file picker opens
  useEffect(() => {
    if (normalizeSlashCmd(optionPickerCtx?.cmd.cmd ?? '') !== 'file') {
      return;
    }
    let cancelled = false;
    setProjectFilesLoading(true);
    setProjectFilesError(undefined);
    void listProjectFileOptions({ projectId }).then((result) => {
      if (cancelled) return;
      setProjectFileOptions(result.options);
      setProjectFilesError(result.error);
      setProjectFilesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [optionPickerCtx, projectId]);

  // Keep keyboard highlight on a valid option without clobbering hover/arrow nav.
  const optionPickerSignature = useMemo(
    () => optionPickerOptions.map((option) => option.id).join('\0'),
    [optionPickerOptions],
  );

  useEffect(() => {
    if (optionPickerOptions.length === 0) {
      setSelectedOptionId((current) => (current === '' ? current : ''));
      return;
    }
    setSelectedOptionId((current) =>
      optionPickerOptions.some((o) => o.id === current) ? current : optionPickerOptions[0]!.id,
    );
  }, [optionPickerSignature]);

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; prompt?: string; code?: string }>).detail;
      if (!detail?.path || !detail.code) return;
      setText(
        [
          detail.prompt?.trim() || 'Review this code.',
          '',
          `File: ${detail.path}`,
          '```',
          detail.code,
          '```',
        ].join('\n'),
      );
      setAttachedFiles((cur) =>
        (cur.includes(detail.path!) ? cur : [...cur, detail.path!]).slice(0, 8),
      );
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
  // Hide entirely when the user already chose a local/Ollama (or any
  // non-Google) chat model — the Gemini key bar is noise while typing
  // to Local Models.
  const googleKey = useAuthStore((s) => s.apiKeys.google);
  const jarvisAgent = useMemo(() => findProtectedJarvisAgent(Object.values(agents)), [agents]);
  const usingNonGoogleChatModel =
    chatModelSelection.mode === 'single' && chatModelSelection.providerId !== 'google';
  const usingLocalChatModel =
    chatModelSelection.mode === 'single' &&
    (chatModelSelection.providerId === 'ollama' || chatModelSelection.providerId === 'local');
  const showFreeKeyNudge =
    !compact &&
    !!jarvisAgent &&
    jarvisAgent.model.provider === 'google' &&
    !googleKey &&
    !usingNonGoogleChatModel &&
    !usingLocalChatModel;

  const referenceCatalog = useMemo(
    () =>
      buildAccountReferenceCatalog({
        accountId: pluginAccountId,
        projectId,
        artifactScope: artifactReferenceScope,
        agents: Object.values(agents),
        plugins: PLUGIN_CATALOG,
        pluginConnections,
        mcps: mentionDiscoveryOpen ? jarvisMcpServerManager.discover() : [],
      }),
    [
      agents,
      artifactReferenceScope,
      mentionDiscoveryOpen,
      pluginAccountId,
      pluginConnections,
      projectId,
    ],
  );
  const filteredReferenceEntries = useMemo(
    () =>
      mentionCtx ? filterReferenceCatalog(referenceCatalog, mentionCtx.query) : Object.freeze([]),
    [mentionCtx, referenceCatalog],
  );
  const filteredReferenceSignature = useMemo(
    () => filteredReferenceEntries.map((entry) => entry.key).join('\0'),
    [filteredReferenceEntries],
  );

  useEffect(() => {
    if (filteredReferenceEntries.length === 0) {
      setSelectedReferenceKey((current) => (current === '' ? current : ''));
      return;
    }
    setSelectedReferenceKey((current) =>
      filteredReferenceEntries.some((entry) => entry.key === current)
        ? current
        : filteredReferenceEntries[0]!.key,
    );
  }, [filteredReferenceSignature]);

  // Filtered slash command list for the typeahead (fuzzy match on cmd + description).
  const filteredSlashCommands = useMemo<SlashCommandDef[]>(() => {
    const q = (slashCtx?.query ?? '').toLowerCase();
    if (!slashCtx) return [];
    const scored = getVisibleSlashCommands()
      .map((c) => ({
        cmd: c,
        score: slashCmdMatchScore(q, c),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.cmd.cmd.localeCompare(b.cmd.cmd))
      .map((s) => s.cmd);
    return scored;
  }, [slashCtx]);

  const filteredSlashCommandsSignature = useMemo(
    () => filteredSlashCommands.map((command) => command.cmd).join('\0'),
    [filteredSlashCommands],
  );

  // Keep selectedSlashCmd in sync when filtered list changes
  useEffect(() => {
    setSelectedSlashCmd((current) =>
      resolveSlashCommandSelection(slashCtx?.query ?? '', filteredSlashCommands, current),
    );
  }, [filteredSlashCommandsSignature, slashCtx?.query]);

  useEffect(() => {
    if (slashCtx === null) {
      setSlashComboboxMetadata((current) => (current === null ? current : null));
      return;
    }
    const picker = slashTypeaheadRef.current;
    if (!picker) return;
    const next = {
      listboxId: picker.getListboxId(),
      activeDescendantId: picker.getActiveDescendantId(),
    };
    setSlashComboboxMetadata((current) =>
      current?.listboxId === next.listboxId &&
      current.activeDescendantId === next.activeDescendantId
        ? current
        : next,
    );
  }, [filteredSlashCommandsSignature, selectedSlashCmd, slashCtx]);

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
    const notes = findNotesCommand(ta.value, ta.selectionStart);
    if (notes && dismissedNotesRef.current !== ta.value) {
      setNotesCtx((current) =>
        current?.start === notes.start &&
        current?.end === notes.end &&
        current?.query === notes.query
          ? current
          : notes,
      );
      setSlashCtx(null);
      setMentionCtx(null);
      return;
    }
    setNotesCtx(null);
    setSlashCtx(notes ? null : getSlashContext(ta.value, ta.selectionStart));
  };

  const activateTokenBoss = (mode: ReasoningMode, remainingText = '') => {
    const currentSelection = useAuthStore.getState().chatModelSelection;
    const tokenProvider = tokenBossProviderForMode(mode, currentSelection);
    setText(remainingText);
    setSlashCtx(null);
    setOptionPickerCtx(null);
    if (!tokenProvider) {
      toast.warning(
        'Token Boss unavailable',
        'Select a supported single model, then choose Token Final Boss from /mode.',
      );
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    requestTokenBoss({
      chatId: String(chatId),
      providerId: tokenProvider.id,
      restoreFocus: textareaRef.current,
      allowAudio: navigator.userActivation?.isActive === true,
    });
  };

  const insertSlashCommand = (cmd: SlashCommandDef) => {
    if (!slashCtx || !textareaRef.current) return;
    const ta = textareaRef.current;
    const before = text.slice(0, slashCtx.start);
    const after = text.slice(ta.selectionStart);

    const canonicalCmd = normalizeSlashCmd(cmd.cmd);
    if (canonicalCmd === 'notes') {
      setText(before + '/notes' + after);
      dismissedNotesRef.current = null;
      setNotesCtx({ start: before.length, end: before.length + 6, query: '' });
      setSlashCtx(null);
      return;
    }

    // Immediate local commands are actions, not decorative confirmed chips.
    // Selecting one with Enter runs locally and never reaches provider dispatch.
    if (isImmediateLocalSlashCommand(canonicalCmd)) {
      setText(before + after);
      setSlashCtx(null);
      requestAnimationFrame(() => void handleSend(`/${canonicalCmd}`));
      return;
    }

    // `/hive` switches to the Hive ensemble when the product surface is enabled.
    if (canonicalCmd === 'hive') {
      setText(before + after);
      setSlashCtx(null);
      if (isHiveProductEnabled()) {
        setChatModelSelection(selectionFromHive('balanced'));
        setConfirmedCommands((cur) => {
          const entry = buildSlashReferenceCommand(cmd);
          return [...cur.filter((c) => c.value !== entry.value), entry];
        });
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    const isReferenceCommand =
      (canonicalCmd === 'terminals' || cmd.category === 'navigation') &&
      !isChatAttachSlashCmd(canonicalCmd);

    if (isReferenceCommand) {
      setText(before + after);
      setConfirmedCommands((cur) => {
        const entry = buildSlashReferenceCommand(cmd);
        return [...cur.filter((c) => c.value !== entry.value), entry];
      });
      setSlashCtx(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // /clearfiles (and aliases) — clear attachments immediately + confirmed chip
    if (canonicalCmd === 'clearfiles') {
      setText(before + after);
      setAttachedFiles([]);
      setAttachedImages([]);
      const flashId = `clear:${Date.now()}`;
      setConfirmedCommands((cur) => [
        ...cur.filter((c) => c.cmd !== 'clearfiles'),
        { cmd: 'clearfiles', value: flashId, label: '/clearfiles · cleared' },
      ]);
      window.setTimeout(() => {
        setConfirmedCommands((cur) =>
          cur.filter((c) => !(c.cmd === 'clearfiles' && c.value === flashId)),
        );
      }, 2200);
      toast.info('Attachments cleared', 'All files and images removed from this message.');
      setSlashCtx(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // Commands with structured choices open the same keyboard-first option-picker flow.
    if (
      cmd.hasOptions &&
      (isChatAttachSlashCmd(cmd.cmd) ||
        normalizeSlashCmd(cmd.cmd) === 'permissions' ||
        normalizeSlashCmd(cmd.cmd) === 'agent' ||
        canonicalCmd === 'cli' ||
        canonicalCmd === 'chat' ||
        cmd.cmd === 'effort' ||
        cmd.cmd === 'mode' ||
        cmd.cmd === 'rlm' ||
        cmd.cmd === 'permissions' ||
        canonicalCmd === 'md' ||
        cmd.cmd === 'theme' ||
        isGlobalThemePickerCommand(cmd.cmd))
    ) {
      setText(before + after);
      setSlashCtx(null);
      setSelectedOptionId(
        isGlobalThemePickerCommand(cmd.cmd)
          ? useUIStore.getState().theme
          : cmd.cmd === 'theme'
            ? loadConsolePreferences().profile
            : canonicalCmd === 'cli'
              ? (chatBackendAffinity?.backend ?? 'opencode')
              : canonicalCmd === 'chat'
                ? storedChatEngine(String(chatId))
                : cmd.cmd === 'rlm'
                  ? resolveRlmEnabled({
                      chatId: String(chatId),
                      workspaceId: workspaceId ?? undefined,
                    }).enabled
                    ? 'on'
                    : 'off'
                  : cmd.cmd === 'effort' || cmd.cmd === 'mode'
                    ? (buildReasoningSlashPickerState({
                        command: cmd.cmd,
                        selection: reasoningSelectionFromChatModel(chatModelSelection),
                        preference: reasoningPreference,
                      }).selectedId ?? '')
                    : '',
      );
      setOptionPickerCtx({ cmd, query: '' });
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // Model picker
    if (canonicalCmd === 'model' && cmd.hasOptions) {
      setText(before + after);
      setSlashCtx(null);
      setModelPickerOpen(true);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // Utility / no-arg commands become confirmed chips (cool effect) when possible
    if (!cmd.takesArg) {
      setText(before + after);
      setConfirmedCommands((cur) => [
        ...cur.filter((c) => c.cmd !== canonicalCmd),
        {
          cmd: canonicalCmd,
          value: `confirmed:${canonicalCmd}`,
          label: `/${canonicalCmd}`,
        },
      ]);
      setSlashCtx(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // Commands that take free-text args: keep slash in the draft at the caret
    // so the user can finish typing (e.g. /multitask fix the bug).
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

  const chooseChatBackend = async (backend: ChatBackend): Promise<void> => {
    try {
      const next = await selectPersistedChatBackend(
        dexieChatBackendPersistence,
        String(chatId),
        backend,
        Date.now(),
      );
      if (backend === 'codex' && chatModelSelection.mode !== 'single') {
        const option = accessibleChatModels.flatOptions.find(
          (option) => option.connectionId === 'openai-codex',
        );
        const selection = selectionFromOption(
          'openai',
          option?.modelId ?? 'gpt-5.4-mini',
          getProviderConnectionDescriptor('openai-codex'),
        );
        if (selection.mode === 'single') {
          await chatRepo.update(chatId as ChatId, {
            connection: {
              ...getProviderConnectionDescriptor('openai-codex'),
              modelId: selection.modelId,
            },
          });
          setRetainedExactChatSelection(selection);
          setChatModelSelection(selection);
        }
      }
      toast.info(
        `${backend === 'codex' ? 'Codex' : 'OpenCode'} selected`,
        next.locked
          ? 'This chat backend is locked because the conversation has started.'
          : 'The backend will lock after the first message is sent.',
      );
    } catch (error) {
      if (error instanceof ChatBackendLockedError) {
        toast.warning(
          'Chat backend is locked',
          `This chat already uses ${error.currentBackend === 'codex' ? 'Codex' : 'OpenCode'}. Start a new chat to switch.`,
        );
        return;
      }
      toast.error('Backend not changed', 'The chat backend could not be saved safely.');
    }
  };

  const selectOption = (option: SlashCommandOption) => {
    if (!optionPickerCtx) return;
    const cmd = optionPickerCtx.cmd;
    const canonical = normalizeSlashCmd(cmd.cmd);

    if (canonical === 'chat') {
      const targetEngine = option.id === 'browser' ? 'browser' : 'native';
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setText('');
      void transitionChatEngine({
        chatId: String(chatId),
        targetEngine,
      }).then((result) => {
        if (result.status === 'failed') {
          toast.error('Could not switch chat mode', 'The current chat was left unchanged.');
        } else {
          useUIStore.getState().setActiveChat(result.chatId);
          useUIStore.getState().setRoute('chat');
        }
      });
      return;
    }

    if (
      canonical === 'cli' &&
      (option.id === 'status' || option.id === 'opencode' || option.id === 'codex')
    ) {
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setText('');
      if (option.id !== 'status') void chooseChatBackend(option.id);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // /agent: open the selected live subagent/multitask child thread (native).
    if (canonical === 'agent') {
      openNativeChildChat(option.id);
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setText('');
      toast.info('Opened agent thread', `${option.label} — parent chat stays in your tabs.`);
      return;
    }

    if (cmd.cmd === 'allaboutme' && option.id === 'retake') {
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setSettingsOpen(true);
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('jarvis:settings:tab', { detail: { tab: 'allaboutme' } }),
        );
        window.dispatchEvent(new CustomEvent('jarvis:allaboutme:retake'));
      }, 0);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (canonical === 'effort') {
      const effort = option.id === 'auto' ? null : parseReasoningEffortArgument(option.id);
      if (effort !== undefined) {
        writeChatReasoningEffort(String(chatId), effort);
        setReasoningPreference(readChatReasoningPreference(String(chatId)));
      }
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (canonical === 'mode') {
      const mode = parseReasoningModeArgument(option.id);
      if (mode) {
        applyChatReasoningMode(String(chatId), mode);
        setReasoningPreference(readChatReasoningPreference(String(chatId)));
        if (mode === 'token-final-boss') activateTokenBoss(mode);
      }
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (canonical === 'rlm') {
      const action = parseRlmSlashArgument(option.id);
      if (action === 'on' || action === 'off') {
        const resolved = setChatRlmEnabled(String(chatId), action === 'on');
        void messageRepo.create({
          chat_id: chatId as ChatId,
          role: 'system',
          parts: [{ kind: 'text', text: formatRlmStatus(resolved, { projectId, workspaceId }) }],
        });
      } else if (action === 'status') {
        void messageRepo.create({
          chat_id: chatId as ChatId,
          role: 'system',
          parts: [
            {
              kind: 'text',
              text: formatRlmStatus(
                resolveRlmEnabled({
                  chatId: String(chatId),
                  workspaceId: workspaceId ?? undefined,
                }),
                { projectId, workspaceId },
              ),
            },
          ],
        });
      } else if (action === 'refresh') {
        markRlmIndexRefreshed();
        window.dispatchEvent(new CustomEvent('jarvis:context-tree-updated'));
        void messageRepo.create({
          chat_id: chatId as ChatId,
          role: 'system',
          parts: [
            {
              kind: 'text',
              text: formatRlmStatus(
                resolveRlmEnabled({
                  chatId: String(chatId),
                  workspaceId: workspaceId ?? undefined,
                }),
                { projectId, workspaceId },
              ),
            },
          ],
        });
      } else if (action === 'trace') {
        useUIStore.getState().setRoute('context');
      }
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setText('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (canonical === 'md' && isMarkdownDocumentKind(option.id)) {
      setConfirmedCommands((current) => [
        ...current.filter((command) => command.cmd !== 'md'),
        { cmd: 'md', value: option.id, label: `/md: ${option.label}` },
      ]);
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // /permissions picker: set Agent / Plan / Ask mode only — never attach a chip.
    if (canonical === 'permissions') {
      const parsed = parsePermissionSlashArg(option.id);
      if (parsed?.kind === 'mode') {
        applyInteractionMode(parsed.value);
      }
      if (parsed?.kind === 'status') {
        const accessState = readPermissionAccess(String(chatId));
        void messageRepo.create({
          chat_id: chatId as ChatId,
          role: 'system',
          parts: [
            {
              kind: 'text',
              text: formatPermissionPolicy({
                mode: interactionMode,
                access: accessState.access,
                approveAll: accessState.approveAll,
              }),
            },
          ],
        });
      }
      setConfirmedCommands((cur) => cur.filter((c) => c.cmd !== 'permissions'));
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      setText('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (canonical === 'canvas' && option.id === 'canvas:snapshot') {
      const currentAuth = useAuthStore.getState();
      const snapshot = captureActiveCanvasSnapshot({
        accountId: resolveAccountIdentity(currentAuth)?.accountId ?? '',
        projectId: currentAuth.projectId,
      });
      if (snapshot === null) {
        toast.warning(
          'Canvas snapshot unavailable',
          'Open the active Canvas for this project and try again.',
        );
      } else {
        const image = canvasSnapshotToImageAttachment(snapshot);
        setAttachedImages((current) => appendComposerMedia(current, [image]));
      }
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // /file picker: attach project file path + show confirmed chip
    if (canonical === 'file') {
      const path = option.id;
      if (isSupportedImagePath(path)) {
        void imageAttachmentFromPath(path)
          .then((image) => {
            setAttachedImages((cur) => appendComposerMedia(cur, [image]));
          })
          .catch((err) => {
            toast.error(
              'Image attach failed',
              err instanceof Error ? err.message : 'Could not attach image.',
            );
          });
      } else {
        setAttachedFiles((cur) => [...cur, path].slice(0, 24));
      }
      setConfirmedCommands((cur) => [
        ...cur.filter((c) => !(c.cmd === 'file' && c.value === path)),
        { cmd: 'file', value: path, label: `/file: ${option.label}` },
      ]);
      setOptionPickerCtx(null);
      setSelectedOptionId('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

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
    const next = before + after;
    setText(next);
    setConfirmedAgentMentions((cur) => {
      if (cur.some((mention) => mention.id === agent.id)) return cur;
      return [...cur, buildConfirmedAgentMention(agent)].slice(0, 8);
    });
    setMentionCtx(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      const pos = before.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  const insertCatalogReference = (entry: ReferenceCatalogEntry) => {
    if (entry.kind === 'agent') {
      const agent = Object.values(agents).find((candidate) => candidate.id === entry.entityId);
      if (agent) insertMention(agent);
      return;
    }
    if (!mentionCtx || !textareaRef.current) return;
    const ta = textareaRef.current;
    const before = text.slice(0, mentionCtx.start);
    const after = text.slice(ta.selectionStart);
    setText(before + after);
    setConfirmedCatalogReferences((current) => {
      const confirmed = buildConfirmedCatalogReference(entry);
      if (current.some((reference) => reference.key === confirmed.key)) return current;
      return [...current, confirmed].slice(0, 8);
    });
    setMentionCtx(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(before.length, before.length);
    });
  };

  const handleSlashCommand = async (trimmed: string): Promise<boolean | string> => {
    if (isComposerInstantCommandSource(trimmed)) {
      if (instantCommandInFlightRef.current) return true;
      instantCommandInFlightRef.current = true;
      setText('');
      setSlashCtx(null);
      try {
        const auth = useAuthStore.getState();
        const interactionId = `chat-${crypto.randomUUID()}`;
        const result = await submitComposerInstantCommand({
          source: trimmed,
          interactionId,
          accountId: resolveAccountIdentity(auth)?.accountId ?? 'local-account',
          workspaceId: String(workspaceId ?? auth.workspaceId ?? 'local-workspace'),
          projectId: String(projectId ?? auth.projectId ?? 'local-project'),
        });
        if (!result.handled || !result.ok) {
          toast.warning('Invalid command', result.handled ? result.message : 'Unknown command.');
        }
      } finally {
        instantCommandInFlightRef.current = false;
      }
      return true;
    }
    if (!trimmed.startsWith('/')) return false;
    const [cmdRaw, ...restParts] = trimmed.slice(1).split(/\s+/);
    const classification = classifySlashCommand(cmdRaw ?? '');
    const cmd = classification?.command ?? normalizeSlashCmd(cmdRaw ?? '');
    const rest = restParts.join(' ').trim();
    const addSystem = async (msg: string) => {
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'system',
        parts: [{ kind: 'text', text: msg }],
      });
      setText('');
    };
    if (!classification) {
      await addSystem(`Unknown slash command: /${cmd}. Try /help.`);
      return true;
    }
    const openAttachPicker = (canonicalCmd: string) => {
      const def = findSlashCommandDef(canonicalCmd);
      if (!def) return false;
      const reasoningState =
        def.cmd === 'effort' || def.cmd === 'mode'
          ? buildReasoningSlashPickerState({
              command: def.cmd,
              selection: reasoningSelectionFromChatModel(chatModelSelection),
              preference: reasoningPreference,
            })
          : null;
      setText('');
      setSlashCtx(null);
      setSelectedOptionId(
        isGlobalThemePickerCommand(def.cmd)
          ? useUIStore.getState().theme
          : def.cmd === 'theme'
            ? loadConsolePreferences().profile
            : normalizeSlashCmd(def.cmd) === 'cli'
              ? (chatBackendAffinity?.backend ?? 'opencode')
              : normalizeSlashCmd(def.cmd) === 'chat'
                ? storedChatEngine(String(chatId))
                : (reasoningState?.selectedId ?? ''),
      );
      setOptionPickerCtx({ cmd: def, query: '' });
      requestAnimationFrame(() => textareaRef.current?.focus());
      return true;
    };
    if (cmd === 'fast' || cmd === 'performance' || cmd === 'rlm') {
      const parsed = parseChatRuntimeCommand(`/${cmd}${rest ? ` ${rest}` : ''}`);
      if (!parsed) {
        await addSystem(`Invalid /${cmd} value. Use /${cmd} status for the current setting.`);
        return true;
      }
      const result = applyChatRuntimeCommand(runtimePolicy.settings, parsed);
      if (parsed.kind === 'fast' && (parsed.value === 'on' || parsed.value === 'off') &&
          chatBackendAffinity?.backend !== 'codex' && chatModelSelection.mode === 'single') {
        const route = findFastModelRoute(chatModelSelection, accessibleChatModels.flatOptions, parsed.value === 'on');
        if (route && route.modelId !== chatModelSelection.modelId) {
          const selection = selectionFromOption(route.provider, route.modelId, route.connection);
          if (selection.mode === 'single' && selection.connectionId) {
            await chatRepo.update(chatId as ChatId, {
              connection: { ...getProviderConnectionDescriptor(selection.connectionId), modelId: selection.modelId },
            });
          }
          setRetainedExactChatSelection(selection.mode === 'single' ? selection : null);
          setChatModelSelection(selection);
        }
      }
      const next = writeChatRuntimePolicyState(String(chatId), {
        ...runtimePolicy,
        settings: result.settings,
      });
      setRuntimePolicy(next);
      if (result.kind === 'action') {
        await addSystem(
          result.action === 'refresh-rlm'
            ? 'RLM refresh requested for the next turn.'
            : 'RLM trace is available in the Context diagnostics surface.',
        );
      } else if (result.kind === 'picker') {
        await addSystem(
          `Use /${cmd} ${cmd === 'fast' ? 'on | off | status' : cmd === 'performance' ? 'responsive | balanced | quality | status' : 'on | off | status | refresh | trace'}.`,
        );
      } else {
        await addSystem(result.message);
      }
      return true;
    }
    if (cmd === 'access') {
      const value = rest.toLowerCase();
      if (!value || value === 'status') {
        await addSystem(`Access: ${runtimePolicy.access}`);
        return true;
      }
      const access =
        value === 'read' || value === 'readonly' || value === 'read-only'
          ? 'read-only'
          : value === 'write' || value === 'write-access'
            ? 'write'
            : value === 'full' || value === 'full-access'
              ? 'full'
              : null;
      if (!access) {
        await addSystem('Use /access read-only | write | full | status.');
        return true;
      }
      const next = writeChatRuntimePolicyState(String(chatId), { ...runtimePolicy, access });
      setRuntimePolicy(next);
      await addSystem(`Access set to ${access}. Interaction mode remains ${interactionMode}.`);
      return true;
    }
    if (cmd === 'approveall' || cmd === 'approve-all') {
      const value = rest.toLowerCase();
      if (!value || value === 'status') {
        await addSystem(
          `Approve All for next run: ${runtimePolicy.approveAllForRun ? 'on' : 'off'}`,
        );
        return true;
      }
      if (value !== 'on' && value !== 'off') {
        await addSystem('Use /approveall on | off | status.');
        return true;
      }
      const next = writeChatRuntimePolicyState(String(chatId), {
        ...runtimePolicy,
        approveAllForRun: value === 'on',
      });
      setRuntimePolicy(next);
      await addSystem(
        value === 'on'
          ? 'Approve All enabled for the next scoped run only; hard denies remain enforced.'
          : 'Approve All disabled.',
      );
      return true;
    }
    if (cmd === 'effort' && rest) {
      const parsed = parseChatRuntimeCommand(`/effort ${rest}`);
      if (parsed) {
        const requested =
          parsed.kind === 'effort' && parsed.value && parsed.value !== 'status'
            ? parsed.value
            : null;
        if (requested && liveAuthorityRejectsEffort(requested, authoritativeLiveEfforts)) {
          const available = authoritativeLiveEfforts!
            .filter((effort) => effort !== 'auto')
            .join(', ');
          await addSystem(
            `Effort “${requested}” is not available for the selected live model. Available: ${available || 'Auto'}.`,
          );
          return true;
        }
        const result = applyChatRuntimeCommand(runtimePolicy.settings, parsed);
        const next = writeChatRuntimePolicyState(String(chatId), {
          ...runtimePolicy,
          settings: result.settings,
        });
        setRuntimePolicy(next);
        if (result.kind === 'updated' || result.kind === 'status') await addSystem(result.message);
        if (result.kind === 'updated') {
          const effort =
            requested === 'auto' ? null : (requested ?? parseReasoningEffortArgument(rest));
          if (effort !== undefined) {
            writeChatReasoningEffort(String(chatId), effort);
            setReasoningPreference(readChatReasoningPreference(String(chatId)));
          }
        }
        return true;
      }
    }
    if (cmd === 'effort') {
      if (rest) {
        const effort = parseReasoningEffortArgument(rest);
        if (effort !== undefined) {
          const normalized = effort ?? 'auto';
          if (liveAuthorityRejectsEffort(normalized, authoritativeLiveEfforts)) {
            const available = authoritativeLiveEfforts!
              .filter((candidate) => candidate !== 'auto')
              .join(', ');
            await addSystem(
              `Effort “${normalized}” is not available for the selected live model. Available: ${available || 'Auto'}.`,
            );
            return true;
          }
          writeChatReasoningEffort(String(chatId), effort);
          setReasoningPreference(readChatReasoningPreference(String(chatId)));
          setText('');
          return true;
        }
      }
      openAttachPicker('effort');
      return true;
    }
    if (cmd === 'mode') {
      if (rest) {
        const mode = parseReasoningModeArgument(rest);
        if (mode) {
          applyChatReasoningMode(String(chatId), mode);
          setReasoningPreference(readChatReasoningPreference(String(chatId)));
          setText('');
          if (mode === 'token-final-boss') activateTokenBoss(mode);
          return true;
        }
      }
      openAttachPicker('mode');
      return true;
    }
    if (cmd === 'cli') {
      const requested = rest.toLowerCase();
      if (!requested) {
        openAttachPicker('cli');
        return true;
      }
      if (requested === 'status') {
        const affinity = chatBackendAffinity;
        await addSystem(
          affinity
            ? `CLI: ${affinity.backend === 'codex' ? 'Codex' : 'OpenCode'}${affinity.locked ? ' · locked for this chat' : ' · locks after the first message'}`
            : 'CLI backend is still loading. Try again.',
        );
        return true;
      }
      if (requested !== 'opencode' && requested !== 'codex') {
        await addSystem('Usage: /cli opencode | codex | status');
        return true;
      }
      await chooseChatBackend(requested);
      setText('');
      return true;
    }
    if (cmd === 'chat') {
      openAttachPicker('chat');
      return true;
    }
    if (cmd === 'permissions' || cmd === 'permission' || cmd === 'perms') {
      const parsed = rest ? parsePermissionSlashArg(rest) : undefined;
      if (parsed?.kind === 'mode') {
        applyInteractionMode(parsed.value);
        // Mode change only — do not attach /permissions as a confirmed chip.
        setConfirmedCommands((cur) => cur.filter((c) => c.cmd !== 'permissions'));
        setText('');
        return true;
      }
      if (parsed?.kind === 'status') {
        const accessState = readPermissionAccess(String(chatId));
        await addSystem(
          formatPermissionPolicy({
            mode: interactionMode,
            access: accessState.access,
            approveAll: accessState.approveAll,
          }),
        );
        return true;
      }
      if (rest && !parsed) {
        await addSystem('Usage: /permissions agent | plan | ask');
        return true;
      }
      openAttachPicker('permissions');
      return true;
    }
    if (cmd === 'ask') {
      applyInteractionMode('ask');
      if (rest) return rest;
      setText('');
      return true;
    }
    if (cmd === 'plan') {
      applyInteractionMode('plan');
      if (rest) return rest;
      setText('');
      return true;
    }
    if (cmd === 'goal') {
      if (!rest) {
        await addSystem(
          'Use /goal <objective>. VibeSpace runs the actual registered OpenCode goal command.',
        );
        return true;
      }
      applyInteractionMode('agent');
      // Preserve the canonical slash payload. The persistent OpenCode adapter
      // validates the live command catalog and invokes session.command; it must
      // never be flattened into an ordinary provider prompt.
      return `/goal ${rest}`;
    }
    if (cmd === 'schedule' && rest) {
      return buildVibeSpaceReferenceRequest('schedule', rest);
    }
    // /agent — live subagent selector (does not spawn; use /multitask or /subagents).
    if (cmd === 'agent') {
      const live = useJarvisInteractionStore.getState().agentsByChat[String(chatId)] ?? [];
      const options = agentSelectorOptions(live);
      if (options.length === 0) {
        await addSystem(
          'No live subagents for this chat. Spawn with /multitask <task> or /subagents <task>, then use /agent to open a thread.',
        );
        setText('');
        return true;
      }
      openAttachPicker('agent');
      setText('');
      return true;
    }
    if (cmd === 'multitask' || cmd === 'subagents') {
      applyInteractionMode('agent');
      if (!rest) {
        await addSystem(
          `Use /${cmd} <task> to ask this session to launch provider-native subagents.`,
        );
        return true;
      }
      await requestNativeDelegation({ parentChatId: chatId, task: rest,
        modelSelection: chatModelSelection, commandName: cmd, repos: { chatRepo, messageRepo } });
      toast.info('Native delegation requested', 'The parent session will launch and coordinate its subagents at the next turn boundary.');
      setText('');
      return true;
    }
    if (cmd === 'usage') {
      const usageMode = parseUsageSlashCommand(trimmed);
      if (!usageMode) {
        await addSystem('Usage commands: /usage, /usage refresh, /usage session, /usage all.');
        return true;
      }
      const persistedChat = await chatRepo.getById(chatId as ChatId).catch(() => undefined);
      const selectedConnection = resolveUsageConnection({
        persistedConnection: persistedChat?.connection,
        selectedConnectionId:
          chatModelSelection.mode === 'single' ? chatModelSelection.connectionId : undefined,
        selectedModelId:
          chatModelSelection.mode === 'single' ? chatModelSelection.modelId : undefined,
        fallbackProviderId: provider,
        fallbackModelId:
          selectedModels[provider] || defaultModelForProvider(provider, defaultLocalModel),
        connections: PROVIDER_CONNECTIONS,
      });
      if (!selectedConnection) {
        await addSystem(
          'Usage is unavailable until this chat has an exact AI connection selected.',
        );
        return true;
      }
      const snapshots =
        usageMode === 'all'
          ? await getAllUsage(
              PROVIDER_CONNECTIONS.filter((connection) => connection.enabled).map((connection) =>
                connection.id === selectedConnection.id ? selectedConnection : connection,
              ),
              chatId as ChatId,
            )
          : [
              usageMode === 'refresh'
                ? await refreshUsage(selectedConnection, chatId as ChatId)
                : await getUsage(selectedConnection, chatId as ChatId, usageMode),
            ];
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'system',
        parts: [
          { kind: 'usage_card', snapshots, scope: usageMode === 'all' ? 'all' : 'connection' },
        ],
      });
      setText('');
      return true;
    }
    if (cmd === 'vibecheck') {
      const { openVibeCheck } = await import('./vibe-check/vibeCheckStore');
      openVibeCheck(String(chatId));
      setText((current) => current.trim().toLowerCase() === '/vibecheck' ? '' : current);
      return true;
    }
    if (cmd === 'doctor') {
      if (rest && rest.toLowerCase() !== 'run') {
        await addSystem('Use /doctor or /doctor run.');
        return true;
      }
      await addSystem('VibeSpace Doctor is checking supported systems…');
      const report = await runVibeSpaceDoctor();
      await addSystem(report.text);
      return true;
    }
    if (cmd === 'mcp') {
      if (rest) {
        await addSystem('Use /mcp to open MCP connections and custom server management.');
        return true;
      }
      setText('');
      requestOpenMcpManager();
      return true;
    }
    if (cmd === 'appearance') {
      if (!rest) return openAttachPicker(cmd);
      const nextTheme = parseThemeCommandArgument(rest);
      if (!nextTheme) {
        await addSystem(getAppearanceCommandHelp());
        return true;
      }
      useUIStore.getState().setTheme(nextTheme);
      const label = SELECTABLE_THEMES.find((theme) => theme.id === nextTheme)?.label ?? nextTheme;
      await addSystem(`Appearance changed to ${label}.`);
      return true;
    }
    if (cmd === 'theme') {
      if (!rest) return openAttachPicker('theme');
      const presentation = parseChatPresentationCommand(`/${cmd}${rest ? ` ${rest}` : ''}`);
      if (!presentation) return false;
      if (presentation.kind === 'console-theme-help') {
        await addSystem(presentation.notice);
        return true;
      }
      if (presentation.kind === 'console-theme') {
        updateConsolePreferences({ profile: presentation.profile, view: 'agentic' });
        await addSystem(presentation.notice);
        return true;
      }
      const nextTheme = parseThemeCommandArgument(presentation.argument);
      if (!nextTheme) {
        await addSystem(getAppearanceCommandHelp());
        return true;
      }
      useUIStore.getState().setTheme(nextTheme);
      const label = SELECTABLE_THEMES.find((theme) => theme.id === nextTheme)?.label ?? nextTheme;
      await addSystem(presentation.notice ?? `Appearance changed to ${label}.`);
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
      setText('');
      if (!isHiveProductEnabled()) {
        await addSystem('Hive is not available in this build.');
        return true;
      }
      setChatModelSelection(selectionFromHive('balanced'));
      if (rest) return rest;
      await addSystem('Switched chat model to Hive — the 5-model balanced ensemble.');
      return true;
    }
    if (cmd === 'md') {
      if (!rest) return openAttachPicker('md');
      const parsed = parseMarkdownSlashArgument(rest);
      if (!parsed) {
        await addSystem(
          `Markdown document types: ${MARKDOWN_DOCUMENT_OPTIONS.map(({ id }) => id).join(', ')}. Use /md <type> <brief>.`,
        );
        return true;
      }
      const option = MARKDOWN_DOCUMENT_OPTIONS.find(({ id }) => id === parsed.kind);
      setConfirmedCommands((current) => [
        ...current.filter((command) => command.cmd !== 'md'),
        { cmd: 'md', value: parsed.kind, label: `/md: ${option?.label ?? parsed.kind}` },
      ]);
      setText('');
      return parsed.brief || true;
    }
    if (cmd === 'canvas' && !rest) return openAttachPicker('canvas');
    const routes: Record<string, string> = {
      kanban: 'kanban',
      canvas: 'canvas',
      history: 'history',
      tools: 'tools',
      agents: 'agents',
      schedule: 'schedule',
    };
    if (cmd in routes) {
      const def = findSlashCommandDef(cmd);
      const reference = def
        ? confirmedCommandReferenceText([buildSlashReferenceCommand(def)])
        : `Context references: /${cmd} references ${routes[cmd]}.`;
      const scopedReference = disableRouteSlashCommands
        ? `${reference} This sidebar stays attached to the current project.`
        : reference;
      return rest ? `${scopedReference} ${rest}` : scopedReference;
    }
    if (cmd === 'terminals') {
      const def = findSlashCommandDef('terminals');
      const reference = def
        ? confirmedCommandReferenceText([buildSlashReferenceCommand(def)])
        : 'Context references: /terminals references Terminal surface.';
      return rest ? `${reference} ${rest}` : reference;
    }
    if (cmd === 'context') {
      if (rest) {
        const projectId = useAuthStore.getState().projectId;
        const maps = projectId
          ? (getActiveContextPersistenceState(projectId)?.maps ?? contextMaps)
          : [];
        const target = rest.toLowerCase();
        const matched = maps.find((m: ContextMapRecord) =>
          (m.name ?? '').toLowerCase().includes(target),
        );
        if (!matched) {
          await addSystem(`No context map matching '${rest}'. Use /context to pick from the list.`);
          return true;
        }
        const root = matched.tree?.nodes?.[0];
        if (!root) {
          await addSystem(`Context map '${matched.name}' has no nodes.`);
          return true;
        }
        const attachment = buildMapSummaryChatAttachment(matched);
        setAttachedContexts((cur) =>
          cur.some(
            (item) => contextChatAttachmentKey(item) === contextChatAttachmentKey(attachment),
          )
            ? cur
            : [...cur, attachment].slice(0, 8),
        );
        setText('');
        await addSystem(`Attached context map '${matched.name}' to this chat.`);
        return true;
      }
      if (openAttachPicker('context')) return true;
      await addSystem(
        'No context maps yet. Open Context and press "Make Context Map", then use /context here.',
      );
      return true;
    }
    if (cmd === 'plug') {
      openAttachPicker('plug');
      return true;
    }
    if (cmd === 'skills') {
      if (rest) {
        const target = rest.toLowerCase();
        const matched = getAllCatalogSkills().find(
          (skill) =>
            skill.id.toLowerCase() === target ||
            skill.name.toLowerCase() === target ||
            skill.name.toLowerCase().includes(target),
        );
        if (!matched) {
          await addSystem(`No skill matching '${rest}'. Use /skills to inspect the catalog.`);
          return true;
        }
        setConfirmedCommands((current) => [
          ...current.filter(
            (command) => !(command.cmd === 'skills' && command.value === matched.id),
          ),
          { cmd: 'skills', value: matched.id, label: `/skills: ${matched.name}` },
        ]);
        setText('');
        return true;
      }
      const available = getAllCatalogSkills()
        .map((skill) => `- ${skill.name} (${skill.id}) - ${skill.description}`)
        .join('\n');
      await addSystem(
        `Available skills:\n${available}\n\nType /skills and choose one from the dropdown to apply it to your next message.`,
      );
      return true;
    }
    if (cmd === 'allaboutme') {
      if (rest) {
        const direct = ALL_ABOUT_ME_SLASH_OPTIONS.find(
          (option) => option.id === rest || option.label.toLowerCase().includes(rest.toLowerCase()),
        );
        if (direct?.id === 'retake') {
          setSettingsOpen(true);
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent('jarvis:settings:tab', { detail: { tab: 'allaboutme' } }),
            );
            window.dispatchEvent(new CustomEvent('jarvis:allaboutme:retake'));
          }, 0);
          setText('');
          return true;
        }
      }
      if (openAttachPicker('allaboutme')) return true;
      return true;
    }
    if (cmd === 'attach') {
      if (!rest || !isSafeAbsoluteAttachmentPath(rest)) {
        await addSystem('Use /attach <absolute path>. Relative paths and traversal are rejected.');
        return true;
      }
      setAttachedFiles((cur) => (cur.includes(rest) ? cur : [...cur, rest]).slice(0, 8));
      setText('');
      return true;
    }
    if (cmd === 'clearfiles') {
      setAttachedFiles([]);
      setAttachedImages([]);
      setText('');
      toast.info('Attachments cleared', 'All files and images removed from this message.');
      return true;
    }
    if (cmd === 'output') {
      setText('');
      window.dispatchEvent(
        new CustomEvent('jarvis:chat:output', {
          detail: { chatId: String(chatId) },
        }),
      );
      return true;
    }
    if (cmd === 'undo') {
      if (jarvisRunning) {
        await addSystem(UNDO_BLOCKED_RUNNING_TEXT);
        return true;
      }
      const history = await messageRepo.listByChat(chatId as ChatId);
      const turn = selectLastUndoableTurn(history);
      if (turn.length === 0) {
        await addSystem(NOTHING_TO_UNDO_TEXT);
        return true;
      }
      // Delete oldest-first so partial failure still leaves a consistent prefix.
      for (const message of turn) {
        await messageRepo.delete(message.id);
      }
      pushRedoTurn({
        chatId: String(chatId),
        messages: turn,
        undoneAt: Date.now(),
      });
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'system',
        parts: [{ kind: 'text', text: `${UNDO_STATUS_TEXT} ${summarizeUndoTurn(turn)}` }],
      });
      setText('');
      return true;
    }
    if (cmd === 'redo') {
      if (jarvisRunning) {
        await addSystem(REDO_BLOCKED_RUNNING_TEXT);
        return true;
      }
      const turn = popRedoTurn(String(chatId));
      if (!turn || turn.messages.length === 0) {
        await addSystem(NOTHING_TO_REDO_TEXT);
        return true;
      }
      // Restore chronological order with original ids/timestamps.
      for (const message of turn.messages) {
        await messageRepo.create({
          id: message.id,
          chat_id: message.chat_id,
          role: message.role,
          agent_id: message.agent_id,
          parts: message.parts,
          parent_id: message.parent_id,
          usage: message.usage,
          created_at: message.created_at,
          updated_at: message.updated_at,
        });
      }
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'system',
        parts: [{ kind: 'text', text: REDO_STATUS_TEXT }],
      });
      setText('');
      return true;
    }
    if (cmd === 'help') {
      const hiveHelp = isHiveProductEnabled() ? '/hive, ' : '';
      await addSystem(
        'Chat slash commands work at the start, middle, or end of a message. ' +
          `/agents, /terminals, ${hiveHelp}/kanban, /history, /tools, /schedule become confirmed reference chips. ` +
          '/context, /plug, /skills, /file open pickers. /file lists files in your open project. ' +
          '/attach <path>, /clearfiles (or /clearfile) clears attachments. ' +
          '/undo removes the last full turn; /redo restores it. ' +
          '/usage, /model, /rlm, /permissions, /theme, /appearance, /commands, /multitask, /ask, /plan.',
      );
      return true;
    }
    if (cmd === 'commands') {
      await addSystem(
        `Jarvis command catalog (${JARVIS_COMMAND_CATALOG.length}):\n${JARVIS_COMMAND_CATALOG.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      );
      return true;
    }
    if (cmd === 'file') {
      if (rest) {
        // Resolve by absolute path or by name within project options
        let path = rest;
        if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(rest)) {
          const listed = await listProjectFileOptions({ projectId });
          const match =
            listed.options.find((o) => o.label.toLowerCase() === rest.toLowerCase()) ||
            listed.options.find((o) => o.label.toLowerCase().includes(rest.toLowerCase()));
          if (match) path = match.id;
        }
        if (isSupportedImagePath(path)) {
          try {
            const image = await imageAttachmentFromPath(path);
            setAttachedImages((cur) => appendComposerMedia(cur, [image]));
            setText('');
            return true;
          } catch (err) {
            toast.error(
              'Image attach failed',
              err instanceof Error ? err.message : 'Could not attach image.',
            );
            return true;
          }
        }
        setAttachedFiles((cur) => [...cur, path].slice(0, 24));
        setText('');
        return true;
      }
      // Open project file picker (same as selecting /file from typeahead)
      const root = getStoredProjectRoot(projectId);
      if (!root) {
        toast.info('No project open', 'Open a project folder in Files, then use /file to attach.');
        setText('');
        return true;
      }
      openAttachPicker('file');
      return true;
    }
    await addSystem(`Command /${cmd} is registered but has no executable VibeSpace route.`);
    return true;
  };

  const currentComposerAttachments: QueuedComposerAttachments = {
    files: attachedFiles,
    images: attachedImages,
    terminals: attachedTerminals,
    plugins: attachedPlugins,
    contexts: attachedContexts,
    commands: confirmedCommands,
    agents: confirmedAgentMentions,
    catalog: confirmedCatalogReferences,
  };
  const currentComposerNotes = attachedNotes;
  const handleSend = async (
    overrideText?: string,
    options: {
      attachments?: QueuedComposerAttachments;
      bypassQueue?: boolean;
      flushMode?: QueueFlushMode;
      promptForgeApproved?: boolean;
      handoffPayload?: ReturnType<typeof buildComposerChatHandoffPayload> | null;
      submittedVisibleHandoffKey?: string | null;
    } = {},
  ): Promise<boolean> => {
    const {
      files: attachedFiles,
      images: attachedImages,
      terminals: attachedTerminals,
      plugins: attachedPlugins,
      contexts: attachedContexts,
      commands: confirmedCommands,
      agents: confirmedAgentMentions,
      catalog: confirmedCatalogReferences,
    } = options.attachments ?? currentComposerAttachments;
    const attachedNotes = options.attachments ? [] : currentComposerNotes;
    if (notesCtx || notesSendingRef.current) return false;
    if (attachedNotes.length && jarvisRunning) {
      toast.warning(
        'Notes are ready',
        'Wait for this response to finish before sending note references.',
      );
      return false;
    }
    const draftText = overrideText ?? text;
    const directlySubmittedDraftEditRevision = handoffDraftEditRevisionRef.current;
    const directlySubmittedVisibleHandoffKey =
      options.handoffPayload === undefined && pendingHandoff
        ? composerChatHandoffDeliveryKey(
            buildComposerChatHandoffPayload({
              projection: pendingHandoff,
              additionalProjections: additionalHandoffs,
              instruction: handoffInstruction,
              draftText,
            }),
          )
        : null;
    const trimmed = draftText.trim();
    const hasConfirmedCommands = confirmedCommands.length > 0;
    const hasConfirmedAgentMentions = confirmedAgentMentions.length > 0;
    const hasConfirmedCatalogReferences = confirmedCatalogReferences.length > 0;
    if (
      (!trimmed &&
        attachedFiles.length === 0 &&
        attachedImages.length === 0 &&
        attachedTerminals.length === 0 &&
        attachedPlugins.length === 0 &&
        attachedContexts.length === 0 &&
        attachedNotes.length === 0 &&
        !pendingHandoff &&
        !options.handoffPayload &&
        !hasConfirmedCommands &&
        !hasConfirmedAgentMentions &&
        !hasConfirmedCatalogReferences) ||
      sending
    )
      return false;
    // Pull utility slash tokens from anywhere in the message (start/middle/end)
    // so "/clearfiles" or "/file readme.md" works even mid-sentence.
    const inline = extractInlineUtilitySlashCommands(trimmed);
    let handledUtilityOnly = false;
    for (const util of inline.utilities) {
      const cmd = normalizeSlashCmd(util.cmd);
      // /file with no target needs the picker UI — don't open it during send.
      if (cmd === 'file' && !util.rest) continue;
      const payload = util.rest ? `/${cmd} ${util.rest}` : `/${cmd}`;
      const handled = await handleSlashCommand(payload);
      if (handled === true) handledUtilityOnly = true;
    }
    const afterInline = inline.utilities.length > 0 ? inline.cleaned : trimmed;
    const canvasAttachmentModes = resolveCanvasAttachmentModesForSend(
      confirmedCommands,
      afterInline,
    );

    // Leading full-message slash (multitask, ask, plan, etc.)
    const slashResult = await handleSlashCommand(afterInline);
    if (slashResult === true) return true;
    // When a route slash command has a remainder (e.g. "/terminals close 5 terminals"),
    // handleSlashCommand returns the remainder text so we send it as the message.
    let rawSendText = typeof slashResult === 'string' ? slashResult.trim() : afterInline;

    // Message was only utility slash tokens (e.g. just /clearfiles) — done.
    if (
      handledUtilityOnly &&
      !rawSendText &&
      confirmedCommands.length === 0 &&
      confirmedAgentMentions.length === 0 &&
      confirmedCatalogReferences.length === 0 &&
      attachedFiles.length === 0 &&
      attachedImages.length === 0 &&
      attachedTerminals.length === 0 &&
      attachedPlugins.length === 0 &&
      attachedContexts.length === 0 &&
      attachedNotes.length === 0 &&
      !pendingHandoff &&
      !options.handoffPayload
    ) {
      return true;
    }

    // Drafting and local slash commands remain available while the selected backend is down.
    // Nothing provider-bound may queue or dispatch until its runtime is ready.
    if (backendRuntimeBlocked) return false;

    const caoDecision = bootstrapCaoLearning({
      text: rawSendText,
      confirmedReferenceKeys: confirmedCatalogReferences.map((reference) => reference.key),
    });
    if (!caoDecision?.control && jarvisRunning && !options.bypassQueue && (!overrideText || options.promptForgeApproved)) {
      // Send button defaults to after-run; Enter passes after-tool explicitly.
      if (!enqueueCurrentMessage(trimmed, options.flushMode ?? 'after-run')) return false;
      playUiSound('chat_message_send');
      return true;
    }

    if (caoDecision?.control) {
      const accountId = resolveAccountIdentity(useAuthStore.getState())?.accountId ?? '';
      if (!accountId || !workspaceId || !projectId) {
        toast.error('CAO control unavailable', 'An exact account, workspace, and project are required.');
        return false;
      }
      const commandMessage = await messageRepo.create({ chat_id: chatId as ChatId, role: 'user', parts: [{ kind: 'text', text: rawSendText }] });
      window.dispatchEvent(new CustomEvent('jarvis:user-command', { detail: {
        origin: 'user', chatId: String(chatId), messageId: commandMessage.id, text: rawSendText,
      } }));
      setCaoCommandInput({ nonce: crypto.randomUUID(), command: caoDecision.control });
      setText('');
      return true;
    }
    const currentReasoning = readChatReasoningPreference(String(chatId));
    const currentRuntime = readChatRuntimePolicyState(String(chatId));
    const invalidEffort = [currentReasoning.effortOverride, currentRuntime.settings.effort].find(
      (value): value is EffortLabel =>
        value !== null && liveAuthorityRejectsEffort(value, authoritativeLiveEfforts),
    );
    if (invalidEffort && !caoDecision) {
      toast.error(
        'Cannot send',
        `Effort “${invalidEffort}” is not available for the selected live model.`,
      );
      return false;
    }

    // Shared Prompt Upgrade Engine: optional auto-upgrade before Send.
    // Manual Upgrade button still opens preview/edit. On failure, fall back to original.
    // Skip when caller already provided overrideText (queued flush / smoke helpers).
    if (
      promptForgeAutoUpgradeRef.current &&
      !overrideText &&
      !options.promptForgeApproved &&
      !promptForge.isDraftApproved(rawSendText) &&
      !requestsReadOnlyContextTool(rawSendText) &&
      rawSendText.trim().length > 0 &&
      promptForgeUpgradeForSendRef.current
    ) {
      try {
        const upgraded = await promptForgeUpgradeForSendRef.current(rawSendText);
        if (upgraded.reason === 'cancelled') return false;
        if (upgraded.requiresReview) return true;
        if (upgraded.upgraded && upgraded.text.trim()) {
          rawSendText = upgraded.text.trim();
        } else if (
          upgraded.reason &&
          upgraded.reason !== 'empty' &&
          upgraded.reason !== 'cancelled'
        ) {
          toast.info('Sent original prompt', upgraded.reason);
        }
      } catch {
        toast.info(
          'Sent original prompt',
          'Prompt upgrade failed. Your original text was sent instead.',
        );
      }
    }

    const interactionModeForSend = useJarvisInteractionStore.getState().modeForChat(chatId);
    const mentionPrefix = confirmedAgentMentions.map((mention) => mention.label).join(' ');
    const catalogReferencePrefix = confirmedCatalogReferenceTextForSend(confirmedCatalogReferences);
    const referenceText = confirmedCommandReferenceText(confirmedCommands);
    const allAboutMeCommand = confirmedCommands.find(
      (command) => command.cmd === 'allaboutme' && command.value,
    );
    let allAboutMeText = '';
    let forceAllAboutMeUpdate = false;
    if (allAboutMeCommand?.value) {
      const optionId = allAboutMeCommand.value as AllAboutMeSlashOptionId;
      const messageCount = await messageRepo.countByChat(chatId as ChatId);
      if (optionId === 'force-update') {
        const status = allAboutMeChatUpdateStatus(messageCount);
        if (!status.ok) {
          await messageRepo.create({
            chat_id: chatId as ChatId,
            role: 'system',
            parts: [{ kind: 'text', text: status.message }],
          });
          setConfirmedCommands((cur) => cur.filter((command) => command.cmd !== 'allaboutme'));
          return true;
        }
        forceAllAboutMeUpdate = true;
      }
      allAboutMeText = buildAllAboutMeSlashText(
        optionId,
        useAllAboutMeStore.getState().markdown,
        messageCount,
      );
    }
    const markdownCommand = confirmedCommands.find(
      (command) => command.cmd === 'md' && command.value && isMarkdownDocumentKind(command.value),
    );
    const markdownInstruction =
      markdownCommand?.value && isMarkdownDocumentKind(markdownCommand.value)
        ? buildMarkdownCreationInstruction({
            kind: markdownCommand.value,
            brief: rawSendText,
            projectRoot: getStoredProjectRoot(projectId),
            fullyLocal: offlineMode,
          })
        : '';
    const handoffPayload =
      options.handoffPayload !== undefined
        ? options.handoffPayload
        : pendingHandoff
          ? buildComposerChatHandoffPayload({
              projection: pendingHandoff,
              additionalProjections: additionalHandoffs,
              instruction: handoffInstruction,
              draftText: markdownInstruction || rawSendText,
            })
          : null;
    const sendText = [
      mentionPrefix,
      catalogReferencePrefix,
      referenceText,
      allAboutMeText,
      handoffPayload ? handoffPayload.text : markdownInstruction || rawSendText,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    let auth = useAuthStore.getState();
    let selectedForSend = restoreExactChatSelection(
      auth.chatModelSelection,
      retainedExactChatSelection,
    );
    const confirmedSkillIdsForSend = confirmedCommands
      .filter((confirmed) => confirmed.cmd === 'skills' && confirmed.value)
      .map((confirmed) => confirmed.value!)
      .slice(0, 6);
    const caoBootstrap = resolveComposerCaoBootstrap({
      decision: caoDecision,
      selectedModel: selectedForSend,
      skillIds: confirmedSkillIdsForSend,
    });
    if (caoBootstrap) selectedForSend = caoBootstrap.modelSelection;
    // Refresh Ollama discovery before gating local sends so a connected
    // daemon is not blocked by a stale empty catalog.
    if (
      selectedForSend.mode === 'single' &&
      (selectedForSend.providerId === 'ollama' || selectedForSend.providerId === 'local')
    ) {
      try {
        const { bootstrapOllamaConnection } = await import('@/lib/ai/ollamaBootstrap');
        await bootstrapOllamaConnection({ waitTimeoutMs: 8_000 });
      } catch {
        // Validation / provider still report a clear local-model error.
      }
      auth = useAuthStore.getState();
      selectedForSend = restoreExactChatSelection(
        auth.chatModelSelection,
        retainedExactChatSelection,
      );
    }
    const sendCheck = validateSendModelAccess(
      sendText,
      selectedForSend,
      modelSelectionContextFromAuth(auth),
      auth.stackCustomSteps,
      {
        attachments: { hasImages: attachedImages.length > 0, hasFiles: attachedFiles.length > 0 },
        tools: attachedPlugins.length > 0,
      },
    );
    if (!sendCheck.ok) {
      toast.error('Cannot send', sendCheck.message);
      return false;
    }

    // Process confirmed commands before sending
    const skillIds = caoBootstrap?.skillIds ?? confirmedSkillIdsForSend;
    let nextAttachedFiles = [...attachedFiles];
    let nextAttachedTerminals = attachedTerminals;
    let nextAttachedPlugins = attachedPlugins;
    let nextAttachedContexts = attachedContexts;
    if (attachedNotes.length) {
      notesSendingRef.current = true;
      try {
        const scope = currentNoteScope();
        if (!scope || attachedNotes.some((ref) => !sameNoteScope(ref, scope)))
          throw new Error('Return to the referenced account/project or remove these note chips.');
        const records = await getNotesWorkspace(scope).resolve(attachedNotes.map((ref) => ref.id));
        const attachments = await buildNoteContextAttachments(records, scope);
        nextAttachedContexts = [...nextAttachedContexts, ...attachments];
        await verifyNotesContextCapacity(attachments, nextAttachedContexts, scope, sendText);
        if (!currentNoteScope() || !sameNoteScope(currentNoteScope()!, scope))
          throw new Error('The account or project changed. Your message has not been sent.');
      } catch (error) {
        toast.error(
          'Cannot send notes',
          error instanceof Error ? error.message : 'Open Notes, retry saving, then send again.',
        );
        return false;
      } finally {
        notesSendingRef.current = false;
      }
    }
    if (canvasAttachmentModes.length > 0) {
      const currentAuth = useAuthStore.getState();
      const accountId = resolveAccountIdentity(currentAuth)?.accountId ?? '';
      const canvasAttachments: ContextChatAttachment[] = [];
      for (const mode of canvasAttachmentModes) {
        const resolved = buildActiveCanvasChatAttachments(
          { accountId, projectId: currentAuth.projectId },
          mode,
        );
        if (resolved.length === 0) {
          toast.warning(
            mode === 'selection' ? 'No Canvas selection attached' : 'No active Canvas attached',
            mode === 'selection'
              ? 'Select one or more objects on the active Canvas and try again.'
              : 'Open the Canvas for this project and try again.',
          );
          return false;
        }
        canvasAttachments.push(...resolved);
      }
      for (const attachment of canvasAttachments) {
        if (
          !nextAttachedContexts.some(
            (context) => contextChatAttachmentKey(context) === contextChatAttachmentKey(attachment),
          )
        ) {
          nextAttachedContexts = [...nextAttachedContexts, attachment];
        }
      }
    }
    for (const confirmed of confirmedCommands) {
      if (confirmed.value?.startsWith('reference:')) continue;
      if (confirmed.value?.startsWith('confirmed:')) continue;
      if (confirmed.cmd === 'clearfiles') continue;
      if (confirmed.cmd === 'permissions') continue;
      if (normalizeSlashCmd(confirmed.cmd) === 'file' && confirmed.value) {
        const path = confirmed.value;
        if (!isSupportedImagePath(path)) {
          nextAttachedFiles = nextAttachedFiles.includes(path)
            ? nextAttachedFiles
            : [...nextAttachedFiles, path].slice(0, 8);
        }
        continue;
      }
      if (normalizeSlashCmd(confirmed.cmd) === 'terminals' && confirmed.value) {
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
      } else if (normalizeSlashCmd(confirmed.cmd) === 'context' && confirmed.value) {
        const maps = projectId
          ? (getActiveContextPersistenceState(projectId)?.maps ?? contextMaps)
          : [];
        const matched = resolveContextMapRecord(maps, confirmed.value);
        if (matched?.tree?.nodes?.[0]) {
          const attachment = buildMapSummaryChatAttachment(matched);
          nextAttachedContexts = nextAttachedContexts.some(
            (context) => contextChatAttachmentKey(context) === contextChatAttachmentKey(attachment),
          )
            ? nextAttachedContexts
            : [...nextAttachedContexts, attachment];
        }
      }
    }
    const confirmedMentionsForSend = confirmedAgentMentions;
    if (!options.attachments) {
      setConfirmedCommands([]);
      setConfirmedAgentMentions([]);
      setConfirmedCatalogReferences([]);
    }

    setSending(true);
    try {
      if (nextAttachedTerminals.length > 0) {
        const scheduled = parseTerminalScheduleRequest(sendText);
        if (scheduled) {
          scheduleTerminalCommandFromChat(
            nextAttachedTerminals,
            scheduled.command,
            scheduled.runAt,
          );
          await messageRepo.create({
            chat_id: chatId as ChatId,
            role: 'system',
            parts: [
              {
                kind: 'text',
                text: `Scheduled terminal message for ${formatUserDateTime(scheduled.runAt)}: ${scheduled.command}`,
              },
            ],
          });
          setText('');
          setAttachedTerminals([]);
          setMentionCtx(null);
          toast.success('Terminal message scheduled', formatUserDateTime(scheduled.runAt));
          return true;
        }
      }
      // Repo stamps id + timestamps + bumps parent chat.updated_at.
      // The runtime listener (started in App.tsx) will read history
      // from the same store after we dispatch the event below — so it
      // sees the user turn we just wrote and skips creating its own
      // user message. (See runtime.ts: prior versions wrote a second
      // copy here, producing the duplicate-bubble bug surfaced in the
      // AI-router audit.)
      // New real user turns invalidate redo history for this chat.
      clearRedoStack(String(chatId));
      let oversizedAttachment: Awaited<ReturnType<typeof createOversizedMessageAttachment>> = null;
      if (!handoffPayload) {
        try {
          oversizedAttachment = await createOversizedMessageAttachment(sendText);
        } catch {
          toast.warning(
            'Long-message attachment unavailable',
            'The message will remain inline so none of your text is lost.',
          );
        }
      }
      const persistedText = resolveComposerPersistedText({
        sendText,
        handoff: Boolean(handoffPayload),
        oversizedSummary: oversizedAttachment ? oversizedMessageSummary(oversizedAttachment) : null,
      });
      const mentionedAgentIds = resolveMentionedAgentIdsForSend(
        sendText,
        agents,
        confirmedMentionsForSend,
      );
      const mentionedPluginIds = extractPluginMentions(sendText, PLUGIN_CATALOG);
      const pluginIds = Array.from(new Set([...nextAttachedPlugins, ...mentionedPluginIds])).slice(
        0,
        8,
      );
      const messageFilePaths = resolveSendFilePaths({
        attachedFiles: nextAttachedFiles,
        sendText,
        ...(oversizedAttachment ? { oversizedPath: oversizedAttachment.path } : {}),
        supportsFiles: connectionSupportsFileAttachments(selectedForSend),
      });
      const tokenOptimizationPreferences = browserTokenOptimizationPreferences.getSnapshot();
      const tokenOptimizationMode = browserTokenOptimizationPreferences.resolveMode(String(chatId));
      // UI keeps full videos; vision path only receives image/* (+ sampled frames).
      const visionAttachments = await visionAttachmentsForSend(attachedImages);
      if (attachedNotes.length) {
        const scope = currentNoteScope();
        if (
          !scope ||
          attachedNotes.some((ref) => !sameNoteScope(ref, scope)) ||
          attachedNotes.map(noteReferenceKey).join('\n') !==
            attachedNotesRef.current.map(noteReferenceKey).join('\n') ||
          (!overrideText && textRef.current !== draftText)
        ) {
          throw new Error(
            'The note references, project, or draft changed while preparing this message. Review it and send again.',
          );
        }
        await verifyNotesContextCapacity(
          nextAttachedContexts.filter((context) => context.mapId.startsWith('notes:')),
          nextAttachedContexts,
          scope,
          sendText,
        );
      }
      const persistUserMessage = () =>
        messageRepo.create({
          chat_id: chatId as ChatId,
          role: 'user',
          parts: [
            { kind: 'text', text: persistedText },
            ...(handoffPayload ? handoffPayload.parts : []),
            ...attachedImages.map((image) => ({
              kind: 'image' as const,
              url: `data:${image.mimeType};base64,${image.data}`,
              alt: image.name,
            })),
            ...(oversizedAttachment
              ? [
                  {
                    kind: 'file_ref' as const,
                    ref: {
                      kind: 'file' as const,
                      id: oversizedAttachment.path,
                      excerpt: 'Temporary long-message attachment · expires after 24 hours',
                    },
                  },
                ]
              : []),
            ...nextAttachedFiles.map((path) => ({
              kind: 'file_ref' as const,
              ref: { kind: 'file' as const, id: path },
            })),
            ...nextAttachedTerminals.map((ref) => ({
              kind: 'file_ref' as const,
              ref: {
                kind: 'memory' as const,
                id: `terminal:${terminalRefKey(ref)}`,
                excerpt: `Terminal reference: ${terminalRefLabel(ref)}`,
              },
            })),
            ...nextAttachedContexts.map((context) => ({
              kind: 'file_ref' as const,
              ref: {
                kind: 'memory' as const,
                id: `context:${contextChatAttachmentKey(context)}`,
                excerpt: `Context: ${context.title}`,
              },
            })),
          ],
        });
      const dispatchUserMessage = async (userMessage: Message, requireAcceptance: boolean) => {
        activeCancellationKeyRef.current = String(userMessage.id);
        const detail = {
          chatId,
          cancellationKey: userMessage.id,
          text: persistedText,
          mentionedAgentIds,
          filePaths: messageFilePaths,
          imageAttachments: visionAttachments,
          terminalRefs: nextAttachedTerminals,
          contextNodes: nextAttachedContexts,
          pluginIds,
          skillIds,
          forceAllAboutMeUpdate,
          interactionMode: interactionModeForSend,
          speakReply: voiceReplyRequestedRef.current || useAuthStore.getState().speakReplies,
          autoApproveActions: useAuthStore.getState().jarvisAutoApprove,
          modelSelectionOverride: selectedForSend,
          reasoningPreference:
            caoBootstrap?.reasoningPreference ?? readChatReasoningPreference(String(chatId)),
          runtimeSettings: caoBootstrap
            ? { ...runtimePolicy.settings, effort: CAO_LEARNER_IDENTITY.reasoningEffort }
            : runtimePolicy.settings,
          accessLevel: runtimePolicy.access,
          approveAllForRun: runtimePolicy.approveAllForRun,
          tokenOptimizationMode,
          tokenOptimizationOutputLimit: tokenOptimizationPreferences.defaultMaxOutputTokens,
          showTokenOptimizationReport:
            tokenOptimizationPreferences.showOptimizationReportAutomatically,
          allowStructuralCodeCompression:
            tokenOptimizationPreferences.allowStructuralCodeCompression,
          // The model chosen in Composer is an explicit user override.
          automaticModelRoutingEligible: false,
          ...(caoBootstrap
            ? {
                caoAuthority: caoBootstrap.requestedIdentity,
                caoBootstrap: caoBootstrap.publicStatus,
              }
            : {}),
        };
        if (requireAcceptance) await dispatchComposerSendWithAcceptance(detail);
        else window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
      };
      let userMessage: Message;
      const submittedHandoffKey = handoffPayload
        ? composerChatHandoffDeliveryKey(handoffPayload)
        : null;
      if (handoffPayload) {
        const delivery = await deliverComposerChatHandoff({
          key: submittedHandoffKey!,
          previousReceipt: pendingHandoffDeliveriesRef.current.get(submittedHandoffKey!),
          persist: persistUserMessage,
          dispatch: (message) => dispatchUserMessage(message, true),
        });
        if (delivery.receipt) {
          pendingHandoffDeliveriesRef.current.set(submittedHandoffKey!, delivery.receipt);
        }
        if (!delivery.ok) throw delivery.error;
        userMessage = delivery.receipt.value;
        pendingHandoffDeliveriesRef.current.delete(submittedHandoffKey!);
      } else {
        userMessage = await persistUserMessage();
        await dispatchUserMessage(userMessage, false);
      }
      if (runtimePolicy.approveAllForRun) {
        const cleared = clearApproveAllForRun(String(chatId));
        setRuntimePolicy(cleared);
      }
      voiceReplyRequestedRef.current = false;
      if ((!overrideText || options.promptForgeApproved) &&
          (!handoffPayload || handoffDraftEditRevisionRef.current === directlySubmittedDraftEditRevision)) setText('');
      if (!options.attachments) {
        setAttachedFiles([]);
        setAttachedImages([]);
        setAttachedTerminals([]);
        setAttachedPlugins([]);
        setAttachedContexts([]);
        setAttachedNotes([]);
      }
      const currentVisibleHandoffKey = pendingHandoffRef.current
        ? composerChatHandoffDeliveryKey(
            buildComposerChatHandoffPayload({
              projection: pendingHandoffRef.current,
              additionalProjections: additionalHandoffsRef.current,
              instruction: handoffInstructionRef.current,
              draftText:
                directlySubmittedVisibleHandoffKey &&
                handoffDraftEditRevisionRef.current === directlySubmittedDraftEditRevision
                  ? draftText
                  : textRef.current,
            }),
          )
        : null;
      const submittedVisibleHandoffKey = handoffPayload
        ? (options.submittedVisibleHandoffKey ??
          directlySubmittedVisibleHandoffKey ??
          submittedHandoffKey)
        : null;
      if (
        shouldClearComposerHandoff({
          submittedHandoffKey: submittedVisibleHandoffKey,
          currentVisibleHandoffKey,
          handoffPayloadProvided: options.handoffPayload !== undefined,
        })
      ) {
        pendingHandoffRef.current = null;
        setPendingHandoff(null);
        additionalHandoffsRef.current=[];setAdditionalHandoffs([]);
      }
      setMentionCtx(null);
      playUiSound('chat_message_send');
      return true;
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
      toast.error('Message not sent', formatComposerSendFailure());
      return false;
    } finally {
      setSending(false);
    }
  };

  const queueSideSendRef = useRef(handleSend);
  queueSideSendRef.current = handleSend;
  useEffect(() => {
    if (modelSelectionReadyChatId !== String(chatId)) return;
    return registerQueueSideSender(String(chatId), (message, projection) =>
      queueSideSendRef.current(message.text, {
        bypassQueue: true,
        attachments: message.attachments,
        handoffPayload: buildComposerChatHandoffPayload({
          projection,
          instruction: 'Use the embedded source conversation as context for this request.',
          draftText: message.text,
        }),
      }),
    );
  }, [chatId, modelSelectionReadyChatId]);

  const [sideOpeningId, setSideOpeningId] = useState<string | null>(null);
  const openQueueInSideChat = async (id: string) => {
    if (queuedDispatchInFlightRef.current) return;
    const queued = queuedMessagesRef.current.find((message) => message.id === id);
    if (!queued) return;
    queuedDispatchInFlightRef.current = id;
    setSideOpeningId(id);
    try {
      if (await openQueuedSideChat(String(chatId), queued)) deleteQueuedMessage(id);
      else
        toast.error('Message remains queued', 'The side chat did not accept it. Retry when ready.');
    } catch (error) {
      toast.error(
        'Side chat not sent',
        error instanceof Error ? error.message : 'Your message remains queued.',
      );
    } finally {
      queuedDispatchInFlightRef.current = null;
      setSideOpeningId(null);
    }
  };

  const dispatchQueuedMessage = (queued: QueuedChatMessage, payload = queued.text) => {
    if (queuedDispatchInFlightRef.current) return;
    queuedDispatchInFlightRef.current = queued.id;
    void dispatchQueuedMessageAfterAcceptance(
      queued,
      payload,
      (nextPayload) => {
        const queuedHandoff = queuedHandoffsRef.current.get(queued.id);
        return handleSend(nextPayload, {
          bypassQueue: true,
          attachments: queued.attachments,
          handoffPayload: queuedHandoff?.payload ?? null,
          submittedVisibleHandoffKey: queuedHandoff?.visibleHandoffKey ?? null,
        });
      },
      (acceptedId) => {
        queuedHandoffsRef.current.delete(acceptedId);
        setQueuedMessages((current) => {
          const remaining = current.filter((message) => message.id !== acceptedId);
          queuedMessagesRef.current = remaining;
          return remaining;
        });
      },
    )
      .catch((error) => {
        // Fail closed: retain the queued item for retry.
        // eslint-disable-next-line no-console
        console.error('[Composer] queued send failed:', error);
        toast.error('Queued message not sent', formatComposerSendFailure());
      })
      .finally(() => {
        queuedDispatchInFlightRef.current = null;
      });
  };

  const interruptAndSendQueued = (id: string) => {
    if (queuedInterruptInFlightRef.current) return;
    const queued = queuedMessagesRef.current.find((message) => message.id === id);
    if (!queued) return;
    if (queuedHandoffsRef.current.has(id) && jarvisRunning) {
      toast.info(
        'Handoff remains queued',
        'A handoff keeps its accepted snapshot and structured receipt, so it will send after this reply finishes.',
      );
      return;
    }
    if (!jarvisRunning || !activeCancellationKeyRef.current) {
      if (!jarvisRunning) dispatchQueuedMessage(queued);
      return;
    }
    if (queued.attachments && Object.values(queued.attachments).some((items) => items.length > 0)) {
      const reordered = [
        queued,
        ...queuedMessagesRef.current.filter((message) => message.id !== id),
      ];
      queuedMessagesRef.current = reordered;
      setQueuedMessages(reordered);
      window.dispatchEvent(
        new CustomEvent('jarvis:cancel', {
          detail: { messageId: activeCancellationKeyRef.current },
        }),
      );
      return;
    }
    queuedInterruptInFlightRef.current = queued.id;
    const reordered = [
      queued,
      ...queuedMessagesRef.current.filter((message) => message.id !== queued.id),
    ];
    queuedMessagesRef.current = reordered;
    setQueuedMessages(reordered);
    window.dispatchEvent(
      new CustomEvent('jarvis:steer', {
        detail: {
          chatId: String(chatId),
          text: queued.text,
          onAccepted: (cancellationKey: string) => {
            activeCancellationKeyRef.current = cancellationKey;
            setQueuedMessages((current) => {
              const remaining = current.filter((message) => message.id !== queued.id);
              queuedMessagesRef.current = remaining;
              return remaining;
            });
            queuedInterruptInFlightRef.current = null;
          },
          onRejected: () => {
            queuedInterruptInFlightRef.current = null;
            toast.error(
              'Steer not sent',
              'The active request could not accept this message. It remains queued for retry.',
            );
          },
        },
      }),
    );
    toast.info(
      'Steering current reply',
      'The active request is stopping, then this message will continue on the same session and model.',
    );
  };
  interruptQueuedRef.current = interruptAndSendQueued;

  const stopAndRestartQueuedModelSwitch = (id: string) => {
    const queued = queuedMessagesRef.current.find((message) => message.id === id);
    if (!queued || !parseJarvisModelSwitchIntent(queued.text)) return;
    interruptAndSendQueued(id);
  };

  const sendQueuedMessageNow = (id: string) => {
    const queued = queuedMessages.find((message) => message.id === id);
    if (!queued) return;
    if (jarvisRunning) {
      interruptAndSendQueued(id);
      return;
    }
    dispatchQueuedMessage(queued);
  };

  /** Same as typing `/multitask <message>` for a queued row (parallel agent work). */
  const startQueuedMultitask = (id: string) => {
    const queued = queuedMessages.find((message) => message.id === id);
    if (!queued) return;
    dispatchQueuedMessage(queued, buildQueuedMultitaskCommand(queued.text));
  };

  // Keep auto-flush bound to latest handleSend + queue (after handleSend is defined).
  flushNextQueuedRef.current = () => {
    if (
      !shouldDispatchNextQueuedMessage(
        sendingRef.current,
        queuedInterruptInFlightRef.current !== null,
      )
    )
      return;
    const { next } = takeNextQueuedMessage(queuedMessagesRef.current);
    if (!next) return;
    dispatchQueuedMessage(next);
  };

  // A reply can finish while this view is unmounted. Once its exact model is
  // restored, drain the retained queue; an explicitly paused run stays paused.
  useEffect(() => {
    if (modelSelectionReadyChatId !== String(chatId) || jarvisRunning || stoppedRequest ||
        queuedMessages.length === 0 || getChatRunState(String(chatId))) return;
    const timer = setTimeout(() => flushNextQueuedRef.current(), 60);
    return () => clearTimeout(timer);
  }, [chatId, queueScope, modelSelectionReadyChatId, jarvisRunning, stoppedRequest, queuedMessages.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (notesCtx) {
      notesPickerRef.current?.keyDown(e);
      return;
    }
    playComposerKeySound(e.nativeEvent);
    // Mod+Enter always sends, regardless of any popover state
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
      return;
    }

    if (e.shiftKey && e.key === 'Tab') {
      e.preventDefault();
      const nextMode = cycleInteractionMode(
        useJarvisInteractionStore.getState().modeForChat(chatId),
      );
      applyInteractionMode(nextMode);
      // Mode chip updates in place — no toast for routine mode cycles.
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
      if (e.key === 'Enter') {
        e.preventDefault();
        modelPickerRef.current?.selectCurrent();
        return;
      }
    }

    // Option picker navigation (highest priority when showing)
    if (optionPickerCtx) {
      if (anyThemePickerActive) {
        if (e.key === 'Escape') {
          e.preventDefault();
          themePickerRef.current?.cancel();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          themePickerRef.current?.moveDown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          themePickerRef.current?.moveUp();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          themePickerRef.current?.selectCurrent();
          return;
        }
      }
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
      if (filteredReferenceEntries.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const i = filteredReferenceEntries.findIndex(
            (entry) => entry.key === selectedReferenceKey,
          );
          const next =
            filteredReferenceEntries[
              (i + 1 + filteredReferenceEntries.length) % filteredReferenceEntries.length
            ]!;
          setSelectedReferenceKey(next.key);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const i = filteredReferenceEntries.findIndex(
            (entry) => entry.key === selectedReferenceKey,
          );
          const baseI = i === -1 ? 0 : i;
          const next =
            filteredReferenceEntries[
              (baseI - 1 + filteredReferenceEntries.length) % filteredReferenceEntries.length
            ]!;
          setSelectedReferenceKey(next.key);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const entry =
            filteredReferenceEntries.find((candidate) => candidate.key === selectedReferenceKey) ??
            filteredReferenceEntries[0];
          if (entry) insertCatalogReference(entry);
          return;
        }
      }
    }

    // Match the advertised Mod+Enter shortcut without changing the bare
    // Enter queue contract. Running turns keep their existing queue controls.
    if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey) && !jarvisRunning) {
      e.preventDefault();
      void handleSend(undefined, { flushMode: 'after-run' });
      return;
    }

    // Bare Tab while running: queue until the full reply finishes.
    if (
      e.key === 'Tab' &&
      !e.shiftKey &&
      jarvisRunning &&
      text.trim() &&
      !modelPickerOpen &&
      !optionPickerCtx &&
      !slashCtx &&
      !mentionCtx
    ) {
      e.preventDefault();
      enqueueCurrentMessage(text, 'after-run');
      return;
    }

    // Bare Enter: send when idle; queue after-tool when Jarvis is running.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const caoControl = bootstrapCaoLearning({
        text,
        confirmedReferenceKeys: confirmedCatalogReferences.map((reference) => reference.key),
      })?.control;
      if (jarvisRunning && text.trim() && !caoControl) {
        enqueueCurrentMessage(text, 'after-tool');
      } else {
        void handleSend(undefined, { flushMode: 'after-run' });
      }
      return;
    }

    if (e.key === 'Escape') {
      // Triple-Esc cancels the entire run (queue kept for resume/resend).
      if (jarvisRunning && !modelPickerOpen && !optionPickerCtx && !slashCtx && !mentionCtx) {
        const result = recordEscapePress(escapeCancelRef.current, Date.now());
        escapeCancelRef.current = result.state;
        if (result.shouldCancelRun) {
          e.preventDefault();
          suppressQueueFlushOnUserCancelRef.current = true;
          const cancellationKey = activeCancellationKeyRef.current;
          if (cancellationKey) {
            window.dispatchEvent(
              new CustomEvent('jarvis:cancel', { detail: { messageId: cancellationKey } }),
            );
          }
          toast.info(CANCELLED_BY_USER_TOAST.title, CANCELLED_BY_USER_TOAST.body);
          return;
        }
      }
      if (jarvisRunning && queuedMessagesRef.current[0]) {
        e.preventDefault();
        interruptAndSendQueued(queuedMessagesRef.current[0].id);
      }
    }
  };

  const promptForgePluginIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...attachedPlugins,
          ...confirmedCommands
            .filter((command) => command.cmd === 'plug' && command.value)
            .map((command) => command.value as string),
        ]),
      ),
    [attachedPlugins, confirmedCommands],
  );
  const promptForgeSkillIds = useMemo(
    () =>
      Array.from(
        new Set(
          confirmedCommands
            .filter((command) => command.cmd === 'skills' && command.value)
            .map((command) => command.value as string),
        ),
      ),
    [confirmedCommands],
  );
  const promptForgeAgents = useMemo(
    () =>
      confirmedAgentMentions
        .map((mention) => agents[mention.id])
        .filter((agent): agent is Agent => Boolean(agent)),
    [agents, confirmedAgentMentions],
  );
  const promptForgeSkills = useMemo(() => {
    const selected = new Set(promptForgeSkillIds);
    return getAllCatalogSkills().filter((skill) => selected.has(skill.id));
  }, [promptForgeSkillIds]);
  const promptForgeModels = useMemo(
    () => promptForgeModelOptionsFromPicker(accessibleChatModels.flatOptions),
    [accessibleChatModels.flatOptions],
  );
  const promptForgeAttachmentSnapshots = useMemo(
    () =>
      buildPromptForgeAttachmentSnapshots({
        files: attachedFiles,
        images: attachedImages.map((image) => ({
          id: image.id,
          label: image.name,
          reference: image.sourcePath ?? `image://${image.id}`,
        })),
        terminals: attachedTerminals,
        plugins: promptForgePluginIds.map((id) => ({
          id,
          label: PLUGIN_CATALOG.find((plugin) => plugin.id === id)?.name ?? id,
        })),
        contexts: attachedContexts.map((context) => ({
          id: contextChatAttachmentKey(context),
          label: context.title,
          reference: `context://${context.mapId}/${context.nodeId}`,
        })),
        skills: promptForgeSkills.map((skill) => ({ id: skill.id, label: skill.name })),
        agents: promptForgeAgents.map((agent) => ({
          id: String(agent.id),
          label: agent.name,
        })),
      }),
    [
      attachedContexts,
      attachedFiles,
      attachedImages,
      attachedTerminals,
      promptForgeAgents,
      promptForgePluginIds,
      promptForgeSkills,
    ],
  );
  const collectPromptForgeSources = useCallback(
    async ({
      job,
      signal,
      now,
    }: {
      job: Readonly<{ originalDraft: string }>;
      signal: AbortSignal;
      now: number;
    }) => {
      const [
        messages,
        persistedChat,
        persistedProject,
        persistedTasks,
        { jarvisMcpServerManager },
        { createJarvisActionCatalog, DEFAULT_JARVIS_ACTION_REGISTRATIONS },
        { getBuiltinAction },
        { useToolStore },
      ] = await Promise.all([
        messageRepo.listByChat(chatId as ChatId),
        chatRepo.getById(chatId as ChatId).catch(() => undefined),
        projectId
          ? projectRepo.getById(projectId as ProjectId).catch(() => undefined)
          : Promise.resolve(undefined),
        workspaceId
          ? taskRepo
              .list({
                workspace_id: workspaceId as WorkspaceId,
                status: ['open', 'in_progress', 'blocked'],
                limit: 64,
              })
              .catch(() => [])
          : Promise.resolve([]),
        import('@/lib/mcp/serverManager'),
        import('@/lib/jarvis/actions/catalog'),
        import('@/lib/actions/registry'),
        import('@/features/tools/toolStore'),
      ]);
      const projectRoot = getStoredProjectRoot(projectId);
      const terminalStates = (
        await Promise.all(
          attachedTerminals.slice(0, 8).map(async (ref) => {
            if (!ref.sessionId) return undefined;
            return terminalSessionRepo
              .getById(ref.sessionId as TerminalSessionId)
              .catch(() => undefined);
          }),
        )
      )
        .filter((session) => session !== undefined)
        .map((session) => ({
          sessionId: String(session.id),
          projectId: session.project_id ? String(session.project_id) : null,
          status: session.status,
          exitCode: session.exit_code,
          observedAt: session.last_active_at,
        }));
      const allAboutMeState = useAllAboutMeStore.getState();
      const allAboutMe =
        allAboutMeState.accountScope === pluginAccountId && allAboutMeState.markdown.trim()
          ? {
              accountId: allAboutMeState.accountScope,
              markdown: allAboutMeState.markdown,
              source: allAboutMeState.source,
              observedAt: allAboutMeState.updatedAt ?? now,
            }
          : undefined;
      const connections = selectPluginConnectionsForAccount(
        usePluginStore.getState(),
        pluginAccountId,
      );
      const connectedPlugins: PromptForgeComposerDescriptor[] = PLUGIN_CATALOG.filter((plugin) => {
        const connection = connections[plugin.id];
        return isPromptForgePluginConnected(plugin, connection, projectId);
      }).map((plugin) => ({
        id: plugin.id,
        label: plugin.name,
        description: [
          plugin.description,
          ...plugin.tools.map((tool) => `${tool.name}: ${tool.description}`),
          'Connection status: connected and enabled for the current project.',
        ].join('\n'),
        verified: true,
        reference: `plugin://${plugin.id}`,
        observedAt: connections[plugin.id]?.updatedAt ?? now,
      }));
      const plugins: PromptForgeComposerDescriptor[] = promptForgePluginIds.map((id) => {
        const plugin = PLUGIN_CATALOG.find((candidate) => candidate.id === id);
        return {
          id,
          label: plugin?.name ?? id,
          description: plugin
            ? [
                plugin.description,
                ...plugin.tools.map((tool) => `${tool.name}: ${tool.description}`),
              ].join('\n')
            : 'Attached plugin metadata is unavailable.',
          verified: isPromptForgePluginAvailable(plugin, connections[id], projectId),
          reference: `plugin://${id}`,
          observedAt: now,
        };
      });
      const activeAgents: PromptForgeComposerDescriptor[] = useJarvisInteractionStore
        .getState()
        .agentsForChat(chatId)
        .filter(
          (agent) =>
            String(agent.parentChatId) === String(chatId) &&
            !['done', 'failed', 'cancelled'].includes(agent.status),
        )
        .slice(0, 64)
        .map((agent) => {
          const observedAt = Date.parse(agent.updatedAt);
          return {
            id: String(agent.agentId),
            label: agent.name,
            description: [
              `Current task: ${agent.task}`,
              `Status: ${agent.status}`,
              agent.currentStep ? `Current step: ${agent.currentStep}` : null,
              `Observed model: ${agent.modelLabel}`,
            ].join('\n'),
            verified: true,
            reference: `agent://chat/${String(chatId)}/${String(agent.agentId)}`,
            observedAt:
              Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt <= now
                ? observedAt
                : undefined,
          };
        });
      const mcpTools: PromptForgeComposerDescriptor[] = jarvisMcpServerManager
        .discover()
        .filter(
          (status) =>
            status.kind === 'external_mcp' &&
            status.state === 'running' &&
            status.healthy &&
            status.exposedTools.length > 0,
        )
        .flatMap((status) =>
          status.exposedTools.slice(0, 64).map((toolName) => ({
            id: `${status.id}.${toolName}`,
            label: toolName,
            description: [
              `External MCP server: ${status.id}`,
              'Observed status: healthy and running.',
              'Exposure status: explicitly allowed for JARVIS.',
            ].join('\n'),
            verified: true,
            reference: `mcp://${status.id}/${toolName}`,
            observedAt: status.toolsDiscoveredAt ?? status.lastUsedAt ?? now,
          })),
        )
        .slice(0, 64);
      const appActions: PromptForgeComposerDescriptor[] = createJarvisActionCatalog(
        DEFAULT_JARVIS_ACTION_REGISTRATIONS,
      )
        .listExposed()
        .filter(
          (registration) =>
            registration.executor.kind === 'builtin' &&
            getBuiltinAction(registration.executor.registryActionId) !== undefined,
        )
        .map((registration) => ({
          id: registration.id,
          label: registration.title,
          description: [
            registration.description,
            `Risk: ${registration.risk}.`,
            `Approval policy: ${registration.approval}.`,
            `Expected effect: ${registration.expectedEffect}`,
            `Required capability: ${registration.requiredCapabilities[0]}.`,
            registration.requiredEntitlements.length > 0
              ? `Required entitlements: ${registration.requiredEntitlements.join(', ')}.`
              : 'Required entitlements: none declared.',
            'Registration is installed; execution still requires current capability, entitlement, and approval checks.',
          ].join('\n'),
          verified: true,
          reference: `action://${registration.id}/v${registration.version}`,
          observedAt: now,
        }));
      const accountIdentity = resolveAccountIdentity(useAuthStore.getState());
      const toolScope = getCurrentSyncQueueAuthorityScope();
      const toolScopeMatches =
        accountIdentity?.source === 'supabase'
          ? toolScope.state === 'cloud' && toolScope.userId === accountIdentity.accountId
          : accountIdentity?.source === 'local' && toolScope.state === 'unbound';
      const customTools: PromptForgeComposerDescriptor[] = toolScopeMatches
        ? useToolStore
            .getState()
            .list()
            .slice(0, 64)
            .map((tool) => {
              const actionIds =
                tool.steps && tool.steps.length > 0
                  ? tool.steps.map((step) => step.action)
                  : [tool.baseAction];
              const installed = actionIds.every((actionId) => Boolean(getBuiltinAction(actionId)));
              return {
                id: tool.slug,
                label: tool.name,
                description: [
                  tool.description,
                  `Saved action${actionIds.length === 1 ? '' : 's'}: ${actionIds.join(', ')}.`,
                  `Availability: ${installed ? 'installed' : 'contains an unavailable action'}.`,
                  'Preset parameter values are intentionally omitted.',
                ].join('\n'),
                verified: installed,
                reference: `tool://custom/${tool.slug}`,
                observedAt: tool.updatedAt,
              };
            })
        : [];
      const tasks = persistedTasks.map((task) => ({
        id: String(task.id),
        title: task.title,
        notes: task.notes?.slice(0, 4_000),
        status: task.status,
        priority: task.priority,
        projectId: task.project_id ? String(task.project_id) : null,
        contextTags: task.context_tags.slice(0, 16),
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for,
        reminderCount: task.reminders.filter(
          (reminder) => reminder.status === 'scheduled' || reminder.status === 'snoozed',
        ).length,
        updatedAt: task.updated_at,
      }));
      const composerSources = await collectPromptForgeComposerSources(
        {
          accountId: pluginAccountId,
          projectId,
          projectRoot,
          chatId: String(chatId),
          draft: job.originalDraft,
          chat: persistedChat
            ? {
                title: persistedChat.title,
                mode: persistedChat.mode,
                interactionMode,
                observedAt: persistedChat.updated_at,
              }
            : undefined,
          project:
            persistedProject && String(persistedProject.id) === projectId
              ? {
                  id: String(persistedProject.id),
                  name: persistedProject.name,
                  root: projectRoot,
                  systemPromptContext: persistedProject.system_prompt_context,
                  noContextMode: persistedProject.no_context_mode,
                  observedAt: persistedProject.updated_at,
                }
              : undefined,
          profile: allAboutMe,
          activity: getChatActivityEvents(chatId),
          files: attachedFiles,
          terminals: attachedTerminals,
          terminalStates,
          terminalSessions: useTerminalTranscriptStore.getState().sessions,
          messages,
          plugins,
          connectedPlugins,
          skills: promptForgeSkills.map((skill) => ({
            id: skill.id,
            label: skill.name,
            description: skill.description,
            verified: true,
            reference: `skill://${skill.id}`,
            observedAt: now,
          })),
          agents: promptForgeAgents.map((agent) => ({
            id: String(agent.id),
            label: agent.name,
            description: agent.description,
            verified: true,
            reference: `agent://${agent.slug}`,
            observedAt: now,
          })),
          activeAgents,
          mcpTools,
          appActions,
          customTools,
          tasks,
          now,
        },
        signal,
      );
      return mergeActiveCanvasSourcesForPromptForge(
        composerSources,
        pluginAccountId,
        projectId,
        useUIStore.getState().route === 'canvas',
      );
    },
    [
      attachedFiles,
      attachedTerminals,
      chatId,
      interactionMode,
      pluginAccountId,
      projectId,
      promptForgeAgents,
      promptForgePluginIds,
      promptForgeSkills,
      workspaceId,
    ],
  );
  const promptForge = usePromptForgeComposer({
    accountId: pluginAccountId,
    chatId: String(chatId),
    projectId,
    draft: text,
    setDraft: setText,
    originalAttachments: promptForgeAttachmentSnapshots,
    imageAttachments: attachedImages,
    contextAttachments: attachedContexts,
    additionalSources: COMPOSER_EMPTY_PROMPT_FORGE_SOURCES,
    collectAdditionalSources: collectPromptForgeSources,
    modelSelection: promptForgeModelSelection,
    modelOptions: promptForgeModels,
    currentChatSelection: chatModelSelection,
    offlineMode,
    defaultLocalModel,
    workingDirectory: getStoredProjectRoot(projectId) || undefined,
  });
  promptForgeUpgradeForSendRef.current = promptForge.upgradeForSend;
  const returnPromptForgeFocus = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    const onPromptForgeHotkey = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        document.activeElement !== textareaRef.current ||
        !matchesHotkey(event, resolveHotkey('PROMPT_FORGE')) ||
        promptForge.disabledReason
      ) {
        return;
      }
      event.preventDefault();
      void promptForge.start();
    };
    window.addEventListener('keydown', onPromptForgeHotkey);
    return () => window.removeEventListener('keydown', onPromptForgeHotkey);
  }, [promptForge.disabledReason, promptForge.start]);

  const canAttemptSlashWhileBackendBlocked =
    backendRuntimeBlocked &&
    (text.trimStart().startsWith('/') || isComposerInstantCommandSource(text));
  const hasDraft =
    text.trim().length > 0 ||
    attachedFiles.length > 0 ||
    attachedImages.length > 0 ||
    attachedTerminals.length > 0 ||
    attachedPlugins.length > 0 ||
    attachedContexts.length > 0 ||
    attachedNotes.length > 0 ||
    confirmedCommands.length > 0 ||
    confirmedAgentMentions.length > 0 ||
    confirmedCatalogReferences.length > 0 ||
    pendingHandoff !== null;
  const canSend =
    hasDraft && !sending && (!backendRuntimeBlocked || canAttemptSlashWhileBackendBlocked);
  const kernelSmokeHiveBound = KERNEL_SMOKE_ENABLED && isKernelSmokeBindingActive();
  const kernelSmokeHivePrepared =
    kernelSmokeHiveBound &&
    chatModelSelection.mode === 'hive' &&
    chatModelSelection.hiveId === 'custom' &&
    stackCustomSteps.length === KERNEL_SMOKE_HIVE_STEPS.length &&
    stackCustomSteps.every(
      (step, index) =>
        step.id === KERNEL_SMOKE_HIVE_STEPS[index]?.id &&
        step.provider === KERNEL_SMOKE_PROVIDER_ID &&
        step.model === 'kernel-smoke-v1',
    );

  const prepareKernelSmokeHive = () => {
    if (!kernelSmokeHiveBound) return;
    useAuthStore.setState({
      stackPreset: 'custom',
      stackCustomSteps: KERNEL_SMOKE_HIVE_STEPS.map((step) => ({ ...step })),
      chatModelSelection: { mode: 'hive', hiveId: 'custom' },
    });
  };

  const addDroppedPath = useCallback(async (path: string) => {
    const clean = path.trim();
    if (!clean) return;
    if (isSupportedImagePath(clean)) {
      try {
        const image = await imageAttachmentFromPath(clean);
        setAttachedImages((cur) => appendComposerMedia(cur, [image]));
        return;
      } catch (err) {
        toast.error(
          'Image attach failed',
          err instanceof Error ? err.message : 'Could not attach image.',
        );
        return;
      }
    }
    setAttachedFiles((cur) => [...cur, clean].slice(0, 24));
    setText((cur) => {
      const separator = cur.length === 0 || /\s$/.test(cur) ? '' : ' ';
      return `${cur}${separator}${clean}`;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const addChatHandoff = useCallback(
    async (payload: ChatDragPayloadV1) => {
      try {
        const auth = useAuthStore.getState();
        const accountId = resolveAccountIdentity(auth)?.accountId;
        const scope = () =>
          JSON.stringify([
            resolveAccountIdentity(useAuthStore.getState())?.accountId,
            useAuthStore.getState().workspaceId,
          ]);
        const before = scope();
        const workspace = auth.workspaceId
          ? await workspaceRepo.getById(auth.workspaceId)
          : undefined;
        if (!accountId || workspace?.owner_id !== accountId || scope() !== before) {
          toast.warning(
            'Chat reference unavailable',
            'Return to the account and workspace that owns this chat.',
          );
          return false;
        }
        const resolved = await resolveComposerChatHandoffDraft(
          { payload, targetChatId: String(chatId) },
          {
            getChat: (id) => chatRepo.getById(id as ChatId),
            listMessages: (id) => messageRepo.listByChat(id as ChatId),
            canAccess: (source, target) =>
              !target.archived &&
              source.workspace_id === auth.workspaceId &&
              target.workspace_id === auth.workspaceId &&
              scope() === before,
          },
        );
        if (!resolved.ok || scope() !== before) {
          toast.warning(
            'Chat reference unavailable',
            !resolved.ok && resolved.reason === 'chat_unavailable'
              ? 'This chat was removed or moved to another workspace. Reopen it from the sidebar and try again.'
              : 'This chat is not accessible in the current account and workspace.',
          );
          return false;
        }
        const projection = resolved.projection;
        const current = [pendingHandoffRef.current, ...additionalHandoffsRef.current].filter(
          (item): item is ChatHandoffProjectionV1 => !!item,
        );
        const existing = current.findIndex((item) => item.source.chatId === projection.source.chatId);
        if (existing >= 0) current[existing] = projection;
        else current.push(projection);
        pendingHandoffRef.current = current[0]!;
        setPendingHandoff(current[0]!);
        additionalHandoffsRef.current = current.slice(1);
        setAdditionalHandoffs(current.slice(1));
        handoffDraftEditRevisionRef.current += 1;
        const insertion = insertChatReference(
          textRef.current,
          projection.source.chatId,
          textareaRef.current?.selectionStart ?? textRef.current.length,
        );
        textRef.current = insertion.text;
        setText(insertion.text);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(insertion.caret, insertion.caret);
        });
        return true;
      } catch {
        toast.warning('Chat reference unavailable', 'Could not read this chat. Please try again.');
        return false;
      }
    },
    [chatId],
  );

  useEffect(() => {
    const onSendContext = (event: Event) => {
      if (String(useUIStore.getState().activeChatId ?? '') !== String(chatId)) return;
      const payload = (event as CustomEvent<ChatDragPayloadV1>).detail;
      if (payload) void addChatHandoff(payload);
    };
    window.addEventListener(CHAT_SEND_CONTEXT_EVENT, onSendContext as EventListener);
    return () =>
      window.removeEventListener(CHAT_SEND_CONTEXT_EVENT, onSendContext as EventListener);
  }, [addChatHandoff, chatId]);

  useEffect(() => {
    const onAttachFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.path) void addDroppedPath(detail.path);
    };
    window.addEventListener('jarvis:file:attach', onAttachFile as EventListener);
    return () => window.removeEventListener('jarvis:file:attach', onAttachFile as EventListener);
  }, [addDroppedPath, chatId]);

  const mergeAttachedImages = useCallback((next: ChatImageAttachment[]) => {
    // No name/size dedupe — multi drag/drop/paste of the same file is allowed.
    setAttachedImages((cur) => {
      const result = appendComposerMediaResult(cur, next);
      if (result.truncated > 0) {
        toast.info(
          'Attachment limit reached',
          `${result.truncated} item(s) not added (max 24 media on this draft).`,
        );
      }
      return result.items;
    });
  }, []);

  const addBrowserImages = useCallback(
    async (files: File[] | FileList) => {
      const images = splitImageFiles(files);
      if (images.length === 0) return false;
      const batch = images.slice(0, MAX_IMAGES_PER_BATCH);
      const next: ChatImageAttachment[] = [];
      let failed = 0;
      for (const file of batch) {
        try {
          next.push(await imageAttachmentFromBrowserFile(file));
        } catch {
          failed += 1;
        }
      }
      if (next.length > 0) mergeAttachedImages(next);
      if (images.length > MAX_IMAGES_PER_BATCH) {
        toast.info(
          'Some images skipped',
          `Attached ${MAX_IMAGES_PER_BATCH} of ${images.length} images this drop.`,
        );
      } else if (failed > 0) {
        toast.warning(
          'Some images failed',
          `${failed} image(s) could not be attached; the rest were kept.`,
        );
      }
      return true;
    },
    [mergeAttachedImages],
  );

  const addBrowserVideos = useCallback(
    async (files: File[] | FileList) => {
      const videos = splitVideoFiles(files);
      if (videos.length === 0) return false;
      const batch = videos.slice(0, MAX_VIDEOS_PER_BATCH);
      // Full videos for UI; vision models get sampled frames only at send time.
      const next: ChatImageAttachment[] = [];
      let failed = 0;
      for (const file of batch) {
        try {
          next.push(await videoAttachmentFromBrowserFile(file));
        } catch {
          failed += 1;
        }
      }
      if (next.length > 0) mergeAttachedImages(next);
      if (videos.length > MAX_VIDEOS_PER_BATCH) {
        toast.info(
          'Some videos skipped',
          `Attached ${MAX_VIDEOS_PER_BATCH} of ${videos.length} videos this drop.`,
        );
      } else if (failed > 0) {
        toast.warning(
          'Some videos failed',
          `${failed} video(s) could not be attached; the rest were kept.`,
        );
      }
      return true;
    },
    [mergeAttachedImages],
  );

  /** OS FileList general files: path-based attach, or temp text for pathless text files. */
  const addBrowserGeneralFiles = useCallback(async (files: File[] | FileList) => {
    const classified = classifyBrowserFilesForAttach(files);
    let attachedAny = false;

    if (classified.pathFiles.length > 0) {
      setAttachedFiles((cur) => {
        // Allow multi-drop of the same path (duplicates OK).
        return [...cur, ...classified.pathFiles.map((entry) => entry.path)].slice(0, 24);
      });
      attachedAny = true;
    }

    for (const file of classified.textWithoutPath.slice(0, 4)) {
      try {
        const text = await readBrowserFileAsText(file);
        if (!text.trim()) continue;
        // Prefer managed temp file so send uses the real file-path context path.
        const temp = await createChatTextFileAttachment(
          `// Attached file: ${file.name || 'file'}\n\n${text}`,
        );
        if (temp?.path) {
          setAttachedFiles((cur) =>
            (cur.includes(temp.path) ? cur : [...cur, temp.path]).slice(0, 8),
          );
          attachedAny = true;
        } else {
          // Browser preview: keep a synthetic path token so previews still list the name.
          const synthetic = `clipboard:${file.name || 'file.txt'}`;
          setAttachedFiles((cur) =>
            (cur.includes(synthetic) ? cur : [...cur, synthetic]).slice(0, 8),
          );
          setText((cur) => {
            const block = `\n\n--- ${file.name || 'file'} ---\n${text.slice(0, 12_000)}`;
            return cur.includes(block.trim()) ? cur : `${cur}${block}`.trimStart();
          });
          attachedAny = true;
        }
      } catch (err) {
        toast.error(
          'File attach failed',
          err instanceof Error ? err.message : `Could not attach ${file.name || 'file'}.`,
        );
        attachedAny = true;
      }
    }

    if (classified.unsupportedWithoutPath.length > 0) {
      const names = classified.unsupportedWithoutPath
        .map((file) => file.name || 'file')
        .slice(0, 3)
        .join(', ');
      toast.warning(
        'Could not attach binary file',
        `${names}: drop from disk in the desktop app (path required), or use /file from the project.`,
      );
      attachedAny = true;
    }

    return attachedAny;
  }, []);

  /** Shared paste/drop entry: images + videos + general files in one DataTransfer. */
  const attachBrowserFileList = useCallback(
    async (files: FileList | File[]) => {
      if (!files || files.length === 0) return false;
      const classified = classifyBrowserFilesForAttach(files);
      let handled = false;
      if (classified.images.length > 0) {
        handled = (await addBrowserImages(classified.images)) || handled;
      }
      if (classified.videos.length > 0) {
        handled = (await addBrowserVideos(classified.videos)) || handled;
      }
      if (
        classified.pathFiles.length > 0 ||
        classified.textWithoutPath.length > 0 ||
        classified.unsupportedWithoutPath.length > 0
      ) {
        handled = (await addBrowserGeneralFiles(files)) || handled;
      }
      return handled;
    },
    [addBrowserGeneralFiles, addBrowserImages, addBrowserVideos],
  );

  // Full-chat OS file drops land on ChatView and re-dispatch here with FileList.
  useEffect(() => {
    const onMedia = (event: Event) => {
      const detail = (event as CustomEvent<MediaAttachDetail>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.files?.length) void attachBrowserFileList(detail.files);
    };
    window.addEventListener(MEDIA_ATTACH_EVENT, onMedia as EventListener);
    return () => window.removeEventListener(MEDIA_ATTACH_EVENT, onMedia as EventListener);
  }, [attachBrowserFileList, chatId]);

  const addDroppedTerminal = useCallback((raw: string | TerminalRef) => {
    const ref = typeof raw === 'string' ? parseTerminalRef(raw) : raw;
    if (!ref) return;
    const key = terminalRefKey(ref);
    setAttachedTerminals((cur) =>
      (cur.some((item) => terminalRefKey(item) === key) ? cur : [...cur, ref]).slice(0, 8),
    );
    setText((cur) => cur || `Please inspect the attached terminal: ${terminalRefLabel(ref)}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const addDroppedContext = useCallback(
    (raw: string | ContextAttachment) => {
      try {
        const context = typeof raw === 'string' ? parseContextAttachment(raw) : raw;
        if (!context) return;
        const normalized = normalizeContextChatAttachment(context);
        if (!contextChatAttachmentMatchesProject(normalized, projectId)) {
          toast.error(
            'Context attach rejected',
            'The Context source belongs to a different project.',
          );
          return;
        }
        const key = contextChatAttachmentKey(normalized);
        setAttachedContexts((cur) =>
          cur.some((item) => contextChatAttachmentKey(item) === key)
            ? cur
            : [...cur, normalized].slice(0, 8),
        );
        setText((cur) => cur || `Please use the attached Context: ${normalized.title}`);
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch {
        toast.error('Context attach rejected', 'The Context attachment is malformed.');
      }
    },
    [projectId],
  );

  useEffect(() => {
    const onAttachTerminal = (event: Event) => {
      const detail = (event as CustomEvent<{ raw?: string; ref?: TerminalRef; chatId?: string }>)
        .detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.ref) addDroppedTerminal(detail.ref);
      else if (detail?.raw) addDroppedTerminal(detail.raw);
    };
    window.addEventListener('jarvis:terminal:attach', onAttachTerminal as EventListener);
    return () =>
      window.removeEventListener('jarvis:terminal:attach', onAttachTerminal as EventListener);
  }, [addDroppedTerminal, chatId]);

  useEffect(() => {
    const onAttachContext = (event: Event) => {
      const detail = (
        event as CustomEvent<{ raw?: string; context?: ContextAttachment; chatId?: string }>
      ).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.context) addDroppedContext(detail.context);
      else if (detail?.raw) addDroppedContext(detail.raw);
    };
    window.addEventListener('jarvis:context:attach', onAttachContext as EventListener);
    return () =>
      window.removeEventListener('jarvis:context:attach', onAttachContext as EventListener);
  }, [addDroppedContext, chatId]);

  useEffect(() => {
    const onInsertText = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; chatId?: string; skillId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(chatId)) return;
      if (detail?.text) {
        setText((cur) => {
          const separator = cur.length === 0 || /\s$/.test(cur) ? '' : ' ';
          return cur + separator + detail.text;
        });
        if (detail.skillId) {
          const skill = getAllCatalogSkills().find((entry) => entry.id === detail.skillId);
          setConfirmedCommands((current) => {
            if (
              current.some(
                (command) => command.cmd === 'skills' && command.value === detail.skillId,
              )
            ) {
              return current;
            }
            const withoutOverflow = current
              .filter((command) => command.cmd !== 'skills')
              .concat(current.filter((command) => command.cmd === 'skills').slice(-5));
            return [
              ...withoutOverflow,
              {
                cmd: 'skills',
                value: detail.skillId,
                label: `/skills: ${skill?.name ?? detail.skillId}`,
              },
            ];
          });
        }
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener('jarvis:composer:insert-text', onInsertText as EventListener);
    return () =>
      window.removeEventListener('jarvis:composer:insert-text', onInsertText as EventListener);
  }, [chatId]);

  // Finish into the draft without requiring a separate dictation confirmation panel.
  useEffect(() => {
    if (sttView.phase === 'preview') void sttController.accept();
    else if (sttView.phase === 'error' && sttView.error) {
      toast.error('Dictation needs attention', sttView.error);
    }
  }, [sttController, sttView.phase, sttView.error]);
  const toggleStt = useCallback(() => {
    const phase = sttController.getSnapshot().phase;
    if (phase === 'starting' || phase === 'transcribing') { sttController.cancel(); return; }
    if (phase === 'listening') { void sttController.finish(); return; }
    if (composerSttEnabled) void sttController.start();
  }, [composerSttEnabled, sttController]);
  useEffect(() => {
    const onToggle = (event: Event) => {
      if (!composerSttEnabled) return;
      const textarea = resolveComposerSttTextarea();
      if (!textarea || textarea !== textareaRef.current) return;
      event.preventDefault(); toggleStt();
    };
    const onStop = () => {
      if (sttController.getSnapshot().phase === 'starting') sttController.cancel();
      else void sttController.finish();
    };
    const onPageHide = () => sttController.cancel();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || sttController.getSnapshot().phase === 'idle') return;
      const field = textareaRef.current;
      if (!field || !(event.target instanceof Node) || !field.closest('[data-tour="chat-composer"]')?.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); sttController.cancel(); field.focus();
    };
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);
    window.addEventListener(COMPOSER_STT_STOP_EVENT, onStop);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);
      window.removeEventListener(COMPOSER_STT_STOP_EVENT, onStop);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', onPageHide);
      sttController.cancel();
    };
  }, [composerSttEnabled, sttController, toggleStt]);
  useEffect(() => { if (!composerSttEnabled) sttController.cancel(); }, [composerSttEnabled, sttController]);
  // The Inspector's compact Composer must not own the main global indicator.
  useEffect(() => {
    if (compact) return;
    setComposerSttListening(sttListening);
    return () => setComposerSttListening(false);
  }, [compact, setComposerSttListening, sttListening]);

  return (
    <div
      className={cn('border-t border-border bg-panel', compact && 'text-[12px]')}
      data-tour="chat-composer"
      data-composer-frame={compact ? undefined : 'layered'}
    >
      <QueuedMessagesBar
        key={String(chatId)}
        messages={queuedMessages}
        onEdit={editQueuedMessage}
        onSendNow={sendQueuedMessageNow}
        onStartMultitask={startQueuedMultitask}
        onOpenSideChat={openQueueInSideChat}
        busyId={sideOpeningId}
        isModelSwitch={(message) => Boolean(parseJarvisModelSwitchIntent(message.text))}
        onStopAndRestart={stopAndRestartQueuedModelSwitch}
        onDelete={deleteQueuedMessage}
      />

      <CaoCommandPanel
        chatId={String(chatId)}
        request={caoCommandInput}
        scope={{
          accountId: resolveAccountIdentity(useAuthStore.getState())?.accountId ?? '',
          workspaceId: String(workspaceId ?? ''),
          projectId: String(projectId ?? ''),
        }}
      />
      {showFreeKeyNudge && (
        <FreeKeyNudge
          onOpenProviders={() => {
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
        />
      )}
      <div className={cn('composer-frame-body px-3 py-2.5', compact && 'px-3.5 py-3')}>
        {chatBackendAffinity?.backend === 'codex' ? (
          <CodexReadinessGate />
        ) : (
          <HarnessReadinessGate />
        )}
        {promptForge.recoverableJob ? (
          <PromptForgeRecovery
            job={promptForge.recoverableJob}
            loading={promptForge.recoveryLoading}
            error={promptForge.recoveryError}
            resumeDisabledReason={promptForge.recoveryDisabledReason}
            needsContextConfirmation={promptForge.recoveryNeedsContextConfirmation}
            compact={compact}
            onRestore={promptForge.restoreRecoveryDraft}
            onResume={promptForge.resumeRecovery}
            onDiscard={promptForge.discardRecovery}
            onConfirmContextChange={promptForge.confirmRecoveryContextChange}
            onReturnFocus={returnPromptForgeFocus}
          />
        ) : null}
        <Popover
          open={
            notesCtx !== null ||
            mentionCtx !== null ||
            slashCtx !== null ||
            optionPickerCtx !== null
          }
          onOpenChange={(open) => {
            if (!open) {
              if (notesCtx) cancelNotes();
              if (anyThemePickerActive) {
                themePickerRef.current?.cancel();
                return;
              }
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
              data-hive-active={chatModelSelection.mode === 'hive' ? 'true' : undefined}
              data-composer-drop-zone="true"
              onDragOver={(e) => {
                if (
                  Array.from(e.dataTransfer.types).includes(VIBESPACE_CHAT_MIME) ||
                  getChatDragKind(e.dataTransfer.types) ||
                  hasOsFileDrag(e.dataTransfer.types)
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  setDragOver(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragOver(false);
                }
              }}
              onDrop={(e) => {
                const chatHandoff = readChatDragPayload(e.dataTransfer);
                if (chatHandoff) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(false);
                  void addChatHandoff(chatHandoff);
                  return;
                }
                const fileList = e.dataTransfer.files;
                if (fileList && fileList.length > 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(false);
                  void attachBrowserFileList(fileList);
                  const payload = getChatDropPayload(e.dataTransfer);
                  if (payload?.kind === 'context') addDroppedContext(payload.raw);
                  else if (payload?.kind === 'terminal') addDroppedTerminal(payload.raw);
                  return;
                }
                const payload = getChatDropPayload(e.dataTransfer);
                if (!payload) return;
                e.preventDefault();
                e.stopPropagation();
                setDragOver(false);
                if (payload.kind === 'context') addDroppedContext(payload.raw);
                else if (payload.kind === 'terminal') addDroppedTerminal(payload.raw);
                else void addDroppedPath(payload.path);
              }}
              className={cn(
                'rounded-lg border border-input bg-background',
                'transition-colors focus-within:border-accent-cyan/40 focus-within:ring-1 focus-within:ring-ring',
                chatModelSelection.mode === 'hive' && 'border-accent-copper/40',
                dragOver &&
                  'border-accent-copper/60 bg-accent-copper/5 ring-1 ring-accent-copper/40',
                compact && 'p-1',
              )}
            >
              {/* Media sits above the input as an extension of the chat box */}
              <ComposerMediaStrip
                images={attachedImages}
                files={attachedFiles}
                compact={compact}
                onRemoveImage={(id) =>
                  setAttachedImages((cur) => cur.filter((item) => item.id !== id))
                }
                onRemoveFile={(path) => {
                  setAttachedFiles((cur) => cur.filter((p) => p !== path));
                  setMediaPreview((current) =>
                    current?.kind === 'file' && current.path === path ? null : current,
                  );
                }}
                onActivateImage={(image) => setMediaPreview(mediaTargetFromAttachment(image))}
                onActivateFile={(path) => {
                  setMediaPreview({
                    kind: 'file',
                    path,
                    projectRoot: getStoredProjectRoot(projectId),
                  });
                }}
              />
              {attachedNotes.length > 0 && (
                <div className="vs-notes-chips" aria-label="Attached notes">
                  {attachedNotes.map((note) => (
                    <span key={noteReferenceKey(note)} className="vs-notes-chip">
                      <button
                        type="button"
                        aria-label={`Open attached note: ${note.title}`}
                        onClick={() => {
                          try {
                            openNoteReference(note);
                          } catch (error) {
                            toast.error('Cannot open note', String(error));
                          }
                        }}
                      >
                        {note.title}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove note reference: ${note.title}`}
                        onClick={() =>
                          setAttachedNotes((current) =>
                            current.filter((n) => noteReferenceKey(n) !== noteReferenceKey(note)),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <InlineChatReferenceInput
                references={inlineReferences}
                onOpenReference={(id) =>
                  setExpandedReferenceId((current) => (current === id ? null : id))
                }
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  const nextDraft = e.target.value;
                  handoffDraftEditRevisionRef.current += 1;
                  retainHandoffs(nextDraft);
                  setText(nextDraft);
                  if (promptForge.reviewOpen) {
                    promptForge.setUpgradedDraft(nextDraft);
                  }
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
                onPaste={(e) => {
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0) {
                    // Prevent default so OS file paste is not also inserted as text.
                    e.preventDefault();
                    void attachBrowserFileList(files);
                  }
                }}
                placeholder={
                  placeholder ??
                  (compact
                    ? 'Message Jarvis…  (@ agent)'
                    : 'Message Jarvis...   (use @ to mention an agent)')
                }
                {...slashComboboxOwnerAttributes(slashCtx !== null, slashComboboxMetadata)}
                aria-label="Message"
                data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_CONTROL.chatComposer : undefined}
                data-composer-input="true"
                style={
                  compact
                    ? {
                        // Driven by --pet-composer-* inside the mini panel so
                        // "Message Jarvis…" tracks panel resize scale.
                        minHeight: 'var(--pet-composer-min-h, 2rem)',
                        maxHeight: MAX_HEIGHT,
                        fontSize: 'var(--pet-composer-font, 0.75rem)',
                        lineHeight: 1.35,
                      }
                    : { minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }
                }
                className={cn(
                  'block w-full resize-none bg-transparent px-3 py-2 text-foreground',
                  'placeholder:text-muted-foreground outline-none',
                  'scrollbar-hidden',
                  !compact && 'text-body',
                  compact && 'px-2 py-1.5 leading-snug',
                )}
              />
              {inlineReferences
                .filter((reference) => reference.source.chatId === expandedReferenceId)
                .map((reference) => (
                  <div
                    key={reference.source.chatId}
                    className="relative mx-3 mb-2 rounded-lg border border-border bg-background p-2"
                    role="dialog"
                    aria-label={`Chat context: ${reference.source.title}`}
                  >
                    <button
                      type="button"
                      className="absolute right-2 top-2 z-10"
                      aria-label="Close chat context"
                      onClick={() => setExpandedReferenceId(null)}
                    >
                      ×
                    </button>
                    <ChatHandoffDraftCard
                      handoff={reference}
                      initiallyExpanded
                      instruction={handoffInstruction}
                      onInstructionChange={setHandoffInstruction}
                      onRemove={() => {
                        const next = textRef.current.replaceAll(
                          chatReferenceToken(reference.source.chatId),
                          '',
                        );
                        handoffDraftEditRevisionRef.current += 1;
                        setText(next);
                        retainHandoffs(next);
                        setExpandedReferenceId(null);
                        textareaRef.current?.focus();
                      }}
                    />
                  </div>
                ))}
              {promptForge.job?.status === 'ready' && promptForge.job.generatedDraft !== null ? (
                <PromptForgeReview
                  open={promptForge.reviewOpen}
                  compact={compact}
                  job={promptForge.job}
                  onAccept={promptForge.accept}
                  onRegenerate={() => void promptForge.regenerate()}
                  onRegenerateWithInstructions={(instructions) =>
                    void promptForge.regenerate(instructions)
                  }
                  onRestoreOriginal={promptForge.restoreOriginal}
                  onReturnFocus={returnPromptForgeFocus}
                />
              ) : null}
              {confirmedAgentMentions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  <TokenList>
                    {confirmedAgentMentions.map((mention) => (
                      <InputToken
                        key={mention.id}
                        type="agent"
                        label={mention.label}
                        onRemove={() =>
                          setConfirmedAgentMentions((cur) =>
                            cur.filter((item) => item.id !== mention.id),
                          )
                        }
                      />
                    ))}
                  </TokenList>
                </div>
              )}
              {confirmedCatalogReferences.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  <TokenList>
                    {confirmedCatalogReferences.map((reference) => (
                      <InputToken
                        key={reference.key}
                        type={
                          reference.kind === 'plugin'
                            ? 'plugin'
                            : reference.kind === 'mcp'
                              ? 'contextmap'
                              : 'file'
                        }
                        label={reference.mention}
                        onRemove={() =>
                          setConfirmedCatalogReferences((current) =>
                            current.filter((candidate) => candidate.key !== reference.key),
                          )
                        }
                      />
                    ))}
                  </TokenList>
                </div>
              )}
              {/* Confirmed command tokens */}
              {confirmedCommands.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  <TokenList>
                    {confirmedCommands.map((cmd) => (
                      <InputToken
                        key={cmd.value ? `${cmd.cmd}:${cmd.value}` : cmd.cmd}
                        type="command"
                        label={cmd.label}
                        icon={cmd.cmd === 'hive' ? <HiveModelIcon size={18} /> : undefined}
                        onRemove={() => removeConfirmedCommand(cmd.cmd, cmd.value)}
                      />
                    ))}
                  </TokenList>
                </div>
              )}
              {attachedTerminals.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedTerminals.map((ref) => (
                    <InputToken
                      key={terminalRefKey(ref)}
                      type="terminal"
                      label={terminalRefLabel(ref)}
                      onRemove={() =>
                        setAttachedTerminals((cur) =>
                          cur.filter((p) => terminalRefKey(p) !== terminalRefKey(ref)),
                        )
                      }
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
                        icon={
                          plugin ? (
                            <PluginLogo plugin={plugin} size="sm" className="!h-5 !w-5" />
                          ) : undefined
                        }
                        onRemove={() =>
                          setAttachedPlugins((cur) => cur.filter((id) => id !== pluginId))
                        }
                      />
                    );
                  })}
                </div>
              )}
              {attachedContexts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {attachedContexts.map((context) => {
                    const token = contextAttachmentTokenView(context);
                    const attachmentKey = contextChatAttachmentKey(context);
                    return (
                      <InputToken
                        key={attachmentKey}
                        type="contextmap"
                        label={token.label}
                        sublabel={token.sublabel}
                        onRemove={() =>
                          setAttachedContexts((cur) =>
                            cur.filter((item) => contextChatAttachmentKey(item) !== attachmentKey),
                          )
                        }
                      />
                    );
                  })}
                </div>
              )}
              <div
                className={cn(
                  'composer-toolbar flex min-w-0 items-center gap-1 px-1.5 pb-1.5 pt-0.5',
                  compact && 'gap-0.5 px-1 pb-1 pt-0',
                )}
                data-composer-toolbar="true"
              >
                {/* Scrollable tools — Send/mic stay pinned so chat never loses the send control */}
                <div
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                  )}
                >
                  {chatBackendAffinity && !chatBackendAffinity.locked && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 gap-1 px-1.5 text-metadata text-muted-foreground"
                      aria-label="Choose coding runtime"
                      onClick={() => {
                        const command = findSlashCommandDef('cli');
                        if (!command) return;
                        setSlashCtx(null);
                        setSelectedOptionId(chatBackendAffinity.backend);
                        setOptionPickerCtx({ cmd: command, query: '' });
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {chatBackendAffinity.backend === 'codex' ? 'Codex' : 'OpenCode'}
                      <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  )}
                  <ModelPicker
                    selection={chatModelSelection}
                    modelCtx={modelCtx}
                    open={modelPickerOpen}
                    onOpenChange={setModelPickerOpen}
                    initialEffort={reasoningPreference.effortOverride ?? 'auto'}
                    reasoningMode={reasoningPreference.mode}
                    pickerRef={modelPickerRef}
                    compact={compact}
                    groups={accessibleChatModels.groups}
                    flatOptions={accessibleChatModels.flatOptions}
                    onSelect={(next, effort) => {
                      if (effort && reasoningPreference.mode === 'normal') {
                        writeChatReasoningEffort(String(chatId), effort === 'auto' ? null : effort);
                        setReasoningPreference(readChatReasoningPreference(String(chatId)));
                      }
                      setRetainedExactChatSelection(next.mode === 'single' ? next : null);
                      setChatModelSelection(next);
                      if (next.mode === 'single' && next.connectionId) {
                        const descriptor = getProviderConnectionDescriptor(next.connectionId);
                        void chatRepo
                          .update(chatId as ChatId, {
                            connection: { ...descriptor, modelId: next.modelId },
                          })
                          .catch(() =>
                            toast.error(
                              'Connection not saved',
                              'Try choosing the connection again.',
                            ),
                          );
                      }
                      if (
                        next.mode === 'single' &&
                        (next.providerId === 'ollama' || next.providerId === 'local')
                      ) {
                        selectLocalModelForChat(next.modelId);
                      }
                    }}
                  />
                  {chatModelSelection.mode === 'single' && chatModelSelection.connectionId ? (
                    <ConnectionInfoPopover
                      connectionId={chatModelSelection.connectionId}
                      modelId={chatModelSelection.modelId}
                    />
                  ) : null}
                  <ModeIndicator
                    mode={interactionMode}
                    chatId={String(chatId)}
                    compact={compact}
                    onSelectMode={(nextMode) => {
                      applyInteractionMode(nextMode);
                    }}
                    onCycle={() => {
                      const nextMode = cycleInteractionMode(
                        useJarvisInteractionStore.getState().modeForChat(chatId),
                      );
                      applyInteractionMode(nextMode);
                    }}
                  />
                  <PromptForgeControl
                    status={promptForge.status}
                    statusMessage={
                      promptForge.isRunning && promptForgeAutoUpgradeOnSend
                        ? `${promptForge.statusMessage} · auto-upgrade`
                        : promptForge.statusMessage
                    }
                    isRunning={promptForge.isRunning}
                    disabledReason={promptForge.disabledReason}
                    error={promptForge.error}
                    compact={compact}
                    modelSelection={promptForgeModelSelection}
                    modelOptions={promptForgeModels}
                    onModelSelectionChange={setPromptForgeModelSelection}
                    privacyMode={promptForge.privacyMode}
                    onPrivacyModeChange={promptForge.setPrivacyMode}
                    allowPublicResearch={promptForge.allowPublicResearch}
                    onAllowPublicResearchChange={promptForge.setAllowPublicResearch}
                    publicResearchAvailable={promptForge.publicResearchAvailable}
                    offlineMode={offlineMode}
                    autoUpgradeOnSend={promptForgeAutoUpgradeOnSend}
                    onAutoUpgradeOnSendChange={setPromptForgeAutoUpgradeOnSend}
                    onStart={promptForge.start}
                    onCancel={promptForge.cancel}
                  />
                  {!compact ? (
                    <span className="ml-1 hidden text-metadata leading-none text-muted-foreground sm:inline">
                      {sttTranscribing ? (
                        <p className="px-1 text-[11px] text-muted-foreground" aria-live="polite">
                          Transcribing…
                        </p>
                      ) : null}
                      {sttListening && sttInterim && !sttTranscribing ? (
                        <span className="italic text-foreground/70" aria-live="polite">
                          {sttInterim}
                        </span>
                      ) : (
                        <>
                          <span className="kbd">{renderHotkey(HOTKEYS.SEND)}</span> to send
                        </>
                      )}
                    </span>
                  ) : null}
                  {kernelSmokeHiveBound ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={prepareKernelSmokeHive}
                      data-sik-evidence={SIK_CONTROL.hiveFixture}
                    >
                      Prepare Hive smoke
                    </Button>
                  ) : null}
                  {kernelSmokeHivePrepared ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleSend(KERNEL_SMOKE_HIVE_TEXT)}
                      data-sik-evidence={SIK_CONTROL.hiveDispatch}
                    >
                      Dispatch Hive smoke
                    </Button>
                  ) : null}
                </div>
                <div className="composer-frame-actions flex shrink-0 items-center gap-0.5">
                  {composerSttEnabled && (
                    <Hint
                      label={sttListening ? 'Stop dictation' : 'Voice to text'}
                      hotkey={HOTKEYS.COMPOSER_STT}
                    >
                      <Button
                        type="button"
                        size="icon-sm"
                        variant={sttListening ? 'accent' : 'ghost'}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={toggleStt}
                        aria-label={sttView.phase === 'starting' ? 'Cancel microphone request' : sttTranscribing ? 'Cancel transcription' : sttListening ? 'Stop dictation' : 'Start dictation'}
                        aria-pressed={sttListening}
                        className={cn(compact && 'h-6 w-6')}
                      >
                        {sttListening ? <MicWaveform volumeRef={volumeRef} /> : <Mic />}
                      </Button>
                    </Hint>
                  )}
                  {jarvisRunning ? (
                    <Hint label="Stop current request" hotkey="Esc ×3">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="accent"
                        onClick={() => {
                          const cancellationKey = activeCancellationKeyRef.current;
                          suppressQueueFlushOnUserCancelRef.current = true;
                          window.dispatchEvent(
                            new CustomEvent('jarvis:cancel', {
                              detail: cancellationKey
                                ? { messageId: cancellationKey }
                                : { chatId: String(chatId) },
                            }),
                          );
                        }}
                        aria-label="Stop current request"
                        className={cn('shrink-0', compact && 'h-6 w-6 min-h-6 min-w-6')}
                      >
                        <Pause />
                      </Button>
                    </Hint>
                  ) : stoppedRequest && !hasDraft ? (
                    <Hint label="Resume current request">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="accent"
                        onClick={() => {
                          const cancellationKey = crypto.randomUUID();
                          activeCancellationKeyRef.current = cancellationKey;
                          window.dispatchEvent(
                            new CustomEvent('jarvis:resume', {
                              detail: { chatId: String(chatId), cancellationKey },
                            }),
                          );
                        }}
                        aria-label="Resume current request"
                        className={cn('shrink-0', compact && 'h-6 w-6 min-h-6 min-w-6')}
                      >
                        <Play />
                      </Button>
                    </Hint>
                  ) : (
                    <Hint label="Send" hotkey={HOTKEYS.SEND}>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant={canSend ? 'accent' : 'ghost'}
                        onClick={() => void handleSend()}
                        disabled={!canSend}
                        aria-label="Send message"
                        className={cn('shrink-0', compact && 'h-6 w-6 min-h-6 min-w-6')}
                        data-sik-evidence={
                          KERNEL_SMOKE_ENABLED ? SIK_CONTROL.chatSubmit : undefined
                        }
                      >
                        <Send />
                      </Button>
                    </Hint>
                  )}
                </div>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className={cn(
              'w-auto max-h-[520px] overflow-hidden border-none bg-transparent p-0 shadow-none',
              // Pet mini-panel is z-[81]; default popover z-50 sits under it so
              // slash / mention pickers never appear. Lift compact pickers above.
              compact && 'z-[120]',
            )}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              // Keep the popover open while the user is interacting with the textarea
              if (textareaRef.current && textareaRef.current.contains(e.target as Node)) {
                e.preventDefault();
              }
            }}
          >
            {notesCtx ? (
              <NotesPicker
                ref={notesPickerRef}
                notes={notesSnapshot.notes}
                initialQuery={notesCtx.query}
                onConfirm={confirmNotes}
                onCancel={cancelNotes}
                loading={notesSnapshot.loading}
                error={notesSnapshot.error}
                onRetry={() => {
                  void notesWorkspace?.refresh().catch(() => undefined);
                }}
              />
            ) : themePickerActive && optionPickerCtx !== null ? (
              <ThemeSlashPicker
                ref={themePickerRef}
                commandLabel={optionPickerCtx.cmd.cmd as 'appearance'}
                initialTheme={useUIStore.getState().theme}
                onCommit={(theme) => {
                  useUIStore.getState().setTheme(theme);
                  setOptionPickerCtx(null);
                  setSelectedOptionId('');
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                onCancel={() => {
                  setOptionPickerCtx(null);
                  setSelectedOptionId('');
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              />
            ) : consoleThemePickerActive && optionPickerCtx !== null ? (
              <ConsoleThemeSlashPicker
                ref={themePickerRef}
                initialProfile={loadConsolePreferences().profile}
                onCommit={(profile) => {
                  updateConsolePreferences({ profile, view: 'agentic' });
                  setOptionPickerCtx(null);
                  setSelectedOptionId('');
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                onCancel={() => {
                  setOptionPickerCtx(null);
                  setSelectedOptionId('');
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              />
            ) : optionPickerCtx !== null ? (
              <SlashCommandOptionPicker
                ref={optionPickerRef}
                commandLabel={optionPickerCtx.cmd.cmd}
                commandIcon={optionPickerCtx.cmd.icon}
                options={optionPickerOptions}
                selectedId={selectedOptionId}
                query={optionPickerCtx.query}
                loading={
                  normalizeSlashCmd(optionPickerCtx.cmd.cmd) === 'file'
                    ? projectFilesLoading
                    : false
                }
                error={
                  normalizeSlashCmd(optionPickerCtx.cmd.cmd) === 'file'
                    ? projectFilesError
                    : (reasoningPickerState?.error ?? undefined)
                }
                onHoverId={setSelectedOptionId}
                onSelect={selectOption}
                compact={compact}
              />
            ) : slashCtx !== null ? (
              <SlashCommandTypeahead
                ref={slashTypeaheadRef}
                commands={filteredSlashCommands}
                selectedCmd={selectedSlashCmd}
                query={slashCtx.query}
                onHoverCmd={setSelectedSlashCmd}
                onSelect={insertSlashCommand}
                compact={compact}
              />
            ) : (
              <MentionTypeahead
                entries={filteredReferenceEntries}
                selectedKey={selectedReferenceKey}
                query={mentionCtx?.query ?? ''}
                onHoverKey={setSelectedReferenceKey}
                onSelect={insertCatalogReference}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
      {mediaPreview ? (
        <MediaPreviewPanel target={mediaPreview} onClose={() => setMediaPreview(null)} />
      ) : null}
    </div>
  );
}

interface ModelPickerProps {
  selection: ChatModelSelection;
  modelCtx: ModelSelectionContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: ChatModelSelection, effort?: EffortLabel) => void;
  initialEffort: EffortLabel;
  reasoningMode: ReasoningMode;
  pickerRef: React.RefObject<ModelPickerTypeaheadRef | null>;
  compact?: boolean;
  groups: ModelPickerGroup[];
  flatOptions: ModelPickerOption[];
}

function ModelPicker({
  selection,
  modelCtx,
  open,
  onOpenChange,
  onSelect,
  initialEffort: manualEffort,
  reasoningMode,
  pickerRef,
  compact = false,
  groups,
  flatOptions,
}: ModelPickerProps) {
  const [axoFocusToken, setAxoFocusToken] = useState(0);
  const automaticRoutingEnabled = useAuthStore((s) => s.automaticModelRoutingEnabled);
  const setAutomaticModelRoutingEnabled = useAuthStore((s) => s.setAutomaticModelRoutingEnabled);
  const hiveEnabled = isHiveProductEnabled();
  const [selectedId, setSelectedId] = useState('');
  const displayLabel = formatChatModelSelectionLabel(selection, modelCtx);
  const activeProvider = selection.mode === 'single' ? selection.providerId : undefined;
  const activeModel = selection.mode === 'single' ? selection.modelId : undefined;
  const activeRoute = flatOptions.flatMap((option) => option.alternativeRoutes ?? [option])
    .find((option) => option.id === selectionOptionId(selection));
  const effortOptions = listEffortOptions((activeRoute?.variants ?? []).map((id) => ({ id })));
  const initialEffort =
    reasoningMode === 'token-final-boss' ? (effortOptions.at(-1)?.label ?? 'auto') : manualEffort;
  const effortLabel =
    effortOptions.find((option) => option.label === initialEffort)?.upstreamEffort ?? initialEffort;

  const flatOptionIds = useMemo(
    () => flatOptions.map((option) => option.id).join('\0'),
    [flatOptions],
  );
  const selectionHighlightId = useMemo(() => {
    if (hiveEnabled && selection.mode === 'hive') return HIVE_OPTION_ID;
    return selectionOptionId(selection) ?? (hiveEnabled ? HIVE_OPTION_ID : '');
  }, [hiveEnabled, selection]);

  useEffect(() => {
    if (!open) return;
    if (hiveEnabled && selection.mode === 'hive') {
      setSelectedId((current) => (current === HIVE_OPTION_ID ? current : HIVE_OPTION_ID));
      return;
    }
    const activeId = selectionOptionId(selection);
    if (activeId && flatOptions.some((option) => option.id === activeId)) {
      setSelectedId((current) => (current === activeId ? current : activeId));
      return;
    }
    const fallback = hiveEnabled ? HIVE_OPTION_ID : (flatOptions[0]?.id ?? '');
    setSelectedId((current) => (current === fallback ? current : fallback));
  }, [open, flatOptionIds, flatOptions, hiveEnabled, selectionHighlightId, selection]);

  useEffect(() => {
    if (!open) pickerRef.current?.cancelPending();
  }, [open, pickerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        pickerRef.current?.cancelPending();
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

  const handleSelect = (
    nextProvider: ProviderId,
    nextModel: string,
    connection?: Readonly<import('@/lib/ai/adapters/types').ProviderConnection>,
    effort: EffortLabel = 'auto',
  ) => {
    onSelect(selectionFromOption(nextProvider, nextModel, connection), effort);
    if (['high', 'xhigh', 'max', 'ultra'].includes(effort)) {
      setAxoFocusToken((token) => token + 1);
    } else {
      setAxoFocusToken(0);
    }
    onOpenChange(false);
  };

  const handleSelectHive = () => {
    if (!hiveEnabled) return;
    onSelect(selectionFromHive('balanced'));
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            'h-7 max-w-[14rem] gap-0.5 px-1.5 text-muted-foreground hover:text-foreground',
            compact && 'h-6 max-w-[9rem] shrink-0 px-1 text-[10px] leading-none',
          )}
          aria-label="Choose model"
          data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_CONTROL.modelPicker : undefined}
          data-sik-transport={
            KERNEL_SMOKE_ENABLED && selection.mode === 'single'
              ? selection.connectionId === 'vibespace-kernel-smoke-cli'
                ? 'cli'
                : selection.connectionId === 'vibespace-kernel-smoke-native'
                  ? 'native'
                  : undefined
              : undefined
          }
        >
          {hiveEnabled && selection.mode === 'hive' ? (
            <HiveModelIcon size={compact ? 14 : 16} />
          ) : null}
          <span className={cn('truncate text-metadata leading-none', compact && 'text-[10px]')}>
            {displayLabel}
          </span>
            <span
              data-composer-effort={initialEffort}
              style={initialEffort !== 'auto' ? undefined : { display: 'none' }}
              className={cn(
                'vibespace-composer-effort inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-copper/35 bg-accent-copper/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-copper',
                initialEffort === 'ultra' && 'vibespace-composer-effort-ultra',
              )}
            >
              <span className="[&>svg]:size-5"><AxoMotion focusToken={axoFocusToken} /></span>
              {effortLabel}
            </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 opacity-70', compact && 'h-3 w-3')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="z-[120] w-auto border-0 bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ModelPickerTypeahead
          ref={pickerRef as React.Ref<ModelPickerTypeaheadRef>}
          groups={groups}
          selectedId={selectedId}
          initialEffort={initialEffort}
          activeProvider={activeProvider}
          activeModel={activeModel}
          hiveActive={hiveEnabled && selection.mode === 'hive'}
          onHoverId={setSelectedId}
          onSelect={handleSelect}
          onSelectHive={hiveEnabled ? handleSelectHive : undefined}
          automaticRoutingEnabled={automaticRoutingEnabled}
          onAutomaticRoutingChange={setAutomaticModelRoutingEnabled}
          compact={compact}
        />
      </PopoverContent>
    </Popover>
  );
}
