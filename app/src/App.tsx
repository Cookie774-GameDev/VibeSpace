/**
 * Jarvis - root App component.
 *
 * Composes:
 *   <AuthGate>            - generates local user, seeds DB, gates onboarding
 *     <AppShell>          - the three-pane chrome (TopBar, Nav, Inspector, etc.)
 *       <ActiveCanvas />  - dispatches chat / council / doc / code mode
 *     </AppShell>
 *     <CommandPalette />  - global Cmd+K
 *     <SettingsModal />   - Cmd+, target
 *     <VoiceModal />      - Cmd+Space target
 *     <GlowBorder />      - screen-edge glow during voice listening
 *     <AmbientHome />     - V2 idle takeover with breathing orb + clock
 *     <Toaster />         - in-app toast outlet
 *   </AuthGate>
 *
 * Plus boot effects:
 *   - openDb + seedIfEmpty (no-throw)
 *   - registerMany default agents into the agent runtime store
 *   - register the chat -> AI runtime listener (jarvis:send / jarvis:cancel)
 *   - useGlobalHotkeys() to wire every HOTKEY -> palette action
 *   - useIdleDetection() to flip ambient mode on inactivity (V2)
 */
import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { AuthGate } from '@/features/auth';
import { AppShell } from '@/components/layout';
import { ChatView } from '@/features/chat';
import { CouncilView } from '@/features/council';
import { TodoPanel, startNotificationLoop } from '@/features/tasks';
import { CommandPalette, useGlobalHotkeys } from '@/features/command-palette';
import { SettingsModal } from '@/features/settings';
import { VoiceModal, GlowBorder } from '@/features/voice';
import { AmbientHome, useIdleDetection } from '@/features/ambient';
import { ScheduleModal } from '@/features/schedule';
import { LauncherDialog, useLinkHotkeys } from '@/features/launcher';
import { AssistantBar } from '@/features/assistant';
import { Toaster, toast } from '@/components/ui/toast';
import { startRuntimeListener } from '@/lib/ai/runtime';
import { messageRepo, agentRepo, chatRepo, openDb } from '@/lib/db';
import { getDefaultAgents } from '@/features/agents';
import { useHotkey, HOTKEYS } from '@/lib/hotkeys';
import type { Agent, AgentId, Message } from '@/types';

/**
 * Renders the right canvas based on `useUIStore.chatMode`. The shell does
 * not pick the canvas; we do, so the shell can stay layout-only.
 */
