import * as React from 'react';
import {
  Bot,
  CircleHelp,
  FileText,
  FolderKanban,
  ListChecks,
  Map,
  NotebookPen,
  Search,
  Sparkles,
  TerminalSquare,
  Wand2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Route } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { toast } from '@/components/ui/toast';
import type { TerminalPromptEvidence } from './terminalCommandFoundation';
import type {
  TerminalCliInstallStatus,
  TerminalShellIntegrationStatus,
} from './terminalCliInstall';
import {
  canInsertUpgradedPromptIntoTerminal,
  runTerminalPromptUpgrade,
  terminalModelOptionsFromPicker,
} from './terminalPromptUpgrade';

type PaletteItem = Readonly<{
  id: string;
  label: string;
  description: string;
  destination?: Route;
  detail?: 'status' | 'help' | 'upgrade';
  icon: LucideIcon;
}>;

export const TERMINAL_PALETTE_ITEMS: readonly PaletteItem[] = Object.freeze([
  {
    id: 'upgrade-prompt',
    label: 'Upgrade prompt',
    description: 'Upgrade text for this terminal agent with project context',
    detail: 'upgrade',
    icon: Wand2,
  },
  {
    id: 'context',
    label: 'Context Map',
    description: 'Open maps, sources, notes, and retrieval activity',
    destination: 'context',
    icon: Map,
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Browse and manage available skills',
    destination: 'skills',
    icon: Sparkles,
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Open the agent workspace',
    destination: 'agents',
    icon: Bot,
  },
  {
    id: 'project',
    label: 'Project',
    description: 'Open the current project workspace',
    destination: 'project-detail',
    icon: FolderKanban,
  },
  {
    id: 'notes',
    label: 'Notes',
    description: 'Open Context notes',
    destination: 'context',
    icon: FileText,
  },
  {
    id: 'daily',
    label: 'Daily Note',
    description: "Open today's Context note",
    destination: 'context',
    icon: NotebookPen,
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Search the current Context workspace',
    destination: 'context',
    icon: Search,
  },
  {
    id: 'terminals',
    label: 'Terminals',
    description: 'Return to the terminal workspace',
    destination: 'terminal',
    icon: TerminalSquare,
  },
  {
    id: 'status',
    label: 'Status',
    description: 'Show this pane’s verified safety state',
    detail: 'status',
    icon: ListChecks,
  },
  {
    id: 'help',
    label: 'Help',
    description: 'Show terminal palette and CLI help',
    detail: 'help',
    icon: CircleHelp,
  },
]);

export interface TerminalCommandPaletteProps {
  open: boolean;
  paneId?: string;
  sessionId: string | null;
  projectId: string | null;
  evidence: TerminalPromptEvidence;
  /** Working directory of this pane (project isolation). */
  cwd?: string | null;
  agentSlug?: string | null;
  agentName?: string | null;
  projectName?: string | null;
  projectRoot?: string | null;
  onClose: () => void;
  onNavigate: (route: Route) => void;
  /**
   * Insert upgraded text into the PTY only when the host decides it is safe.
   * Must not be called during the upgrade network/model call itself.
   */
  onInsertUpgradedPrompt?: (text: string) => void | Promise<void>;
  onInstallCli?: () => Promise<TerminalCliInstallStatus>;
  onUninstallCli?: () => Promise<TerminalCliInstallStatus>;
  onInstallShellIntegration?: () => Promise<TerminalShellIntegrationStatus>;
  onUninstallShellIntegration?: () => Promise<TerminalShellIntegrationStatus>;
}

