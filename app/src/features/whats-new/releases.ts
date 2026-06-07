/**
 * Release notes data + version metadata for the in-app "What's new" modal.
 *
 * Why a static module rather than fetching: Jarvis is offline-first and
 * we don't want a network call on every launch just to surface a
 * changelog. New releases land in this file when they ship; the build
 * version (`tauri.conf.json` + `package.json`) is the source of truth
 * for "what version am I running", and `CURRENT_VERSION` here mirrors it.
 *
 * Auto-open behaviour:
 *   - On boot, `useWhatsNew()` reads `localStorage['jarvis-last-seen-version']`
 *     and compares it to `CURRENT_VERSION`.
 *   - If they differ (including a fresh install where the key is missing),
 *     the modal opens once, focused on the **latest** release entry.
 *   - Dismissing the modal writes `CURRENT_VERSION` back to localStorage so
 *     it doesn't reopen until the next bump.
 *
 * Adding a new release:
 *   1. Bump `package.json` + `tauri.conf.json` to the new semver.
 *   2. Bump `CURRENT_VERSION` here to match.
 *   3. Prepend a new `Release` to `RELEASES` (newest first).
 *   4. Build. The first time a user runs the new build, the modal pops.
 */

import {
  Sparkles,
  Wrench,
  Rocket,
  Package,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

/**
 * Authoritative current build version.
 * Keep in sync with `package.json` and `src-tauri/tauri.conf.json`.
 *
 * The version string is also what the auto-show flow stores in
 * localStorage so users only see each release's notes once.
 */
export const CURRENT_VERSION = '0.1.22';

/**
 * Section type for grouping changelog items inside a release.
 *
 * - `feature`     — net-new functionality the user can use right now.
 * - `improvement` — existing functionality got better.
 * - `fix`         — a bug got squashed.
 * - `shipped`     — release-management notes (build, installer, infra).
 * - `known`       — known issues / things deferred.
 */
export type ReleaseSectionKind =
  | 'feature'
  | 'improvement'
  | 'fix'
  | 'shipped'
  | 'known';

export interface ReleaseSection {
  kind: ReleaseSectionKind;
  /** Optional override for the section heading. Default is derived from `kind`. */
  heading?: string;
  /** One-liner per entry. Keep them short — the modal is for scanning. */
  items: string[];
}

export interface Release {
  /** Semver. Used both as the heading and the localStorage key value. */
  version: string;
  /** ISO date the build shipped, e.g. '2026-05-29'. Rendered with `toLocaleDateString`. */
  date: string;
  /** One-line summary shown next to the version pill. */
  headline: string;
  /** Optional 2-3 sentence intro paragraph above the bullets. */
  summary?: string;
  /**
   * Sections, rendered in declaration order. Group features first,
   * then improvements/fixes, then shipped/known. Empty `items` arrays
   * are filtered out by the renderer.
   */
  sections: ReleaseSection[];
}

const RELEASE_0_1_21: Release = {
    version: '0.1.22',
    date: '2026-06-07',
    headline: 'Real AI routing, hosted music, and a stronger Jarvis terminal',
    summary:
      'Jarvis now uses your selected provider and model, understands file paths typed into chat, and ships a hosted five-track ambient playlist foundation. The terminal launcher is also becoming a proper coding command center.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Use /model to open a real provider and model picker, with the selection persisted for future chats.',
          'Windows file paths typed into chat are automatically attached as request context.',
          'Ambient music now supports five hosted tracks played sequentially on repeat.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Built-in Jarvis agents follow the provider and model you selected.',
          'The Jarvis terminal command now exposes focused app, code, Ultra, Claude, and Codex launch modes.',
          'Reminder channels and completion notifications behave consistently across desktop and in-app surfaces.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Provider failures remain visible instead of being replaced by unrelated mock responses.',
          'Mock mode clearly identifies itself and no longer pretends it analyzed unavailable files.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Published the updater-signed Jarvis One 0.1.22 Windows release and verified a silent local upgrade.',
        ],
      },
    ],
  };

/**
 * Per-section heading + icon. The renderer reads this so we keep
 * presentation in lock-step with the cozy palette tokens.
 *
 * Hue assignments map to the existing CSS vars (--terracotta /
 * --honey / --sage / --lavender / --rose) via Tailwind's
 * `text-accent-*` utilities so dark/light themes both look correct.
 */
export const SECTION_META: Record<
  ReleaseSectionKind,
  { label: string; icon: LucideIcon; toneClass: string }
> = {
  feature: {
    label: 'New',
    icon: Sparkles,
    // Terracotta — same hue as the primary accent.
    toneClass: 'text-accent-copper',
  },
  improvement: {
    label: 'Improved',
    icon: Rocket,
    // Honey — secondary brand accent.
    toneClass: 'text-accent-amber',
  },
  fix: {
    label: 'Fixed',
    icon: Wrench,
    // Sage — calm green that still reads on warm wood.
    toneClass: 'text-[hsl(var(--sage))]',
  },
  shipped: {
    label: 'Shipped',
    icon: Package,
    // Lavender — neutral on the warm palette.
    toneClass: 'text-[hsl(var(--lavender))]',
  },
  known: {
    label: 'Known issues',
    icon: AlertTriangle,
    // Subdued so it doesn't scream — ink-faint inherits the right tone in both themes.
    toneClass: 'text-[hsl(var(--ink-faint))]',
  },
};

