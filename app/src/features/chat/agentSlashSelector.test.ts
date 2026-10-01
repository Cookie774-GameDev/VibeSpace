import { describe, expect, it, vi } from 'vitest';
import { normalizeSlashCmd, SLASH_CMD_ALIASES, SLASH_COMMANDS } from './SlashCommandTypeahead';
import { agentSelectorOptions } from './listLiveChatAgents';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import { OPEN_CHILD_CHAT_PANEL_EVENT, openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { useUIStore } from '@/stores/ui';

describe('/agent slash selector contract', () => {
  it('does not alias /agent to multitask and registers a selector command', () => {
    expect(SLASH_CMD_ALIASES.agent).toBeUndefined();
    expect(normalizeSlashCmd('agent')).toBe('agent');
    expect(normalizeSlashCmd('multitask')).toBe('multitask');
    const agentCmd = SLASH_COMMANDS.find((c) => c.cmd === 'agent');
    const multitaskCmd = SLASH_COMMANDS.find((c) => c.cmd === 'multitask');
    expect(agentCmd?.hasOptions).toBe(true);
    expect(multitaskCmd?.aliases ?? []).not.toContain('agent');
  });

  it('builds selector options and opens the exact native child panel while retaining the parent route', () => {
    const agents: JarvisChatAgent[] = [
      {
        agentId: 'ja_1',
        name: 'Subagent 1',
        parentChatId: 'parent',
        childChatId: 'child_1',
        task: 'Review UI',
        modelLabel: 'llama',
        status: 'editing',
        filesTouched: [],
        lockedFiles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const options = agentSelectorOptions(agents);
    expect(options[0]?.childChatId).toBe('child_1');

    const originalBrowser = browserChatStore.getState();
    const originalUI = useUIStore.getState();
    const opened = vi.fn();
    window.addEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, opened);
    try {
      browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
      useUIStore.setState({ activeChatId: 'parent', route: 'chat' });
      openNativeChildChat(options[0]!.childChatId, agents[0]!.parentChatId);
      expect(opened).toHaveBeenCalledOnce();
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ childChatId: 'child_1', parentChatId: 'parent' });
      expect(browserChatStore.getState().chatPreferences).toEqual({});
      expect(browserChatStore.getState().engine).toBe('browser');
      expect(useUIStore.getState().activeChatId).toBe('parent');
      expect(useUIStore.getState().route).toBe('chat');
    } finally {
      window.removeEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, opened);
      browserChatStore.setState(originalBrowser);
      useUIStore.setState(originalUI);
    }
  });
});
