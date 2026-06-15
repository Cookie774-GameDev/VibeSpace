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
import { applyThemeToDocument, useUIStore } from '@/stores/ui';
import { handleVoiceModuleClosed } from '@/features/voice/voiceRouter';
import { useAgentStore } from '@/stores/agents';
import { AuthGate } from '@/features/auth';
import { AppShell } from '@/components/layout';
import { JarvisContextMenu } from '@/components/layout/JarvisContextMenu';
import { PageRouter } from '@/components/layout/PageRouter';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { startNotificationLoop } from '@/features/tasks';
import { useGlobalHotkeys } from '@/features/command-palette';
import { WakeWordHost } from '@/features/voice/WakeWordHost';
import { ApiKeySaveBurst } from '@/features/settings/ApiKeySaveBurst';
import { CallModal, startOutboundTrigger } from '@/features/call';
import { useBridgeLifecycle } from '@/lib/bridge/useBridgeLifecycle';
import { useIdleDetection, AmbientAudioHost } from '@/features/ambient';
import { useLinkHotkeys } from '@/features/launcher';
import { Toaster, toast } from '@/components/ui/toast';
import { startRuntimeListener } from '@/lib/ai/runtime';
import { messageRepo, agentRepo, chatRepo, openDb, db } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { getDefaultAgents } from '@/features/agents';
import { ensureActiveChat, branchChatFromMessage } from '@/features/chat/chatLifecycle';
import type { ChatId, MessageId } from '@/types/common';
import { useHotkey, HOTKEYS } from '@/lib/hotkeys';
import { DevConsoleHost } from '@/features/dev-console';
import { initTerminalScheduler } from '@/features/terminals/terminalScheduler';
import { UpdateWarningHost } from '@/features/updates/UpdateWarningHost';
import { GlobalDictationOverlay } from '@/features/global-dictation/GlobalDictationOverlay';
import type { Agent, AgentId, Message } from '@/types';

type SupabaseSessionLike = {
  user?: {
    id?: string;
    email?: string;
  };
  expires_at?: number;
} | null;

/**
 * Lazy-mounted modals + canvas surfaces.
 *
 * Two reasons each component is wrapped here instead of imported eagerly:
 *
 *   1. Code-splitting. The chat view, council grid, settings sections,
 *      schedule editor, launcher tile editor, what's-new modal, actions
 *      palette, ambient takeover, and wellness break all pull large
 *      dependency graphs (motion, dexie hooks, big component trees) that
 *      have no business landing in the boot chunk.
 *
 *   2. Runtime cost. Most of these are gated by an `open` boolean in the
 *      UI store; even when closed they pay rendering + tree-walk cost
 *      every time the store updates. Lazy-mounting means the React tree
 *      never sees them until the user actually summons them.
 *
 * Suspense fallbacks are deliberately `null` — these are overlays whose
 * own internal skeletons handle empty/loading states better than a
 * generic spinner would.
 */
const ChatView = React.lazy(() => import('@/features/chat').then((m) => ({ default: m.ChatView })));
const CouncilView = React.lazy(() =>
  import('@/features/council').then((m) => ({ default: m.CouncilView })),
);
import { getLastSettingsTab } from '@/features/settings/settingsTabMemory';

const SettingsModal = React.lazy(() =>
  import('@/features/settings').then((m) => ({ default: m.SettingsModal })),
);
const VoiceModal = React.lazy(() =>
  import('@/features/voice/VoiceModal').then((m) => ({ default: m.VoiceModal })),
);
const CommandPalette = React.lazy(() =>
  import('@/features/command-palette').then((m) => ({ default: m.CommandPalette })),
);
const LauncherDialog = React.lazy(() =>
  import('@/features/launcher').then((m) => ({ default: m.LauncherDialog })),
);
const AssistantBar = React.lazy(() =>
  import('@/features/assistant').then((m) => ({ default: m.AssistantBar })),
);
const WhatsNewHost = React.lazy(() =>
  import('@/features/whats-new').then((m) => ({ default: m.WhatsNewHost })),
);
const ActionsPalette = React.lazy(() =>
  import('@/features/actions').then((m) => ({ default: m.ActionsPalette })),
);
const AmbientHome = React.lazy(() =>
  import('@/features/ambient').then((m) => ({ default: m.AmbientHome })),
);
const CelebrationHost = React.lazy(() =>
  import('@/features/celebrate').then((m) => ({ default: m.CelebrationHost })),
);