/**
 * The release log. Newest first. Each entry should be self-contained
 * — readers might be jumping back several versions after a long gap.
 *
 * Wording rules of thumb:
 *   - Past tense, third person ("Added X", "Fixed Y").
 *   - One concrete user-visible thing per bullet.
 *   - No marketing language. No emoji unless the user asks.
 *   - Mention where to find it ("on the Terminals page", "Mod+J", etc.)
 *     when it isn't obvious.
 */
export const RELEASES: readonly Release[] = [
  RELEASE_0_1_21,
  {
    version: '0.1.20',
    date: '2026-06-06',
    headline: 'Secure Plugins catalog and terminal capability context',
    summary:
      'Jarvis now has a searchable Plugins section with secure OS-keychain credentials, connection testing, metadata-only cloud sync, and controlled plugin capability context for project agents. The catalog includes 353 services while clearly separating working connectors from planned entries.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added Settings -> Plugins with search, filters, connection status, setup instructions, masked credential fields, reconnect, disconnect, and terminal-access controls.',
          'Added live connection tests for GitHub, Figma, Supabase, Shopify, and Slack plus a deterministic local mock connector.',
          'Added a validated 353-entry catalog spanning developer tools, cloud, databases, productivity, communication, ecommerce, payments, analytics, design, AI, CMS, and infrastructure.',
          'Connected and enabled plugins now contribute bounded capability descriptors and approval-gated plugin.call actions to project agents without exposing credentials.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Plugin credentials use the existing Tauri OS-keychain bridge; localStorage and Supabase persist only non-secret connection metadata.',
          'Plugin connection metadata participates in private account sync and the Supabase migration rejects credential-shaped plugin payloads.',
          'Native HTTP scopes now cover the implemented connector API hosts.',
        ],
      },
      {
        kind: 'known',
        items: [
          'Catalog entries marked Planned are discoverable but cannot connect until a tested connector is implemented.',
          'Real service validation requires user-provided credentials; automated tests use mocks and the local connector.',
        ],
      },
    ],
  },
  {
    version: '0.1.19',
    date: '2026-06-06',
    headline: 'Critical hotfix: fixed maximum update depth React crash on app boot',
    summary:
      'This hotfix resolves a React Error #185 (maximum update depth exceeded) that could crash the app during initial load or route changes. The root cause was TerminalsPage being unconditionally mounted behind CSS display:none in PageRouter, triggering synchronous useLayoutEffect re-render cascades inside the Suspense boundary.',
    sections: [
      {
        kind: 'fix',
        items: [
          'Fixed React Error #185 crash by conditionally mounting TerminalsPage only when the terminal route is active, instead of hiding it with CSS.',
          'Stabilized Inspector setInspectorOpen callback with useCallback to prevent unnecessary effect churn.',
        ],
      },
    ],
  },
  {
    version: '0.1.18',
    date: '2026-06-05',
    headline: 'Safer persistence, cloud-sync tool queues, voice summon stabilization, and terminal PTY reattachment',
    summary:
      'This release prevents localStorage quota failures from taking down the React UI, connects custom tool changes to Supabase sync queues, reattaches active terminal PTYs on app reload, and suppresses context menus on terminal drag operations.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added a preloaded Clock tool to support timestamped scheduling.',
          'Added cloud sync queue integration for custom tool changes.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Configured a decoupled safeLocalStorage layer that handles quota full writes without crashing the React UI.',
          'Implemented loop-free terminal transcript pruning (clamped to 10 sessions, max 512 KB total, and 32 KB per session) to protect localStorage space.',
          'Upgraded the voice summon modal and summon UI to stay open and display continuous transcription.',
          'Expanded the ambient music catalog with additional high-fidelity audio tracks.',
          'Route mentioned agents (Scout, Builder, Reviewer) directly to their respective system prompts.',
          'Windows release packaging now fails fast when the updater private key is missing.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Fixed context menu popups by suppressing custom menus during terminal right-click drags and across the context map canvas.',
          'Fixed terminal session persistence by reattaching live terminal sessions and stabilizing the reopen lifecycle after app reload.',
          'Stabilized voice dictation recording, playback replies, and general voice terminal security.',
          'Fixed native HTTP localhost scopes and secured legacy API key migrations.',
          'Fixed update-warning dialog close handling and ambient toggle state to avoid React maximum-update-depth crashes.',
        ],
      },
    ],
  },
  {
    version: '0.1.17',
    date: '2026-06-03',
    headline: 'Stateful terminal erase hold, inline renaming, custom default font size, and UI freeze fixes',
    summary:
      'This release introduces substantial terminal polish: an eraser button that requires a pointer-hold to confirm, inline double-click tab renaming, a global default font size slider in Settings, and critical Rust-side thread safety optimizations to resolve random application freezes.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added a hold-to-confirm Eraser button in the terminal toolbar with visual progress fill and a 3.5s auto-reset timeout.',
          'Added a global default terminal font size range slider under Settings -> Appearance (supporting 1px to 72px sizes).',
          'Implemented inline terminal tab renaming (double-click to edit) with a cozy styled input field that saves on Enter/Blur and cancels on Escape.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Expanded the individual terminal "T" font size cycling icon to range from 10px to 20px without layout scale clamps.',
          'Increased font size validation constraints to range from 1 to 100.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Resolved random app freezing deadlocks by offloading Rust-side PTY write, flush, and resize operations onto a separate spawn_blocking thread pool.',
        ],
      },
    ],
  },
  {
    version: '0.1.16',
    date: '2026-06-03',
    headline: 'System tray background run, update warning consolidation, and terminal project mapping',
    summary:
      'This release adds tray background capabilities, solves update warning loops, and fixes alternate buffer / clear screens on terminal initialization.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added system tray background run support so closing the app hides it to the tray, keeping background processes active.',
          'Added single-instance check to focus the running Jarvis service on relaunch.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Fixed infinite update loops in UpdateWarningHost by merging Dialog component definitions.',
          'Fixed terminal initialization blanking out by filtering alternate buffer codes and extending the bypass window to 3 seconds.',
          'Fixed terminal navigation lag by keeping TerminalsPage permanently mounted in the background.',
          'Fixed terminal transcript project cross-talk by enforcing strict project namespaces across sessions, move commands, and repaired layouts.',
        ],
      },
    ],
  },
  {
    version: '0.1.15',
    date: '2026-06-02',
    headline: 'Terminal persistence, account controls, Jarvis Call gating, and safer updates',
    summary:
      'This update focuses on production polish: terminals preserve more state without rerunning commands, Context files behave like real project files, account and plan controls are visible, and silent updates warn before installing.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added a full Account page from the top-left J avatar with plan, billing, saved-key, usage, and Jarvis Call status.',
          'Added admin-aware entitlements so configured admin builds receive Ultra access and Jarvis Call automatically.',
          'Added live `/usage` summaries for OpenAI and OpenRouter keys plus local monthly message/token totals for every provider.',
          'Added a Hey Jarvis wake-word listener, visible wake bubble, and Shift+Tab shortcut for fast Jarvis summon.',
          'Added multi-step workflow tools and an AI-callable action so Jarvis can create reusable complex tools.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Terminal panes now stay mounted through fullscreen changes and avoid rerunning startup commands on same-project moves or reattachment.',
          'Dropped file and Context paths paste as paths in chat and terminals instead of executing terminal wrappers.',
          'Auto-updates now surface 1-hour, 30-minute, and 5-minute warnings with Update Later and snooze options.',
          'The Plans page now centers plan icons and adapts the page background to the active purchased tier.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Removed terminal system-prompt/context printing and false terminal-complete notifications during reload or hydration.',
          'Centralized duplicate global hotkey handlers so keyboard toggles no longer fire twice.',
          'Reduced terminal transcript write pressure with debounced persistence and hidden native terminal scrollbars.',
          'Jarvis Call is now blocked for non-entitled users from every top-bar entry point, while active calls can always hang up.',
          'Ambient audio now retries playback after browser audio-policy gestures instead of silently staying muted.',
        ],
      },
      {
        kind: 'known',
        items: [
          'OpenAI organization usage and OpenRouter key usage are live when the linked key has access; other provider-hosted usage APIs still fall back to local totals.',
          'OS-level SmartScreen reputation still requires a trusted code-signing certificate and distribution reputation outside the app code.',
        ],
      },
    ],
  },
  {
    version: '0.1.14',
    date: '2026-06-02',
    headline: 'Context maps, file routing, notifications, and terminal stability',
    summary:
      'This update expands project Context into multiple active maps, makes file routing more predictable, adds done-notification controls, and stabilizes terminal project switching.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Context now supports multiple maps per project, with Active and Deleted labels and a five-active-map limit.',
          'Settings now include done-notification controls for Jarvis, terminals, tasks, Context maps, and skills.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Context maps are more spread out, easier to scan, and use plain-English fallback summaries for file nodes.',
          'File drags into chat and terminals now attach or paste the file path instead of dumping file contents into terminals.',
          'AI system prompts can include a user-controlled completion cue that asks agents to say clearly when work is done.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'The Context sidebar label now opens the Context page while the chevron only expands or collapses maps.',
          'Selecting files from Context or terminal connected files now opens the right page with the file preselected.',
          'Project switching on the Terminals page now avoids stale tree caching, pane morphing, and blank old-project xterm views.',
        ],
      },
    ],
  },
  {
    version: '0.1.13',
    date: '2026-06-02',
    headline: 'Terminal drag polish, sidebar Jarvis, and global dictation',
    summary:
      'This update tightens the Terminals workspace and the right-side Jarvis panel: terminal drops now swap predictably, sidebar chat stays project-scoped, and speech-to-text uses Ctrl+Caps Lock with an idle timeout.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added Ctrl+Caps Lock speech-to-text routing for focused chat composers and terminal panes.',
          'Added self-made Jarvis commands in the Assistant bar, including creating custom terminal commands and running multi-step “then” plans.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Terminal pane drops in the same project now swap positions instead of shifting the grid like a puzzle.',
          'Terminal dragging now hides the source tile, keeps a clear white drop outline, and supports Escape cancellation.',
          'The right-side Jarvis chat now uses compact rendering and stays attached to the active project without navigating the main canvas.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Speech-to-text now stops after 30 seconds without voice activity, including the Groq recorder path.',
          'Terminal xterm hosts now fill the available pane width without leaving the stray left sliver.',
          'Terminal and Context drops are scoped to the chat surface that received the drop, so sidebar and main chat composers do not both consume the same attachment.',
        ],
      },
    ],
  },
  {
    version: '0.1.12',
    date: '2026-06-02',
    headline: 'Interactive cozy Context Map and provider-picked generation',
    summary:
      'Context now opens as a polished map-first workspace: circular nodes connected by strings, left-click inspection, right-click panning, wheel zoom, and a Center Map button if you get lost. Map generation can use the saved provider keys already configured in Jarvis, then drag any selected Context into chat or terminals.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added an interactive Context Map with circular nodes, string links, right-click panning, wheel zoom, and click targets on both nodes and strings.',
          'Added a Create Map flow with a saved-key provider picker for Google, Groq, OpenAI, and Anthropic, plus local fallback.',
          'Context nodes now show size, created date, modified date, model metadata, summaries, tags, and linked children.',
          'Added Jarvis commands for creating/generating the Context Map and recentering it.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Context remains draggable into chat and terminals from the selected Context panel and node list.',
          'A white creation flash now transitions completed generation into the map canvas.',
          'The map includes a Center Map button so large project maps are recoverable after panning around.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Sidebar Context branches and project file folders now expand only from their dropdown arrow instead of from the label click.',
        ],
      },
    ],
  },
  {
    version: '0.1.11',
    date: '2026-06-02',
    headline: 'Project Context skill trees, sidebar files, and Context drag/drop',
    summary:
      'This update replaces the old Skills route with project-scoped Context: generate a structured project skill tree, browse files from the sidebar, drag Context into chat or terminals, and let every AI prompt start with the project map.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Added a Context workspace with a Make Skill Tree flow that scans project files and uses Gemini when a Google API key is configured.',
          'Generated Context trees are stored per project and injected into every AI request as a compact navigation map.',
          'Context nodes can be dragged into chat or terminals, attaching request-specific context with a copper power-up effect.',
          'The left sidebar now shows Context instead of Skills and includes a recursive project file browser with draggable files.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Files and Context path inputs now offer native folder/file pickers in the desktop app while keeping typed paths as fallback.',
          'The Files button still opens the full Files page/editor/Jarvis ask flow, while the sidebar tree stays lightweight.',
          'Natural-language commands, slash commands, route tools, action registry, breadcrumbs, and onboarding now route to Context.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Terminal Context drops paste shell-commented context blocks so they do not accidentally execute as commands.',
        ],
      },
    ],
  },
  {
    version: '0.1.10',
    date: '2026-06-02',
    headline: 'Right-click terminal dragging, project moves, and better scheduled terminal messages',
    summary:
      'This update makes terminals feel movable across the workspace: right-drag a terminal into chat for context, onto another terminal position to reorder the puzzle, or onto a project to move the live PTY there. Scheduled terminal messages now understand word numbers like “five hours.”',
    sections: [
      {
        kind: 'feature',
        items: [
          'Right-click dragging now works from anywhere on a terminal tile, with a lightweight floating preview and copper drop highlighting.',
          'Dropping a terminal into Jarvis chat attaches its stable terminal reference so Jarvis receives the latest transcript context.',
          'Dropping a terminal onto a project moves the live terminal into that project and opens the project terminal workspace.',
          'Attached-terminal scheduling understands word numbers, including prompts like “message this terminal in five hours.”',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Terminal pane drops now insert/reorder panes so occupied spots shift out of the way instead of only swapping positions.',
          'Cross-project terminal moves preserve the child process and update backend project metadata without respawning the PTY.',
          'Project terminal move helpers stay lazy-loaded from navigation to avoid adding terminal code to cold start.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Fixed duplicate drop handling between chat/composer and terminal/project drop targets.',
        ],
      },
    ],
  },
  {
    version: '0.1.9',
    date: '2026-06-01',
    headline: 'Reliable Groq dictation, stable terminal references, and durable terminal scheduling',
    summary:
      'This patch fixes the broken Groq speech-to-text upload path and makes terminal references production-safe by using stable pane references instead of only volatile PTY session ids. Scheduled terminal messages now persist and re-arm after Jarvis restarts.',
    sections: [
      {
        kind: 'fix',
        items: [
          'Groq STT now records and uploads a real WAV file to Whisper instead of relying on fragile WebM blobs that Groq can reject as invalid media.',
          'Terminal references dragged into chat now carry stable pane metadata and resolve transcripts by pane or session so Jarvis actually receives terminal context.',
          'The installer and About panel now reflect the current Jarvis One update details more accurately.',
        ],
      },
      {
        kind: 'feature',
        items: [
          'Attached-terminal requests like “send this terminal hello in 5 hours” create durable scheduled terminal messages that survive app restarts.',
          'Scheduled terminal messages route back to the original pane when it is still present, or open a safe replacement pane when the original terminal had to be respawned.',
        ],
      },
      {
        kind: 'known',
        items: [
          'Live OS terminal processes still cannot survive a full Jarvis process exit without a separate background terminal daemon; Jarvis restores layout, transcript, and respawns safely in this build.',
        ],
      },
    ],
  },
  {
    version: '0.1.8',
    date: '2026-06-01',
    headline: 'Workspace restore, better dictation, recursive files, terminal references, and more commands',
    summary:
      'Jarvis One now restores the active chat, route, project files, terminal layouts, and terminal transcripts after closing or updating. Dictation can use Groq Whisper for faster, more accurate transcription, Files now shows an expandable project tree, and terminal panes can be dragged into chat as context.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Workspace restore persists active route, active chat, active project, file roots, open files, terminal pane trees, and terminal transcripts across closes and updates.',
          'Groq Whisper speech-to-text path uses `whisper-large-v3-turbo` when a Groq key is configured, with Web Speech retained as fallback.',
          'Files is now project-scoped and recursive: open a project folder once, expand subfolders, and drag any file into chat or terminals.',
          'Send to Jarvis from Files now creates or reuses a chat before preparing the selected code question.',
          'Terminal panes can be dragged into chat as references so Jarvis can inspect their latest transcript.',
          'Added a 50-command Jarvis command catalog plus `/commands` in chat.',
          'Added deterministic assistant commands for `ask opencode/claude/codex/... to ...` and `give all terminals all context`.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Attached terminal and file context is request-scoped, so existing project context and connected terminal files continue working without prompt bloat on unrelated turns.',
          'Files roots and open files are keyed per project, not globally, so switching projects restores the correct file tree.',
        ],
      },
    ],
  },
  {
    version: '0.1.7',
    date: '2026-06-01',
    headline: 'Files workspace, chat attachments, terminal drops, and slash commands',
    summary:
      'Jarvis One now has a first-class Files route for browsing and editing project files without leaving the app. Files can be dragged into chat or directly onto a terminal pane, and attached files are included in the model prompt alongside the project context and Jarvis system prompt.',
    sections: [
      {
        kind: 'feature',
        items: [
          'New lazy-loaded Files page. Open an absolute project folder, browse folders, create text files, edit compatible text/code files, and save changes through small Tauri file commands with 1 MB safety caps.',
          'Drag a file from Files onto a terminal pane to paste that file into the exact PTY under the cursor. The pane lights up with a copper drop target while dragging.',
          'Drag a file into chat or use /attach to send file context with a message. Attached files are read at send time and inserted into the AI request with the active project context.',
          'Files editor has an Ask Jarvis flow for selected code. Highlight code, type a question or edit request, and Jarvis drafts the chat with the selected snippet and file attachment.',
          'Chat slash commands added: /usage, /model, /files, /terminals, /kanban, /skills, /history, /tools, /agents, /schedule, /attach, /clearfiles, and /help.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Files is a lazy route so the editor and file-browser code do not enter the cold-start bundle.',
          'Existing per-terminal connected files and project system context remain intact; explicit chat attachments are added as a separate request-scoped context block.',
        ],
      },
    ],
  },
  {
    version: '0.1.6',
    date: '2026-06-01',
    headline: 'Fully automatic silent updates, renamed to Jarvis One, and per-project terminal limit',
    summary:
      'Welcome to Jarvis One! This update introduces a fully automatic and silent background updater that runs without UAC elevation warnings or manual confirmation prompts, along with terminal limits that are now scoped to 10 sessions per project rather than globally.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Scoped PTY terminal sessions to projects. You can now run up to 10 terminals per project. Switching projects swaps the entire grid context out and lets you maintain separate terminal lists.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Official brand name upgrade: the application has been renamed to Jarvis One.',
          'Fully automatic silent background updater. The updater now runs completely silently in the background with zero user interaction.',
          'Windows UAC admin prompt bypass. The installer has been configured to run in per-user space under Local AppData, allowing background updates to install without UAC warnings.',
        ],
      },
    ],
  },
  {
    version: '0.1.5',
    date: '2026-05-31',
    headline: 'Manual terminal resize, compact chrome, faster cold start',
    summary:
      'Terminals are now drag-resizable: every boundary between tiles has a thin handle you can grab to redistribute the space, and double-clicking resets that boundary to even. The top bar collapses to 28px on the Terminals page (and in chat fullscreen) so terminals get back about 80px of vertical room, and the old hero header on the Terminals page is gone — its title now lives as a small label in the same toolbar as the Add pane / Reset / Open swarm buttons. Cold-start is also noticeably leaner: LiveKit, Supabase, and settings sections used to sit on the initial-load graph for everyone; now they only download when you actually open them.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Manual resize handles between every terminal tile in Tiles mode. Drag a handle to redistribute the columns or rows; double-click resets that boundary to even. Sizes are remembered per layout shape (2x2, 3x2, etc.) across reloads, so a 4-tile grid keeps your column ratios when you toggle back to it.',
          'Compact top bar on the Terminals page (and whenever chat is in fullscreen). The bar shrinks from 40px to 28px and the low-frequency buttons (launcher, assistant, schedule, search, voice, call, what\'s-new) tuck into a `...` overflow menu so the right cluster stays just fullscreen / more / settings / avatar.',
          'Side rail stays visible in fullscreen mode (Mod+Shift+F). Previously the left navigation hid along with the to-do drawer; now only the drawer collapses, so route switching is always one click away. Use Mod+B to also hide the rail manually for true distraction-free.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Terminals page header collapsed into a single 32px toolbar. The big "Terminals" hero title with eyebrow text is gone — the page now opens straight into the grid, with the page label, pane count, and mode toggle all sharing one row with Add pane / Reset / Open swarm.',
          'Cold start payload dropped about 227 kB gzipped. LiveKit (132 kB), Supabase (54 kB), and the settings sections chunk (41 kB) were sitting on the initial preload list for every load — they\'re lazy now and only download when you open Call, sign-in, or Settings. Boot module preloads went from 13 chunks to 10.',
          'Tile inner padding tightened from p-3 to p-2, and the tile chrome strip from h-9 to h-7, so the actual terminal viewport is wider and taller in every grid layout.',
          'Smarter Cargo release profile: thin LTO with 4 codegen units instead of full LTO with 1 unit. Builds get a few percent larger but link in roughly a third the peak memory, which keeps Tauri from OOM-ing during release optimisation on machines that aren\'t huge.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Settings → Phone & Voice no longer drags LiveKit and Supabase onto the boot graph. The static `getCallService` import in TopBar, outbound triggers, and the bridge lifecycle hook all switched to env-only checks plus dynamic imports.',
          'Auth barrel no longer re-exports `SignInDialog` (which transitively static-imports the Supabase SDK). Settings → Account still uses the dialog by direct path inside the lazy settings chunk.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Bumped to 0.1.5 (package.json, Cargo.toml, tauri.conf.json, releases.ts).',
          'Drop counterproductive `settings-sections` manualChunks rule in `vite.config.ts`. Rollup was relocating shared symbols into the named chunk and forcing the boot chunk to back-import it — which was preloading PhoneVoice\'s LiveKit + Supabase deps for everyone.',
          'New: persisted resize state lives under `localStorage["jarvis-tile-grid-sizes-v1"]`, keyed by layout shape.',
        ],
      },
      {
        kind: 'known',
        items: [
          'On Windows machines with strict Application Control / Smart App Control policies, the Tauri MSI/EXE rebuild may be blocked the first time it runs after a clean target directory (the freshly compiled `build-script-build.exe` is unsigned). Add the cargo target dir to your security software exclusions, or run the build with the policy temporarily relaxed.',
          'Resize handles only appear in Tiles mode. Splits mode keeps its existing draggable separators with no behaviour change.',
        ],
      },
    ],
  },
  {
    version: '0.1.4',
    date: '2026-05-30',
    headline: 'Connect a model to start, optional offline local models, leaner top bar',
    summary:
      'Jarvis now asks you to connect a model before the workspace opens — the free path is a Google Gemini key (no card), or you can run fully offline with a local model. Local Models is a real feature now: connect a local Ollama daemon, pick or download a model, and flip an Offline toggle that keeps every message on your machine. The top bar also lost its duplicate route buttons so navigation lives in one place.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Model-access gate: after onboarding, Jarvis requires a connected model before opening the app. Paste a free Google Gemini key (a "Get a free key" link takes you to AI Studio, no card needed) or choose "Run fully offline instead". The gate clears the instant a key is saved or offline mode is on.',
          'Local Models (Settings -> Local Models): connect a local Ollama daemon over its OpenAI-compatible API — no API key, no internet. Live connection status, a default-model picker populated from your installed models, a manual override, and a download list (Llama 3.2 3B/1B, Qwen 2.5 3B, Phi 3.5, Gemma 2 2B) with one-click "Copy pull" commands.',
          'Offline mode toggle: forces every chat through your local model and ignores all cloud providers. Nothing leaves the machine — great on a plane or for private work.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Top bar no longer duplicates the Terminals / Kanban / Benchmarks buttons that already live in the side panel. Route navigation now has one home (the sidebar), with the breadcrumb popover as the switcher when the sidebar is collapsed.',
          'Default provider is now Google (Gemini 2.5 Flash Lite) instead of the mock provider, matching the seeded Jarvis agent so a connected key works immediately.',
          'Onboarding no longer promises the mock provider keeps you running — it points you at the free Gemini key or the offline path you\'ll be asked to pick.',
          'Built-in agent files renamed to the AgentsScout / AgentsBuilder / AgentsReviewer.md convention.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Bumped to 0.1.4 (package.json, Cargo.toml, tauri.conf.json, releases.ts).',
          'New modules: `lib/ai/providers/ollama.ts` (real local adapter), `features/auth/RequireModelAccess.tsx` (the gate), `features/settings/sections/LocalModels.tsx`.',
          'Router honours offline mode and routes `ollama` / `local` agents to the real adapter; `offlineMode` + `defaultLocalModel` persist in the auth store.',
        ],
      },
      {
        kind: 'known',
        items: [
          'In a packaged build, Ollama may reject the app origin until you set `OLLAMA_ORIGINS=*`; the Local Models section explains this. A CORS-free Rust-side fetch is a planned follow-up.',
          'No local runtime is bundled — you install Ollama yourself, which keeps the installer tiny.',
          'Provider "Test" buttons are still mocked; real key validation is a follow-up.',
        ],
      },
    ],
  },
  {
    version: '0.1.3',
    date: '2026-05-31',
    headline: 'AI-proposed actions, custom tools, eye breaks, four plans',
    summary:
      'Jarvis can now propose any of 24 built-in actions inline in chat — open the Terminals swarm, run Claude Code in a new pane, start a 20-20-20 eye break, jump to a settings tab — and you Approve / Cancel with one click before anything runs. A new Tools page lets you wrap those actions with friendly names and preset params, Mod+Shift+A opens an actions palette for direct invocation, and the Plans tab now shows the full ladder: Free, Starter $5, Pro $20, Ultra $100 (Stripe ships next).',
    sections: [
      {
        kind: 'feature',
        items: [
          'Action system: Jarvis can propose any of 24 built-in actions via fenced ```action blocks. Each proposal renders as an inline Approve / Cancel card in the assistant bubble; nothing runs until you click Approve, status flows pending -> running -> success / error / cancelled, and the AI sees the result on its next turn.',
          'Built-in actions cover navigation (open Tools / Terminals / Kanban / ...), settings tabs, theme toggle, voice modal, terminal commands (Claude Code, OpenCode, custom shell), terminal swarm preset, chat operations (new chat, branch), wellness break, and host shell (open URL).',
          'Custom Tools page (sidebar -> Tools, or natural-language "open tools"). Wrap any built-in action with a friendly name, emoji, description, and preset params. Saved tools show up in the actions palette and in the AI catalogue so Jarvis can propose them too. Quick-start templates included.',
          'Actions palette (Mod+Shift+A). Direct invocation of every registered action plus your custom tools. Substring search, grouped by category, recent actions pinned at top, inline parameter form when an action needs values.',
          'Wellness break overlay: full-screen 20-20-20 eye break with breathing orb and serene countdown. Triggered by Jarvis proposing `wellness.eyeBreak`, by clicking it in the actions palette, or by saving it as a quick-start tool. Esc skips.',
          'Plans tab redesigned as a four-card ladder. Free is "Current"; Starter $5/mo (voice + Jarvis Call), Pro $20/mo (premium models), and Ultra $100/mo (frontier models) are "Available soon" until Stripe ships.',
          'Terminal command queue. When the AI proposes a terminal action and you Approve, the new pane appears reliably even when you weren\'t already on the Terminals route — the page drains the queue on mount.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Default model swapped to Gemini 2.5 Flash Lite — the truly free Google quota — so a fresh Free-tier user never accidentally hits the paid Gemini Flash budget.',
          'Action catalogue is added to the Jarvis system prompt only (not to Builder / Scout / Reviewer), so sub-agent prompts stay lean.',
          'Approval cards style status with the cozy palette: copper for pending, amber spinner for running, sage for success, terracotta for error, muted for cancelled.',
          'Custom tools persist locally under `jarvis-tools` browser storage and queue private Jarvis Cloud account sync when signed in. Export / Import remains available for manual backups.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Terminals "Open swarm" no longer races the lazy chunk on cold-load. The 4-pane preset now reliably appears whether you triggered it from the page header, an AI proposal, or the actions palette.',
          'Council agents no longer crash when an `action_proposal` part lands in their stream — they render a compact read-only badge instead.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Bumped to 0.1.3 (package.json, Cargo.toml, tauri.conf.json, releases.ts).',
          'New modules: `lib/actions/*` (registry / runner / parse / prompt addendum), `lib/entitlements.ts`, `features/tools/*`, `features/actions/*`, `features/wellness/*`.',
          'Hotkey table: `Mod+Shift+A` reserved for the actions palette.',
          'Settings -> Hotkeys, NavPane, TopBar, mcp/builtins, assistant parser all updated to recognise the new `tools` route.',
        ],
      },
      {
        kind: 'known',
        items: [
          'Stripe billing is not yet connected, so Starter / Pro / Ultra cards say "Available soon". The entitlements module (`lib/entitlements.ts`) is the source of truth for what each tier unlocks; it just isn\'t enforced until the webhook lands.',
          'Public tool publishing is still separate from private account sync. `useToolStore.publish()` queues the private tool record for Jarvis Cloud sync.',
          'Approving an action that lacks a built-in registration (typo from the AI, or a custom tool deleted between proposal and approval) shows an error inline instead of guessing.',
        ],
      },
    ],
  },
  {
    version: '0.1.2',
    date: '2026-05-30',
    headline: 'Free Llama 3.3 for Jarvis + tighter terminals',
    summary:
      'A real Groq adapter ships in this build, so Jarvis runs on Llama 3.3 70B for free with a 30-second console.groq.com signup. Terminals got a per-pane toolbar (font size, clear, fullscreen) and a fix for the cell-width mismatch that produced "mushed words" at 2x2 and below. A new Plans tab in Settings explains the free vs $5 ladder honestly: free is fully working today, $5 is "available soon".',
    sections: [
      {
        kind: 'feature',
        items: [
          'Groq provider is real. Paste a free `gsk_...` key into Settings -> Providers and the seeded Jarvis agent runs on Llama 3.3 70B at sub-second TTFT, no card required.',
          'Per-pane toolbar on every terminal: cycle font size (12/13/14/16), clear screen (^L), fullscreen this pane, close. Works in both Tiles and Splits modes.',
          'Per-pane fullscreen with Esc-to-exit. Click the maximise icon on a tile, the page renders just that pane in 1x1; the others keep their PTYs alive backend-side and re-attach when you exit.',
          'New Plans tab in Settings (Sparkles icon, between Account and Providers). Two cards: Free (BYOK + free Groq, current) and Pro $5/mo (Jarvis-hosted, available soon).',
          'Composer banner: when the Jarvis agent has no Groq key yet, a one-line nudge appears above the message input with "Get key" + "Open Providers" shortcuts.',
          'Settings -> Providers now shows a "Get a free key (no card)" link next to Groq pointing at console.groq.com/keys.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Terminal pane cap dropped from 16 to 6. At 1280-wide, 7+ panes pushed individual terminals below ~40 cols and shells started wrapping; 6 keeps every pane legible.',
          'Benchmarks page auto-refreshes when you alt-tab back to Jarvis, plus a 24h background poll. Manual refresh still works as before.',
          'Per-pane font size is persisted on the leaf, so it survives Tiles <-> Splits mode flips and reloads.',
          'Router prefers Groq first when promoting a mock-default agent (was: Anthropic -> OpenAI -> Google). Free path leads.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Terminal "mushed words" / overlapping glyphs at 2x2 tiles and below. Root cause: xterm measured cell width before JetBrains Mono finished loading, baking in fallback monospace metrics. Fix waits for `document.fonts.ready` before `term.open()`, busts the metric cache, and adds a late re-fit when fonts settle later.',
          'ResizeObserver now coalesces multiple fires per animation frame into one fit() + `terminal_resize` IPC. Dragging a split or reflowing the grid no longer hammers the backend with dozens of resize calls per second.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Bumped build to 0.1.2 (package.json, Cargo.toml, tauri.conf.json, releases.ts).',
          'Real `providers/groq.ts` adapter wired through `lib/ai/router.ts` + `COST_RATES` (groq:* listed at 0/0 for the free tier).',
        ],
      },
      {
        kind: 'known',
        items: [
          'Pro $5/mo tier is "Available soon" only. The Supabase + Stripe plumbing exists in `features/billing/HostedJarvis.tsx` but isn\u2019t connected to a live backend yet, so the upgrade button is intentionally disabled.',
          'Phone calling still requires the Fly.io deploy + Groq/Cartesia/LiveKit/Twilio keys + `VITE_PHONE_JARVIS_CLOUD_URL` from 0.1.1. No call connects until that\u2019s wired.',
          'Live agent orchestration (pane output streaming into the matching agent\u2019s chat) still hasn\u2019t landed; agent tags remain labels + default commands today.',
        ],
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-05-29',
    headline: 'Terminal swarm + update log',
    summary:
      'A new tile-grid layout matches the OpenCode 2x2 feel, every pane can be tagged with an agent role, and a one-click "Open swarm" preset drops in Builder, Scout, Reviewer, and Jarvis as a 4-tile workspace. This is also the first release that ships its own update log.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Terminals page now has a Tiles layout (default) that auto-arranges 1-16 panes into equal rectangles. The legacy Splits mode is still available via the toggle.',
          'Each pane chrome strip has an Agent picker. Tagging a pane with Builder / Scout / Reviewer / Coder pre-fills a sensible CLI (claude, opencode, etc.) on the first launch.',
          'New "Open swarm" button drops in a 2x2 with Builder, Scout, Reviewer, and Jarvis pre-assigned in one click.',
          'In-app update log: a "What\u2019s new" modal opens on the first launch after every version bump, and stays available from the top bar.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Tile mode reflows the grid as you add panes (1x1 -> 2x1 -> 2x2 -> 3x2 -> 3x3 -> 4x4). No more squished single-row strip when you open four terminals.',
          'Switching between Tiles and Splits keeps your existing PTY sessions and agent tags intact.',
          'Pane chrome was unified across Tiles and Splits so the agent pill, command label, and close button line up the same way in both modes.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Bumped build to 0.1.1. Fresh MSI + NSIS installers regenerated.',
          'Build pipeline still: `tsc --noEmit` -> `vite build` -> `tauri build`. ~3.5 minutes end-to-end on this machine.',
        ],
      },
      {
        kind: 'known',
        items: [
          'Phone calling is shipped in code (commit c5e11fa) but not wired end-to-end yet \u2014 needs a Fly.io deploy + Groq/Cartesia/LiveKit/Twilio keys + VITE_PHONE_JARVIS_CLOUD_URL. No call will connect until that\u2019s done.',
          'The agent tag on a pane is a label + default command today. Live orchestration (pane output streamed into the matching agent\u2019s chat) hasn\u2019t been wired yet.',
        ],
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-05-29',
    headline: 'V3 BridgeMind-class platform',
    summary:
      'First public-facing 0.1 build. Real terminals, multi-page workspace, skills, kanban, benchmarks, +7 providers, and the warm Cozy Checklist theme.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Real PTY terminals (up to 16 splittable panes) on the Terminals page.',
          'Pages router: Terminal, Kanban, Skills, Agents, Benchmarks, History.',
          'Skills system: drop .md files into ~/.jarvis/skills/ and they show up in the library.',
          'Kanban board with drag-across columns (Todo / In progress / Done).',
          'Live benchmarks page with public Chatbot Arena scores.',
          'Session history with replay scrubber.',
          'Jarvis Assistant (Mod+J): local NL command bar, deterministic regex parser, no remote AI calls.',
          'Phone-Jarvis scaffolding: real PSTN (Path A) + in-app voice (Path C), with LiveKit Cloud + Pipecat backbone.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Cozy Checklist theme: warm wood / cream paper, terracotta + honey + sage palette, Fraunces serif headings.',
          'Branding icons + Windows installer (.msi/.exe).',
          'Ambient idle home with breathing orb + clock.',
          'Schedule + Quick launcher modals with hotkeys.',
          'Speech-to-text in the chat composer (toggleable).',
          'Fullscreen workspace toggle.',
          'Expanded provider roster (+7 providers) routed through a single AI router.',
        ],
      },
      {
        kind: 'shipped',
        items: [
          'Tauri 2 desktop shell (Cargo + lib.rs + capabilities + JS bridge with browser fallback).',
          'AuthGate + 5-step onboarding + 6-tab settings modal.',
          'Supabase scaffolding for cloud sync (opt-in).',
        ],
      },
    ],
  },
];

/**
 * Convenience accessor used by the modal renderer.
 * Always returns a non-null release because RELEASES is non-empty.
 */
export function getLatestRelease(): Release {
  // Non-null asserted because the array is statically populated above.
  return RELEASES[0]!;
}
