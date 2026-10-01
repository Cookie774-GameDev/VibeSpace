import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentId } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { syncDiscoveredOllamaModels } from '@/lib/ai/models';
import { resetProviderModelCache } from '@/lib/ai/providerModelCatalog';
import type { JarvisProfile } from '@/lib/jarvis/profiles/types';
import { AgentManager } from './AgentManager';

const recycleBinMocks = vi.hoisted(() => ({
  moveAgentToRecycleBin: vi.fn(),
}));

vi.mock('@/features/recycle-bin/recycleBinService', () => ({
  recycleBinService: recycleBinMocks,
}));

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    agentRepo: {
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('@/lib/db/jarvisRepositories', () => ({
  jarvisProfileRepo: {
    getActive: vi.fn(),
    updateCustomInstructions: vi.fn(),
  },
}));

vi.mock('@/lib/ai/providers/ollama', () => ({
  isOllamaReachable: vi.fn(async () => false),
  listOllamaModels: vi.fn(async () => []),
}));

const baseAgent: Agent = {
  id: 'agent_alpha' as AgentId,
  slug: 'alpha',
  name: 'Alpha Agent',
  description: 'Existing description',
  system_prompt: 'Existing prompt\n\nKeep this formatting.',
  model: { provider: 'google', model: 'gemini-2.5-flash' },
  tools_allowed: ['files.read'],
  memory_scope: 'project',
  capabilities: ['writing'],
  skills: ['analyze'],
  temperature: 0.7,
  effort: 'medium',
  persona: 'jarvis',
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

const secondAgent: Agent = {
  ...baseAgent,
  id: 'agent_beta' as AgentId,
  slug: 'beta',
  name: 'Beta Agent',
  updated_at: 2,
};

const protectedJarvis: Agent = {
  ...baseAgent,
  id: 'agent_jarvis' as AgentId,
  slug: 'jarvis',
  name: 'JARVIS',
  system_prompt: 'Legacy protected prompt',
  builtin: true,
};

const jarvisSlugCollision: Agent = {
  ...baseAgent,
  id: 'agent_jarvis_collision' as AgentId,
  slug: 'jarvis',
  name: 'User Jarvis',
  builtin: false,
};

function profileFixture(overrides: Partial<JarvisProfile> = {}): JarvisProfile {
  return {
    id: 'profile_local-user-a',
    revisionId: 'revision_1',
    accountId: 'local-user-a',
    name: 'JARVIS',
    customInstructions: 'Be concise.',
    instructionSource: 'user',
    memoryScope: 'profile',
    voiceEnabled: false,
    active: true,
    identityVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function repoMocks(agent: Agent = baseAgent) {
  const { agentRepo } = await import('@/lib/db');
  vi.mocked(agentRepo.getById).mockResolvedValue(agent);
  vi.mocked(agentRepo.create).mockImplementation(async (created) => ({
    ...created,
    id: created.id ?? agent.id,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  }));
  vi.mocked(agentRepo.update).mockImplementation(async (_id, patch) => ({
    ...agent,
    ...patch,
    model: patch.model ?? agent.model,
    updated_at: 3,
  }));
  vi.mocked(agentRepo.delete).mockResolvedValue(undefined);
  return agentRepo;
}

async function profileRepoMocks(profile: JarvisProfile | undefined = profileFixture()) {
  const { jarvisProfileRepo } = await import('@/lib/db/jarvisRepositories');
  vi.mocked(jarvisProfileRepo.getActive).mockResolvedValue(profile);
  vi.mocked(jarvisProfileRepo.updateCustomInstructions).mockImplementation(
    async (_accountId, _profileId, customInstructions) => ({
      ...(profile ?? profileFixture()),
      customInstructions: customInstructions.replace(/\r\n?/g, '\n'),
      instructionSource: customInstructions.length === 0 ? 'none' : 'user',
      revisionId: 'revision_2',
      updatedAt: 2,
    }),
  );
  return jarvisProfileRepo;
}

function registerOnly(agent: Agent) {
  useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
  useAgentStore.getState().registerMany([agent]);
}

describe('AgentManager save lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: { google: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultProvider: 'google',
      defaultLocalModel: '',
      cloudSession: null,
      localUserId: 'local-user-a',
    });
    useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
    useAgentStore.getState().registerMany([baseAgent, secondAgent]);
    await repoMocks();
    await profileRepoMocks();
  });

  it('enables Save immediately for valid name and prompt changes, then resets after persistence', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);
    const save = screen.getByRole('button', { name: 'Save agent' });
    expect(save).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('idle');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Renamed' } });
    expect(save).toHaveProperty('disabled', false);
    expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('unsaved');
    fireEvent.change(screen.getByLabelText('System prompt'), {
      target: { value: 'Updated prompt\n\nKeep formatting.' },
    });
    fireEvent.click(save);

    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(agentRepo.update).toHaveBeenCalledWith(
      baseAgent.id,
      expect.objectContaining({
        name: 'Alpha Renamed',
        system_prompt: 'Updated prompt\n\nKeep formatting.',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', true),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('saved'),
    );
  });

  it('requires confirmation before moving a custom agent to the Recycle Bin', async () => {
    recycleBinMocks.moveAgentToRecycleBin.mockResolvedValueOnce(undefined);
    render(<AgentManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(recycleBinMocks.moveAgentToRecycleBin).not.toHaveBeenCalled();
    expect(
      screen.getByRole('alertdialog', { name: 'Move Alpha Agent to Recycle Bin?' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(recycleBinMocks.moveAgentToRecycleBin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Recycle Bin' }));
    await waitFor(() =>
      expect(recycleBinMocks.moveAgentToRecycleBin).toHaveBeenCalledWith(baseAgent),
    );
  });

  it('limits persona options to jarvis and friday and offers recommended max tokens', async () => {
    render(<AgentManager />);
    const persona = screen.getByLabelText('Persona') as HTMLSelectElement;
    expect(Array.from(persona.options).map((option) => option.value)).toEqual(['jarvis', 'friday']);
    const maxTokens = screen.getByLabelText('Max output tokens') as HTMLSelectElement;
    expect(Array.from(maxTokens.options).map((option) => option.value)).toEqual([
      'recommended',
      'custom',
    ]);
    expect(maxTokens.value).toBe('recommended');
  });

  it('renders unavailable mock-default state truthfully without migrating agent or auth state', async () => {
    const mockDefaultAgent: Agent = {
      ...baseAgent,
      model: { provider: 'mock', model: 'mock-default' },
    };
    const agentRepo = await repoMocks(mockDefaultAgent);
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'ollama',
      defaultLocalModel: 'llama3.2:latest',
    });
    syncDiscoveredOllamaModels(['llama3.2:latest']);
    registerOnly(mockDefaultAgent);

    render(<AgentManager />);

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    const unavailable = Array.from(provider.options).find((option) => option.value === 'mock');
    expect(provider.value).toBe('mock');
    expect(unavailable?.selected).toBe(true);
    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.textContent).toContain('Mock (demo)');
    expect(unavailable?.textContent).toContain('unavailable');
    expect(screen.getByText(/configured for Mock \(demo\)/i).textContent).toContain(
      'Default provider (Local Models)',
    );
    expect(screen.queryByText(/Connect Mock/i)).toBeNull();

    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(useAgentStore.getState().agents[mockDefaultAgent.id]?.model).toEqual({
      provider: 'mock',
      model: 'mock-default',
    });
    expect(useAuthStore.getState().defaultProvider).toBe('ollama');
    expect(useAuthStore.getState().defaultLocalModel).toBe('llama3.2:latest');
  });

  it('keeps a connected provider as a normal available provider', async () => {
    registerOnly(baseAgent);
    await repoMocks(baseAgent);

    render(<AgentManager />);

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    const googleOption = Array.from(provider.options).find((option) => option.value === 'google');
    expect(provider.value).toBe('google');
    expect(googleOption?.disabled).toBe(false);
    expect(screen.queryByText(/unavailable current provider/i)).toBeNull();
  });

  it('preserves the actual Default provider sentinel behavior', async () => {
    const defaultAgent: Agent = {
      ...baseAgent,
      model: { provider: 'mock', model: 'default-provider' },
    };
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'ollama',
      defaultLocalModel: 'llama3.2:latest',
    });
    syncDiscoveredOllamaModels(['llama3.2:latest']);
    registerOnly(defaultAgent);
    await repoMocks(defaultAgent);

    render(<AgentManager />);

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(provider.value).toBe('default');
    expect(provider.selectedOptions[0]?.textContent).toContain('Default provider');
    expect(screen.getByText('Follows Settings → Providers → Default provider')).toBeTruthy();
    expect(screen.queryByText(/configured for Mock \(demo\).*unavailable/i)).toBeNull();
  });

  it('enables NO BS with the approved cinematic and persists its directive at the prompt end', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);

    const noBs = screen.getByRole('checkbox', { name: /NO BS/i });
    expect(noBs.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(noBs);

    expect(noBs.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'NO BS activation' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'NO BS activation' })).toBeNull();
    expect(document.activeElement).toBe(noBs);
    const prompt = screen.getByLabelText('System prompt') as HTMLTextAreaElement;
    expect(prompt.value).toContain('## NO BS');
    expect(prompt.value.trim().endsWith('<!-- vibespace:no-bs:end -->')).toBe(true);

    fireEvent.change(prompt, { target: { value: `${prompt.value}\nNew base instruction.` } });
    expect(prompt.value).toContain('New base instruction.');
    expect(prompt.value.trim().endsWith('<!-- vibespace:no-bs:end -->')).toBe(true);
    expect(prompt.value.indexOf('New base instruction.')).toBeLessThan(
      prompt.value.indexOf('## NO BS'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(agentRepo.update).mock.calls[0]?.[1];
    expect(patch?.system_prompt).toBe(prompt.value);
  });

  it('blocks save on concurrent conflict until the latest agent is reloaded', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local edit' } });
    expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('unsaved');

    act(() => {
      useAgentStore.getState().registerAgent({
        ...baseAgent,
        name: 'Remote edit',
        updated_at: 99,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('conflict'),
    );
    expect(screen.getByRole('button', { name: 'Retry save' })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-editor-status')).toBe('idle'),
    );
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Remote edit');
    expect(agentRepo.update).not.toHaveBeenCalled();
  });

  it('tracks skills, tools, capabilities, model settings, toggles, and advanced fields', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Skills'), { target: { value: 'build, analyze' } });
    fireEvent.change(screen.getByLabelText('Allowed tools'), {
      target: { value: 'files.read, files.write' },
    });
    fireEvent.change(screen.getByLabelText('Capabilities'), {
      target: { value: 'writing, planning' },
    });
    fireEvent.change(screen.getByLabelText('Memory scope'), { target: { value: 'workspace' } });
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'friday' } });
    fireEvent.change(screen.getByLabelText('Max output tokens'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('Custom max output tokens'), {
      target: { value: '4096' },
    });
    fireEvent.change(screen.getByLabelText('Appearance hue'), { target: { value: '210' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(agentRepo.update).toHaveBeenCalledWith(
      baseAgent.id,
      expect.objectContaining({
        skills: ['analyze', 'build'],
        tools_allowed: ['files.read', 'files.write'],
        capabilities: ['planning', 'writing'],
        memory_scope: 'workspace',
        effort: 'high',
        persona: 'friday',
        max_output_tokens: 4096,
        color_hue: 210,
      }),
    );
  });

  it('persists a selected VibeSpace emoji through the agent repository', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);

    const quickChoices = screen.getByLabelText('Agent emoji quick choices');
    const choices = within(quickChoices).getAllByRole('button', { name: /^Choose /u });
    fireEvent.click(choices[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(agentRepo.update).toHaveBeenCalledWith(
      baseAgent.id,
      expect.objectContaining({ emoji: 'vibe:aurora-builder' }),
    );
  });

  it('prevents duplicate saves while persistence is in flight', async () => {
    const agentRepo = await repoMocks();
    let resolveUpdate!: (agent: Agent) => void;
    vi.mocked(agentRepo.update).mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(<AgentManager />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'One Save' } });
    const save = screen.getByRole('button', { name: 'Save agent' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save agent' }).textContent).toContain('Saving...');

    resolveUpdate({ ...baseAgent, name: 'One Save', updated_at: 4 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save agent' }).textContent).toContain('Saved'),
    );
  });

  it('preserves newer edits made while an agent save is in flight', async () => {
    const agentRepo = await repoMocks();
    const pendingUpdate = deferred<Agent>();
    vi.mocked(agentRepo.update).mockReturnValue(pendingUpdate.promise);
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Submitted name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Newer unsaved name' } });

    pendingUpdate.resolve({ ...baseAgent, name: 'Submitted name', updated_at: 4 });
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Newer unsaved name'),
    );
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', false);
  });

  it('does not let a stale save completion overwrite a newly selected editor', async () => {
    const agentRepo = await repoMocks();
    const pendingUpdate = deferred<Agent>();
    vi.mocked(agentRepo.update).mockReturnValue(pendingUpdate.promise);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Saved Later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Beta Agent/i }));
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Beta Agent'),
    );

    act(() => pendingUpdate.resolve({ ...baseAgent, name: 'Alpha Saved Later', updated_at: 4 }));
    await waitFor(() =>
      expect(useAgentStore.getState().agents[baseAgent.id]?.name).toBe('Alpha Saved Later'),
    );
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Beta Agent');
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', true);
  });

  it('preserves edits after failure and retries through the same Save action', async () => {
    const agentRepo = await repoMocks();
    vi.mocked(agentRepo.update)
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValueOnce({ ...baseAgent, name: 'Retry Me', updated_at: 5 });
    render(<AgentManager />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retry Me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Your edits are still here');
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Retry Me');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(2));
  });

  it('saves a dirty Agent with Ctrl+S', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Keyboard save' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
  });

  it('warns before switching and supports explicit revert', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AgentManager />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: /Beta Agent/i }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Unsaved name');

    fireEvent.click(screen.getByRole('button', { name: /Reset/i }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Alpha Agent');
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', true);
  });

  it('preserves ordinary Agent clone behavior and confirms recycle deletion', async () => {
    const agentRepo = await repoMocks();
    render(<AgentManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(agentRepo.create).toHaveBeenCalledTimes(1));
    expect(agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Alpha Agent (copy)',
        system_prompt: baseAgent.system_prompt,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const clonedAgent = vi.mocked(agentRepo.create).mock.calls[0]?.[0];
    expect(recycleBinMocks.moveAgentToRecycleBin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Recycle Bin' }));
    await waitFor(() =>
      expect(recycleBinMocks.moveAgentToRecycleBin).toHaveBeenCalledWith(
        expect.objectContaining({ id: clonedAgent?.id }),
      ),
    );
    expect(agentRepo.delete).not.toHaveBeenCalled();
  });
});