function applyCloudSession(session: SupabaseSessionLike): void {
  const userId = session?.user?.id;
  if (!userId) {
    useAuthStore.getState().setCloudSession(null);
    return;
  }
  useAuthStore.getState().setCloudSession({
    user_id: userId,
    email: session.user?.email ?? '',
    expires_at: session.expires_at ?? 0,
  });
  void syncPlanFromProfile(userId);
}

/**
 * Pull the server-managed subscription tier into the local auth store so the
 * Plans/Account UI reflects Stripe state after sign-in and app restarts.
 * Fire-and-forget: failures leave the locally persisted plan untouched.
 */
async function syncPlanFromProfile(userId: string): Promise<void> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const supa = getSupabaseClient();
    if (!supa) return;
    const { data, error } = await supa
      .from('profiles')
      .select('tier')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data?.tier) return;
    const tier = data.tier === 'byok-only' ? 'free' : data.tier;
    if (tier === 'free' || tier === 'starter' || tier === 'pro' || tier === 'ultra') {
      const store = useAuthStore.getState();
      if (store.plan !== tier) store.setPlan(tier);
    }
  } catch (err) {
    console.warn('[billing] plan sync skipped:', err);
  }
}

/**
 * Renders the right canvas based on `useUIStore.route` (V3) and
 * `chatMode` (V2). For non-`chat` routes (terminal / kanban / context /
 * benchmarks / history / agents) we delegate to `<PageRouter />`.
 *
 * For the `chat` route we keep the existing council bootstrap so
 * council mode still pulls per-chat agent ids and seeds messages.
 */
