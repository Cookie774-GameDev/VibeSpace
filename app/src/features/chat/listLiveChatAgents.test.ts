import { describe, expect, it } from 'vitest';
import { agentSelectorOptions, listLiveChatAgents } from './listLiveChatAgents';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';

function agent(
  partial: Partial<JarvisChatAgent> & Pick<JarvisChatAgent, 'agentId' | 'status'>,
): JarvisChatAgent {
  return {
    name: `Agent ${partial.agentId}`,
    parentChatId: 'parent',
    childChatId: `child_${partial.agentId}`,
    task: 'Do work',
    modelLabel: 'ollama / llama',
    filesTouched: [],
    lockedFiles: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:05:00.000Z',
    ...partial,
  };
}

describe('listLiveChatAgents', () => {
  it('prefers running agents and includes recently finished ones', () => {
    const now = Date.parse('2026-08-06T10:10:00.000Z');
    const agents = [
      agent({ agentId: 'done', status: 'done', updatedAt: '2026-08-06T10:09:00.000Z' }),
      agent({ agentId: 'run', status: 'editing', updatedAt: '2026-08-06T10:08:00.000Z' }),
      agent({ agentId: 'old', status: 'done', updatedAt: '2026-08-01T10:00:00.000Z' }),
    ];
    const live = listLiveChatAgents(agents, now);
    expect(live.map((a) => a.agentId)).toEqual(['run', 'done']);
    expect(agentSelectorOptions(agents, now).map((o) => o.childChatId)).toEqual([
      'child_run',
      'child_done',
    ]);
  });
});
