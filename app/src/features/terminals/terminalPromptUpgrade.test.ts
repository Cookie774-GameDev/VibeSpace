import { describe, expect, it } from 'vitest';
import {
  buildTerminalRelatedSources,
  buildTerminalPromptUpgradeSources,
  canInsertUpgradedPromptIntoTerminal,
  clipForUpgradeSource,
  prepareUpgradedPromptInsert,
  terminalDraftFromSession,
  terminalPromptUpgradeChatId,
} from './terminalPromptUpgrade';
import { useTerminalTranscriptStore } from './transcriptStore';
import type { TerminalPromptEvidence } from './terminalCommandFoundation';

const baseEvidence = (overrides: Partial<TerminalPromptEvidence> = {}): TerminalPromptEvidence =>
  Object.freeze({
    promptProtocol: 'osc133',
    atPrompt: true,
    alternateScreen: false,
    interactiveProgram: false,
    localShell: true,
    passwordPrompt: false,
    sshSession: false,
    ...overrides,
  });

describe('terminalPromptUpgrade', () => {
  it('scopes chat ids by project and session so projects cannot leak', () => {
    const a = terminalPromptUpgradeChatId({
      accountId: 'acc',
      projectId: 'proj-a',
      sessionId: 'pty-1',
      paneId: 'pane-1',
    });
    const b = terminalPromptUpgradeChatId({
      accountId: 'acc',
      projectId: 'proj-b',
      sessionId: 'pty-1',
      paneId: 'pane-1',
    });
    const c = terminalPromptUpgradeChatId({
      accountId: 'acc',
      projectId: 'proj-a',
      sessionId: 'pty-2',
      paneId: 'pane-2',
    });
    expect(a).toContain('proj-a');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('terminal:')).toBe(true);
  });

  it('reads the live terminal draft and includes it as a source', () => {
    useTerminalTranscriptStore.setState({
      sessions: {
        'pty-1': {
          sessionId: 'pty-1',
          agentSlug: null,
          command: null,
          text: 'PS C:\\demo>',
          lastWriteAt: 1,
          bytesSeen: 12,
          currentInput: 'make an html game',
        },
      },
    });
    expect(terminalDraftFromSession('pty-1')).toBe('make an html game');
    const sources = buildTerminalPromptUpgradeSources({
      scope: {
        accountId: 'acc',
        projectId: 'proj-1',
        sessionId: 'pty-1',
        paneId: 'pane-1',
      },
      now: 1_000,
    });
    expect(sources.some((source) => source.id === 'terminal-draft:pty-1')).toBe(true);
    expect(sources.some((source) => source.content.includes('make an html game'))).toBe(true);
  });

  it('builds session + project sources without dumping unbounded history', () => {
    const sources = buildTerminalPromptUpgradeSources({
      scope: {
        accountId: 'acc',
        projectId: 'proj-1',
        sessionId: 'pty-1',
        paneId: 'pane-1',
      },
      projectName: 'Demo',
      projectRoot: 'C:\\demo',
      agentSlug: 'builder',
      agentName: 'Builder',
      cwd: 'C:\\demo',
      now: 1_000,
    });
    expect(sources.some((s) => s.kind === 'terminal')).toBe(true);
    expect(sources.some((s) => s.kind === 'project')).toBe(true);
    expect(sources.every((s) => s.projectScoped || s.id.includes('terminal'))).toBe(true);
  });

  it('clips long source text', () => {
    const long = 'x'.repeat(10_000);
    const clipped = clipForUpgradeSource(long, 100);
    expect(clipped.length).toBeLessThan(200);
    expect(clipped).toContain('truncated');
  });

  it('blocks insert when the shell is busy or interactive', () => {
    expect(canInsertUpgradedPromptIntoTerminal(baseEvidence()).ok).toBe(true);
    expect(canInsertUpgradedPromptIntoTerminal(baseEvidence({ atPrompt: false })).ok).toBe(false);
    expect(
      canInsertUpgradedPromptIntoTerminal(baseEvidence({ interactiveProgram: true })).ok,
    ).toBe(false);
    expect(canInsertUpgradedPromptIntoTerminal(baseEvidence({ passwordPrompt: true })).ok).toBe(
      false,
    );
    expect(canInsertUpgradedPromptIntoTerminal(baseEvidence({ sshSession: true })).ok).toBe(false);
    expect(canInsertUpgradedPromptIntoTerminal(baseEvidence({ localShell: false })).ok).toBe(
      false,
    );
  });

  it('keeps related chat, context, repository, and links inside the same account and project', () => {
    const sources = buildTerminalRelatedSources({
      scope: {
        accountId: 'account-a',
        projectId: 'project-a',
        sessionId: 'pty-1',
      },
      now: 2_000,
      chats: [
        {
          id: 'chat-a',
          projectId: 'project-a',
          title: 'Release fixes',
          excerpt: 'Fix the release verifier.',
          updatedAt: 1_900,
        },
        {
          id: 'chat-b',
          projectId: 'project-b',
          title: 'Foreign project',
          excerpt: 'must not leak',
          updatedAt: 1_950,
        },
      ],
      contextMaps: [
        {
          id: 'map-a',
          accountId: 'account-a',
          projectId: 'project-a',
          name: 'Project map',
          summary: 'Release paths and ownership.',
          entryPoints: ['app/src/release.ts'],
          updatedAt: 1_800,
        },
        {
          id: 'map-foreign',
          accountId: 'account-b',
          projectId: 'project-a',
          name: 'Foreign account',
          summary: 'must not leak',
          entryPoints: [],
          updatedAt: 1_850,
        },
      ],
      repositories: [
        {
          id: 'repo-a',
          accountId: 'account-a',
          mapId: 'map-a',
          label: 'octo/project',
          reference: 'https://github.com/octo/project/tree/abc',
          detail: 'Pinned commit abc',
          updatedAt: 1_700,
        },
      ],
      links: [
        {
          id: 'link-a',
          projectId: 'project-a',
          label: 'Release runbook',
          url: 'https://example.com/runbook',
          updatedAt: 1_600,
        },
        {
          id: 'link-b',
          projectId: 'project-b',
          label: 'Foreign link',
          url: 'https://example.com/foreign',
          updatedAt: 1_650,
        },
      ],
    });

    expect(sources.map((source) => source.label)).toEqual([
      'Release fixes',
      'Project map',
      'octo/project',
      'Release runbook',
    ]);
    expect(sources.every((source) => source.projectScoped)).toBe(true);
    expect(sources.map((source) => source.content).join('\n')).not.toContain('must not leak');
  });

  it('inserts preview text without an Enter or carriage return', () => {
    expect(prepareUpgradedPromptInsert('ship this fix')).toBe('ship this fix');
    expect(prepareUpgradedPromptInsert('line one\r\nline two')).toBe('line one\nline two');
  });
});
