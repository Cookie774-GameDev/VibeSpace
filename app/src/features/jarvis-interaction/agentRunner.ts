import { chatRepo as realChatRepo, messageRepo as realMessageRepo } from '@/lib/db/repositories';
import { newChatId } from '@/lib/ids';
import type { AgentId, ChatId } from '@/types/common';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { CHAT_BACKEND_AFFINITY_VERSION, type ChatBackend } from '@/lib/ai/backend/chatBackend';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import {
  createEmptyJarvisCoordinationSnapshot,
  loadJarvisCoordinationSnapshot,
  registerJarvisChatAgent,
  saveJarvisCoordinationSnapshot,
} from './coordination';
import { formatActiveChatCommandMessage } from '@/features/chat/chatActiveCommands';
import { buildJarvisChatAgentPrompt, createJarvisChatAgentCard } from './agents';
import { useJarvisInteractionStore } from './sessionStore';
import type { JarvisChatAgent } from './types';
import type { VoiceAgentProvider } from '@/features/voice/voiceProviderSelection';

type ChatRepoLike = Pick<typeof realChatRepo, 'getById' | 'create'>;
type MessageRepoLike = Pick<typeof realMessageRepo, 'create'>;

export interface LaunchJarvisChatAgentInput {
  parentChatId: ChatId | string;
  task: string;
  modelLabel: string;
  modelSelection?: ChatModelSelection;
  /** Exact execution backend for voice workers; omitted to preserve legacy callers. */
  workerProvider?: VoiceAgentProvider;
  /** Approved images, such as a single permitted screen capture, for the worker turn. */
  imageAttachments?: readonly ChatImageAttachment[];
  /** Voice already recorded the parent turn; false avoids a second synthetic command message. */
  recordParentCommand?: boolean;
  jarvisAgentId?: AgentId | string;
  commandName?: 'multitask' | 'subagents';
  repos?: { chatRepo: ChatRepoLike; messageRepo: MessageRepoLike };
  dispatchEvent?: (event: CustomEvent) => void;
  now?: string;
  createId?: (prefix: 'chat' | 'agent') => string;
}

function backendForVoiceProvider(provider: VoiceAgentProvider): ChatBackend {
  return provider;
}

function providerLabel(provider: VoiceAgentProvider): 'Codex' | 'OpenCode' {
  return provider === 'codex' ? 'Codex' : 'OpenCode';
}

function reportedModelLabel(provider: VoiceAgentProvider | undefined, modelLabel: string): string {
  if (!provider) return modelLabel;
  const prefix = `${providerLabel(provider)} · `;
  return modelLabel.startsWith(prefix) ? modelLabel : `${prefix}${modelLabel}`;
}

function assertVoiceWorkerSelection(
  provider: VoiceAgentProvider | undefined,
  selection: ChatModelSelection | undefined,
): void {
  if (!provider) return;
  const expectedConnectionId =
    provider === 'codex' ? CODEX_CLI_CONNECTION.id : OPENCODE_CLI_CONNECTION.id;
  if (selection?.mode !== 'single' || selection.connectionId !== expectedConnectionId) {
    throw new Error(
      `${providerLabel(provider)} worker provider does not match the selected model connection.`,
    );
  }
}

