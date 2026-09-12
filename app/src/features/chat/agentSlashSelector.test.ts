import { describe, expect, it } from 'vitest';
import { normalizeSlashCmd, SLASH_CMD_ALIASES, SLASH_COMMANDS } from './SlashCommandTypeahead';
import { agentSelectorOptions } from './listLiveChatAgents';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import { openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';
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

  it('builds selector options and openNativeChildChat pins native without dropping route chat', () => {
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

    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
    useUIStore.setState({ activeChatId: 'parent', route: 'chat' });
    openNativeChildChat(options[0]!.childChatId);
    expect(browserChatStore.getState().chatPreferences.child_1?.engine).toBe('native');
    expect(useUIStore.getState().activeChatId).toBe('child_1');
    expect(useUIStore.getState().route).toBe('chat');
  });
});
