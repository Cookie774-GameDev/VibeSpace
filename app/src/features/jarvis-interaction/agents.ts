import type { ChatId } from '@/types/common';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import type { JarvisChatAgent } from './types';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'into',
  'from',
  'this',
  'that',
  'please',
  'jarvis',
  'review',
  'build',
  'create',
  'update',
  'fix',
  'make',
]);

export function createJarvisChatAgentName(task: string): string {
  const word = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((part) => part.length > 3 && !STOP_WORDS.has(part));
  if (!word) return 'Jarvis Agent';
  return `Jarvis ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

export function createJarvisChatAgentCard(input: {
  agentId: string;
  parentChatId: ChatId | string;
  childChatId: ChatId | string;
  task: string;
  modelLabel: string;
  modelSelection?: ChatModelSelection;
  now: string;
}): JarvisChatAgent {
  return {
    agentId: input.agentId,
    name: createJarvisChatAgentName(input.task),
    parentChatId: input.parentChatId,
    childChatId: input.childChatId,
    task: input.task,
    modelLabel: input.modelLabel,
    modelSelection: input.modelSelection,
    status: 'thinking',
    currentStep: 'Child chat started',
    filesRead: [],
    filesEditing: [],
    diffSummary: { addedLines: 0, removedLines: 0 },
    filesTouched: [],
    lockedFiles: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function buildJarvisChatAgentPrompt(task: string): string {
  return [
    'You are a chat-native Jarvis multitask agent inside the VibeSpace chat interface.',
    'You are a worker for a parent chat supervisor. Stay in this thread and complete the assigned task.',
    'Do not spawn terminal panes. Use the current chat model.',
    'When finished, end with a clear one-line RESULT for the parent (what you did and any key paths).',
    'If the parent relays follow-up messages, respond in this same thread. Do not claim the parent UI updated.',
    '',
    `Task: ${task}`,
  ].join('\n');
}
