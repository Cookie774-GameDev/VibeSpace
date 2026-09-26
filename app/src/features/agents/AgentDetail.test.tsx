import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisProfile } from '@/lib/jarvis/profiles/types';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Agent, AgentId, ProjectId, WorkspaceId } from '@/types';
import { AgentDetail } from './AgentDetail';

const { chatCreateMock, getActiveProfileMock } = vi.hoisted(() => ({
  chatCreateMock: vi.fn(),
  getActiveProfileMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  chatRepo: {
    create: chatCreateMock,
  },
}));

vi.mock('@/lib/db/jarvisRepositories', () => ({
  jarvisProfileRepo: {
    getActive: getActiveProfileMock,
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const protectedJarvis: Agent = {
  id: 'agent_protected_jarvis' as AgentId,
  slug: 'jarvis',
  name: 'JARVIS',
  description: 'Protected built-in assistant',
  system_prompt: 'LEGACY JARVIS SYSTEM PROMPT MUST NEVER RENDER',
  model: { provider: 'google', model: 'gemini-2.5-flash' },
  tools_allowed: ['files.read'],
  memory_scope: 'project',
  capabilities: ['writing'],
  temperature: 0.4,
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

const ordinaryAgent: Agent = {
  ...protectedJarvis,
  id: 'agent_ordinary' as AgentId,
  slug: 'writer',
  name: 'Writer',
  description: 'Ordinary agent',
  system_prompt: 'ORDINARY AGENT SYSTEM PROMPT',
  builtin: false,
};

const slugCollisionAgent: Agent = {
  ...ordinaryAgent,
  id: 'agent_slug_collision' as AgentId,
  slug: 'jarvis',
  name: 'User JARVIS',
  system_prompt: 'USER COLLISION SYSTEM PROMPT',
};

function profile(accountId: string, customInstructions: string): JarvisProfile {
  return {
    id: `profile-${accountId}`,
    revisionId: `revision-${accountId}`,
    accountId,
    name: 'Jarvis',
    customInstructions,
    instructionSource: customInstructions.length === 0 ? 'none' : 'user',
    memoryScope: 'profile',
    voiceEnabled: true,
    active: true,
    identityVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function selectAgent(agent: Agent): void {
  useAgentStore.getState().registerAgent(agent);
  useUIStore.setState({ activeAgentId: agent.id });
}

describe('AgentDetail profile projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useUIStore.setState(useUIStore.getInitialState(), true);
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
      apiKeys: {},
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: '',
    });
    useUIStore.setState({
      activeAgentId: protectedJarvis.id,
      activeChatId: null,
      chatMode: 'council',
      route: 'agent-detail',
    });
    useAgentStore.getState().registerAgent(protectedJarvis);
    chatCreateMock.mockResolvedValue({ id: 'chat-created' });
  });

  it('shows active-profile Custom instructions for protected JARVIS and never the legacy prompt', async () => {
    getActiveProfileMock.mockResolvedValue(profile('account-a', 'PROFILE CUSTOM INSTRUCTIONS'));

    render(<AgentDetail />);

    expect(await screen.findByText('PROFILE CUSTOM INSTRUCTIONS')).toBeTruthy();
    expect(screen.getByText('27 chars · ~7 tokens')).toBeTruthy();
    expect(screen.getByText('Custom instructions')).toBeTruthy();
    expect(screen.queryByText('System prompt')).toBeNull();
    expect(screen.queryByText(protectedJarvis.system_prompt)).toBeNull();
    expect(getActiveProfileMock).toHaveBeenCalledWith('account-a');
  });

  it('treats an empty active profile as ready rather than loading', async () => {
    getActiveProfileMock.mockResolvedValue(profile('account-a', ''));

    render(<AgentDetail />);

    await waitFor(() => expect(screen.queryByText('Profile is still loading')).toBeNull());
    expect(screen.getByText('Custom instructions')).toBeTruthy();
    expect(screen.getByText(/0 chars/)).toBeTruthy();
    expect(screen.getByText(/No custom instructions saved for this agent/i)).toBeTruthy();
    expect(screen.queryByText(protectedJarvis.system_prompt)).toBeNull();
  });

  it('keeps a missing protected profile in a bounded loading state', async () => {
    getActiveProfileMock.mockResolvedValue(undefined);

    render(<AgentDetail />);

    await waitFor(() => expect(getActiveProfileMock).toHaveBeenCalledWith('account-a'));
    expect(screen.getByRole('status').textContent).toBe('Profile is still loading');
    expect(screen.queryByText('0 chars · ~0 tokens')).toBeNull();
    expect(screen.queryByText(protectedJarvis.system_prompt)).toBeNull();
  });

  it('clears the previous account profile immediately before loading the next account', async () => {
    const accountB = deferred<JarvisProfile | undefined>();
    getActiveProfileMock.mockImplementation((accountId: string) =>
      accountId === 'account-a'
        ? Promise.resolve(profile(accountId, 'ACCOUNT A INSTRUCTIONS'))
        : accountB.promise,
    );
    render(<AgentDetail />);
    expect(await screen.findByText('ACCOUNT A INSTRUCTIONS')).toBeTruthy();

    act(() => useAuthStore.setState({ localUserId: 'account-b' }));

    expect(screen.queryByText('ACCOUNT A INSTRUCTIONS')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Profile is still loading');
    accountB.resolve(profile('account-b', 'ACCOUNT B INSTRUCTIONS'));
    expect(await screen.findByText('ACCOUNT B INSTRUCTIONS')).toBeTruthy();
  });

  it('ignores a stale profile load from a prior account generation', async () => {
    const accountA = deferred<JarvisProfile | undefined>();
    const accountB = deferred<JarvisProfile | undefined>();
    getActiveProfileMock.mockImplementation((accountId: string) =>
      accountId === 'account-a' ? accountA.promise : accountB.promise,
    );
    render(<AgentDetail />);
    await waitFor(() => expect(getActiveProfileMock).toHaveBeenCalledWith('account-a'));

    act(() => useAuthStore.setState({ localUserId: 'account-b' }));
    await waitFor(() => expect(getActiveProfileMock).toHaveBeenCalledWith('account-b'));
    accountB.resolve(profile('account-b', 'CURRENT ACCOUNT B INSTRUCTIONS'));
    expect(await screen.findByText('CURRENT ACCOUNT B INSTRUCTIONS')).toBeTruthy();

    accountA.resolve(profile('account-a', 'STALE ACCOUNT A INSTRUCTIONS'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('STALE ACCOUNT A INSTRUCTIONS')).toBeNull();
    expect(screen.getByText('CURRENT ACCOUNT B INSTRUCTIONS')).toBeTruthy();
  });

  it('does not fall back to local scope for a malformed cloud identity', async () => {
    useAuthStore.setState({
      localUserId: 'valid-local-account',
      cloudSession: { user_id: '   ', email: 'cloud@example.com', expires_at: 123 },
    });

    render(<AgentDetail />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getActiveProfileMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Profile is still loading');
    expect(screen.queryByText(protectedJarvis.system_prompt)).toBeNull();
  });

  it.each([
    ['ordinary agent', ordinaryAgent],
    ['user-created jarvis slug collision', slugCollisionAgent],
  ])('keeps %s on the legacy System prompt path without loading a profile', (_name, agent) => {
    selectAgent(agent);

    render(<AgentDetail />);

    expect(screen.getByText('System prompt')).toBeTruthy();
    expect(screen.getByText(agent.system_prompt)).toBeTruthy();
    expect(screen.queryByText('Custom instructions')).toBeNull();
    expect(getActiveProfileMock).not.toHaveBeenCalled();
  });

  it('preserves provider, model, metadata, and Start chat navigation', async () => {
    selectAgent(ordinaryAgent);
    render(<AgentDetail />);

    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.getAllByText('gemini-2.5-flash')).toHaveLength(2);
    expect(screen.getByText('0.40')).toBeTruthy();
    expect(screen.getByText('writing')).toBeTruthy();
    expect(screen.getByText('project')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(chatCreateMock).toHaveBeenCalledTimes(1));
    expect(chatCreateMock).toHaveBeenCalledWith({
      workspace_id: 'workspace-a',
      project_id: 'project-a',
      title: 'Chat with Writer',
      mode: 'chat',
      active_agent_ids: [ordinaryAgent.id],
    });
    expect(useUIStore.getState()).toMatchObject({
      activeChatId: 'chat-created',
      chatMode: 'chat',
      route: 'chat',
    });
  });
});
