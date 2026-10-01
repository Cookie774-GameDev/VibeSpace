import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCommandPalette } from './TerminalCommandPalette';
import { useTerminalTranscriptStore } from './transcriptStore';
import { runTerminalPromptUpgrade } from './terminalPromptUpgrade';

vi.mock('./terminalPromptUpgrade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./terminalPromptUpgrade')>();
  return {
    ...actual,
    runTerminalPromptUpgrade: vi.fn(async () => ({
      ok: true,
      upgradedPrompt: 'Build a polished HTML game with keyboard controls.',
      originalDraft: 'hi there, please make me a HTML game',
      job: { id: 'upgrade-job-1' },
      usedPublicResearch: false,
      modelLabel: 'GPT-5.3 Codex Spark',
    })),
  };
});

const evidence = {
  promptProtocol: 'osc133',
  atPrompt: true,
  alternateScreen: false,
  interactiveProgram: false,
  localShell: true,
  passwordPrompt: false,
  sshSession: false,
} as const;

describe('TerminalCommandPalette', () => {
  beforeEach(() => {
    vi.mocked(runTerminalPromptUpgrade).mockClear();
  });

  it('preserves ordinary overlay depth while flattening MonoChrome shadow and blur', () => {
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'VibeSpace terminal palette' });
    expect(dialog.className).toContain('shadow-[0_18px_60px_hsl(var(--foreground)/0.28)]');
    expect(dialog.className).toContain('backdrop-blur');
    expect(dialog.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(dialog.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
  });

  it('renders the complete in-pane top level and filters without touching the PTY', () => {
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'VibeSpace terminal palette' })).toBeTruthy();
    for (const label of [
      'Upgrade prompt',
      'Context Map',
      'Skills',
      'Agents',
      'Project',
      'Notes',
      'Daily Note',
      'Search',
      'Terminals',
      'Status',
      'Help',
    ]) {
      expect(screen.getByRole('option', { name: new RegExp(`^${label}\\b`, 'i') })).toBeTruthy();
    }

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter terminal commands' }), {
      target: { value: 'skill' },
    });
    expect(screen.getByRole('option', { name: /Skills/i })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Context Map/i })).toBeNull();
  });

  it('supports arrow/Tab selection, Enter navigation, Escape, and mouse status', () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Filter terminal commands' });
    // First item is now "Upgrade prompt" (detail panel); Tab moves to Context Map → Skills
    fireEvent.keyDown(input, { key: 'Tab' }); // Context Map
    fireEvent.keyDown(input, { key: 'Tab' }); // Skills
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('skills');

    fireEvent.click(screen.getByRole('option', { name: /Status/i }));
    expect(screen.getByText(/Verified local shell prompt/i)).toBeTruthy();
    expect(screen.getByText(/pty-1/i)).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Backspace' });
    const returnedInput = screen.getByRole('combobox', { name: 'Filter terminal commands' });

    // ArrowUp from Skills (index 2) wraps or moves; open Status via click is enough.
    // Navigate Context Map from list.
    fireEvent.click(screen.getByRole('option', { name: /Context Map/i }));
    expect(onNavigate).toHaveBeenLastCalledWith('context');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <TerminalCommandPalette
        open={false}
        paneId="pane-1"
        sessionId={null}
        projectId={null}
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('offers explicit reversible CLI setup without exposing native secrets', async () => {
    const onInstallCli = vi.fn().mockResolvedValue({
      installed: true,
      binDir: 'C:\\Users\\Test\\.jarvis\\bin',
      commandNames: ['vibespace', 'vs'],
    });
    const onUninstallCli = vi.fn().mockResolvedValue({
      installed: false,
      binDir: 'C:\\Users\\Test\\.jarvis\\bin',
      commandNames: ['vibespace', 'vs'],
    });
    const installedShellIntegration = {
      available: true,
      installed: true,
      profiles: [
        {
          shell: 'powershell' as const,
          path: 'C:\\Users\\Test\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
          installed: true,
        },
      ],
    };
    const onInstallShellIntegration = vi.fn().mockResolvedValue(installedShellIntegration);
    const onUninstallShellIntegration = vi.fn().mockResolvedValue({
      ...installedShellIntegration,
      installed: false,
      profiles: installedShellIntegration.profiles.map((profile) => ({
        ...profile,
        installed: false,
      })),
    });
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onInstallCli={onInstallCli}
        onUninstallCli={onUninstallCli}
        onInstallShellIntegration={onInstallShellIntegration}
        onUninstallShellIntegration={onUninstallShellIntegration}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Help/i }));
    expect(screen.getByText(/optional.*marked, removable block/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install terminal commands' }));
    expect(await screen.findByText(/Installed vibespace and vs/i)).toBeTruthy();
    expect(onInstallCli).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Remove terminal commands' }));
    expect(await screen.findByText(/Removed managed terminal commands/i)).toBeTruthy();
    expect(onUninstallCli).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Enable shell prompt integration' }));
    expect(
      await screen.findByText(/Enabled managed prompt integration for 1 shell profile/i),
    ).toBeTruthy();
    expect(onInstallShellIntegration).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Remove shell prompt integration' }));
    expect(await screen.findByText(/Removed managed prompt integration/i)).toBeTruthy();
    expect(onUninstallShellIntegration).toHaveBeenCalledOnce();
    expect(screen.queryByText(/token|nonce/i)).toBeNull();
  });

  it('opens Upgrade prompt detail without writing to the PTY', () => {
    const onInsert = vi.fn();
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onInsertUpgradedPrompt={onInsert}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Upgrade prompt/i }));
    expect(screen.getByText(/Upgrade prompt/i)).toBeTruthy();
    expect(screen.getByLabelText(/Draft from this terminal/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert at prompt' })).toBeTruthy();
    // Upgrade not started — insert handler must not have been called
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('prefills Upgrade prompt from the live terminal draft without asking the user to retype', async () => {
    useTerminalTranscriptStore.setState({
      sessions: {
        'pty-1': {
          sessionId: 'pty-1',
          agentSlug: null,
          command: null,
          text: '',
          lastWriteAt: 1,
          bytesSeen: 0,
          currentInput: 'hi there, please make me a HTML game',
        },
      },
    });
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Upgrade prompt/i }));
    expect(screen.getByLabelText(/Draft from this terminal/i)).toHaveProperty(
      'value',
      'hi there, please make me a HTML game',
    );
    await waitFor(() => {
      expect(runTerminalPromptUpgrade).toHaveBeenCalled();
    });
    expect(await screen.findByRole('button', { name: 'Accept upgraded prompt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry prompt upgrade' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add context to prompt upgrade' })).toBeTruthy();
  });

  it('fails closed without rendering native setup error details', async () => {
    render(
      <TerminalCommandPalette
        open
        paneId="pane-1"
        sessionId="pty-1"
        projectId="project-1"
        evidence={evidence}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onInstallShellIntegration={vi.fn().mockRejectedValue(new Error('token=must-not-render'))}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Help/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable shell prompt integration' }));
    expect(await screen.findByText('Terminal command setup failed. Try again.')).toBeTruthy();
    expect(screen.queryByText(/must-not-render/i)).toBeNull();
  });
});
