import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectExplicitVoiceAgentSlug,
  detectVoiceMention,
  ensureJarvisChatForVoice,
  ensureJarvisChatForProvider,
  isJarvisChat,
  voiceMessageTextForAgentRoute,
} from './voiceChatRouting';
import type { Agent, Chat } from '@/types';
import { chatRepo, db } from '@/lib/db';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { createJarvisChatIntentStore } from '@/features/chat/jarvisChatIntent';

const jarvisAgent = {
  id: 'agent-jarvis',
  slug: 'jarvis',
  name: 'Jarvis',
  builtin: true,
} as Agent;

const jarvisCollision = {
  ...jarvisAgent,
  id: 'agent-jarvis-collision',
  builtin: false,
} as Agent;

const criticAgent = {
  id: 'agent-critic',
  slug: 'critic',
  name: 'Critic',
} as Agent;

const agents = {
  [jarvisAgent.id]: jarvisAgent,
  [criticAgent.id]: criticAgent,
};

describe('provider-bound Jarvis voice chats', () => {
  it('creates a new provider chat for each voice opening even when older voice chats exist', async () => {
    const previousAuth = useAuthStore.getState();
    const previousAgents = useAgentStore.getState().agents;
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'voice-opening-account',
      workspaceId: 'voice-opening-workspace' as never,
      projectId: null,
    });
    useAgentStore.setState({ agents: { [jarvisAgent.id]: jarvisAgent } });
    vi.spyOn(db.chats, 'where').mockReturnValue({
      equals: () => ({
        toArray: async () => [
          {
            id: 'old-voice-chat',
            title: 'Jarvis Voice yesterday',
            active_agent_ids: [jarvisAgent.id],
            backend_affinity: { version: 1, backend: 'codex', locked: false, selectedAt: 1 },
          },
        ],
      }),
    } as never);
    let created = 0;
    const create = vi.spyOn(chatRepo, 'createAuthorized').mockImplementation(
      async (input) =>
        ({
          ...input,
          id: `new-voice-chat-${++created}`,
        }) as never,
    );

    try {
      await expect(
        ensureJarvisChatForProvider('codex', undefined, {
          freshVoiceConversation: true,
          openingId: 'first-opening',
        }),
      ).resolves.toBe('new-voice-chat-1');
      await expect(
        ensureJarvisChatForProvider('codex', undefined, {
          freshVoiceConversation: true,
          openingId: 'second-opening',
        }),
      ).resolves.toBe('new-voice-chat-2');
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        title: expect.stringMatching(/^Jarvis Voice /),
        backend_affinity: expect.objectContaining({ backend: 'codex' }),
      });
    } finally {
      useAuthStore.setState(previousAuth);
      useAgentStore.setState({ agents: previousAgents });
    }
  });

  it('creates a Codex chat with explicit backend affinity before its first message', async () => {
    const previousAuth = useAuthStore.getState();
    const previousAgents = useAgentStore.getState().agents;
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'voice-provider-account',
      workspaceId: 'voice-provider-workspace' as never,
      projectId: null,
    });
    useAgentStore.setState({ agents: { [jarvisAgent.id]: jarvisAgent } });
    vi.spyOn(db.chats, 'where').mockReturnValue({
      equals: () => ({ toArray: async () => [] }),
    } as never);
    const create = vi.spyOn(chatRepo, 'createAuthorized').mockImplementation(
      async (input) =>
        ({
          ...input,
          id: 'chat-codex-voice',
        }) as never,
    );

    try {
      await expect(ensureJarvisChatForProvider('codex')).resolves.toBe('chat-codex-voice');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          backend_affinity: expect.objectContaining({ backend: 'codex', locked: false }),
        }),
        expect.anything(),
        expect.any(Function),
      );
    } finally {
      useAuthStore.setState(previousAuth);
      useAgentStore.setState({ agents: previousAgents });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('voiceChatRouting detection', () => {
  it('stops an old intent flight when a new keyed flight starts in the same scope', async () => {
    const previousAuth = useAuthStore.getState();
    const previousAgents = useAgentStore.getState().agents;
    let releaseOldRead!: () => void;
    let markOldReadStarted!: () => void;
    const oldReadGate = new Promise<void>((resolve) => {
      releaseOldRead = resolve;
    });
    const oldReadStarted = new Promise<void>((resolve) => {
      markOldReadStarted = resolve;
    });
    let reads = 0;
    vi.spyOn(db.chats, 'where').mockReturnValue({
      equals: () => ({
        toArray: async () => {
          reads += 1;
          if (reads === 2) {
            markOldReadStarted();
            await oldReadGate;
          }
          return [];
        },
      }),
    } as never);
    const persisted: string[] = [];
    const insert = async (input: Record<string, unknown>, authorize?: () => boolean) => {
      if (authorize && !authorize()) return null;
      const id = `chat-voice-${persisted.length + 1}`;
      persisted.push(id);
      return { ...input, id } as never;
    };
    vi.spyOn(chatRepo, 'create').mockImplementation(
      async (input) => (await insert(input as never)) as never,
    );
    vi.spyOn(chatRepo, 'createAuthorized').mockImplementation(
      async (input, _owner, authorize) => (await insert(input as never, authorize)) as never,
    );
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'account-voice-intent',
      workspaceId: 'workspace-voice-intent' as never,
      projectId: 'project-voice-intent' as never,
    });
    useAgentStore.setState({ agents: { [jarvisAgent.id]: jarvisAgent } });
    const scope = {
      accountId: 'account-voice-intent',
      workspaceId: 'workspace-voice-intent',
      projectId: 'project-voice-intent',
    };

    try {
      const oldFlight = ensureJarvisChatForVoice('old intent');
      await oldReadStarted;
      createJarvisChatIntentStore(window.localStorage).write(scope, {
        intent: { kind: 'explicit-new' },
      });
      const newFlight = ensureJarvisChatForVoice('new intent');
      await expect(newFlight).resolves.toBe('chat-voice-1');
      releaseOldRead();

      await expect(oldFlight).resolves.toBeNull();
      expect(persisted).toEqual(['chat-voice-1']);
    } finally {
      releaseOldRead();
      useAuthStore.setState(previousAuth);
      useAgentStore.setState({ agents: previousAgents });
    }
  });

  it('single-flights concurrent Jarvis voice creation in one exact scope', async () => {
    const previousAuth = useAuthStore.getState();
    const previousAgents = useAgentStore.getState().agents;
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'account-voice',
      workspaceId: 'workspace-voice' as never,
      projectId: 'project-voice' as never,
    });
    useAgentStore.setState({ agents: { [jarvisAgent.id]: jarvisAgent } });
    vi.spyOn(db.chats, 'where').mockReturnValue({
      equals: () => ({ toArray: async () => [] }),
    } as never);
    const create = vi
      .spyOn(chatRepo, 'createAuthorized')
      .mockImplementation(async (input, _owner, authorize) =>
        authorize()
          ? ({
              ...input,
              id: 'chat-voice',
              workspace_id: 'workspace-voice',
              project_id: 'project-voice',
              active_agent_ids: [jarvisAgent.id],
            } as never)
          : null,
      );

    try {
      await expect(
        Promise.all([ensureJarvisChatForVoice('first'), ensureJarvisChatForVoice('second')]),
      ).resolves.toEqual(['chat-voice', 'chat-voice']);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      useAuthStore.setState(previousAuth);
      useAgentStore.setState({ agents: previousAgents });
    }
  });

  it('rereads the exact scope before creation and reuses a newly visible chat', async () => {
    const previousAuth = useAuthStore.getState();
    const previousAgents = useAgentStore.getState().agents;
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'account-voice',
      workspaceId: 'workspace-voice' as never,
      projectId: 'project-voice' as never,
    });
    useAgentStore.setState({ agents: { [jarvisAgent.id]: jarvisAgent } });
    let reads = 0;
    vi.spyOn(db.chats, 'where').mockReturnValue({
      equals: () => ({
        toArray: async () => {
          reads += 1;
          return reads === 1
            ? []
            : [
                {
                  id: 'chat-visible',
                  workspace_id: 'workspace-voice',
                  project_id: 'project-voice',
                  active_agent_ids: [jarvisAgent.id],
                  updated_at: 20,
                },
              ];
        },
      }),
    } as never);
    const create = vi.spyOn(chatRepo, 'create');

    try {
      await expect(ensureJarvisChatForVoice()).resolves.toBe('chat-visible');
      expect(create).not.toHaveBeenCalled();
    } finally {
      useAuthStore.setState(previousAuth);
      useAgentStore.setState({ agents: previousAgents });
    }
  });

  it('treats empty active_agent_ids as a Jarvis chat', () => {
    const chat = { active_agent_ids: [] } as unknown as Chat;
    expect(isJarvisChat(chat, agents)).toBe(true);
  });

  it('treats critic-bound chats as non-Jarvis', () => {
    const chat = { active_agent_ids: [criticAgent.id] } as unknown as Chat;
    expect(isJarvisChat(chat, agents)).toBe(false);
  });

  it('rejects a user-created jarvis slug collision as a protected voice chat', () => {
    const collisionAgents = { [jarvisCollision.id]: jarvisCollision };
    const chat = { active_agent_ids: [jarvisCollision.id] } as unknown as Chat;

    expect(isJarvisChat(chat, collisionAgents)).toBe(false);
    expect(isJarvisChat({ active_agent_ids: [] } as unknown as Chat, collisionAgents)).toBe(false);
  });

  it('defaults generic utterances to Jarvis (no explicit agent)', () => {
    expect(detectExplicitVoiceAgentSlug('open five terminals')).toBeNull();
    expect(detectExplicitVoiceAgentSlug('hey Jarvis what is up')).toBeNull();
  });

  it('routes ask-the-agent phrasing to the named specialist', () => {
    expect(detectExplicitVoiceAgentSlug('ask the critic to review this')).toBe('critic');
    expect(voiceMessageTextForAgentRoute('ask the critic to review this', 'critic')).toBe(
      'to review this',
    );
  });

  it('routes @mentions to specialists but ignores @jarvis', () => {
    expect(detectVoiceMention('@critic fix the intro')).toBe('critic');
    expect(detectExplicitVoiceAgentSlug('@critic fix the intro')).toBe('critic');
    expect(detectExplicitVoiceAgentSlug('@jarvis summarize')).toBeNull();
  });

  it('routes dictation-into-agent phrasing', () => {
    expect(detectExplicitVoiceAgentSlug('type into critic the new paragraph')).toBe('critic');
    expect(voiceMessageTextForAgentRoute('type into critic the new paragraph', 'critic')).toBe(
      'the new paragraph',
    );
  });
});
