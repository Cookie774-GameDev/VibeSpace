/**
 * Pet mini-panel terminals — same live PTY + pane chrome as the main app.
 *
 * - No grid: one visible terminal at a time (tabs switch focus).
 * - Max 4 terminals (enforced by presentation store).
 * - PaneToolbar copy: palette, T (font cycle), Clear (hold→confirm), X (hold→confirm).
 * - Sessions stay mounted (hidden when inactive) so tab switches stay lag-free
 *   and the same PTY/transcript is preserved — never re-spawned on focus.
 */
import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { invoke } from '@tauri-apps/api/core';
import { Plus } from 'lucide-react';
import { TerminalView } from '@/features/terminals/TerminalView';
import {
  DEFAULT_FONT_SIZE,
  PaneToolbar,
  nextFontSize,
} from '@/features/terminals/PaneToolbar';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { terminalSessionRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { PET_PANEL_MAX_TERMINALS, PET_PANEL_TERMINAL_LIMIT_MESSAGE } from './petPanelLifecycle';
import { usePetPresentationStore } from './petPresentationStore';
import type { PetTerminalViewMode } from './petTerminalLayout';
import { cn } from '@/lib/utils';

export type { PetTerminalViewMode };

const FONT_SIZES_KEY = 'vibespace-pet-terminal-font-sizes';

function loadFontSizes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FONT_SIZES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveFontSizes(map: Record<string, number>): void {
  try {
    localStorage.setItem(FONT_SIZES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function PetTerminalSurface({ className }: { className?: string }) {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const defaultFontSize = useUIStore((s) => s.defaultTerminalFontSize) || DEFAULT_FONT_SIZE;
  const terminals = usePetPresentationStore((s) => s.terminals);
  const registerTerminal = usePetPresentationStore((s) => s.registerTerminal);
  const setTerminalStatus = usePetPresentationStore((s) => s.setTerminalStatus);
  const panelActiveTerminalId = usePetPresentationStore((s) => s.panelActiveTerminalId);
  const setPanelActiveTerminalId = usePetPresentationStore((s) => s.setPanelActiveTerminalId);
  const lastLimitMessage = usePetPresentationStore((s) => s.lastLimitMessage);
  const petTerminalCount = usePetPresentationStore((s) => s.petTerminalCount);

  const [fontSizes, setFontSizes] = React.useState<Record<string, number>>(loadFontSizes);
  const [fullscreenId, setFullscreenId] = React.useState<string | null>(null);

  const sessions = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      return terminalSessionRepo.listByWorkspace(workspaceId as never);
    },
    [workspaceId],
    [],
  );

  const petTerms = React.useMemo(
    () => Object.values(terminals).filter((t) => t.owner === 'pet-mini-panel'),
    [terminals],
  );

  const active =
    petTerms.find((t) => t.terminalId === panelActiveTerminalId) ?? petTerms[0] ?? null;

  React.useEffect(() => {
    if (active && active.terminalId !== panelActiveTerminalId) {
      setPanelActiveTerminalId(active.terminalId);
    }
  }, [active, panelActiveTerminalId, setPanelActiveTerminalId]);

  React.useEffect(() => {
    for (const row of sessions ?? []) {
      if (!terminals[row.id]) {
        registerTerminal({
          terminalId: row.id,
          ptyId: row.id,
          owner: 'main',
          title: row.title || row.shell_command || 'terminal',
          cwd: row.cwd,
          shell: row.shell_command,
          status: row.status === 'exited' ? 'exited' : 'running',
        });
      }
    }
  }, [sessions, terminals, registerTerminal]);

  const setFontSizeFor = React.useCallback((terminalId: string, size: number) => {
    setFontSizes((prev) => {
      const next = { ...prev, [terminalId]: size };
      saveFontSizes(next);
      return next;
    });
  }, []);

  const closeTerminal = React.useCallback(async (terminalId: string, sessionId: string | null) => {
    if (sessionId && !sessionId.startsWith('pending_')) {
      try {
        await invoke('terminal_kill', { sessionId });
      } catch {
        /* backend torn down */
      }
      useTerminalTranscriptStore.getState().forgetSession(sessionId);
    }
    usePetPresentationStore.setState((s) => {
      const next = { ...s.terminals };
      delete next[terminalId];
      return {
        terminals: next,
        panelActiveTerminalId:
          s.panelActiveTerminalId === terminalId ? null : s.panelActiveTerminalId,
        lastLimitMessage: null,
      };
    });
    setFullscreenId((cur) => (cur === terminalId ? null : cur));
    setFontSizes((prev) => {
      if (!(terminalId in prev)) return prev;
      const next = { ...prev };
      delete next[terminalId];
      saveFontSizes(next);
      return next;
    });
  }, []);

  const spawnOnPet = () => {
    if (petTerminalCount() >= PET_PANEL_MAX_TERMINALS) {
      usePetPresentationStore.setState({ lastLimitMessage: PET_PANEL_TERMINAL_LIMIT_MESSAGE });
      return;
    }
    usePetPresentationStore.setState({ lastLimitMessage: null });
    const tempId = `pending_${Date.now()}`;
    setPanelActiveTerminalId(tempId);
    usePetPresentationStore.setState((s) => ({
      terminals: {
        ...s.terminals,
        [tempId]: {
          terminalId: tempId,
          ptyId: tempId,
          owner: 'pet-mini-panel',
          title: 'new',
          status: 'running',
        },
      },
    }));
  };

  const showTabs = !fullscreenId && petTerms.length > 0;

  return (
    <div
      className={cn('flex h-full min-h-0 min-w-0 flex-col gap-2', className)}
      data-pet-terminal-surface="true"
      data-pet-terminal-layout="tabs"
    >
      {!fullscreenId && (
        <div className="flex min-h-6 shrink-0 items-center gap-0.5" data-pet-terminal-toolbar="true">
          <Button
            size="icon-sm"
            variant="secondary"
            className="h-6 w-6"
            onClick={spawnOnPet}
            disabled={petTerminalCount() >= PET_PANEL_MAX_TERMINALS}
            aria-label="New terminal"
            title={
              petTerminalCount() >= PET_PANEL_MAX_TERMINALS
                ? `Maximum ${PET_PANEL_MAX_TERMINALS} terminals`
                : 'New terminal'
            }
            data-testid="pet-terminal-new"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <span className="text-metadata text-muted-foreground" aria-label="Terminal count">
            {petTerminalCount()}/{PET_PANEL_MAX_TERMINALS}
          </span>
        </div>
      )}

      {lastLimitMessage && (
        <div
          role="alert"
          data-testid="pet-terminal-limit"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm"
        >
          {lastLimitMessage ?? PET_PANEL_TERMINAL_LIMIT_MESSAGE}
        </div>
      )}

      {showTabs && (
        <div
          className="flex min-w-0 shrink-0 gap-1 overflow-x-auto scrollbar-hidden"
          role="tablist"
          aria-label="Terminals"
          data-pet-terminal-tabs="true"
        >
          {petTerms.map((t) => (
            <Button
              key={t.terminalId}
              size="sm"
              variant={t.terminalId === active?.terminalId ? 'default' : 'outline'}
              onClick={() => setPanelActiveTerminalId(t.terminalId)}
              data-terminal-id={t.terminalId}
              data-pty-id={t.ptyId}
              title={t.title || t.terminalId}
              aria-label={`Open terminal ${t.title || t.terminalId}`}
              aria-selected={t.terminalId === active?.terminalId}
              role="tab"
              className="h-7 min-w-0 max-w-36 shrink-0 truncate px-2 text-xs"
            >
              {t.title || t.terminalId.slice(0, 8)}
            </Button>
          ))}
        </div>
      )}

      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background"
        data-pet-terminal-stage="true"
      >
        {petTerms.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-secondary text-muted-foreground">
            No terminals on the Pet panel. Create one or move a live session from main.
          </div>
        ) : (
          petTerms.map((t) => {
            const isPending = t.terminalId.startsWith('pending_');
            const sessionId = isPending ? null : t.ptyId;
            const isActive = t.terminalId === active?.terminalId;
            const isFs = fullscreenId === t.terminalId;
            const fontSize = fontSizes[t.terminalId] ?? defaultFontSize;
            const paneId = `pet-pane-${t.terminalId}`;

            // Keep every pet terminal mounted (max 4) so focus switches are lag-free
            // and the same live PTY is never torn down just by changing tabs.
            return (
              <div
                key={t.terminalId}
                className={cn(
                  'absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
                  !isActive && !isFs && 'invisible pointer-events-none',
                  isFs && 'z-10',
                )}
                data-pet-terminal-tile={t.terminalId}
                data-pet-terminal-focused={isActive ? 'true' : 'false'}
                data-pty-id={t.ptyId}
                aria-hidden={!isActive}
              >
                <div
                  className="flex h-6 shrink-0 items-center justify-between gap-1 border-b border-border bg-paper-soft px-1.5"
                  data-pet-terminal-chrome="true"
                >
                  <div className="min-w-0 truncate font-mono text-[10px] leading-none">
                    <span className="text-foreground">{t.title || t.terminalId.slice(0, 8)}</span>
                    <span className="ml-1 text-muted-foreground">· {t.status}</span>
                  </div>
                  {/* Same main-app PaneToolbar (T / Clear hold / X hold / palette).
                      Only mount on the focused tile so controls stay unique + responsive. */}
                  {isActive ? (
                    <PaneToolbar
                      sessionId={sessionId}
                      paneId={paneId}
                      fontSize={fontSize}
                      isFullscreen={isFs}
                      canFullscreen
                      onFontSizeCycle={() =>
                        setFontSizeFor(t.terminalId, nextFontSize(fontSize, defaultFontSize))
                      }
                      onFullscreenToggle={() =>
                        setFullscreenId((cur) => (cur === t.terminalId ? null : t.terminalId))
                      }
                      onClose={() => {
                        void closeTerminal(t.terminalId, sessionId);
                      }}
                    />
                  ) : null}
                </div>
                <div className="min-h-0 flex-1" data-pet-terminal-input="true">
                  <TerminalView
                    key={t.ptyId}
                    sessionId={sessionId}
                    paneId={paneId}
                    hideChrome
                    className="h-full w-full"
                    projectId={projectId}
                    fontSize={fontSize}
                    cwd={t.cwd}
                    command={t.shell}
                    onReady={(readySessionId) => {
                      const prev = t.terminalId;
                      usePetPresentationStore.setState((s) => {
                        const next = { ...s.terminals };
                        delete next[prev];
                        next[readySessionId] = {
                          terminalId: readySessionId,
                          ptyId: readySessionId,
                          owner: 'pet-mini-panel',
                          title: t.title === 'new' ? 'terminal' : t.title || 'terminal',
                          cwd: t.cwd,
                          shell: t.shell,
                          status: 'running',
                        };
                        return {
                          terminals: next,
                          panelActiveTerminalId:
                            s.panelActiveTerminalId === prev
                              ? readySessionId
                              : s.panelActiveTerminalId,
                        };
                      });
                      setFontSizes((prevMap) => {
                        if (!(prev in prevMap)) return prevMap;
                        const nextMap = { ...prevMap, [readySessionId]: prevMap[prev]! };
                        delete nextMap[prev];
                        saveFontSizes(nextMap);
                        return nextMap;
                      });
                    }}
                    onExit={(code) => {
                      setTerminalStatus(
                        t.terminalId,
                        code === 0 || code == null ? 'exited' : 'error',
                      );
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
