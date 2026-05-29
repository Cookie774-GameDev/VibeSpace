import * as React from 'react';
import { Search, Mic, Settings, PanelLeft, CalendarDays, Maximize2, Minimize2, Rocket, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Hint } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn, isMac } from '@/lib/utils';

/**
 * TopBar - 40px chrome at the very top of the app.
 *
 * Left cluster: collapse-nav button, workspace/project breadcrumb.
 * Right cluster: schedule, fullscreen toggle, search/palette, voice mic, settings, avatar.
 *
 * The header itself is a Tauri drag region so users can drag the window
 * by its background. Interactive elements opt out via `no-drag`.
 */
export function TopBar() {
  const navOpen = useUIStore((s) => s.navOpen);
  const toggleNav = useUIStore((s) => s.toggleNav);
  const voiceListening = useUIStore((s) => s.voiceListening);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleVoice = useUIStore((s) => s.toggleVoice);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  // V2 — schedule + launcher + fullscreen
  const setScheduleOpen = useUIStore((s) => s.setScheduleOpen);
  const setLauncherOpen = useUIStore((s) => s.setLauncherOpen);
  const setAssistantOpen = useUIStore((s) => s.setAssistantOpen);
  const chatFullscreen = useUIStore((s) => s.chatFullscreen);
  const toggleChatFullscreen = useUIStore((s) => s.toggleChatFullscreen);

  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const displayName = useAuthStore((s) => s.displayName);

  // The auth store currently has only IDs for workspace/project (no name
  // fields), so we fall back to generic labels when the IDs are set, and
  // "Loading..." when they're null. Replace with real names once the
  // auth/workspaces stores expose them.
  const workspaceLabel = workspaceId ? 'Workspace' : 'Loading\u2026';
  const projectLabel = projectId ? 'Project' : null;

  return (
    <header
      aria-label="Application header"
      className={cn(
        'drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel pr-2',
        // Reserve room on macOS for native traffic-light buttons in
        // titleBarStyle: overlay configurations.
        isMac ? 'pl-[72px]' : 'pl-2',
      )}
    >
      {/* Left: nav toggle */}
      <div className="no-drag flex items-center">
        <Hint label={navOpen ? 'Hide sidebar' : 'Show sidebar'} hotkey="Mod+B">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleNav}
            aria-label="Toggle navigation"
            aria-pressed={navOpen}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        </Hint>
      </div>

      {/* Breadcrumb */}
      <div className="no-drag flex min-w-0 items-center gap-1.5">
        <Avatar
          seed={workspaceId ?? 'workspace'}
          initials={(workspaceLabel || 'W').charAt(0)}
          size={20}
          className="shrink-0"
        />
        <span
          className={cn(
            'truncate text-secondary font-medium',
            workspaceId ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {workspaceLabel}
        </span>
        {projectLabel && (
          <>
            <span className="px-0.5 text-secondary text-muted-foreground/60 select-none">/</span>
            <span className="truncate text-secondary text-muted-foreground">{projectLabel}</span>
          </>
        )}
      </div>

      {/* Spacer (also drag region) */}
      <div className="flex-1" />

      {/* Right cluster */}
      <div className="no-drag flex items-center gap-1">
        <Hint label="Quick launcher" hotkey={HOTKEYS.LAUNCHER}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setLauncherOpen(true)}
            aria-label="Open quick launcher"
          >
            <Rocket className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Jarvis Assistant" hotkey={HOTKEYS.ASSISTANT}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAssistantOpen(true)}
            aria-label="Open Jarvis Assistant"
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Schedule" hotkey={HOTKEYS.SCHEDULE}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setScheduleOpen(true)}
            aria-label="Open schedule"
          >
            <CalendarDays className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint
          label={chatFullscreen ? 'Exit fullscreen' : 'Fullscreen workspace'}
          hotkey={HOTKEYS.TOGGLE_FULLSCREEN}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleChatFullscreen}
            aria-label={chatFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={chatFullscreen}
          >
            {chatFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </Hint>

        <Hint label="Search" hotkey="Mod+K">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
          >
            <Search className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Voice" hotkey="Mod+Space">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleVoice}
            aria-label="Voice"
            aria-pressed={voiceListening}
            className="relative"
          >
            <Mic
              className={cn('h-4 w-4 transition-colors', voiceListening && 'text-accent-cyan')}
            />
            {voiceListening && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent-cyan/60 animate-pulse"
              />
            )}
          </Button>
        </Hint>

        <Hint label="Settings" hotkey="Mod+,">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </Hint>

        <div className="pl-1">
          <Avatar
            seed={displayName || workspaceId || 'jarvis'}
            initials={(displayName || 'J').charAt(0)}
            size={24}
            aria-label={displayName ? `Profile: ${displayName}` : 'Profile'}
          />
        </div>
      </div>
    </header>
  );
}
