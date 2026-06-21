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

describe('AgentRolePicker', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder'));
  });

  it('shows coordinated swarm label on the trigger when persisted', () => {
    render(
      <AgentRolePicker
        agentSlug="coder"
        agentMode="coordinated"
        onChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /coder.*swarm/i })).toBeTruthy();
  });

  it('selects no-context as a single option from the list', () => {
    const onSelectionChange = vi.fn();
    render(
      <AgentRolePicker
        agentSlug="coder"
        agentMode="default"
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /assign agent/i }));
    fireEvent.click(screen.getByRole('button', { name: /^no context$/i }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      agentSlug: null,
      agentMode: 'no-context',
    });
  });

  it('selects an agent with default context in one click', () => {
    const onSelectionChange = vi.fn();
    render(<AgentRolePicker onSelectionChange={onSelectionChange} />);

    fireEvent.click(screen.getByRole('button', { name: /assign agent/i }));
    fireEvent.click(screen.getByRole('button', { name: /^coder$/i }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      agentSlug: 'coder',
      agentMode: 'default',
    });
  });

  it('selects shell as a single option with cleared mode', () => {
    const onSelectionChange = vi.fn();
    render(
      <AgentRolePicker
        agentSlug="coder"
        agentMode="default"
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /assign agent/i }));
    fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      agentSlug: null,
      agentMode: undefined,
    });
  });
});