describe('AgentManager protected JARVIS profile lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: { google: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultProvider: 'google',
      defaultLocalModel: '',
      cloudSession: null,
      localUserId: 'local-user-a',
    });
    registerOnly(protectedJarvis);
    await repoMocks(protectedJarvis);
    await profileRepoMocks();
  });

  it('loads active-profile Custom instructions instead of Agent.system_prompt', async () => {
    const jarvisProfileRepo = await profileRepoMocks(
      profileFixture({ customInstructions: 'Use my profile.' }),
    );
    render(<AgentManager />);

    expect(await screen.findByLabelText('Custom instructions')).toHaveProperty(
      'value',
      'Use my profile.',
    );
    expect(screen.queryByLabelText('System prompt')).toBeNull();
    expect(jarvisProfileRepo.getActive).toHaveBeenCalledWith('local-user-a');
  });

  it('saves an empty profile-only edit without persisting Agent.system_prompt', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks(
      profileFixture({ customInstructions: 'Remove me.' }),
    );
    render(<AgentManager />);

    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() =>
      expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledWith(
        'local-user-a',
        'profile_local-user-a',
        '',
      ),
    );
    expect(agentRepo.getById).toHaveBeenCalledWith(protectedJarvis.id);
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(agentRepo.create).not.toHaveBeenCalled();
  });

  it('treats line-ending-only profile edits as normalized no-ops', async () => {
    const jarvisProfileRepo = await profileRepoMocks(
      profileFixture({ customInstructions: 'First\r\nSecond' }),
    );
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    fireEvent.change(instructions, { target: { value: 'First\nSecond' } });

    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', true);
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();
  });

  it('saves non-prompt Agent fields and profile instructions together without owning system_prompt', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JARVIS Renamed' } });
    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: 'Use tools carefully.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(agentRepo.update).mock.calls[0]?.[1];
    expect(patch).toEqual(expect.objectContaining({ name: 'JARVIS Renamed' }));
    expect(patch).not.toHaveProperty('system_prompt');
    expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledWith(
      'local-user-a',
      'profile_local-user-a',
      'Use tools carefully.',
    );
  });

  it('fails closed instead of recreating a missing protected row with its legacy prompt', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(agentRepo.getById).mockResolvedValue(undefined);
    render(<AgentManager />);

    await screen.findByLabelText('Custom instructions');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Missing protected row' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Protected JARVIS agent row is unavailable.',
    );
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(agentRepo.create).not.toHaveBeenCalled();
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();
  });

  it('fails closed before a profile-only write when the protected row is missing', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(agentRepo.getById).mockResolvedValue(undefined);
    render(<AgentManager />);

    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: 'Must not persist.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Protected JARVIS agent row is unavailable.',
    );
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(agentRepo.create).not.toHaveBeenCalled();
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();
  });

  it('fails closed before either write when the persisted row is no longer protected', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(agentRepo.getById).mockResolvedValue({
      ...baseAgent,
      id: protectedJarvis.id,
      slug: 'reused-id',
      builtin: false,
    });
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Must not persist' } });
    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: 'Must not persist either.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Protected JARVIS agent row is unavailable.',
    );
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(agentRepo.create).not.toHaveBeenCalled();
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();
  });

  it('clones protected JARVIS from visible profile instructions, never its hidden legacy prompt', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    await profileRepoMocks(profileFixture({ customInstructions: 'Visible clone instructions.' }));
    render(<AgentManager />);

    await waitFor(() =>
      expect(screen.getByLabelText('Custom instructions')).toHaveProperty(
        'value',
        'Visible clone instructions.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));

    await waitFor(() => expect(agentRepo.create).toHaveBeenCalledTimes(1));
    const clone = vi.mocked(agentRepo.create).mock.calls[0]?.[0];
    expect(clone).toMatchObject({
      builtin: false,
      system_prompt: 'Visible clone instructions.',
    });
    expect(clone?.system_prompt).not.toBe(protectedJarvis.system_prompt);
  });

  it('reports a partial combined save truthfully and retries only the profile write', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(jarvisProfileRepo.updateCustomInstructions).mockRejectedValueOnce(
      new Error('Profile storage unavailable'),
    );
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JARVIS Persisted' } });
    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: 'Retry profile only.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Agent changes were saved');
    expect(alert.textContent).toContain('custom instructions were not saved');
    expect(agentRepo.update).toHaveBeenCalledTimes(1);
    expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'JARVIS Persisted');

    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() =>
      expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledTimes(2),
    );
    expect(agentRepo.update).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary V2 fields saveable while only Custom instructions are loading', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const pendingProfile = deferred<JarvisProfile | undefined>();
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(jarvisProfileRepo.getActive).mockReturnValue(pendingProfile.promise);
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    expect(instructions).toHaveProperty('disabled', true);
    expect(screen.getByText('Profile is still loading')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JARVIS V2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(vi.mocked(agentRepo.update).mock.calls[0]?.[1]).not.toHaveProperty('system_prompt');
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();

    pendingProfile.resolve(profileFixture());
    await waitFor(() => expect(instructions).toHaveProperty('disabled', false));
  });

  it('clears prior-account profile text immediately when the account changes', async () => {
    const profileB = profileFixture({
      id: 'profile_local-user-b',
      accountId: 'local-user-b',
      customInstructions: 'Account B instructions.',
    });
    const pendingProfileB = deferred<JarvisProfile | undefined>();
    const jarvisProfileRepo = await profileRepoMocks(
      profileFixture({ customInstructions: 'Account A instructions.' }),
    );
    vi.mocked(jarvisProfileRepo.getActive).mockImplementation((accountId) =>
      accountId === 'local-user-b'
        ? pendingProfileB.promise
        : Promise.resolve(profileFixture({ customInstructions: 'Account A instructions.' })),
    );
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    await waitFor(() => expect(instructions).toHaveProperty('value', 'Account A instructions.'));
    act(() => useAuthStore.setState({ localUserId: 'local-user-b' }));

    await waitFor(() => expect(instructions).toHaveProperty('value', ''));
    expect(instructions).toHaveProperty('disabled', true);
    pendingProfileB.resolve(profileB);
    await waitFor(() => expect(instructions).toHaveProperty('value', 'Account B instructions.'));
  });

  it('ignores a stale prior-account load that resolves after the current account', async () => {
    const pendingProfileA = deferred<JarvisProfile | undefined>();
    const profileB = profileFixture({
      id: 'profile_local-user-b',
      accountId: 'local-user-b',
      customInstructions: 'Current account.',
    });
    const jarvisProfileRepo = await profileRepoMocks();
    vi.mocked(jarvisProfileRepo.getActive).mockImplementation((accountId) =>
      accountId === 'local-user-a' ? pendingProfileA.promise : Promise.resolve(profileB),
    );
    render(<AgentManager />);

    await screen.findByLabelText('Custom instructions');
    act(() => useAuthStore.setState({ localUserId: 'local-user-b' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Custom instructions')).toHaveProperty(
        'value',
        'Current account.',
      ),
    );

    pendingProfileA.resolve(profileFixture({ customInstructions: 'Stale account.' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Custom instructions')).toHaveProperty(
        'value',
        'Current account.',
      ),
    );
  });

  it('does not write a captured profile after the account changes during an agent save', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const pendingAgentRead = deferred<Agent | undefined>();
    vi.mocked(agentRepo.getById).mockReturnValue(pendingAgentRead.promise);
    const jarvisProfileRepo = await profileRepoMocks();
    render(<AgentManager />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JARVIS Submitted' } });
    fireEvent.change(await screen.findByLabelText('Custom instructions'), {
      target: { value: 'Submitted profile text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.getById).toHaveBeenCalledTimes(1));

    act(() => useAuthStore.setState({ localUserId: 'local-user-b' }));
    pendingAgentRead.resolve(protectedJarvis);
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(jarvisProfileRepo.updateCustomInstructions).not.toHaveBeenCalled();
  });

  it('clears a local profile when identity source changes with the same account id', async () => {
    const nextProfile = deferred<JarvisProfile | undefined>();
    const jarvisProfileRepo = await profileRepoMocks(
      profileFixture({ customInstructions: 'Local-source instructions.' }),
    );
    vi.mocked(jarvisProfileRepo.getActive)
      .mockResolvedValueOnce(profileFixture({ customInstructions: 'Local-source instructions.' }))
      .mockReturnValueOnce(nextProfile.promise);
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    expect(instructions).toHaveProperty('value', 'Local-source instructions.');
    act(() =>
      useAuthStore.setState({
        cloudSession: {
          user_id: 'local-user-a',
          email: 'cloud@example.com',
          expires_at: Date.now() + 60_000,
        },
      }),
    );

    await waitFor(() => expect(instructions).toHaveProperty('value', ''));
    expect(instructions).toHaveProperty('disabled', true);
  });

  it('preserves newer agent and profile edits made during a combined save', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const pendingUpdate = deferred<Agent>();
    vi.mocked(agentRepo.update).mockReturnValue(pendingUpdate.promise);
    const jarvisProfileRepo = await profileRepoMocks();
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Submitted name' } });
    fireEvent.change(instructions, { target: { value: 'Submitted profile.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Newer name' } });
    fireEvent.change(instructions, { target: { value: 'Newer profile.' } });
    pendingUpdate.resolve({ ...protectedJarvis, name: 'Submitted name', updated_at: 4 });

    await waitFor(() =>
      expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledWith(
        'local-user-a',
        'profile_local-user-a',
        'Submitted profile.',
      ),
    );
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Newer name');
    expect(instructions).toHaveProperty('value', 'Newer profile.');
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', false);
  });

  it('does not report success when an Agent edit arrives during the later profile write', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    const pendingProfileWrite = deferred<JarvisProfile>();
    vi.mocked(jarvisProfileRepo.updateCustomInstructions).mockReturnValue(
      pendingProfileWrite.promise,
    );
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Submitted name' } });
    fireEvent.change(instructions, { target: { value: 'Submitted profile.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(jarvisProfileRepo.updateCustomInstructions).toHaveBeenCalledTimes(1),
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Late Agent edit' } });
    pendingProfileWrite.resolve(
      profileFixture({
        revisionId: 'revision_2',
        customInstructions: 'Submitted profile.',
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save agent' }).textContent?.trim()).toBe('Save'),
    );
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Late Agent edit');
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', false);
  });

  it('does not report an Agent-only save complete when a profile edit arrives in flight', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const pendingAgentUpdate = deferred<Agent>();
    vi.mocked(agentRepo.update).mockReturnValue(pendingAgentUpdate.promise);
    await profileRepoMocks();
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Submitted Agent name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));

    fireEvent.change(instructions, { target: { value: 'Late profile edit.' } });
    pendingAgentUpdate.resolve({
      ...protectedJarvis,
      name: 'Submitted Agent name',
      updated_at: 4,
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save agent' }).textContent?.trim()).toBe('Save'),
    );
    expect(instructions).toHaveProperty('value', 'Late profile edit.');
    expect(screen.getByRole('button', { name: 'Save agent' })).toHaveProperty('disabled', false);
  });

  it('does not fall back to local identity when a malformed cloud identity exists', async () => {
    const agentRepo = await repoMocks(protectedJarvis);
    const jarvisProfileRepo = await profileRepoMocks();
    useAuthStore.setState({
      cloudSession: {
        user_id: '   ',
        email: 'broken@example.com',
        expires_at: Date.now() + 60_000,
      },
      localUserId: 'local-user-a',
    });
    render(<AgentManager />);

    const instructions = await screen.findByLabelText('Custom instructions');
    expect(instructions).toHaveProperty('value', '');
    expect(instructions).toHaveProperty('disabled', true);
    expect(jarvisProfileRepo.getActive).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JARVIS Local Field' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agentRepo.update).toHaveBeenCalledTimes(1));
    expect(vi.mocked(agentRepo.update).mock.calls[0]?.[1]).not.toHaveProperty('system_prompt');
  });

  it('treats a non-builtin jarvis slug collision as an ordinary Agent prompt', async () => {
    const agentRepo = await repoMocks(jarvisSlugCollision);
    const jarvisProfileRepo = await profileRepoMocks();
    registerOnly(jarvisSlugCollision);
    render(<AgentManager />);

    expect(screen.getByLabelText('System prompt')).toHaveProperty('value', baseAgent.system_prompt);
    expect(screen.queryByLabelText('Custom instructions')).toBeNull();
    expect(jarvisProfileRepo.getActive).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('System prompt'), {
      target: { value: 'Ordinary user prompt.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() =>
      expect(agentRepo.update).toHaveBeenCalledWith(
        jarvisSlugCollision.id,
        expect.objectContaining({ system_prompt: 'Ordinary user prompt.' }),
      ),
    );
  });
});
