import { useAgentStore } from '@/stores/agents';
import type { ChatId } from '@/types/common';
import { useChatActivityStore } from './activityStore';
import type { ChatActivityCategory } from './types';

export type LiveAgentActivityPhase = Readonly<{
  category: ChatActivityCategory;
  title: string;
  subtitle?: string;
  detail?: string;
}>;

type LiveRunBinding = Readonly<{
  chatId: string;
  activityId: string;
}>;

const liveRunBindings = new Map<string, LiveRunBinding>();
const PHASE_VERB: Readonly<Record<ChatActivityCategory, string>> = {
  thinking: 'thinking',
  file: 'reading files',
  writing: 'writing files',
  coordination: 'coordinating',
  context: 'gathering context',
  learning: 'learning',
  response: 'writing response',
};

export function setLiveAgentActivityPhase(
  chatId: ChatId | string,
  activityId: string,
  phase: LiveAgentActivityPhase,
): boolean {
  const chatKey = String(chatId);
  const event = useChatActivityStore
    .getState()
    .eventsByChat[chatKey]?.find((candidate) => candidate.id === activityId);
  if (!event || event.status !== 'running') return false;
  if (event.agentId) {
    useAgentStore.getState().setVerb(event.agentId, PHASE_VERB[phase.category]);
  }
  if (
    event.category === phase.category &&
    event.title === phase.title &&
    event.subtitle === phase.subtitle &&
    event.detail === phase.detail
  ) {
    return false;
  }
  useChatActivityStore.getState().update(chatId, activityId, {
    category: phase.category,
    title: phase.title,
    subtitle: phase.subtitle,
    detail: phase.detail,
    ts: Date.now(),
  });
  return true;
}

export function bindLiveAgentActivityRun(
  runId: string,
  chatId: ChatId | string,
  activityId: string,
): () => void {
  const binding = Object.freeze({ chatId: String(chatId), activityId });
  liveRunBindings.set(runId, binding);
  return () => {
    if (liveRunBindings.get(runId) === binding) liveRunBindings.delete(runId);
  };
}

export function setLiveAgentActivityRunPhase(
  runId: string,
  phase: LiveAgentActivityPhase,
): boolean {
  const binding = liveRunBindings.get(runId);
  if (!binding) return false;
  return setLiveAgentActivityPhase(binding.chatId, binding.activityId, phase);
}
