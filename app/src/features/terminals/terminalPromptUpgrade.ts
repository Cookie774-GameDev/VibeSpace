/**
 * Terminal Prompt Upgrade — reuses the shared engine from Prompt 29.
 *
 * Scope is always terminal + project so upgrades never leak between projects
 * or panes. The upgrade runs only in the palette overlay; it never writes to
 * the PTY or interrupts a running process.
 */

import { db } from '@/lib/db';
import Dexie from 'dexie';
import {
  accessiblePromptUpgradeModels,
  runPromptUpgrade,
  type PromptUpgradeEngineResult,
} from '@/features/prompt-forge/promptUpgradeEngine';
import { createPromptForgeJobStore } from '@/features/prompt-forge/jobStore';
import { promptForgeModelOptionsFromPicker } from '@/features/prompt-forge/contextPreparation';
import type { PromptForgeModelSelection, PromptForgePrivacyMode } from '@/features/prompt-forge/contracts';
import type {
  PromptForgeCurrentChatSelection,
  PromptForgeModelOption,
} from '@/features/prompt-forge/modelSelection';
import type { PromptForgeSourceCandidate } from '@/features/prompt-forge/sourcePack';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import type { ProjectId } from '@/types/common';
import { useTerminalTranscriptStore } from './transcriptStore';
import type { TerminalPromptEvidence } from './terminalCommandFoundation';

const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_SOURCE_BODY = 4_000;
const MAX_RELATED_CHATS = 3;
const MAX_RELATED_MESSAGES = 6;
const MAX_RELATED_MAPS = 4;
const MAX_RELATED_LINKS = 8;

export type TerminalPromptUpgradeScope = Readonly<{
  accountId: string;
  projectId: string | null;
  sessionId: string | null;
  paneId?: string | null;
}>;

type TerminalRelatedChat = Readonly<{
  id: string;
  projectId: string | null;
  title: string;
  excerpt: string;
  updatedAt: number;
}>;

type TerminalRelatedContextMap = Readonly<{
  id: string;
  accountId: string;
  projectId: string | null;
  name: string;
  summary: string;
  entryPoints: readonly string[];
  updatedAt: number;
}>;

type TerminalRelatedRepository = Readonly<{
  id: string;
  accountId: string;
  mapId: string;
  label: string;
  reference: string;
  detail: string;
  updatedAt: number;
}>;

type TerminalRelatedLink = Readonly<{
  id: string;
  projectId: string | null;
  label: string;
  url: string;
  updatedAt: number;
}>;

export type TerminalRelatedSourceInput = Readonly<{
  scope: TerminalPromptUpgradeScope;
  now: number;
  chats: readonly TerminalRelatedChat[];
  contextMaps: readonly TerminalRelatedContextMap[];
  repositories: readonly TerminalRelatedRepository[];
  links: readonly TerminalRelatedLink[];
}>;

function relatedCandidate(
  now: number,
  values: Pick<
    PromptForgeSourceCandidate,
    'id' | 'kind' | 'label' | 'reference' | 'content' | 'trust' | 'observedAt' | 'whySelected'
  >,
): PromptForgeSourceCandidate {
  return Object.freeze({
    ...values,
    content: clipForUpgradeSource(values.content),
    verified: true,
    explicit: false,
    projectScoped: true,
    lexicalScore: 0.72,
    semanticScore: null,
    observedAt: Math.min(now, Math.max(0, values.observedAt)),
  });
}

/**
 * Converts already-bounded workspace records into Prompt Upgrade sources.
 * The second filter is intentional defense in depth: callers must not be
 * able to pass a foreign account/project row into a terminal upgrade.
 */
