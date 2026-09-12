import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentId } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { syncDiscoveredOllamaModels } from '@/lib/ai/models';
import { resetProviderModelCache } from '@/lib/ai/providerModelCatalog';
import {
  JARVIS_CREATOR_APPLY_AGENT_EVENT,
  type JarvisCreatorAgentDraft,
} from '@/features/jarvis-creator/contracts';
import { consumePendingJarvisCreatorStart } from '@/features/jarvis-creator/launcher';
import { AgentManager } from './AgentManager';

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

vi.mock('@/lib/ai/providers/ollama', () => ({
  isOllamaReachable: vi.fn(async () => false),
  listOllamaModels: vi.fn(async () => []),
}));

const baseAgent: Agent = {
  id: 'agent_existing' as AgentId,
  slug: 'existing-agent',
  name: 'Existing Agent',
  description: 'Existing description',
  system_prompt: 'Existing prompt',
  model: { provider: 'google', model: 'gemini-2.5-flash' },
  tools_allowed: [],
  memory_scope: 'project',
  capabilities: ['writing'],
  temperature: 0.7,
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

describe('AgentManager Jarvis creator integration', () => {
  beforeEach(() => {
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: { google: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultProvider: 'google',
      defaultLocalModel: '',
    });
    useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
    useAgentStore.getState().registerAgent(baseAgent);
    useUIStore.setState({ inspectorOpen: false });
    consumePendingJarvisCreatorStart();
  });

  it('creates a blank agent from the list plus button', async () => {
    const { agentRepo } = await import('@/lib/db');
    vi.mocked(agentRepo.create).mockImplementation(async (agent) => ({
      ...baseAgent,
      ...agent,
      id: (agent.id ?? 'agent_created') as AgentId,
      created_at: 2,
      updated_at: 2,
    }));

    render(<AgentManager />);
    fireEvent.click(screen.getByRole('button', { name: /New agent/i }));

    await waitFor(() => {
      expect(Object.values(useAgentStore.getState().agents)).toHaveLength(2);
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'New Agent');
    });
    const created = Object.values(useAgentStore.getState().agents).find(
      (agent) => agent.id !== baseAgent.id,
    );
    expect(created?.name).toBe('New Agent');
  });

  it('opens the Inspector Jarvis creator from the agent editor', () => {
    render(<AgentManager />);

    fireEvent.click(screen.getByRole('button', { name: /Create with Jarvis/i }));

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(consumePendingJarvisCreatorStart()).toMatchObject({
      kind: 'agent',
      currentName: 'Existing Agent',
      currentDescription: 'Existing description',
    });
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Existing Agent');
    expect(Object.values(useAgentStore.getState().agents)).toHaveLength(1);
  });

  it('applies a Jarvis-generated agent draft into the editor without saving', async () => {
    render(<AgentManager />);
    const draft: JarvisCreatorAgentDraft = {
      name: 'Launch Planner',
      description: 'Plans launches in tight phases.',
      system_prompt: 'You are a sharp launch planning specialist.',
      capabilities: ['planning', 'writing'],
      tools_allowed: ['files'],
      temperature: 1.15,
    };

    act(() => {
      window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_AGENT_EVENT, { detail: draft }));
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Launch Planner'),
    );
    expect(screen.getByLabelText('Description')).toHaveProperty(
      'value',
      'Plans launches in tight phases.',
    );
    expect(screen.getByLabelText('System prompt')).toHaveProperty(
      'value',
      'You are a sharp launch planning specialist.',
    );
    expect(screen.getByLabelText(/Temperature/i)).toHaveProperty('value', '1.15');
    expect(screen.getByRole('button', { name: /Save/i })).toHaveProperty('disabled', false);
  });

  it('keeps agent model selection as a connected dropdown without custom id entry', () => {
    useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
    useAgentStore.getState().registerAgent({
      ...baseAgent,
      model: { provider: 'google', model: 'legacy-manual-model' },
    });

    render(<AgentManager />);

    const modelField = screen.getByLabelText('Model');
    expect(modelField.tagName).toBe('SELECT');
    expect(
      screen.getByRole('option', { name: 'Gemini 2.5 Flash (gemini-2.5-flash)' }),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Advanced: custom model ID/i })).toBeNull();
    expect(screen.queryByDisplayValue('legacy-manual-model')).toBeNull();
  });
});