export async function launchJarvisChatAgent(input: LaunchJarvisChatAgentInput): Promise<{
  agentId: string;
  childChatId: string;
  agents: JarvisChatAgent[];
}> {
  assertVoiceWorkerSelection(input.workerProvider, input.modelSelection);
  const repos = input.repos ?? { chatRepo: realChatRepo, messageRepo: realMessageRepo };
  const dispatchEvent =
    input.dispatchEvent ?? ((event: CustomEvent) => window.dispatchEvent(event));
  const now = input.now ?? new Date().toISOString();
  const selectedAt = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const cardModelLabel = reportedModelLabel(input.workerProvider, input.modelLabel);
  const parent = await repos.chatRepo.getById(input.parentChatId as ChatId);
  if (!parent) throw new Error(`Parent chat ${input.parentChatId} not found`);

  const taskPlan =
    input.commandName === 'subagents'
      ? buildSubagentLaunchPlan(input.task)
      : [{ kind: 'agent' as const, task: input.task }];
  const cards: JarvisChatAgent[] = [];
  for (const plan of taskPlan) {
    const childChatId = input.createId?.('chat') ?? newChatId();
    const agentId = input.createId?.('agent') ?? `ja_${Date.now().toString(36)}_${cards.length}`;
    const childTitle = `${plan.kind === 'planner' ? 'Planner' : 'Agent'}: ${plan.task.slice(0, 48) || 'Jarvis task'}`;
    await repos.chatRepo.create({
      id: childChatId as ChatId,
      workspace_id: parent.workspace_id,
      project_id: parent.project_id,
      title: childTitle,
      mode: 'chat',
      active_agent_ids: input.jarvisAgentId ? [input.jarvisAgentId as AgentId] : [],
      // A voice worker's route must match its durable backend affinity; other
      // callers retain the existing parent-connection inheritance behavior.
      ...(input.workerProvider
        ? {
            connection:
              input.workerProvider === 'codex' ? CODEX_CLI_CONNECTION : OPENCODE_CLI_CONNECTION,
          }
        : parent.connection
          ? { connection: parent.connection }
          : {}),
      ...(input.workerProvider
        ? {
            backend_affinity: {
              version: CHAT_BACKEND_AFFINITY_VERSION,
              backend: backendForVoiceProvider(input.workerProvider),
              locked: false,
              selectedAt,
            },
          }
        : {}),
    });
    // Multitask/subagent children must always use VibeSpace native chat, never
    // inherit a sticky global Browser Chat engine preference.
    browserChatStore.getState().setEngine('native', String(childChatId));

    const card = {
      ...createJarvisChatAgentCard({
        agentId,
        parentChatId: input.parentChatId,
        childChatId,
        task: plan.task,
        modelLabel: cardModelLabel,
        modelSelection: input.modelSelection,
        now,
      }),
      name:
        plan.kind === 'planner' ? 'Jarvis Planner' : createSubagentName(plan.task, cards.length),
      currentStep: plan.kind === 'planner' ? 'Planning subagent split' : 'Queued for child chat',
    };
    cards.push(card);
  }

  const firstCard = cards[0];
  if (!firstCard) throw new Error('No Jarvis agent cards were created');
  const commandName = input.commandName === 'subagents' ? 'subagents' : 'multitask';
  if (input.recordParentCommand !== false) {
    await repos.messageRepo.create({
      chat_id: input.parentChatId as ChatId,
      role: 'user',
      // Active command in use — not an attachment chip.
      parts: [{ kind: 'text', text: formatActiveChatCommandMessage(commandName, input.task) }],
    });
  }
  await repos.messageRepo.create({
    chat_id: input.parentChatId as ChatId,
    role: 'assistant',
    parts: cards.map((agent) => ({ kind: 'agent_card' as const, agent })),
  });
  for (const card of cards) {
    useJarvisInteractionStore.getState().upsertAgent(input.parentChatId, card);
  }

  if (parent.project_id) {
    try {
      const root = getStoredProjectRoot(parent.project_id);
      if (root) {
        const snapshot = await loadJarvisCoordinationSnapshot(root).catch(() =>
          createEmptyJarvisCoordinationSnapshot(root, now),
        );
        let next = snapshot;
        for (const card of cards) {
          next = registerJarvisChatAgent(next, {
            agentId: String(card.agentId),
            name: card.name,
            modelLabel: cardModelLabel,
            chatId: card.childChatId,
            task: card.task,
            now,
          });
        }
        await saveJarvisCoordinationSnapshot(root, next);
      }
    } catch {
      // Browser preview or unavailable project roots degrade to the persisted session card.
    }
  }

  // Runtime assumes the user turn is already persisted (same contract as Composer).
  // Without a child user message, toLLMMessages is empty and the worker thread fails.
  for (const card of cards) {
    const childPrompt = buildJarvisChatAgentPrompt(card.task);
    const childParts = [
      { kind: 'text' as const, text: childPrompt },
      ...(input.imageAttachments ?? []).map((image) => ({
        kind: 'image' as const,
        url: `data:${image.mimeType};base64,${image.data}`,
        alt: image.name,
      })),
    ];
    await repos.messageRepo.create({
      chat_id: card.childChatId as ChatId,
      role: 'user',
      parts: childParts,
    });
    useJarvisInteractionStore.getState().updateAgent(input.parentChatId, card.agentId, {
      status: 'thinking',
      currentStep: 'Running in child chat',
      updatedAt: new Date().toISOString(),
    });
    dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: {
          chatId: card.childChatId,
          text: childPrompt,
          interactionMode: 'agent',
          ...(input.jarvisAgentId ? { agentId: input.jarvisAgentId } : {}),
          ...(input.modelSelection ? { modelSelectionOverride: input.modelSelection } : {}),
          structuredContext: {
            kind: input.commandName === 'subagents' ? 'subagents' : 'multitask',
            payload: {
              parentChatId: input.parentChatId,
              agentId: card.agentId,
              commandName: input.commandName ?? 'multitask',
              task: card.task,
              ...(input.workerProvider ? { workerProvider: input.workerProvider } : {}),
              screenshotAttached: Boolean(input.imageAttachments?.length),
              allTasks: cards.map((agent) => ({ agentId: agent.agentId, task: agent.task })),
            },
          },
        },
      }),
    );
  }

  return {
    agentId: String(firstCard.agentId),
    childChatId: String(firstCard.childChatId),
    agents: cards,
  };
}

type LaunchPlanItem = {
  kind: 'agent' | 'planner' | 'subagent';
  task: string;
};

function buildSubagentLaunchPlan(task: string): LaunchPlanItem[] {
  const subagentTasks = deriveSubagentTasks(task);
  return [
    { kind: 'planner', task: `Plan subagents for: ${task}` },
    ...subagentTasks.slice(0, 2).map((subtask) => ({ kind: 'subagent' as const, task: subtask })),
  ];
}

function deriveSubagentTasks(task: string): string[] {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (!normalized) return ['Clarify the requested subagent task'];
  const parts = normalized
    .split(/\s*(?:,|;|\band\b)\s+/i)
    .map((part) => normalizeSubtask(part))
    .filter(Boolean);
  const unique = Array.from(new Set(parts));
  return (unique.length > 0 ? unique : [normalized]).slice(0, 3);
}

function normalizeSubtask(part: string): string {
  return part
    .replace(/^(?:and|then|also)\s+/i, '')
    .replace(/\.$/, '')
    .trim();
}

function createSubagentName(task: string, index: number): string {
  const title = task
    .replace(/^(?:fix|make|update|create|build|review|audit)\s+/i, '')
    .replace(/\.$/, '')
    .trim();
  return title ? `Subagent ${index}: ${capitalize(title).slice(0, 34)}` : `Subagent ${index}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