export function buildTerminalRelatedSources(
  input: TerminalRelatedSourceInput,
): readonly PromptForgeSourceCandidate[] {
  const projectId = input.scope.projectId;
  if (!projectId) return Object.freeze([]);

  const maps = input.contextMaps
    .filter(
      (map) =>
        map.accountId === input.scope.accountId &&
        map.projectId === projectId,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RELATED_MAPS);
  const mapIds = new Set(maps.map((map) => map.id));

  const chats = input.chats
    .filter((chat) => chat.projectId === projectId && chat.excerpt.trim())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RELATED_CHATS)
    .map((chat) =>
      relatedCandidate(input.now, {
        id: `terminal-related-chat:${chat.id}`,
        kind: 'chat',
        label: chat.title || 'Related project chat',
        reference: `chat://${chat.id}`,
        content: chat.excerpt,
        trust: 'user',
        observedAt: chat.updatedAt,
        whySelected: 'Recent conversation from this project only.',
      }),
    );

  const contextMaps = maps.map((map) =>
    relatedCandidate(input.now, {
      id: `terminal-context-map:${map.id}`,
      kind: 'context_map',
      label: map.name || 'Project Context Map',
      reference: `context-map://${map.id}`,
      content: [
        map.summary,
        map.entryPoints.length
          ? `Relevant repository entries:\n${map.entryPoints.slice(0, 16).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      trust: 'project',
      observedAt: map.updatedAt,
      whySelected: 'Current Context Map for this account and project.',
    }),
  );

  const repositories = input.repositories
    .filter(
      (repository) =>
        repository.accountId === input.scope.accountId && mapIds.has(repository.mapId),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RELATED_MAPS)
    .map((repository) =>
      relatedCandidate(input.now, {
        id: `terminal-repository:${repository.id}`,
        kind: 'project',
        label: repository.label,
        reference: repository.reference,
        content: repository.detail,
        trust: 'project',
        observedAt: repository.updatedAt,
        whySelected: 'Verified repository source attached to this project Context Map.',
      }),
    );

  const links = input.links
    .filter((link) => link.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RELATED_LINKS)
    .map((link) =>
      relatedCandidate(input.now, {
        id: `terminal-project-link:${link.id}`,
        kind: 'attachment',
        label: link.label,
        reference: link.url,
        content: `Project link: ${link.url}`,
        trust: 'user',
        observedAt: link.updatedAt,
        whySelected: 'Saved link attached to this project.',
      }),
    );

  return Object.freeze([...chats, ...contextMaps, ...repositories, ...links]);
}

function messageText(parts: readonly { kind: string; text?: string }[]): string {
  return parts
    .filter(
      (part): part is { kind: 'text'; text: string } =>
        part.kind === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export async function collectTerminalRelatedSources(
  scope: TerminalPromptUpgradeScope,
  now = Date.now(),
): Promise<readonly PromptForgeSourceCandidate[]> {
  if (!scope.projectId) return Object.freeze([]);
  const projectId = scope.projectId;

  const [chatRows, mapRows] = await Promise.all([
    db.chats.where('project_id').equals(projectId).toArray(),
    db.context_maps
      .where('[accountId+projectId]')
      .equals([scope.accountId, projectId])
      .toArray(),
  ]);

  const recentChats = chatRows
    .filter((chat) => !chat.archived)
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, MAX_RELATED_CHATS);
  const chats: TerminalRelatedChat[] = [];
  for (const chat of recentChats) {
    const messages = await db.messages
      .where('[chat_id+created_at]')
      .between([chat.id, Dexie.minKey], [chat.id, Dexie.maxKey])
      .reverse()
      .limit(MAX_RELATED_MESSAGES)
      .toArray();
    const excerpt = messages
      .reverse()
      .map((message) => messageText(message.parts))
      .filter(Boolean)
      .join('\n\n');
    chats.push({
      id: String(chat.id),
      projectId: chat.project_id ? String(chat.project_id) : null,
      title: chat.title,
      excerpt: clipForUpgradeSource(excerpt),
      updatedAt: chat.updated_at,
    });
  }

  const activeMaps = mapRows
    .filter((map) => map.status === 'active')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RELATED_MAPS);
  const sourceRows = (
    await Promise.all(
      activeMaps.map((map) =>
        db.context_sources.where('[accountId+mapId]').equals([scope.accountId, map.id]).toArray(),
      ),
    )
  ).flat();
  const repositories: TerminalRelatedRepository[] = sourceRows
    .filter((source) => source.github !== undefined)
    .map((source) => ({
      id: source.id,
      accountId: source.accountId,
      mapId: source.mapId,
      label: source.label,
      reference: `https://github.com/${source.github!.owner}/${source.github!.repository}/tree/${source.github!.resolvedCommitSha}`,
      detail: [
        `Repository: ${source.github!.owner}/${source.github!.repository}`,
        `Selected ref: ${source.github!.selectedRef}`,
        `Resolved commit: ${source.github!.resolvedCommitSha}`,
        `Visibility: ${source.github!.visibility}`,
      ].join('\n'),
      updatedAt: source.updatedAt,
    }));

  const project = await db.projects.get(projectId as ProjectId);
  const links = project
    ? (await db.quick_links.where('workspace_id').equals(project.workspace_id).toArray())
        .filter((link) => String(link.project_id ?? '') === projectId)
        .map((link) => ({
          id: String(link.id),
          projectId,
          label: link.label,
          url: link.url,
          updatedAt: link.updated_at,
        }))
    : [];

  return buildTerminalRelatedSources({
    scope,
    now,
    chats,
    contextMaps: activeMaps.map((map) => ({
      id: map.id,
      accountId: map.accountId,
      projectId: map.projectId,
      name: map.name,
      summary: map.summary,
      entryPoints: map.recommendedEntryPoints.map(
        (entry) => entry.path ?? entry.label,
      ),
      updatedAt: map.updatedAt,
    })),
    repositories,
    links,
  });
}

