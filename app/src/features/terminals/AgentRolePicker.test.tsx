import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRolePicker } from './AgentRolePicker';
import { useAgentStore } from '@/stores/agents';
import type { Agent } from '@/types';

function makeAgent(slug: string, name: string): Agent {
  return {
    id: `agent_${slug}`,
    slug,
    name,
    description: `${name} agent`,
    system_prompt: '',
    model: { provider: 'mock', model: 'mock' },
    tools_allowed: ['*'],
    memory_scope: 'project',
    temperature: 0.7,
    max_output_tokens: 4096,
    color_hue: 200,
    capabilities: [],
    builtin: true,
    created_at: 1,
    updated_at: 1,
  } as unknown as Agent;
}

describe('AgentRolePicker modes', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder'));
  });

  it('shows the selected mode in the trigger label', () => {
    render(
      <AgentRolePicker
        agentSlug="coder"
        agentMode="coordinated"
        onChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /coder.*coordinated/i })).toBeTruthy();
  });

  it('lets users select no-context mode from the popover', () => {
    const onModeChange = vi.fn();
    render(
      <AgentRolePicker
        agentSlug="coder"
        agentMode="default"
        onChange={vi.fn()}
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /coder.*default/i }));
    fireEvent.click(screen.getByRole('button', { name: /plain isolated agent/i }));

    expect(onModeChange).toHaveBeenCalledWith('no-context');
    expect(screen.getByText('NO CONTEXT')).toBeTruthy();
  });
});