export function TerminalCommandPalette({
  open,
  paneId,
  sessionId,
  projectId,
  evidence,
  cwd,
  agentSlug,
  agentName,
  projectName,
  projectRoot,
  onClose,
  onNavigate,
  onInsertUpgradedPrompt,
  onInstallCli,
  onUninstallCli,
  onInstallShellIntegration,
  onUninstallShellIntegration,
}: TerminalCommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [detail, setDetail] = React.useState<'status' | 'help' | 'upgrade' | null>(null);
  const [cliSetupPending, setCliSetupPending] = React.useState(false);
  const [cliSetupMessage, setCliSetupMessage] = React.useState<string | null>(null);
  const [upgradeDraft, setUpgradeDraft] = React.useState('');
  const [upgradedText, setUpgradedText] = React.useState<string | null>(null);
  const [upgradeStatus, setUpgradeStatus] = React.useState<string | null>(null);
  const [upgradeBusy, setUpgradeBusy] = React.useState(false);
  const [upgradeError, setUpgradeError] = React.useState<string | null>(null);
  const upgradeAbortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const upgradeTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const localUserId = useAuthStore((s) => s.localUserId);
  const cloudSession = useAuthStore((s) => s.cloudSession);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const promptForgeModelSelection = useAuthStore((s) => s.promptForgeModelSelection);
  const chatModelSelection = useAuthStore((s) => s.chatModelSelection);
  const accessibleChatModels = useAccessibleChatModels();
  const accountId =
    resolveAccountIdentity({ localUserId, cloudSession })?.accountId ?? localUserId ?? 'local';

  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return TERMINAL_PALETTE_ITEMS;
    return TERMINAL_PALETTE_ITEMS.filter((item) =>
      `${item.label} ${item.description}`.toLowerCase().includes(normalized),
    );
  }, [query]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    setDetail(null);
    setCliSetupPending(false);
    setCliSetupMessage(null);
    setUpgradeDraft('');
    setUpgradedText(null);
    setUpgradeStatus(null);
    setUpgradeError(null);
    setUpgradeBusy(false);
    upgradeAbortRef.current?.abort();
    upgradeAbortRef.current = null;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  React.useEffect(() => {
    if (detail === 'upgrade') {
      requestAnimationFrame(() => upgradeTextareaRef.current?.focus());
    }
  }, [detail]);

  React.useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  if (!open) return null;

  const select = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.detail) {
      setDetail(item.detail);
      return;
    }
    if (item.destination) {
      onNavigate(item.destination);
      onClose();
    }
  };

  const cancelUpgrade = () => {
    upgradeAbortRef.current?.abort();
    upgradeAbortRef.current = null;
    setUpgradeBusy(false);
    setUpgradeStatus(null);
  };

  const runUpgrade = async () => {
    if (upgradeBusy || !upgradeDraft.trim()) return;
    const controller = new AbortController();
    upgradeAbortRef.current = controller;
    setUpgradeBusy(true);
    setUpgradeError(null);
    setUpgradeStatus('Upgrading with terminal + project context…');
    setUpgradedText(null);
    try {
      const modelOptions = terminalModelOptionsFromPicker(accessibleChatModels.flatOptions);
      const result = await runTerminalPromptUpgrade({
        scope: {
          accountId: accountId || 'local',
          projectId,
          sessionId,
          paneId: paneId ?? null,
        },
        originalDraft: upgradeDraft,
        modelSelection: promptForgeModelSelection,
        modelOptions,
        currentChatSelection:
          chatModelSelection.mode === 'single'
            ? {
                mode: 'single',
                providerId: chatModelSelection.providerId,
                modelId: chatModelSelection.modelId,
                ...(chatModelSelection.connectionId
                  ? { connectionId: chatModelSelection.connectionId }
                  : {}),
              }
            : chatModelSelection.mode === 'hive'
              ? { mode: 'hive', hiveId: chatModelSelection.hiveId }
              : { mode: 'none' },
        offlineMode,
        defaultLocalModel,
        // Prefer local when offline; otherwise allow provider if user has cloud models.
        privacyMode: offlineMode ? 'local_only' : 'provider_allowed',
        allowPublicResearch: !offlineMode,
        projectName,
        projectRoot,
        agentSlug,
        agentName,
        cwd,
        workingDirectory: projectRoot ?? cwd ?? undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setUpgradedText(result.upgradedPrompt);
        setUpgradeStatus(`Ready · ${result.modelLabel}`);
      } else {
        setUpgradedText(null);
        setUpgradeError(result.reason);
        setUpgradeStatus(null);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setUpgradeError(
        err instanceof Error ? err.message : 'Prompt upgrade failed. Your draft is unchanged.',
      );
      setUpgradeStatus(null);
    } finally {
      if (upgradeAbortRef.current === controller) upgradeAbortRef.current = null;
      setUpgradeBusy(false);
    }
  };

  const copyUpgraded = async () => {
    const text = upgradedText?.trim() || upgradeDraft.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied', 'Prompt copied. Terminal contents were not changed.');
    } catch {
      toast.error('Copy failed', 'Select the text and copy it manually.');
    }
  };

  const insertUpgraded = async () => {
    const text = (upgradedText ?? upgradeDraft).trim();
    if (!text) return;
    const gate = canInsertUpgradedPromptIntoTerminal(evidence);
    if (!gate.ok) {
      toast.info('Copy instead', gate.reason);
      return;
    }
    if (!onInsertUpgradedPrompt) {
      toast.info('Copy instead', 'Insert is unavailable for this terminal.');
      return;
    }
    try {
      await onInsertUpgradedPrompt(text);
      toast.success('Inserted', 'Upgraded prompt typed at the shell prompt.');
      onClose();
    } catch {
      toast.error('Insert failed', 'Copy the upgraded prompt and paste it yourself.');
    }
  };

  const updateTerminalSetup = async <T,>(
    action: (() => Promise<T>) | undefined,
    successMessage: (status: T) => string,
  ) => {
    if (!action || cliSetupPending) return;
    setCliSetupPending(true);
    setCliSetupMessage(null);
    try {
      setCliSetupMessage(successMessage(await action()));
    } catch {
      setCliSetupMessage('Terminal command setup failed. Try again.');
    } finally {
      setCliSetupPending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (detail === 'upgrade' && upgradeBusy) {
        cancelUpgrade();
        return;
      }
      if (detail) {
        cancelUpgrade();
        setDetail(null);
        return;
      }
      onClose();
      return;
    }
    if (detail === 'upgrade') {
      // Keep typing in the upgrade textarea; don't steal keys for list nav.
      return;
    }
    if (detail) {
      if (event.key === 'Backspace') {
        event.preventDefault();
        setDetail(null);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      setSelectedIndex((index) => (filtered.length ? (index + 1) % filtered.length : 0));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      setSelectedIndex((index) =>
        filtered.length ? (index - 1 + filtered.length) % filtered.length : 0,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      select(filtered[selectedIndex]);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="VibeSpace terminal palette"
      onKeyDown={handleKeyDown}
      className="absolute inset-2 z-40 flex min-h-0 flex-col overflow-hidden rounded-xl border border-accent-copper/50 bg-background/95 shadow-[0_18px_60px_hsl(var(--foreground)/0.28)] backdrop-blur [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none"
    >
      <div className="flex items-center gap-2 border-b border-border bg-paper-soft px-3 py-2">
        <Sparkles className="h-4 w-4 text-accent-copper" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-display text-ui-strong text-foreground">VibeSpace</div>
          <div className="truncate text-metadata text-muted-foreground">
            Pane {paneId ?? 'unbound'} · Ctrl/⌘+Shift+P
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close VibeSpace terminal palette"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {detail === 'upgrade' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-secondary text-foreground">
          <h3 className="font-display text-ui-strong">Upgrade prompt</h3>
          <p className="mt-1 text-metadata text-muted-foreground">
            Uses this terminal’s session, project, transcript, and shared Prompt Upgrade engine.
            Running work is never interrupted while upgrading.
          </p>
          <p className="mt-1 font-mono text-metadata text-muted-foreground">
            Scope · project {projectId ?? 'none'} · session {sessionId ?? 'none'}
            {agentSlug ? ` · agent ${agentSlug}` : ''}
          </p>
          <label className="mt-3 block text-metadata text-muted-foreground" htmlFor="terminal-upgrade-draft">
            Draft for this terminal agent
          </label>
          <textarea
            id="terminal-upgrade-draft"
            ref={upgradeTextareaRef}
            value={upgradeDraft}
            onChange={(e) => setUpgradeDraft(e.target.value)}
            rows={5}
            placeholder="Describe what this terminal agent should do…"
            disabled={upgradeBusy}
            className="mt-1 w-full resize-y rounded-md border border-border bg-paper px-3 py-2 text-body text-foreground outline-none focus:border-accent-copper disabled:opacity-60"
          />
          {upgradedText ? (
            <>
              <label
                className="mt-3 block text-metadata text-muted-foreground"
                htmlFor="terminal-upgrade-result"
              >
                Upgraded prompt (what will be sent / inserted)
              </label>
              <textarea
                id="terminal-upgrade-result"
                value={upgradedText}
                onChange={(e) => setUpgradedText(e.target.value)}
                rows={8}
                className="mt-1 w-full resize-y rounded-md border border-accent-copper/40 bg-paper px-3 py-2 text-body text-foreground outline-none focus:border-accent-copper"
              />
            </>
          ) : null}
          {upgradeStatus ? (
            <p className="mt-2 text-metadata text-accent-copper" role="status" aria-live="polite">
              {upgradeStatus}
            </p>
          ) : null}
          {upgradeError ? (
            <p className="mt-2 text-metadata text-destructive" role="alert">
              {upgradeError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {upgradeBusy ? (
              <button
                type="button"
                onClick={cancelUpgrade}
                className="rounded-md border border-border px-3 py-2 text-secondary text-foreground"
              >
                Cancel upgrade
              </button>
            ) : (
              <button
                type="button"
                disabled={!upgradeDraft.trim()}
                onClick={() => void runUpgrade()}
                className="rounded-md border border-accent-copper/60 bg-accent-copper/10 px-3 py-2 text-secondary text-accent-copper disabled:cursor-not-allowed disabled:opacity-50"
              >
                Upgrade
              </button>
            )}
            <button
              type="button"
              disabled={!upgradeDraft.trim() && !upgradedText}
              onClick={() => void copyUpgraded()}
              className="rounded-md border border-border px-3 py-2 text-secondary text-foreground disabled:opacity-50"
            >
              Copy
            </button>
            <button
              type="button"
              disabled={!upgradedText?.trim() && !upgradeDraft.trim()}
              onClick={() => void insertUpgraded()}
              title={(() => {
                const gate = canInsertUpgradedPromptIntoTerminal(evidence);
                return gate.ok
                  ? 'Type into the shell prompt without interrupting other panes'
                  : gate.reason;
              })()}
              className="rounded-md border border-border px-3 py-2 text-secondary text-foreground disabled:opacity-50"
            >
              Insert at prompt
            </button>
            <button
              type="button"
              onClick={() => {
                cancelUpgrade();
                setDetail(null);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              className="rounded-md border border-border px-3 py-2 text-secondary text-muted-foreground"
            >
              Back
            </button>
          </div>
        </div>
      ) : detail === 'status' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-secondary text-foreground">
          <h3 className="font-display text-ui-strong">Terminal status</h3>
          <p className="mt-2">
            {evidence.atPrompt
              ? 'Verified local shell prompt'
              : 'Slash interception is closed; use the toolbar or Ctrl/⌘+Shift+P.'}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-metadata">
            <dt>Session</dt>
            <dd>{sessionId ?? 'not attached'}</dd>
            <dt>Project</dt>
            <dd>{projectId ?? 'none'}</dd>
            <dt>Protocol</dt>
            <dd>{evidence.promptProtocol}</dd>
            <dt>Alternate screen</dt>
            <dd>{evidence.alternateScreen ? 'yes' : 'no'}</dd>
          </dl>
          <button type="button" onClick={() => setDetail(null)} className="mt-4 text-accent-copper">
            Back
          </button>
        </div>
      ) : detail === 'help' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-secondary text-foreground">
          <h3 className="font-display text-ui-strong">Terminal help</h3>
          <p className="mt-2">
            Type <code>/vibespace</code> only at a verified local shell prompt. In interactive,
            remote, or full-screen programs, use the toolbar or Ctrl/⌘+Shift+P.
          </p>
          <p className="mt-2">
            The real <code>vibespace</code> and <code>vs</code> CLI commands are separate from this
            in-pane overlay.
          </p>
          <p className="mt-2">
            Shell prompt integration is optional. It adds only a marked, removable block to
            supported shell profiles and preserves their existing content.
          </p>
          {onInstallCli ||
          onUninstallCli ||
          onInstallShellIntegration ||
          onUninstallShellIntegration ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {onInstallCli ? (
                <button
                  type="button"
                  disabled={cliSetupPending}
                  onClick={() =>
                    void updateTerminalSetup(
                      onInstallCli,
                      (status) =>
                        `Installed vibespace and vs in ${status.binDir}. Open a new terminal if PATH has not refreshed.`,
                    )
                  }
                  className="rounded-md border border-accent-copper/60 bg-accent-copper/10 px-3 py-2 text-secondary text-accent-copper disabled:cursor-wait disabled:opacity-60"
                >
                  Install terminal commands
                </button>
              ) : null}
              {onUninstallCli ? (
                <button
                  type="button"
                  disabled={cliSetupPending}
                  onClick={() =>
                    void updateTerminalSetup(
                      onUninstallCli,
                      (status) => `Removed managed terminal commands from ${status.binDir}.`,
                    )
                  }
                  className="rounded-md border border-border px-3 py-2 text-secondary text-foreground disabled:cursor-wait disabled:opacity-60"
                >
                  Remove terminal commands
                </button>
              ) : null}
              {onInstallShellIntegration ? (
                <button
                  type="button"
                  disabled={cliSetupPending}
                  onClick={() =>
                    void updateTerminalSetup(
                      onInstallShellIntegration,
                      (status) =>
                        `Enabled managed prompt integration for ${status.profiles.length} shell profile(s). Open a new shell to apply it.`,
                    )
                  }
                  className="rounded-md border border-accent-copper/60 bg-accent-copper/10 px-3 py-2 text-secondary text-accent-copper disabled:cursor-wait disabled:opacity-60"
                >
                  Enable shell prompt integration
                </button>
              ) : null}
              {onUninstallShellIntegration ? (
                <button
                  type="button"
                  disabled={cliSetupPending}
                  onClick={() =>
                    void updateTerminalSetup(
                      onUninstallShellIntegration,
                      () =>
                        'Removed managed prompt integration. Open shells keep their current prompt until restarted.',
                    )
                  }
                  className="rounded-md border border-border px-3 py-2 text-secondary text-foreground disabled:cursor-wait disabled:opacity-60"
                >
                  Remove shell prompt integration
                </button>
              ) : null}
            </div>
          ) : null}
          {cliSetupMessage ? (
            <p
              className="mt-3 text-secondary text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {cliSetupMessage}
            </p>
          ) : null}
          <button type="button" onClick={() => setDetail(null)} className="mt-4 text-accent-copper">
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="border-b border-border p-2">
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Filter terminal commands"
              aria-controls="vibespace-terminal-palette-list"
              aria-expanded="true"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Type to filter…"
              className="w-full rounded-md border border-border bg-paper px-3 py-2 text-body text-foreground outline-none focus:border-accent-copper"
            />
          </div>
          <div
            id="vibespace-terminal-palette-list"
            role="listbox"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {filtered.map((item, index) => {
              const Icon = item.icon;
              const selected = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-label={item.label}
                  aria-selected={selected}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(item)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left',
                    selected
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-body text-foreground">{item.label}</span>
                    <span className="block truncate text-metadata">{item.description}</span>
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 ? (
              <p className="p-4 text-center text-secondary text-muted-foreground">
                No matching VibeSpace commands.
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