/** Normalize line endings but never append Enter/CR. */
export function prepareUpgradedPromptInsert(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

/** Stable Prompt Forge job scope — isolated per project + terminal session. */
export function terminalPromptUpgradeChatId(scope: TerminalPromptUpgradeScope): string {
  const project = scope.projectId?.trim() || 'none';
  const session = scope.sessionId?.trim() || scope.paneId?.trim() || 'unbound';
  // Keep within Prompt Forge SAFE_ID charset
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._:/@-]/g, '_').slice(0, 80);
  return `terminal:${safe(project)}:${safe(session)}`;
}

export function clipForUpgradeSource(text: string, max = MAX_SOURCE_BODY): string {
  const clean = text.replace(/\u0000/g, '').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n…[truncated by VibeSpace]`;
}

/**
 * Build compact, relevant sources for this terminal only.
 * Does not dump all history — transcript is a bounded tail.
 */
export function buildTerminalPromptUpgradeSources(input: {
  scope: TerminalPromptUpgradeScope;
  projectName?: string | null;
  projectRoot?: string | null;
  agentSlug?: string | null;
  agentName?: string | null;
  cwd?: string | null;
  now?: number;
}): readonly PromptForgeSourceCandidate[] {
  const now = input.now ?? Date.now();
  const sources: PromptForgeSourceCandidate[] = [];
  const chatId = terminalPromptUpgradeChatId(input.scope);

  sources.push({
    id: `terminal-session:${chatId}`,
    kind: 'terminal',
    label: 'Current terminal session',
    reference: chatId,
    content: clipForUpgradeSource(
      [
        `sessionId: ${input.scope.sessionId ?? 'none'}`,
        `paneId: ${input.scope.paneId ?? 'none'}`,
        `projectId: ${input.scope.projectId ?? 'none'}`,
        `cwd: ${input.cwd ?? 'unknown'}`,
        `agent: ${input.agentName ?? input.agentSlug ?? 'none'}`,
      ].join('\n'),
    ),
    verified: true,
    explicit: true,
    projectScoped: Boolean(input.scope.projectId),
    trust: 'project',
    lexicalScore: 1,
    semanticScore: null,
    observedAt: now,
    whySelected: 'Upgrade is scoped to this terminal pane only.',
  });

  if (input.projectName || input.projectRoot || input.scope.projectId) {
    sources.push({
      id: `terminal-project:${input.scope.projectId ?? 'none'}`,
      kind: 'project',
      label: input.projectName ?? 'Current project',
      reference: input.projectRoot ?? input.scope.projectId ?? 'project',
      content: clipForUpgradeSource(
        [
          `name: ${input.projectName ?? 'unknown'}`,
          `id: ${input.scope.projectId ?? 'none'}`,
          `root: ${input.projectRoot ?? 'unknown'}`,
        ].join('\n'),
      ),
      verified: true,
      explicit: true,
      projectScoped: true,
      trust: 'project',
      lexicalScore: 0.95,
      semanticScore: null,
      observedAt: now,
      whySelected: 'Project isolation — sources stay inside this project.',
    });
  }

  const sessionId = input.scope.sessionId;
  if (sessionId) {
    const transcript = useTerminalTranscriptStore.getState().sessions[sessionId]?.text ?? '';
    if (transcript.trim()) {
      const tail =
        transcript.length > MAX_TRANSCRIPT_CHARS
          ? transcript.slice(-MAX_TRANSCRIPT_CHARS)
          : transcript;
      sources.push({
        id: `terminal-transcript:${sessionId}`,
        kind: 'terminal',
        label: 'Recent terminal output',
        reference: `terminal://${sessionId}`,
        content: clipForUpgradeSource(tail, MAX_TRANSCRIPT_CHARS),
        verified: true,
        explicit: false,
        projectScoped: Boolean(input.scope.projectId),
        trust: 'project',
        lexicalScore: 0.85,
        semanticScore: null,
        observedAt: now,
        whySelected: 'Recent output from this session only (bounded tail).',
      });
    }
  }

  return Object.freeze(sources);
}

