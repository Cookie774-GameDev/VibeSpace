import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');

describe('Composer Prompt Forge integration', () => {
  it('uses the same typed-or-dictated draft and existing attachment state without auto-sending', () => {
    const hookStart = source.indexOf('const promptForge = usePromptForgeComposer({');
    const hookEnd = source.indexOf('\n  });', hookStart);
    const hookOptions = source.slice(hookStart, hookEnd);
    expect(hookStart).toBeGreaterThan(0);
    expect(hookEnd).toBeGreaterThan(hookStart);
    expect(hookOptions).toContain('draft: text');
    expect(hookOptions).toContain('contextAttachments: attachedContexts');
    expect(hookOptions).toContain('imageAttachments: attachedImages');
    expect(hookOptions).toContain('collectAdditionalSources: collectPromptForgeSources');
    expect(source).toContain('files: attachedFiles');
    expect(source).toContain('terminals: attachedTerminals');
    expect(source).toContain('PromptForgeControl');
    expect(source).toContain('promptForgeAutoUpgradeOnSend');
    expect(source).toContain('upgradeForSend');
    expect(source).toMatch(
      /const upgraded = await promptForgeUpgradeForSendRef\.current\(rawSendText\);[\s\S]*rawSendText = upgraded\.text\.trim\(\);/u,
    );
    expect(source).toMatch(
      /const sendText = \[[\s\S]*markdownInstruction \|\| rawSendText,[\s\S]*\]\s*\.filter\(Boolean\)/u,
    );
    expect(source).toContain('PromptForgeReview');
    expect(source).not.toMatch(/onStart=\{[^}]*handleSend/u);
    expect(source).not.toMatch(/onReplace=\{[^}]*handleSend/u);
  });

  it('places the secondary Forge control between model/mode selection and dictation/Send', () => {
    const mode = source.indexOf('<ModeIndicator');
    const forge = source.indexOf('<PromptForgeControl');
    const dictation = source.indexOf('{composerSttEnabled && (', forge);
    const send = source.indexOf('<Hint label="Send"', forge);
    expect(mode).toBeGreaterThan(0);
    expect(forge).toBeGreaterThan(mode);
    expect(dictation).toBeGreaterThan(forge);
    expect(send).toBeGreaterThan(dictation);
  });

  it('scopes the documented shortcut to the focused Composer textarea', () => {
    expect(source).toContain('document.activeElement !== textareaRef.current');
    expect(source).toContain("matchesHotkey(event, resolveHotkey('PROMPT_FORGE'))");
    expect(source).toContain('event.preventDefault()');
  });

  it('wires recovered-job model and changed-context gates into the recovery surface', () => {
    expect(source).toContain('resumeDisabledReason={promptForge.recoveryDisabledReason}');
    expect(source).toContain(
      'needsContextConfirmation={promptForge.recoveryNeedsContextConfirmation}',
    );
    expect(source).toContain('onConfirmContextChange={promptForge.confirmRecoveryContextChange}');
  });

  it('collects live account-scoped chat, project, profile, and recent activity context', () => {
    expect(source).toContain('chatRepo.getById(chatId as ChatId)');
    expect(source).toContain('projectRepo.getById(projectId');
    expect(source).toContain('getChatActivityEvents(chatId)');
    expect(source).toContain('useAllAboutMeStore.getState()');
    expect(source).toContain('accountId: pluginAccountId');
    expect(source).toContain('draft: job.originalDraft');
    expect(source).toContain('chat: persistedChat');
    expect(source).toContain('persistedProject && String(persistedProject.id) === projectId');
    expect(source).toContain('profile: allAboutMe');
    expect(source).toContain('activity: getChatActivityEvents(chatId)');
    expect(source).toContain('terminalSessionRepo');
    expect(source).toContain('.getById(ref.sessionId as TerminalSessionId)');
    expect(source).toContain('terminalStates,');
  });

  it('projects only observed active agents and account/project-scoped capability catalogs', () => {
    expect(source).toMatch(
      /useJarvisInteractionStore\s*\.getState\(\)\s*\.agentsForChat\(chatId\)/u,
    );
    expect(source).toContain('activeAgents:');
    expect(source).toContain('selectPluginConnectionsForAccount(');
    expect(source).toContain('isPromptForgePluginConnected(');
    expect(source).toContain('connectedPlugins:');
    expect(source).toMatch(/jarvisMcpServerManager\s*\.discover\(\)/u);
    expect(source).toContain("status.kind === 'external_mcp'");
    expect(source).toContain('DEFAULT_JARVIS_ACTION_REGISTRATIONS');
    expect(source).toContain("registration.executor.kind === 'builtin'");
    expect(source).toMatch(/useToolStore\s*\.getState\(\)\s*\.list\(\)/u);
    expect(source).toMatch(/taskRepo\s*\.list\(/u);
    expect(source).toContain('workspace_id: workspaceId');
    expect(source).toContain('mcpTools:');
    expect(source).toContain('appActions:');
    expect(source).toContain('customTools:');
    expect(source).toContain('tasks,');
  });
});