function ActiveCanvas() {
  const route = useUIStore((s) => s.route);
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

  // V3 — non-chat routes go through the lazy PageRouter.
  if (route !== 'chat') {
    return <PageRouter />;
  }

  if (chatMode === 'council') {
    return (
      <React.Suspense fallback={null}>
        <CouncilView agentIds={councilAgentIds} messages={councilMessages} />
      </React.Suspense>
    );
  }
  // doc / code modes are placeholders in V1 - render the chat as a fallback.
  return (
    <React.Suspense fallback={null}>
      <ChatView />
    </React.Suspense>
  );
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
    let stopTerminalScheduler: (() => void) | undefined;
    let stopSyncLoop: (() => void) | undefined;
    let stopCloudAuth: (() => void) | undefined;
    let cancelled = false;
    const errors: string[] = [];

    function addError(label: string, err: unknown): void {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[boot] ${label}:`, msg);
      errors.push(`${label}: ${msg}`);
    }

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms/1000}s`)), ms)),
      ]).catch((err) => { addError(label, err); throw err; });
    }

    (async () => {
      // Phase 1: storage & keys
      try { await withTimeout(openDb(), 10_000, 'openDb'); } catch { /* degraded */ }

      if (cancelled) return;

      try { await withTimeout(useAuthStore.getState().hydrateApiKeysFromVault(), 5_000, 'hydrateKeys'); } catch { /* fallback to localStorage */ }

      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('install_terminal_launcher'))
        .catch((err) => console.warn('[launcher] terminal command setup failed', err));

      // Phase 2: Supabase (non-blocking, fire-and-forget)
      try {
        const { isSupabaseConfigured } = await withTimeout(
          import('@/lib/supabase/env').then((m) => m), 5_000, 'supabaseCheck',
        ).catch(() => ({ isSupabaseConfigured: () => false }));
        if (!isSupabaseConfigured()) {
          applyCloudSession(null);
        } else {
          const supabaseModules = await withTimeout(
            Promise.all([import('@/lib/supabase/client'), import('@/lib/sync')]), 15_000, 'supabaseImport',
          ).catch(() => null);
          if (supabaseModules && !cancelled) {
            const [{ getSupabaseClient }, { processCloudPull, processSyncQueue, pruneSyncQueue, retrySyncErrors, startSyncLoop }] = supabaseModules;
            const supa = getSupabaseClient();
            if (supa) {
              void supa.auth.getSession().then(({ data }) => {
                if (cancelled) return;
                applyCloudSession(data.session as SupabaseSessionLike);
                // Startup routing: when cloud auth is configured but no one is
                // signed in, open the Account page so the user can sign up /
                // sign in. When signed in, the persisted last route is restored
                // automatically (route is persisted in the UI store).
                if (!data.session) {
                  useUIStore.getState().setRoute('account');
                } else if (data.session.user?.id) {
                  void import('@/lib/launchPromo').then((m) => m.claimLaunchPromo(data.session?.user?.id));
                }
              });
              const sub = supa.auth.onAuthStateChange((_event, session) => {
                if (cancelled) return;
                applyCloudSession(session as SupabaseSessionLike);
                if (session?.user?.id) {
                  void retrySyncErrors().then(() => processSyncQueue()).then(() => processCloudPull()).catch((err) => console.warn('[sync] immediate flush failed:', err));
                  void import('@/lib/launchPromo').then((m) => m.claimLaunchPromo(session.user?.id));
                }
              });
              stopCloudAuth = () => sub.data.subscription.unsubscribe();
            }
            await retrySyncErrors().catch((err) => console.warn('[sync] retrySyncErrors failed:', err));
            void processCloudPull().catch((err) => console.warn('[sync] initial pull failed:', err));
            void pruneSyncQueue().catch((err) => console.warn('[sync] prune failed:', err));
            if (!cancelled) stopSyncLoop = startSyncLoop();
          }
        }
      } catch { /* Supabase unavailable, app works offline */ }

      // Phase 3: agent registration
      try {
        const persistedAgents = await withTimeout(agentRepo.list(), 10_000, 'agentRepo');
        registerMany(persistedAgents.length > 0 ? persistedAgents : getDefaultAgents());
      } catch {
        registerMany(getDefaultAgents());
      }

      // Phase 4: runtime listener
      stopRuntime = startRuntimeListener({
        getAgentById: (id) => useAgentStore.getState().agents[id] ?? null,
        getAgentBySlug: (slug) => {
          const agents = useAgentStore.getState().agents;
          const wanted = slug.trim().toLowerCase();
          return Object.values(agents).find((a) => a.slug.toLowerCase() === wanted) ?? null;
        },
        getAgentForChat: async (chatId) => {
          const agents = Object.values(useAgentStore.getState().agents) as Agent[];
          const chat = await chatRepo.getById(chatId as never);
          const chatAgentId = chat?.active_agent_ids?.[0];
          if (chatAgentId && useAgentStore.getState().agents[chatAgentId]) {
            return useAgentStore.getState().agents[chatAgentId];
          }
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

      // Phase 5: background loops
      try { stopNotifications = startNotificationLoop(); } catch (err) { console.error('Failed to start notification loop:', err); }
      try { stopTerminalScheduler = initTerminalScheduler(); } catch (err) { console.error('Failed to start terminal scheduler:', err); }

      // Phase 6: Ollama model discovery (non-blocking)
      void import('@/lib/ai').then(({ listOllamaModels, syncDiscoveredOllamaModels, isOllamaReachable }) =>
        isOllamaReachable().then((connected: boolean) => {
          if (!connected || cancelled) return;
          return listOllamaModels().then((models: string[]) => {
            if (!cancelled) syncDiscoveredOllamaModels(models);
          });
        })
      ).catch((err) => console.warn('[boot] Ollama model discovery failed:', err));

      // Report accumulated errors
      if (errors.length > 0 && !cancelled) {
        toast.warning(`${errors.length} startup issue${errors.length>1?'s':''}`, errors.slice(0,3).join('; ') + (errors.length>3 ? ` (+${errors.length-3} more)` : ''));
      }
    })();

    return () => {
      cancelled = true;
      stopRuntime?.();
      stopNotifications?.();
      stopTerminalScheduler?.();
      stopSyncLoop?.();
      stopCloudAuth?.();
    };
    // Run once - boot is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function useDesktopReopenLifecycle() {
  React.useEffect(() => {
    const refreshBranding = () => {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('refresh_app_branding'))
        .catch(() => {
          /* Web preview or test runtime without Tauri invoke. */
        });
    };

    const notifyVisible = (reason: string) => {
      refreshBranding();
      window.requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent('jarvis:terminals:visible', {
            detail: { reason },
          }),
        );
      });
    };

    const onFocus = () => notifyVisible('window-focus');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') notifyVisible('visibility');
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // When the app is closed (hidden to tray) or torn down, stop any in-flight
    // speech so Jarvis does not keep talking in the background.
    const stopAllSpeech = () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      void import('@/features/voice/speechSynthesis')
        .then((m) => m.stopSpeech())
        .catch(() => {});
      void import('@/features/voice/TtsService')
        .then((m) => m.TtsService.stop())
        .catch(() => {});
    };
    window.addEventListener('pagehide', stopAllSpeech);

    let disposed = false;
    let unlistenReopen: (() => void) | null = null;
    let unlistenHide: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen('jarvis:before-hide', () => stopAllSpeech()),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenHide = unlisten;
      })
      .catch(() => {});
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ reason?: string }>('jarvis:reopen', (event) => {
          notifyVisible(event.payload?.reason ?? 'desktop-reopen');
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenReopen = unlisten;
      })
      .catch(() => {
        /* Web preview or test runtime without Tauri events. */
      });

    return () => {
      disposed = true;
      unlistenReopen?.();
      unlistenHide?.();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', stopAllSpeech);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
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
  const setRoute = useUIStore((s) => s.setRoute);
  useHotkey(HOTKEYS.SCHEDULE, (e) => {
    e.preventDefault();
    setRoute('schedule');
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
  useHotkey(
    HOTKEYS.JARVIS_BUBBLE,
    (e) => {
      e.preventDefault();
      if (useUIStore.getState().route === 'chat') {
        const next = !useAuthStore.getState().jarvisAutoApprove;
        useAuthStore.getState().setJarvisAutoApprove(next);
        toast.info(
          next ? 'Auto-approve on' : 'Auto-approve off',
          next
            ? 'Jarvis will run proposed actions without asking in this chat.'
            : 'Jarvis will show Approve cards before running actions.',
        );
        return;
      }
      setAssistantOpen(true);
    },
    { whenInputs: true },
  );

  // V3 — Actions palette (Mod+Shift+A). Sister to Mod+K (general
  // command palette) and Mod+Shift+L (launcher tiles); focused on
  // running registered actions + custom user-authored tools.
  const toggleActionsPalette = useUIStore((s) => s.toggleActionsPalette);
  useHotkey(HOTKEYS.ACTIONS, (e) => {
    e.preventDefault();
    toggleActionsPalette();
  });

  // V2 — per-link launcher hotkeys (e.g. Mod+Shift+1 jumps straight to YouTube).
  useLinkHotkeys();

  return null;
}

/**
 * Launcher dialog mount, listens to ui.launcherOpen.
 */
function LauncherDialogHost() {
  const open = useUIStore((s) => s.launcherOpen);
  const setOpen = useUIStore((s) => s.setLauncherOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <LauncherDialog open={open} onOpenChange={setOpen} />
    </React.Suspense>
  );
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
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <AssistantBar open={open} onOpenChange={setOpen} />
    </React.Suspense>
  );
}

function CommandPaletteHost() {
  const open = useUIStore((s) => s.paletteOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <CommandPalette />
    </React.Suspense>
  );
}

function SettingsModalHost() {
  const open = useUIStore((s) => s.settingsOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <SettingsModal initialTab={getLastSettingsTab()} />
    </React.Suspense>
  );
}

function VoiceModuleLifecycle() {
  const open = useUIStore((s) => s.voiceModalOpen);
  React.useEffect(() => {
    if (!open) handleVoiceModuleClosed();
  }, [open]);
  return null;
}

function VoiceModalHost() {
  const open = useUIStore((s) => s.voiceModalOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <VoiceModal />
    </React.Suspense>
  );
}

function ActionsPaletteHost() {
  const open = useUIStore((s) => s.actionsPaletteOpen);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <ActionsPalette />
    </React.Suspense>
  );
}