export type TerminalPromptUpgradeRequest = Readonly<{
  scope: TerminalPromptUpgradeScope;
  originalDraft: string;
  modelSelection: PromptForgeModelSelection;
  modelOptions: readonly PromptForgeModelOption[];
  currentChatSelection: PromptForgeCurrentChatSelection;
  offlineMode: boolean;
  defaultLocalModel: string;
  privacyMode: PromptForgePrivacyMode;
  allowPublicResearch: boolean;
  projectName?: string | null;
  projectRoot?: string | null;
  agentSlug?: string | null;
  agentName?: string | null;
  cwd?: string | null;
  workingDirectory?: string;
  signal?: AbortSignal;
  /** Extra sources (context maps, files) collected by the host. */
  additionalSources?: readonly PromptForgeSourceCandidate[];
}>;

export async function runTerminalPromptUpgrade(
  request: TerminalPromptUpgradeRequest,
): Promise<PromptUpgradeEngineResult> {
  const chatId = terminalPromptUpgradeChatId(request.scope);
  const sessionSources = buildTerminalPromptUpgradeSources({
    scope: request.scope,
    projectName: request.projectName,
    projectRoot: request.projectRoot,
    agentSlug: request.agentSlug,
    agentName: request.agentName,
    cwd: request.cwd,
  });
  const relatedSources = await collectTerminalRelatedSources(request.scope).catch(
    () => Object.freeze([]) as readonly PromptForgeSourceCandidate[],
  );
  const additionalSources = Object.freeze([
    ...sessionSources,
    ...relatedSources,
    ...(request.additionalSources ?? []),
  ]);

  return runPromptUpgrade({
    accountId: request.scope.accountId,
    chatId,
    projectId: request.scope.projectId,
    originalDraft: request.originalDraft,
    modelSelection: request.modelSelection,
    modelOptions: request.modelOptions,
    currentChatSelection: request.currentChatSelection,
    offlineMode: request.offlineMode,
    defaultLocalModel: request.defaultLocalModel,
    privacyMode: request.privacyMode,
    allowPublicResearch: request.allowPublicResearch,
    additionalSources,
    workingDirectory: request.workingDirectory ?? request.projectRoot ?? request.cwd ?? undefined,
    repository: createPromptForgeJobStore(db),
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

export function terminalModelOptionsFromPicker(
  flatOptions: readonly ModelPickerOption[],
): readonly PromptForgeModelOption[] {
  return accessiblePromptUpgradeModels(promptForgeModelOptionsFromPicker(flatOptions));
}

/**
 * Whether it is safe to insert upgraded text into the live PTY.
 * Never insert during interactive programs, password prompts, SSH, or
 * when we cannot verify a local shell prompt.
 */
export function canInsertUpgradedPromptIntoTerminal(
  evidence: TerminalPromptEvidence,
): Readonly<{ ok: true } | { ok: false; reason: string }> {
  if (!evidence.localShell) {
    return { ok: false, reason: 'Insert is only available on a verified local shell.' };
  }
  if (evidence.passwordPrompt) {
    return { ok: false, reason: 'Terminal is waiting for a password — copy instead.' };
  }
  if (evidence.sshSession) {
    return { ok: false, reason: 'SSH session is active — copy instead of auto-insert.' };
  }
  if (evidence.interactiveProgram || evidence.alternateScreen) {
    return {
      ok: false,
      reason: 'An interactive program is running — copy the upgrade; do not interrupt it.',
    };
  }
  if (!evidence.atPrompt) {
    return {
      ok: false,
      reason: 'Shell is busy or not at a prompt — copy the upgrade or wait for the prompt.',
    };
  }
  return { ok: true };
}
