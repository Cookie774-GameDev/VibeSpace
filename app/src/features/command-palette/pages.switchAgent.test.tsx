import * as React from 'react';
import { Command } from 'cmdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRepo } from '@/lib/db';
import { toast } from '@/components/ui/toast';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Agent, AgentId, Chat } from '@/types';
import { PageContent } from './pages';

function coderFixture(): Agent {
  return {
    id: 'agt_coder' as AgentId,
    slug: 'coder',
    name: 'Coder',
    description: 'Coding agent',
    system_prompt: 'Help with coding.',
    model: { provider: 'openai', model: 'gpt-6-luna' },
    tools_allowed: [],
    memory_scope: 'project',
    capabilities: ['code'],
    created_at: 1,
    updated_at: 1,
  };
}

describe('command palette agent switcher', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the empty roster without a subscription update loop', () => {
    useAgentStore.setState({ agents: {} });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <Command shouldFilter={false}>
            <Command.List>
              <PageContent page="switch-agent" ctx={{ closePalette: vi.fn(), pushPage: vi.fn() }} />
            </Command.List>
          </Command>,
        ),
      ).not.toThrow();
      expect(screen.getByText('No agents registered.')).toBeTruthy();
    } finally {
      error.mockRestore();
    }
  });

  it('persists the selected agent to the current chat before closing', async () => {
    const coder = coderFixture();
    useAgentStore.setState({ agents: { [coder.id]: coder } });
    useUIStore.setState({ route: 'chat', activeChatId: 'chat-a' });
    useAuthStore.setState({ workspaceId: 'workspace-a' as never, projectId: 'project-a' as never });
    vi.spyOn(chatRepo, 'getById').mockResolvedValue({
      id: 'chat-a',
      workspace_id: 'workspace-a',
      project_id: 'project-a',
      active_agent_ids: ['agt_custom'],
      mode: 'chat',
    } as Chat);
    const update = vi.spyOn(chatRepo, 'update').mockResolvedValue({} as Chat);
    const closePalette = vi.fn();

    render(
      <Command shouldFilter={false}>
        <Command.List>
          <PageContent page="switch-agent" ctx={{ closePalette, pushPage: vi.fn() }} />
        </Command.List>
      </Command>,
    );
    fireEvent.click(screen.getByText('Coder'));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('chat-a', { active_agent_ids: ['agt_coder'] }),
    );
    expect(closePalette).toHaveBeenCalledOnce();
  });

  it('does not change the old chat if selection changes while it loads', async () => {
    const coder = coderFixture();
    useAgentStore.setState({ agents: { [coder.id]: coder } });
    useUIStore.setState({ route: 'chat', activeChatId: 'chat-a' });
    useAuthStore.setState({ workspaceId: 'workspace-a' as never, projectId: 'project-a' as never });
    let resolveChat!: (chat: Chat) => void;
    vi.spyOn(chatRepo, 'getById').mockReturnValue(
      new Promise<Chat>((resolve) => {
        resolveChat = resolve;
      }),
    );
    const update = vi.spyOn(chatRepo, 'update').mockResolvedValue({} as Chat);
    const showError = vi.spyOn(toast, 'error').mockReturnValue('toast-error');
    const closePalette = vi.fn();

    render(
      <Command shouldFilter={false}>
        <Command.List>
          <PageContent page="switch-agent" ctx={{ closePalette, pushPage: vi.fn() }} />
        </Command.List>
      </Command>,
    );
    fireEvent.click(screen.getByText('Coder'));
    useUIStore.setState({ activeChatId: 'chat-b' });
    resolveChat({
      id: 'chat-a',
      workspace_id: 'workspace-a',
      project_id: 'project-a',
      active_agent_ids: ['agt_custom'],
      mode: 'chat',
    } as Chat);

    await waitFor(() => expect(showError).toHaveBeenCalledOnce());
    expect(update).not.toHaveBeenCalled();
    expect(closePalette).not.toHaveBeenCalled();
  });
});
