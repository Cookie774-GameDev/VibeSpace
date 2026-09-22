import { afterEach, describe, expect, it } from 'vitest';
import type { Chat } from '@/types/chat';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { writeChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import { readCaoChatTargetIdentity, resolveCaoChatBackend } from './targetIdentity';

function chat(backend_affinity?: Chat['backend_affinity']): Chat {
  return {
    id: 'chat-identity-test',
    workspace_id: 'workspace-identity-test',
    project_id: 'project-identity-test',
    title: 'Identity test chat',
    mode: 'chat',
    active_agent_ids: [],
    connection: {
      id: 'openai-codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
    },
    ...(backend_affinity ? { backend_affinity } : {}),
    created_at: 1,
    updated_at: 1,
  } as unknown as Chat;
}

afterEach(() => {
  resetDiscoveredConnectionModelsForTests();
  localStorage.removeItem('vibespace.chat-runtime-settings.v1');
});

describe('CAO shared target identity', () => {
  it('derives the backend from a legacy Codex connection without affinity', () => {
    expect(resolveCaoChatBackend(chat())).toBe('codex');
  });

  it('rejects a persisted affinity that conflicts with the exact connection', () => {
    expect(
      resolveCaoChatBackend(
        chat({
          version: 1,
          backend: 'opencode',
          locked: true,
          selectedAt: 1,
          lockedAt: 1,
        }),
      ),
    ).toBeUndefined();
  });

  it('resolves the displayed live effort for a legacy Codex chat', () => {
    setDiscoveredConnectionModels('openai-codex', [
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        variants: ['low', 'high'],
        defaultReasoningEffort: 'low',
        source: 'cli_model',
        lastVerifiedAt: 1,
      },
    ]);
    writeChatRuntimePolicyState('chat-identity-test', {
      settings: {
        effort: 'low',
        fastMode: 'auto',
        performance: 'balanced',
        rlmEnabled: false,
      },
      access: 'read-only',
      approveAllForRun: false,
    });

    expect(readCaoChatTargetIdentity(chat())).toMatchObject({
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    });
  });
});
