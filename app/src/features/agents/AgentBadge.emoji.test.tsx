import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentId } from '@/types';
import { AgentBadge } from './AgentBadge';

const agent: Agent = {
  id: 'agent_emoji' as AgentId,
  slug: 'emoji-agent',
  name: 'Emoji Agent',
  description: 'Uses a stable VibeSpace icon.',
  system_prompt: 'Help.',
  model: { provider: 'mock', model: 'mock' },
  tools_allowed: [],
  memory_scope: 'project',
  capabilities: ['writing'],
  emoji: 'vibe:ocean-builder',
  created_at: 1,
  updated_at: 1,
};

afterEach(cleanup);

describe('AgentBadge emoji', () => {
  it('renders a persisted VibeSpace emoji token as the agent identity', () => {
    render(<AgentBadge agent={agent} />);

    expect(screen.getByText('Emoji Agent')).toBeTruthy();
    expect(document.querySelector('[data-emoji-id="vibe:ocean-builder"]')).toBeTruthy();
  });
});