function ActiveCanvas() {
  const chatMode = useUIStore((s) => s.chatMode);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const [councilAgentIds, setCouncilAgentIds] = React.useState<AgentId[]>([]);
  const [councilMessages, setCouncilMessages] = React.useState<Message[]>([]);
  const agentMap = useAgentStore((s) => s.agents);

  // When council mode is on, pull the chat's `active_agent_ids` and stream
  // messages from the same chat so each panel can filter on agent_id.
  React.useEffect(() => {
    if (chatMode !== 'council' || !activeChatId) {
      setCouncilAgentIds([]);
      setCouncilMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const chat = await chatRepo.getById(activeChatId as never);
        if (cancelled || !chat) return;
        // Default to all built-in agents if the chat hasn't been wired yet.
        const ids =
          chat.active_agent_ids?.length > 0
            ? chat.active_agent_ids
            : (Object.values(agentMap) as Agent[]).slice(0, 4).map((a) => a.id);
        setCouncilAgentIds(ids);
        const msgs = await messageRepo.listByChat(activeChatId as never);
        if (!cancelled) setCouncilMessages(msgs);
      } catch (err) {
        console.error('Council bootstrap failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatMode, activeChatId, agentMap]);

  if (chatMode === 'council') {
    return <CouncilView agentIds={councilAgentIds} messages={councilMessages} />;
  }
  // doc / code modes are placeholders in V1 - render the chat as a fallback.
  return <ChatView />;
}

/**
 * Boot-time wiring: open DB, register default agents, start runtime + notification loops.
 * Mounted ONCE inside AuthGate (after seeding) via this effect.
 */
function useBoot() {
  const registerMany = useAgentStore((s) => s.registerMany);

  React.useEffect(() => {
    let stopRuntime: (() => void) | undefined;
    let stopNotifications: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // 1) Open IndexedDB. Seeding happens inside AuthGate before we mount.
      try {
        await openDb();
      } catch (err) {
        console.error('Failed to open Jarvis DB:', err);
        toast.error('Storage error', 'Could not open local database. Some features may not work.');
      }

      if (cancelled) return;

      // 2) Register the 7 built-in agents into the in-memory agent store so
      //    the UI can find them. The DB also has rows for these from seedIfEmpty.
      try {
        registerMany(getDefaultAgents());
      } catch (err) {
        console.error('Failed to register default agents:', err);
      }

      // 3) Wire the AI runtime to the chat composer events.
      stopRuntime = startRuntimeListener({
        getAgentById: (id) => useAgentStore.getState().agents[id] ?? null,
        getAgentBySlug: (slug) => {
          const agents = useAgentStore.getState().agents;
          return Object.values(agents).find((a) => a.slug === slug) ?? null;
        },
        getAgentForChat: () => {
          // Default to Jarvis (slug='jarvis') for now. Real chat-bound default
          // resolution lands when the chat list / picker stores the chosen agent.
          const agents = Object.values(useAgentStore.getState().agents) as Agent[];
          return agents.find((a) => a.slug === 'jarvis') ?? agents[0] ?? null;
        },
        getMessages: async (chatId) => {
          return messageRepo.listByChat(chatId as never);
        },
        appendMessage: async (msg) => {
          // messageRepo.create accepts the full message minus id+timestamps and
          // stamps them in for us.
          return messageRepo.create(msg as never);
        },
        updateMessage: async (id, patch) => {
          await messageRepo.update(id, patch);
        },
      });

      // 4) Start the smart-reminder notification loop. A5's TodoPanel also
      //    starts it on mount; calling it here too is safe (the loop is idempotent
      //    because each scheduled reminder has a fired/dismissed status guard).
      try {
        stopNotifications = startNotificationLoop();
      } catch (err) {
        console.error('Failed to start notification loop:', err);
      }
    })();

    return () => {
      cancelled = true;
      stopRuntime?.();
      stopNotifications?.();
    };
    // Run once - boot is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Wires up the global Cmd+K palette + every other hotkey across features.
 */
function GlobalHotkeysHost() {
  useGlobalHotkeys();

  // V2 — idle detection drives ambient takeover.
  useIdleDetection();

  // V2 — fullscreen chat toggle.
  const toggleChatFullscreen = useUIStore((s) => s.toggleChatFullscreen);
  useHotkey(
    HOTKEYS.TOGGLE_FULLSCREEN,
    (e) => {
      e.preventDefault();
      toggleChatFullscreen();
    },
    { whenInputs: true },
  );

  // V2 — manual ambient toggle (Mod+Shift+.).
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const ambientEnabled = useUIStore((s) => s.ambient);
  useHotkey(HOTKEYS.AMBIENT_TOGGLE, (e) => {
    e.preventDefault();
    if (!ambientEnabled) return;
    setAmbientActive(!useUIStore.getState().ambientActive);
  });

  // V2 — Schedule (Mod+Shift+S).
  const setScheduleOpen = useUIStore((s) => s.setScheduleOpen);
  useHotkey(HOTKEYS.SCHEDULE, (e) => {
    e.preventDefault();
    setScheduleOpen(!useUIStore.getState().scheduleOpen);
  });

  // V2 — Launcher (Mod+Shift+L).
  const setLauncherOpen = useUIStore((s) => s.setLauncherOpen);
  useHotkey(HOTKEYS.LAUNCHER, (e) => {
    e.preventDefault();
    setLauncherOpen(!useUIStore.getState().launcherOpen);
  });

  // V2 — Jarvis Assistant (Mod+J).
  const setAssistantOpen = useUIStore((s) => s.setAssistantOpen);
  useHotkey(HOTKEYS.ASSISTANT, (e) => {
    e.preventDefault();
    setAssistantOpen(!useUIStore.getState().assistantOpen);
  });

  // V2 — per-link launcher hotkeys (e.g. Mod+Shift+1 jumps straight to YouTube).
  useLinkHotkeys();

  return null;
}

/**
 * Schedule modal mount, listens to ui.scheduleOpen.
 */
function ScheduleModalHost() {
  const open = useUIStore((s) => s.scheduleOpen);
  const setOpen = useUIStore((s) => s.setScheduleOpen);
  return <ScheduleModal open={open} onOpenChange={setOpen} />;
}

/**
 * Launcher dialog mount, listens to ui.launcherOpen.
 */
function LauncherDialogHost() {
  const open = useUIStore((s) => s.launcherOpen);
  const setOpen = useUIStore((s) => s.setLauncherOpen);
  return <LauncherDialog open={open} onOpenChange={setOpen} />;
}

/**
 * Jarvis Assistant mount, listens to ui.assistantOpen.
 *
 * The bar is the natural-language command surface (Mod+J). It runs a
 * deterministic local parser — no remote AI calls.
 */
function AssistantBarHost() {
  const open = useUIStore((s) => s.assistantOpen);
  const setOpen = useUIStore((s) => s.setAssistantOpen);
  return <AssistantBar open={open} onOpenChange={setOpen} />;
}

/**
 * Inner shell - rendered after AuthGate has confirmed local user + seeding.
 */
function WorkspaceRoot() {
  useBoot();
  return (
    <>
      <GlobalHotkeysHost />
      <AppShell>
        <ActiveCanvas />
      </AppShell>

      {/* Modal layer */}
      <CommandPalette />
      <SettingsModal />
      <VoiceModal />
      <ScheduleModalHost />
      <LauncherDialogHost />
      <AssistantBarHost />

      {/* Visual ambient effects */}
      <GlowBorder />

      {/* V2 — idle takeover. Self-renders only when ambientActive=true. */}
      <AmbientHome />

      {/* The TodoPanel portals into the shell's <aside id="todo-drawer-root" /> */}
      <TodoPanel />

      {/* Toast outlet */}
      <Toaster />
    </>
  );
}

/**
 * App root: AuthGate decides whether to show Onboarding or the workspace.
 * Onboarding flow is its own component owned by A8.
 */
export function App() {
  return (
    <AuthGate>
      <WorkspaceRoot />
    </AuthGate>
  );
}

export default App;