function ThemeHost() {
  const theme = useUIStore((state) => state.theme);

  React.useEffect(() => {
    applyThemeToDocument(theme);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyThemeToDocument('system');
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [theme]);

  return null;
}

/**
 * Inner shell - rendered after AuthGate has confirmed local user + seeding.
 */
function WorkspaceRoot() {
  useBoot();
  useBridgeLifecycle();
  useDesktopReopenLifecycle();

  // Wire outbound-call trigger so any feature can call `fireOutboundCall(...)`.
  // Default categories (manual + error) are toggled in Settings → Phone & Voice.
  React.useEffect(() => {
    const stop = startOutboundTrigger({
      onResult: (ok, info) => {
        if (ok) {
          toast.info('Outbound call queued', `Reason: ${info.reason}`);
        } else if (
          info.error &&
          info.error !== 'cooldown' &&
          info.error !== 'cloud_not_configured'
        ) {
          // Quiet failures we don't want to spam the user about
          // (cooldown is normal during a crash burst; cloud-not-configured
          // is the user's setup problem already surfaced in Settings).
          console.warn('[outbound]', info);
        }
      },
    });
    return stop;
  }, []);

  // Listen for the jarvis:new-chat event to spawn a new chat
  React.useEffect(() => {
    const handleNewChat = async () => {
      try {
        const chatId = await ensureActiveChat({ forceNew: true });
        if (!chatId) {
          toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
        }
      } catch (err) {
        toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
      }
    };

    const handleBranch = async (event: Event) => {
      const detail = (event as CustomEvent<{ messageId: string; chatId: string }>).detail;
      if (!detail?.messageId || !detail?.chatId) return;
      try {
        await branchChatFromMessage({
          chatId: detail.chatId as ChatId,
          messageId: detail.messageId as MessageId,
        });
        toast.success('Branched', 'Opened a new chat from that message — continue from here.');
      } catch (err) {
        toast.error(
          'Branch failed',
          err instanceof Error ? err.message : 'Could not branch from this message.',
        );
      }
    };

    window.addEventListener('jarvis:new-chat', handleNewChat);
    window.addEventListener('jarvis:branch', handleBranch);
    return () => {
      window.removeEventListener('jarvis:new-chat', handleNewChat);
      window.removeEventListener('jarvis:branch', handleBranch);
    };
  }, []);

  return (
    <>
      <GlobalHotkeysHost />
      <AppShell>
        <ActiveCanvas />
      </AppShell>

      {/* Modal layer — mount only while open to avoid idle store subscriptions */}
      <CommandPaletteHost />
      <SettingsModalHost />
      <VoiceModuleLifecycle />
      <VoiceModalHost />
      <WakeWordHost />
      <React.Suspense fallback={null}>
        <CallModal />
      </React.Suspense>
      <LauncherDialogHost />
      <AssistantBarHost />
      <WhatsNewHost />
      <UpdateWarningHost />

      {/* Visual ambient effects removed — clean UI */}

      {/* V3 — confetti + serif gradient toast on success milestones. */}
      <CelebrationHost />

      {/* Provider key save success burst. */}
      <ApiKeySaveBurst />

      {/* V2 — idle takeover. Self-renders only when ambientActive=true. */}
      <AmbientHome />
      <AmbientAudioHost />

      {/* V3 — actions palette (Mod+Shift+A). Direct user invocation of
          built-in actions and saved custom tools. Sibling to the
          AI-proposed approval cards rendered inline in chat bubbles. */}
      <ActionsPaletteHost />

      {/* Toast outlet */}
      <JarvisContextMenu />
      <Toaster />
    </>
  );
}

/**
 * App root: AuthGate decides whether to show Onboarding or the workspace.
 * Onboarding flow is its own component owned by A8.
 *
 * Two safety wrappers sit around AuthGate:
 *
 *   - <ErrorBoundary>: catches any uncaught render error and shows a
 *     recoverable error card instead of the React tree blanking out.
 *     Without it, a crash inside any lazy chunk or boot effect would
 *     leave the user staring at a dark window.
 *
 *   - <DevConsoleHost>: installs the patchers (console / fetch /
 *     invoke / dispatch / window-error) that pump events into the
 *     in-app DevConsole panel, plus the Mod+Shift+D and F12 hotkeys
 *     to summon it. Mounted at the root so it captures onboarding-
 *     stage logs too.
 */
export function App() {
  if (new URLSearchParams(window.location.search).get('view') === 'dictation') {
    return (
      <ErrorBoundary>
        <ThemeHost />
        <GlobalDictationOverlay />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeHost />
      <AuthGate>
        <WorkspaceRoot />
      </AuthGate>
      <DevConsoleHost />
    </ErrorBoundary>
  );
}

export default App;
