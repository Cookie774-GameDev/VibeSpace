# Plan D — Quick Launch & Media Control Bridge

**Owner:** Planner D
**Scope:** A) Quick Launch (link tabs) and B) Media Control Bridge (in-app YouTube + auto-skip-ad)
**Status:** V2 design — ready for B1 (Tauri/CSP/shortcuts) and B2 (Dexie/Postgres migration) handoffs.

This plan covers two user-driven asks:

> "Make a feature where I could put links of a specific tab and it will open it when I click it — like for example if I was to workout I'd want to open my YouTube playlist — in the Jarvis app. Make it a full feature."

> "Pause the YouTube video from the Jarvis app itself, skip the ad — for example if I was to listen and it could auto skip for me. We NEED this!"

The two features share a player surface: Quick Launch is the *entry point* (tile → open), MediaPlayer is the *runtime* (open → control). Designing them together avoids a second pass when we wire YouTube playlists and "play [link name]" voice intents.

---

## 0. Architecture overview

```text
┌──────────────────────────── NavPane ─────────────────────────────┐
│ Pinned · Projects · Chats · Agents · Skills · Files              │
│ ┌──────── LauncherPanel (collapsible) ────────┐                  │
│ │  GroupChip  GroupChip  GroupChip   ⊕         │                  │
│ │  ┌──┐┌──┐┌──┐┌──┐                           │                  │
│ │  │  ││  ││  ││  │   ← LauncherGrid          │                  │
│ │  └──┘└──┘└──┘└──┘                            │                  │
│ └──────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
                  │ click LinkCard
                  ▼
        ┌──────────────────────┐
        │  launchQuickLink()   │ ◀── voice ("play workout")
        └─────────┬────────────┘     palette ("Quick Launch: …")
                  │ behavior
   ┌──────────────┼───────────────────────────────────┐
   ▼              ▼                                   ▼
external_browser  in_app_player → MediaPlayer ◀── pip_window (Tauri webview)
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │  useMediaStore      │ ◀── voice ("pause", "next")
                            │  YT.Player wrapper  │     palette media:* actions
                            │  HLS.js / <video>   │     auto-skip-ad poll loop
                            └─────────────────────┘
```

Key invariant: every kind that needs playback (`youtube`, `youtube-playlist`, `spotify`, `soundcloud`, audio/video files) routes through the `MediaPlayer` component. The behavior (`in_app_player` vs `pip_window` vs `side_panel`) only changes *where* MediaPlayer is mounted — never *what* drives playback.

---

## 1. Quick Launch data model (Dexie + Postgres)

> **HANDOFF → Planner B2** — own the Dexie migration v8 → v9 and the Postgres `2026_xx_quick_launch.sql` migration. Schema below is canonical; do not invent shorter column names.

### 1.1 `quick_links` table

```ts
// app/src/storage/schemas/quick-link.ts
export type QuickLinkKind =
  | 'web'
  | 'youtube'
  | 'youtube-playlist'
  | 'spotify'
  | 'soundcloud'
  | 'app'
  | 'file'
  | 'jarvis-action';

export type QuickLinkBehavior =
  | 'external_browser'
  | 'in_app_player'
  | 'pip_window'
  | 'side_panel';

export interface QuickLink {
  /** Stable id, format `qlk_<26char ulid>`. */
  id: string;
  /** Workspace scope. Required (ws_default if user has no workspaces). */
  workspace_id: string;
  /** Optional project scope. NULL = workspace-wide. */
  project_id: string | null;
  /** User-visible label, max 80 chars. */
  label: string;
  /** Target URL, file path, action id, or app moniker. Max 2048 chars. */
  url: string;
  /** Discriminator (drives icon defaults + behavior validation). */
  kind: QuickLinkKind;
  /**
   * Icon source. One of:
   *  - `lucide:<name>`   e.g. `lucide:music`
   *  - `favicon:<host>`  resolved at render time via /favicon.ico fallback
   *  - `data:image/...`  base64 thumbnail (capped at 64 KB)
   *  - `yt:<videoId>`    resolved to https://i.ytimg.com/vi/<id>/hqdefault.jpg
   */
  icon: string;
  /** OKLCH hue (0–360) used for the tile chip color. */
  color_hue: number;
  /** Determines runtime mount point. Validated against kind in launchQuickLink. */
  behavior: QuickLinkBehavior;
  /** Optional hotkey, parsed by lib/hotkeys.ts. NULL = no binding. */
  hotkey: string | null;
  /** Stable sort within a group (or workspace if group is null). */
  position: number;
  /** Group id (FK to quick_link_groups.id). NULL = ungrouped. */
  group_id: string | null;
  /** Free-form tags as JSON array, lower-cased, deduped. Max 16 tags, 24 chars each. */
  tags: string[];
  /** Last invocation timestamp, ms epoch. NULL = never used. */
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}
```

### 1.2 `quick_link_groups` table

```ts
export interface QuickLinkGroup {
  /** Stable id, format `qlg_<26char ulid>`. */
  id: string;
  workspace_id: string;
  /** User-visible name, max 40 chars. Required, unique per workspace. */
  name: string;
  /** OKLCH hue for the chip. */
  color_hue: number;
  /** Sort order in the chip strip. */
  position: number;
  created_at: number;
  updated_at: number;
}
```

### 1.3 Indexing

Dexie schema string for v9:

```ts
db.version(9).stores({
  quick_links:
    '&id, workspace_id, project_id, group_id, kind, position, last_used_at, [workspace_id+position], [workspace_id+group_id+position]',
  quick_link_groups:
    '&id, workspace_id, position, [workspace_id+position]',
});
```

Postgres equivalents: btree on `(workspace_id, position)` and `(workspace_id, group_id, position)`; partial index on `last_used_at WHERE last_used_at IS NOT NULL` for "Recent" view.

### 1.4 Validation rules (enforced in repository layer, not in UI)

- `behavior` ↔ `kind` matrix (see §3) is enforced server-side. UI offers only valid combos.
- `hotkey` must parse via `lib/hotkeys.ts`. Duplicate hotkeys per workspace return 409.
- `url` must be `http(s):`, `file:`, `jarvis-action:`, `spotify:`, or one of the `app:` schemes. No `javascript:`, no `data:` URLs as targets.
- `label` is HTML-escaped on read; `tags` are normalized to `[a-z0-9-]+` only.

---

## 2. Quick Launch UI

### 2.1 Component tree

```
app/src/features/launcher/
├── LauncherPanel.tsx          ← lives in NavPane, collapsible
├── LauncherGrid.tsx           ← 4-col tile grid (or list/inline)
├── LinkCard.tsx               ← one tile, drag handle, 3-dot menu
├── LinkEditDialog.tsx         ← create/edit modal
├── GroupChip.tsx              ← top strip filter chip
├── GroupEditDialog.tsx        ← rename/recolor/delete group
├── BookmarkImportDialog.tsx   ← Chrome/FF HTML import
├── DragDropProvider.tsx       ← dnd-kit wrapper, shared with LauncherGrid
├── hooks/
│   ├── useQuickLinks.ts       ← live query (Dexie)
│   ├── useLaunchLink.ts       ← orchestration: emits launch event
│   └── useFaviconResolver.ts  ← async resolves favicon: with cache
└── lib/
    ├── parseBookmarkHtml.ts
    ├── inferKindFromUrl.ts
    └── youtubeOembed.ts
```

### 2.2 LauncherPanel placement (NavPane)

Insert after the existing `Files` section in `app/src/components/layout/NavPane.tsx:64`:

```tsx
<NavSection title="Quick Launch" icon={<Rocket className="h-4 w-4" />} navOpen={navOpen}>
  <LauncherPanel collapsedView={!navOpen} />
</NavSection>
```

When `navOpen=false`, `LauncherPanel` renders the top 6 most-used links as 28×28 icon-only buttons stacked vertically (matches the existing `NavItem` pattern at lines 109–141). When `navOpen=true`, it renders the full grid.

### 2.3 View modes

```ts
export type LauncherViewMode = 'tile' | 'list' | 'palette-inline';
```

- **tile**: 4-col CSS grid, 64×64 cards with label below. Default.
- **list**: dense rows, label + icon + last-used timestamp + hotkey hint. For users with 30+ links.
- **palette-inline**: rendered *inside* the command palette under a "Quick Launch" group when the palette is open (uses the existing `registerAction` plumbing — see §8).

Mode is per-workspace and stored in `useUIStore.launcherViewMode`.

### 2.4 LinkCard interaction model

```tsx
interface LinkCardProps {
  link: QuickLink;
  isDragging?: boolean;
  isFiltered?: boolean;
}

// Behavior:
// - click            → useLaunchLink().launch(link.id)
// - cmd/ctrl-click   → force `external_browser` behavior (override)
// - shift-click      → open `LinkEditDialog`
// - right-click      → context menu: Edit / Duplicate / Set hotkey / Change behavior / Delete
// - long-press (touch) → same as right-click
// - drag handle      → reorder within group, drop on GroupChip to reassign group
```

3-dot menu items (rendered via existing `DropdownMenu` from `@/components/ui/dropdown-menu`):

1. Edit…
2. Duplicate
3. Move to group ▶
4. Set hotkey…
5. Change behavior ▶ (only valid behaviors per kind shown)
6. Copy URL
7. Delete (confirm via `AlertDialog`)

### 2.5 LinkEditDialog fields

```tsx
interface LinkEditDialogValues {
  label: string;
  url: string;
  kind: QuickLinkKind;          // auto-inferred via inferKindFromUrl, user-overridable
  behavior: QuickLinkBehavior;  // filtered to legal options for kind
  group_id: string | null;
  icon: string;                 // pickers: lucide grid, "use favicon", "use thumbnail" (YT only)
  color_hue: number;            // hue slider, default = hash(label) % 360
  hotkey: string | null;        // captured by HotkeyInput, validated client-side
  tags: string[];               // chip input
}
```

Auto-fill on URL paste:

1. `inferKindFromUrl(url)` decides the kind (`youtube.com/playlist?list=` → `youtube-playlist`, etc.).
2. For YouTube URLs, fetch via `youtubeOembed(url)` → prefill `label` and `icon`.
3. For other URLs, attempt `https://www.google.com/s2/favicons?sz=64&domain=<host>` for `icon`.
4. `behavior` defaults: see matrix in §3.

### 2.6 GroupChip

Top of the LauncherGrid renders a chip strip:

```
[ All • 24 ]  [ ⚡ Workout • 4 ]  [ 🎵 Music • 8 ]  [ 📚 Reading • 3 ]   ⊕
```

- Click chip → filters grid (sets `useLauncherStore.activeGroupId`).
- Right-click chip → `GroupEditDialog`.
- Drag a `LinkCard` onto a chip → reassigns `group_id`.
- "+" button → create new group (name + hue picker).
- Empty state when no groups: chip strip is hidden, "Create your first group" link in the empty cell.

---

## 3. Quick Launch behaviors (kind × behavior matrix)

Behavior is the *only* thing that determines runtime mount. The matrix below is exhaustive — combinations not listed are rejected at validation time.

| kind                | external_browser | in_app_player    | pip_window        | side_panel      |
|---------------------|:----------------:|:----------------:|:-----------------:|:---------------:|
| `web`               | ✅ default        | ✅                | ✅                 | ✅               |
| `youtube`           | ✅                | ✅ default        | ✅                 | ✅               |
| `youtube-playlist`  | ✅                | ✅ default        | ✅                 | ✅               |
| `spotify`           | ✅ default        | ⚠ web embed only | ⚠ web embed only  | ⚠               |
| `soundcloud`        | ✅                | ✅ default        | ✅                 | ✅               |
| `app`               | n/a (shell-open) | ❌                | ❌                 | ❌               |
| `file`              | n/a (shell-open) | ✅ for media files| ✅ for media files | ❌               |
| `jarvis-action`     | n/a (palette)    | ❌                | ❌                 | ❌               |

⚠ = Spotify Connect Web Playback SDK requires a Premium account + an OAuth flow. V2 falls back to `external_browser` if the user is not authed; the embed widget plays 30-sec previews only. Document this in the LinkEditDialog when the user picks Spotify + in_app_player.

### 3.1 Behavior implementations

```ts
// app/src/features/launcher/launchQuickLink.ts
export async function launchQuickLink(link: QuickLink, opts?: LaunchOpts): Promise<void> {
  // Touch last_used_at first so Recent updates even on failure.
  await quickLinkRepo.touch(link.id);

  switch (link.kind) {
    case 'app':
    case 'file':
      // Always shell-open. Validate path is under one of the allowed dirs:
      //   - file: must resolve under app's allowed FS scope (B1 wires)
      //   - app: validated against `app://` scheme registered in tauri.conf.json
      return shellOpenScoped(link.url);

    case 'jarvis-action':
      // Format: 'jarvis-action:<actionId>?<query>'
      return performAction(parseActionId(link.url));

    case 'web':
    case 'youtube':
    case 'youtube-playlist':
    case 'soundcloud':
    case 'spotify':
      switch (link.behavior) {
        case 'external_browser':
          return openExternal(link.url);                       // existing tauri.ts:212
        case 'in_app_player':
          return useMediaStore.getState().play({ link });      // §5
        case 'pip_window':
          await ensurePipWindow();                             // §9
          return useMediaStore.getState().play({ link, mount: 'pip' });
        case 'side_panel':
          useUIStore.getState().setInspectorTab('media');      // new tab in Inspector
          return useMediaStore.getState().play({ link, mount: 'side' });
      }
  }
}
```

`shellOpenScoped` is a thin wrapper over the existing `openExternal` that validates the path against the FS scope (B1's `tauri-plugin-fs` config). For `file:` URLs, we resolve the path through `@tauri-apps/api/path` to ensure it is under `appDataDir` or one of the user-configured allowed dirs.

---

## 4. Quick Launch import + hotkeys + voice

### 4.1 Bookmark HTML import

Chrome and Firefox both export bookmarks as a `<dl><dt><h3>folder</h3><dl>…<a href>…</a>…</dl></dt></dl>` tree. Parser:

```ts
// app/src/features/launcher/lib/parseBookmarkHtml.ts
export interface ParsedBookmark {
  label: string;
  url: string;
  /** Full folder path, e.g. ["Bookmarks Bar", "Workout"]. */
  folderPath: string[];
  /** ms epoch from Chrome's ADD_DATE attribute (seconds since epoch * 1000). */
  addedAt: number | null;
}

export function parseBookmarkHtml(html: string): ParsedBookmark[];
```

Algorithm:

1. Use the browser's native `DOMParser` (`new DOMParser().parseFromString(html, 'text/html')`).
2. Walk the document. Each `<dt>` may contain either a `<h3>` (folder) or an `<a>` (link).
3. Maintain a folder-path stack as we recurse into `<dl>` siblings of `<h3>`.
4. For each `<a>`: emit `{label: a.textContent, url: a.href, folderPath: [...stack], addedAt: parseAddDate(a.getAttribute('add_date'))}`.
5. Fallback for malformed exports: also accept flat `<a>` tags at the document root.

Import dialog flow:

1. User picks a `.html` file via `tauri-plugin-dialog`.
2. Render preview tree with checkboxes (default: all checked).
3. Group mapping: each top-level folder becomes a `quick_link_group`. User can rename/merge before commit.
4. Bulk insert via Dexie transaction.

### 4.2 YouTube oembed

```ts
// app/src/features/launcher/lib/youtubeOembed.ts
interface OembedResponse {
  title: string;
  author_name: string;
  thumbnail_url: string;  // i.ytimg.com/vi/<id>/hqdefault.jpg
  html: string;           // we discard
}

export async function youtubeOembed(url: string): Promise<OembedResponse | null>;
```

CORS: `https://www.youtube.com/oembed` does **not** send `Access-Control-Allow-Origin: *`. Two paths:

- **Tauri build:** call via a thin Rust command `cmd_youtube_oembed(url)` that fetches server-side and returns the JSON. This is the production path.
- **Web build (dev only):** skip oembed entirely, derive `videoId` from the URL, fall back to the well-known thumbnail URL `https://i.ytimg.com/vi/{id}/hqdefault.jpg` (CORS-friendly) and use the URL hostname as the label until the user edits.

> **HANDOFF → Planner B1** — add Rust command `cmd_youtube_oembed(url: String) -> Result<serde_json::Value, String>` using `reqwest`. Allow only `youtube.com`/`youtu.be` hosts in the URL parser before issuing the fetch.

### 4.3 Drag-and-drop URL onto Jarvis

Tauri 2 emits a `tauri://drag-drop` event payload with `paths` and `position`. We also listen for the standard HTML5 `dragover`/`drop` on the AppShell root for URL strings dragged from a browser tab.

```ts
// app/src/features/launcher/hooks/useUrlDrop.ts
useEffect(() => {
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const url = e.dataTransfer?.getData('text/uri-list')
              ?? e.dataTransfer?.getData('text/plain');
    if (url && /^https?:/.test(url)) {
      openLinkEditDialog({ url });   // pre-fills the dialog, kicks oembed lookup
    }
  };
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', onDrop);
  return () => window.removeEventListener('drop', onDrop);
}, []);
```

### 4.4 Hotkeys

- `Mod+Shift+1`…`Mod+Shift+9`: bound to the first 9 links by `position` within `group_id IS NULL OR active group`. If the user assigned a custom `hotkey`, that wins.
- `Mod+Shift+0`: opens the LauncherPanel and focuses the first tile (keyboard nav).
- `Mod+Shift+L`: open the new-link dialog.
- `Mod+Shift+G`: open the new-group dialog.

> **HANDOFF → Planner B1** — register `tauri-plugin-global-shortcut` and expose a JS API in `app/src/lib/tauri.ts` so the existing `registerGlobalHotkey` (currently a window-level fallback at lines 139–185) routes through the plugin. `Mod+Shift+1..9` should be OS-wide so the user can launch from anywhere.

### 4.5 Voice intents

Add to `IntentClassifier.ts` (file at `app/src/features/voice/IntentClassifier.ts`):

```ts
export type Intent = /* existing */
  | 'launch_quick_link'      // "open my workout playlist", "launch X"
  | 'launch_group'           // "open workout setup", "start my work routine"
  | 'list_quick_links'       // "list my links", "what links do I have"
  | 'media:play'             // "play X", "resume"
  | 'media:pause'            // "pause"
  | 'media:stop'             // "stop"
  | 'media:next'             // "next", "skip song"
  | 'media:prev'             // "previous", "back"
  | 'media:skip_ad'          // "skip ad"
  | 'media:seek'             // "skip thirty seconds", "rewind ten"
  | 'media:volume'           // "volume to 50"
  | 'media:what_playing';    // "what's playing"

const RX_LAUNCHER = {
  launch_quick_link: /^(open|launch|start)\s+(?:my\s+)?(.+?)(?:\s+(?:link|tab|playlist|page))?$/i,
  launch_group: /^(open|start|launch)\s+(?:my\s+)?(.+?)\s+(?:setup|routine|group|set)$/i,
  list_quick_links: /^(list|show)\s+(?:my\s+)?(?:quick\s+)?(?:links|launches|tabs)$/i,
};

const RX_MEDIA = {
  play: /^(play|resume|continue|unpause)\b/i,
  pause: /^(pause|hold)\b/i,
  stop: /^(stop|stop\s+music|stop\s+playing)\b/i,
  next: /^(next|skip(?:\s+song|\s+track)?|fwd)\b/i,
  prev: /^(prev(?:ious)?|back|last\s+song)\b/i,
  skip_ad: /^(skip\s+(?:the\s+)?ad|skip\s+commercial|kill\s+the\s+ad)\b/i,
  seek_fwd: /^(skip|fast\s*forward|fwd)\s+(\d+)\s*(?:second|sec|s|minute|min|m)\b/i,
  seek_back: /^(rewind|back|go\s+back)\s+(\d+)\s*(?:second|sec|s|minute|min|m)\b/i,
  volume: /^(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})\b/i,
  what_playing: /^(what'?s\s+playing|what\s+song|what\s+is\s+this)\b/i,
};
```

Resolution rules for `launch_quick_link`:

1. Strip trigger verb. Take remainder as `query`.
2. Fuzzy-match (`fuse.js` already in repo) over `quick_links.label` + `tags` for the active workspace.
3. If best match score < 0.4, fall through to `media:play` if a player is active and the query has no fuzzy match.
4. If multiple matches within 0.05 of each other → return `clarify` action: "Did you mean `<a>` or `<b>`?".

For `launch_group`: same fuzzy match against `quick_link_groups.name`. When matched, launch *all* links in that group in `position` order, opening up to 4 in `pip_window` mode and the rest in `external_browser` to avoid swamping the player.

`media:what_playing` reads `useMediaStore.getState().nowPlaying` and TTS's `"<title> by <author>"`.

---

## 5. MediaPlayer architecture (3 layers)

V2 ships Layers 1 + 2. Layer 3 is design-only.

### 5.1 Layer 1 — YouTube IFrame Player API (V2 ship)

**Embed:** `https://www.youtube-nocookie.com/embed/{videoId}?enablejsapi=1&origin={tauriOrigin}&rel=0&modestbranding=1&playsinline=1`

For playlists: `https://www.youtube-nocookie.com/embed/videoseries?list={listId}&enablejsapi=1&origin={tauriOrigin}`.

`tauriOrigin` is `https://tauri.localhost` on Windows or `tauri://localhost` on macOS — read at runtime from `window.location.origin` so it tracks Tauri's IPC origin. The `origin` parameter is required for `enablejsapi=1` to actually accept commands; otherwise the iframe silently no-ops.

**Loader:** YouTube wants you to load `https://www.youtube.com/iframe_api`. That script then defines `window.YT` and calls a global `window.onYouTubeIframeAPIReady`. We wrap it once:

```ts
// app/src/features/media/lib/loadYTApi.ts
let ready: Promise<typeof YT> | null = null;

export function loadYTApi(): Promise<typeof YT> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    if ((window as any).YT?.Player) return resolve((window as any).YT);
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => { ready = null; reject(new Error('iframe_api load failed')); };
    (window as any).onYouTubeIframeAPIReady = () => resolve((window as any).YT);
    document.head.appendChild(tag);
  });
  return ready;
}
```

> **HANDOFF → Planner B1** — CSP `script-src` must allow `https://www.youtube.com` for this loader. See §10.

### 5.2 Component: MediaPlayer.tsx

```tsx
// app/src/features/media/MediaPlayer.tsx
export interface MediaPlayerProps {
  /** Where to mount: 'main' (Inspector media tab), 'pip' (PiP window), 'side' (Inspector side_panel). */
  mount: 'main' | 'pip' | 'side';
}

export function MediaPlayer({ mount }: MediaPlayerProps) {
  const link = useMediaStore((s) => s.activeLink);
  const ref = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YT.Player | null>(null);

  useEffect(() => {
    if (!link || link.kind === 'app' || link.kind === 'file') return;

    let disposed = false;
    (async () => {
      const YT = await loadYTApi();
      if (disposed || !ref.current) return;
      playerRef.current = new YT.Player(ref.current, {
        videoId: extractVideoId(link.url),
        playerVars: {
          enablejsapi: 1,
          origin: window.location.origin,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          // playlist: extractPlaylistId(link.url),  // for youtube-playlist
        },
        events: {
          onReady,
          onStateChange,
          onError,
          onPlaybackQualityChange,
        },
      });
    })();

    return () => {
      disposed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [link?.id]);

  // Public store API plumbed through useMediaStore.bind(...) — see §5.4
  return <div ref={ref} className={mountClass(mount)} />;
}
```

### 5.3 Public store API (`useMediaStore`)

```ts
// app/src/features/media/useMediaStore.ts
export interface NowPlaying {
  videoId: string | null;
  title: string;
  author: string;
  durationSec: number;
  positionSec: number;
  /** YT.Player state mapped to a friendly enum. */
  state: 'idle' | 'cued' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
  /** Detected ad runtime info — see §7. */
  ad: { active: boolean; autoSkipAttempted: boolean };
  /** Quality bucket from YT.Player.getPlaybackQuality, e.g. 'hd1080'. */
  quality: string | null;
}

export interface MediaStoreState {
  activeLink: QuickLink | null;
  mount: 'main' | 'pip' | 'side' | null;
  nowPlaying: NowPlaying;
  volume: number;          // 0..100
  muted: boolean;
  // Imperative API (resolved when the player is ready)
  play: (args: { link: QuickLink; mount?: 'main' | 'pip' | 'side' }) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (sec: number, allowSeekAhead?: boolean) => void;
  seekBy: (deltaSec: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  skipAd: () => void;       // forces auto-skip path
  // Internal: bound by MediaPlayer when YT.Player is ready
  _bind: (player: YT.Player) => void;
  _unbind: () => void;
}
```

Imperative methods are queued if `_bind` hasn't fired yet. This lets voice commands ("play X") fire before the iframe finishes loading.

### 5.4 Layer 2 — generic HTML5 media (V2 ship)

For `kind=file` with extensions in `['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.mp4', '.webm', '.mkv', '.m3u8']` we render a plain `<audio>` or `<video>` instead of the YT iframe. For `.m3u8` (HLS) we attach `hls.js`:

```ts
// app/src/features/media/lib/hlsAttach.ts
import Hls from 'hls.js';   // pin: 1.5.x

export function attachHls(video: HTMLVideoElement, src: string): () => void {
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;        // Safari + iOS
    return () => { video.src = ''; };
  }
  if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    return () => hls.destroy();
  }
  console.warn('[media] HLS unsupported, falling back to direct src');
  video.src = src;
  return () => { video.src = ''; };
}
```

Layer 2 reuses the same `useMediaStore` API. `nowPlaying.state` is mapped from the standard HTMLMediaElement events (`play`, `pause`, `ended`, `waiting`, `error`). `getDuration()` → `video.duration`, `seekTo` → `video.currentTime = sec`.

### 5.5 Layer 3 — Browser extension companion (V3 SCAFFOLD ONLY)

Document the protocol so V3 can drop in. No code in V2 beyond an interface file.

```ts
// app/src/features/media/extension-protocol.ts
/**
 * V3 only. WebSocket on ws://127.0.0.1:8765, single connection per Jarvis instance.
 * Auth: HMAC handshake using a per-install token at appDataDir/extension-token.
 */
export type ExtensionMessage =
  | { type: 'auth'; token: string }
  | { type: 'media:state'; tabId: number; payload: NowPlaying }
  | { type: 'media:command'; tabId: number; cmd: 'play' | 'pause' | 'next' | 'skipAd'; args?: unknown };
```

The companion extension (Manifest V3, Chromium + Firefox) will inject content scripts that talk to `<video>` elements directly — including ad-segment detection via DOM heuristics that we *cannot* do from inside an iframe. That's the actual ad-blocker path; the V2 heuristic in §7 is best-effort.

---

## 6. YouTube iframe integration (event flow)

### 6.1 Lifecycle

```text
new YT.Player()
  └─> onReady           player is ready, store state := 'cued'
  └─> onStateChange(-1) UNSTARTED
  └─> onStateChange(3)  BUFFERING
  └─> onStateChange(1)  PLAYING                        ← start ad-detect poll
  └─> onStateChange(2)  PAUSED                         ← pause ad-detect poll
  └─> onStateChange(0)  ENDED                          ← auto-next if playlist
  └─> onStateChange(5)  CUED
  └─> onError(N)        see §6.3
```

State enum mapping:

```ts
function mapYtState(code: number): NowPlaying['state'] {
  switch (code) {
    case -1: return 'idle';
    case 0:  return 'ended';
    case 1:  return 'playing';
    case 2:  return 'paused';
    case 3:  return 'buffering';
    case 5:  return 'cued';
    default: return 'idle';
  }
}
```

### 6.2 onReady — bind store

```ts
function onReady(e: YT.PlayerEvent) {
  const player = e.target;
  useMediaStore.getState()._bind(player);
  // Drain any imperative calls queued before bind.
  player.setVolume(useMediaStore.getState().volume);
  if (useMediaStore.getState().muted) player.mute();
}
```

### 6.3 onError — fallback table

| code | meaning                            | UI action                                              |
|------|------------------------------------|--------------------------------------------------------|
| 2    | Invalid videoId or parameter       | Toast "This video link looks malformed". Disable play. |
| 5    | HTML5 player error                 | Retry once, then toast "Video failed to load".         |
| 100  | Video not found / private          | Toast "Video unavailable". Mark link.                  |
| 101  | Embedding disabled by uploader     | Auto-fallback to `external_browser`.                   |
| 150  | Same as 101 (older alias)          | Auto-fallback to `external_browser`.                   |
| 153  | Age-restricted (rare)              | Auto-fallback to `external_browser`.                   |

The auto-fallback path:

```ts
function onError(e: YT.OnErrorEvent) {
  const link = useMediaStore.getState().activeLink;
  if (!link) return;
  if ([101, 150, 153].includes(e.data)) {
    toast.warn('Embedding disabled. Opening in your browser.');
    openExternal(link.url);
    useMediaStore.getState().stop();
    return;
  }
  useMediaStore.setState((s) => ({
    nowPlaying: { ...s.nowPlaying, state: 'error' },
  }));
}
```

### 6.4 getVideoData usage

`player.getVideoData()` returns `{video_id, title, author}`. We poll it on every `onStateChange(1)` and again every 2s during playback (cheap, in-process call). This is what powers `media:what_playing` and the ad heuristic in §7.

### 6.5 postMessage origin checking

We never send postMessages directly to the iframe — `YT.Player` wraps that. But we do install a `message` listener at the window level for the V3 extension protocol. That listener must check:

```ts
const ALLOWED_ORIGINS = new Set([
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
]);
window.addEventListener('message', (ev) => {
  if (!ALLOWED_ORIGINS.has(ev.origin)) return;   // drop cross-origin junk
  // ... only forward known message types
});
```

---

## 7. Auto-skip-ad heuristic (full algorithm)

### 7.1 Algorithm

```ts
// app/src/features/media/lib/adDetect.ts
/**
 * YouTube serves an ad inside the same iframe by switching the video momentarily
 * to a different video_id. The originally requested videoId stays in the
 * player's "videoUrl"-derived loadVideoById call, but getVideoData() reports
 * the *currently playing* video. So when those diverge, we are very likely
 * inside an ad break.
 *
 * Limits:
 *  - Unskippable pre-rolls: seeking is blocked; we report ad=true but cannot bypass.
 *  - Bumper ads (≤6s): seeking succeeds after ~5s.
 *  - Mid-roll ads: seeking succeeds. For multiple back-to-back ads we re-detect.
 *  - Companion ads (banner overlay): we ignore. They don't block playback.
 */
export interface AdDetectorOpts {
  player: YT.Player;
  requestedVideoId: string;
  onAdState: (ad: { active: boolean; autoSkipAttempted: boolean }) => void;
  onSkipBlocked: () => void;
}

export function startAdDetector(opts: AdDetectorOpts): () => void {
  const { player, requestedVideoId, onAdState, onSkipBlocked } = opts;
  let lastAdAttemptAt = 0;
  let consecutiveBlockedAttempts = 0;

  const tick = () => {
    if (player.getPlayerState() !== 1 /* PLAYING */) return;
    const data = player.getVideoData();
    const playing = data?.video_id;
    if (!playing) return;

    const adProbablyPlaying = playing !== requestedVideoId;
    if (!adProbablyPlaying) {
      onAdState({ active: false, autoSkipAttempted: false });
      consecutiveBlockedAttempts = 0;
      return;
    }

    // Throttle: at most one skip attempt every 1500ms per ad.
    const now = Date.now();
    if (now - lastAdAttemptAt < 1500) return;
    lastAdAttemptAt = now;

    const dur = player.getDuration();
    const before = player.getCurrentTime();
    player.seekTo(Math.max(dur - 0.1, 0), true);

    // Check 200ms later whether the seek "took". If currentTime barely moved,
    // we're in an unskippable pre-roll — give up gracefully.
    setTimeout(() => {
      const after = player.getCurrentTime();
      if (after - before < 0.5) {
        consecutiveBlockedAttempts += 1;
        if (consecutiveBlockedAttempts >= 2) {
          onSkipBlocked();
        }
      } else {
        consecutiveBlockedAttempts = 0;
      }
    }, 200);

    onAdState({ active: true, autoSkipAttempted: true });
  };

  const interval = setInterval(tick, 750);
  return () => clearInterval(interval);
}
```

### 7.2 Failure modes (user-visible)

| scenario                             | algorithm result                  | UI                                   |
|--------------------------------------|-----------------------------------|--------------------------------------|
| Standard mid-roll                    | `autoSkipAttempted=true`, succeeds| Brief "Ad skipped" toast (1s)        |
| Unskippable pre-roll (full)          | `autoSkipAttempted=true`, blocked | "Pre-roll ad — can't skip" badge     |
| Unskippable pre-roll (5s skippable)  | succeeds after 5s                 | "Ad skipped" after the 5s gate       |
| Bumper (6s)                          | succeeds after 5s                 | as above                             |
| Companion banner                     | not detected                      | no UI; user closes the banner        |
| User has Premium / no ads            | never triggers                    | no UI                                |
| Rate limited (2 blocked attempts)    | `onSkipBlocked` fires             | toast suggests opening in browser    |

### 7.3 Honest framing in UI

The settings toggle copy:

> **Auto-skip detected ads** *(default ON)*
> Best-effort skip when YouTube switches the embedded player to an ad. Pre-roll ads with no skip button can't be bypassed inside the embedded player. For full ad-blocking, the upcoming Jarvis browser extension (V3) is the path.

This sets realistic expectations and avoids "Jarvis adblock doesn't work" support churn.

### 7.4 User toggle wiring

```ts
// app/src/stores/settings.ts addition
export interface SettingsState {
  // ...
  media: {
    autoSkipAds: boolean;        // default: true
    cookielessYouTube: boolean;  // default: true
    defaultBehaviorYouTube: 'in_app_player' | 'external_browser';  // default: in_app_player
    pipAlwaysOnTop: boolean;     // default: true
    rememberVolume: boolean;     // default: true
  };
}
```

Settings UI lives under Settings → Media (B3 panel) — handoff to Planner C if they own settings.

---

## 8. Voice + palette intents

### 8.1 Voice → handler routing

```ts
// app/src/features/voice/handlers/quick-launch.ts
export async function handleVoiceIntent(intent: VoiceIntent) {
  switch (intent.intent) {
    case 'launch_quick_link': {
      const match = await fuzzyFindLink(intent.slots.query!);
      if (!match) {
        toast.info(`No link matching "${intent.slots.query}"`);
        return;
      }
      return launchQuickLink(match);
    }
    case 'launch_group': {
      const grp = await fuzzyFindGroup(intent.slots.query!);
      if (!grp) return;
      const links = await quickLinkRepo.byGroup(grp.id);
      for (const l of links.slice(0, 4)) {
        await launchQuickLink({ ...l, behavior: 'pip_window' });
      }
      for (const l of links.slice(4)) {
        await launchQuickLink({ ...l, behavior: 'external_browser' });
      }
      return;
    }
    case 'list_quick_links':
      return ttsEnumerate(await quickLinkRepo.recent(10));

    case 'media:play':       return useMediaStore.getState().resume();
    case 'media:pause':      return useMediaStore.getState().pause();
    case 'media:stop':       return useMediaStore.getState().stop();
    case 'media:next':       return useMediaStore.getState().next();
    case 'media:prev':       return useMediaStore.getState().prev();
    case 'media:skip_ad':    return useMediaStore.getState().skipAd();
    case 'media:seek':       return useMediaStore.getState().seekBy(intent.slots.seekDeltaSec ?? 0);
    case 'media:volume':     return useMediaStore.getState().setVolume(intent.slots.volume ?? 50);
    case 'media:what_playing': {
      const np = useMediaStore.getState().nowPlaying;
      if (np.videoId) tts(`Playing ${np.title} by ${np.author}`);
      else tts('Nothing is playing right now');
      return;
    }
  }
}
```

Slot extraction additions (in `IntentClassifier.ts`):

```ts
function extractSeek(text: string): number | null {
  let m = text.match(RX_MEDIA.seek_fwd);
  if (m) return parseInt(m[2], 10) * (m[0].toLowerCase().includes('min') ? 60 : 1);
  m = text.match(RX_MEDIA.seek_back);
  if (m) return -parseInt(m[2], 10) * (m[0].toLowerCase().includes('min') ? 60 : 1);
  return null;
}

function extractVolume(text: string): number | null {
  const m = text.match(RX_MEDIA.volume);
  if (!m) return null;
  return Math.max(0, Math.min(100, parseInt(m[1], 10)));
}
```

### 8.2 Palette actions

Every quick link gets a dynamic palette action. Use the existing `registerAction` registry (`actions.ts:356`):

```ts
// app/src/features/launcher/registerLauncherActions.ts
export function registerLauncherActions(): () => void {
  const subs: Array<() => void> = [];

  // Subscribe to Dexie liveQuery for quick_links so the registry stays in sync.
  const sub = liveQuery(() => quickLinkRepo.allForActiveWorkspace())
    .subscribe((links) => {
      // Replace all dynamic actions for this group.
      unregisterAllByPrefix('ql:');
      for (const link of links) {
        registerAction({
          id: `ql:${link.id}`,
          label: link.label,
          description: kindLabel(link.kind),
          icon: resolveLucideIcon(link.icon),
          page: 'root',
          keywords: ['launch', 'open', ...link.tags],
          hotkey: link.hotkey ?? undefined,
          perform: ({ closePalette }) => {
            launchQuickLink(link);
            closePalette();
          },
        });
      }
    });
  subs.push(() => sub.unsubscribe());

  // Static media commands.
  for (const cmd of MEDIA_PALETTE_ACTIONS) subs.push(registerAction(cmd));

  return () => subs.forEach((d) => d());
}

const MEDIA_PALETTE_ACTIONS: Action[] = [
  { id: 'media:play',     label: 'Media: Play',     icon: Play,       page: 'root',
    keywords: ['resume', 'unpause'],
    perform: ({ closePalette }) => { useMediaStore.getState().resume(); closePalette(); } },
  { id: 'media:pause',    label: 'Media: Pause',    icon: Pause,      page: 'root',
    perform: ({ closePalette }) => { useMediaStore.getState().pause();  closePalette(); } },
  { id: 'media:stop',     label: 'Media: Stop',     icon: Square,     page: 'root',
    perform: ({ closePalette }) => { useMediaStore.getState().stop();   closePalette(); } },
  { id: 'media:next',     label: 'Media: Next',     icon: SkipForward,page: 'root',
    perform: ({ closePalette }) => { useMediaStore.getState().next();   closePalette(); } },
  { id: 'media:prev',     label: 'Media: Previous', icon: SkipBack,   page: 'root',
    perform: ({ closePalette }) => { useMediaStore.getState().prev();   closePalette(); } },
  { id: 'media:skip-ad',  label: 'Media: Skip ad',  icon: Forward,    page: 'root',
    perform: ({ closePalette }) => { useMediaStore.getState().skipAd(); closePalette(); } },
  { id: 'media:pip',      label: 'Media: Toggle PiP window', icon: PictureInPicture2, page: 'root',
    hotkey: 'Mod+Shift+P',
    perform: ({ closePalette }) => { togglePipWindow();                 closePalette(); } },
];
```

`registerLauncherActions` is called once from `App.tsx` mount and disposed on unmount.

---

## 9. Picture-in-Picture window (Tauri)

### 9.1 Spawn

```ts
// app/src/features/media/pip/openPipWindow.ts
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const PIP_LABEL = 'media-pip';

export async function ensurePipWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(PIP_LABEL);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return existing;
  }
  return new WebviewWindow(PIP_LABEL, {
    url: 'index.html#/pip-media',
    width: 360,
    height: 220,
    minWidth: 280,
    minHeight: 160,
    resizable: true,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: true,
    title: 'Jarvis · Media',
  });
}

export async function togglePipWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PIP_LABEL);
  if (existing) {
    const visible = await existing.isVisible();
    if (visible) await existing.close();
    else await existing.show();
    return;
  }
  await ensurePipWindow();
}
```

> **HANDOFF → Planner B1** — capability `core:webview:allow-create-webview-window` must be granted to the main window. See §10.

### 9.2 PiP route

`app/src/main.tsx` already mounts a router. Add a `/pip-media` route that renders only the MediaPlayer + a transparent drag region:

```tsx
// app/src/features/media/pip/PipMediaWindow.tsx
export function PipMediaWindow() {
  return (
    <div data-tauri-drag-region className="h-screen w-screen bg-black/80 backdrop-blur">
      <div className="flex h-full w-full flex-col">
        <div data-tauri-drag-region className="flex h-7 items-center justify-between px-2">
          <span className="text-metadata text-white/70">Jarvis</span>
          <button onClick={() => closePip()} className="text-white/70 hover:text-white">×</button>
        </div>
        <MediaPlayer mount="pip" />
        <MediaPipControls />  {/* play / pause / next / volume / pin */}
      </div>
    </div>
  );
}
```

The PiP window subscribes to the main window's `useMediaStore` via Tauri's event bus (`emitTo` / `listen`) — both windows share the same store snapshot, but neither is the source of truth: the iframe lives in *the window where the link was launched*. PiP commands are forwarded to that window via a `media:command` event.

> Tradeoff: we could move the iframe into the PiP window only. Trying to keep the iframe in main and forwarding events lets the user keep watching when they collapse PiP. We will revisit if event lag is noticeable.

### 9.3 Hotkey

`Mod+Shift+P` toggles PiP. Bound via the same `registerGlobalHotkey` plumbing once B1 wires the plugin. Until then, window-level hotkey works.

---

## 10. Permissions + CSP requirements

> **HANDOFF → Planner B1** — these are the exact diffs to `tauri.conf.json`, `capabilities/default.json`, and the new `capabilities/pip.json`. Do not relax further.

### 10.1 CSP additions in `tauri.conf.json` → `app.security.csp`

The current value is `null`, which means Tauri leaves CSP unset. V2 sets it to a tight policy and explicitly opens the holes we need:

```json
{
  "app": {
    "security": {
      "csp": {
        "default-src": "'self'",
        "script-src":  "'self' https://www.youtube.com",
        "style-src":   "'self' 'unsafe-inline'",
        "img-src":     "'self' data: blob: https://i.ytimg.com https://yt3.ggpht.com https://*.googleusercontent.com",
        "media-src":   "'self' blob: data: https:",
        "frame-src":   "https://www.youtube-nocookie.com https://www.youtube.com",
        "connect-src": "'self' ipc: https://ipc.localhost https://www.youtube.com https://i.ytimg.com",
        "font-src":    "'self' data:",
        "object-src":  "'none'",
        "base-uri":    "'self'",
        "form-action": "'self'"
      }
    }
  }
}
```

**Tradeoff:** allowing `https://www.youtube.com` in `script-src` *does* loosen CSP — anything a YouTube CDN script does runs with our origin. Two mitigations:

1. We use `youtube-nocookie.com` for the iframe, which limits the YT scripts that *load*. The loader script itself comes from `youtube.com`.
2. We isolate per-window: the PiP window uses a separate capability (`pip.json`) that does *not* grant Tauri command access, only `core:webview:default`. So even if a YT script gained foothold, it has no `invoke` surface.

Alternative considered and rejected: hosting the iframe loader on a Tauri subroute and proxying the API. Possible but doubles the CSP surface and breaks YouTube TOS for the embed contract. Not worth it for V2.

### 10.2 Capability additions in `capabilities/default.json`

Add to `permissions`:

```json
[
  "core:default",
  "core:event:default",
  "core:window:default",
  "core:webview:default",
  "core:webview:allow-create-webview-window",
  "core:app:default",
  "core:path:default",
  "notification:default",
  "dialog:default",
  "shell:allow-open",
  "os:default",
  "global-shortcut:default",
  "fs:allow-read-text-file"
]
```

(`global-shortcut` and `fs` reads are needed for §4.4 hotkeys and bookmark imports.)

### 10.3 New capability `capabilities/pip.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "pip",
  "description": "Capability for the Picture-in-Picture media window. Minimal IPC, no shell.",
  "windows": ["media-pip"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:webview:default"
  ]
}
```

### 10.4 Rust commands to add (B1)

```rust
// src-tauri/src/commands/media.rs
#[tauri::command]
async fn cmd_youtube_oembed(url: String) -> Result<serde_json::Value, String> {
    // Validate host whitelist before fetch.
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().ok_or_else(|| "no host".to_string())?;
    if !matches!(host, "www.youtube.com" | "youtu.be" | "youtube.com" | "m.youtube.com") {
        return Err(format!("disallowed host: {host}"));
    }
    let oembed = format!("https://www.youtube.com/oembed?url={}&format=json",
                        urlencoding::encode(&url));
    let resp = reqwest::get(&oembed).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("oembed status {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}
```

Register in `lib.rs:62` next to `greet`/`app_version`.

---

## 11. Privacy + failure modes

### 11.1 Privacy defaults

- Use `youtube-nocookie.com` everywhere by default. Settings → Media → "Use cookieless YouTube" is ON by default. When OFF (user opt-in), we route to `youtube.com` instead. No third-party cookies are written by Jarvis itself.
- No telemetry on quick-link contents. `last_used_at` stays local; nothing is synced unless the user enables workspace sync (B2 owns that contract).
- Bookmark imports are purely local — we never POST the parsed list anywhere.

### 11.2 Per-error-code UX (full table)

| YT error | code | user toast                                                | follow-up                          |
|----------|:----:|-----------------------------------------------------------|------------------------------------|
| Invalid  | 2    | "This video link looks malformed."                        | Disable play; open Edit dialog.    |
| HTML5    | 5    | "Video failed to load. Retrying…"                         | One retry, then surface error.     |
| Not found| 100  | "Video unavailable (removed or private)."                 | Mark `link.broken=true` (future).  |
| No embed | 101  | "Embedding disabled — opening in your browser."           | shell-open the URL.                |
| Same     | 150  | (same as 101)                                             | shell-open.                        |
| Age      | 153  | "Age-restricted video — opening in your browser."         | shell-open.                        |
| Network  | n/a  | "Offline — queued the play command."                      | Retry when navigator.onLine=true.  |

### 11.3 Offline behavior

`useMediaStore` has an internal command queue. If `play()` is called while `navigator.onLine === false`, we store the request and listen for the `online` event:

```ts
window.addEventListener('online', () => {
  const queued = useMediaStore.getState()._drainQueue();
  for (const cmd of queued) executeCommand(cmd);
});
```

Up to 8 queued commands; older ones drop with a toast.

### 11.4 Non-YouTube URL routing

`inferKindFromUrl` decides:

```ts
export function inferKindFromUrl(raw: string): { kind: QuickLinkKind; behavior: QuickLinkBehavior } {
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'web', behavior: 'external_browser' }; }
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    if (url.searchParams.has('list') && !url.searchParams.has('v')) {
      return { kind: 'youtube-playlist', behavior: 'in_app_player' };
    }
    return { kind: 'youtube', behavior: 'in_app_player' };
  }
  if (host === 'open.spotify.com' || host === 'spotify.com') {
    return { kind: 'spotify', behavior: 'external_browser' };  // see §3 caveat
  }
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    return { kind: 'soundcloud', behavior: 'in_app_player' };
  }
  if (url.protocol === 'file:')             return { kind: 'file', behavior: 'external_browser' };
  if (url.protocol === 'jarvis-action:')    return { kind: 'jarvis-action', behavior: 'external_browser' };
  if (/^[a-z][a-z0-9+\-.]*:$/.test(url.protocol) && url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'app', behavior: 'external_browser' };  // custom URL handlers
  }
  return { kind: 'web', behavior: 'external_browser' };
}
```

For `web` URLs, the user can still pick `in_app_player` in the dialog — we just iframe the URL. Many sites set `X-Frame-Options: SAMEORIGIN` and the iframe will refuse to load. We detect that via a 5s `load` event timeout on the iframe, and fall back to `external_browser` with a toast.

---

## 12. V3 extension protocol (scaffold only)

Document so V3 has a clean drop-in. **No code in V2 beyond the type definitions.**

### 12.1 Transport

WebSocket on `ws://127.0.0.1:8765`. The port is fixed (matching what the extension's manifest expects). Single connection per Jarvis instance. If the port is in use, Jarvis surfaces a settings error: "Companion port busy".

Why WS and not native messaging? Native messaging requires browser-specific manifests installed at OS paths and is awkward to ship. WS works on Chrome/Firefox/Edge with a single content-script + background-script pair, and Jarvis can verify connections via HMAC.

### 12.2 Auth

```ts
// shared/extension-protocol.ts
export type Handshake =
  | { type: 'auth'; token: string; clientVersion: string }
  | { type: 'auth-ok'; capabilities: string[] }
  | { type: 'auth-err'; reason: string };
```

Token is a 256-bit random value generated at first launch, stored at `appDataDir/extension-token`. The extension reads it from a Jarvis-hosted localhost endpoint protected by an installed-flag — see V3 plan.

### 12.3 Message types

```ts
export type ExtensionMessage =
  | Handshake
  | { type: 'state'; tabId: number; payload: NowPlaying }
  | { type: 'command'; tabId: number | 'active'; cmd: ExtensionCommand; args?: unknown }
  | { type: 'discover-tabs'; }
  | { type: 'tabs'; tabs: Array<{ id: number; url: string; title: string; isPlaying: boolean }> };

export type ExtensionCommand =
  | 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'stop'
  | 'seek-by' | 'seek-to' | 'volume' | 'mute'
  | 'skip-ad'   // V3-only: extension content script removes ad DOM nodes / forces .skip-button click
  | 'open-pip';
```

### 12.4 V2 stubs

Ship the type file plus a `useExtensionStore` placeholder that exposes `connected: false`. No socket open. This lets V2 settings UI render an "Install companion (V3)" CTA without a runtime branch.

---

## 13. Build/test plan

### 13.1 New unit tests

- `parseBookmarkHtml.test.ts` — Chrome export, Firefox export, malformed flat list, deeply nested folders.
- `inferKindFromUrl.test.ts` — every supported host + edge cases (youtu.be short, m.youtube.com, query-string playlists, file URLs).
- `IntentClassifier.test.ts` (extend) — every new RX_LAUNCHER and RX_MEDIA pattern with positive/negative cases.
- `useMediaStore.test.ts` — queue drain, bind/unbind lifecycle, volume clamp.
- `adDetect.test.ts` — happy path (skip succeeds), pre-roll (skip blocked), throttling (no second attempt within 1500ms).

### 13.2 New integration tests (Playwright on the web build)

- "Launch a quick link routes to MediaPlayer when behavior=in_app_player". Mock YT.Player.
- "Drag URL onto window opens edit dialog with prefilled URL".
- "Group launch opens N players with correct mounts".

### 13.3 Manual QA matrix

| platform | YT play | YT pause via voice | PiP window opens | Auto-skip-ad on a known mid-roll | Bookmark import |
|----------|:-------:|:------------------:|:----------------:|:--------------------------------:|:---------------:|
| Win 11   |   ☐     |        ☐           |        ☐         |              ☐                   |        ☐        |
| macOS    |   ☐     |        ☐           |        ☐         |              ☐                   |        ☐        |
| Linux    |   ☐     |        ☐           |        ☐         |              ☐                   |        ☐        |

---

## 14. Rollout phases

### Phase D1 — Quick Launch core (no media)

- Schema (B2 lands first).
- `LauncherPanel` + `LauncherGrid` + `LinkCard` + `LinkEditDialog` + groups.
- `kind ∈ {web, app, file, jarvis-action}`, `behavior ∈ {external_browser}` only.
- Hotkeys 1–9, voice `launch_quick_link`.

Ship gate: user can save 20 links, organize into groups, hotkey-launch the first 9, voice-launch by name.

### Phase D2 — MediaPlayer + YouTube

- `useMediaStore` + `MediaPlayer` + YT iframe loader.
- Add `kind ∈ {youtube, youtube-playlist, soundcloud}` and `behavior ∈ {in_app_player}`.
- Voice/palette media:* commands.
- Auto-skip-ad ON by default.

Ship gate: user can launch a YT playlist, voice-pause/resume, "skip ad" works on a non-pre-roll mid-roll ad.

### Phase D3 — PiP + side_panel + bookmark import

- `behavior ∈ {pip_window, side_panel}`.
- Bookmark HTML import.
- Drag-and-drop URL → add link.

Ship gate: PiP window stays on top, user can workout-mode their bookmarks with one chip click.

### Phase D4 — V3 prep (scaffold only)

- Extension protocol type file.
- Settings stub for "Companion (V3 preview)".
- No actual socket.

---

## 15. Risk register

| risk                                                | likelihood | impact | mitigation                                                         |
|-----------------------------------------------------|:----------:|:------:|--------------------------------------------------------------------|
| YouTube changes the iframe API                      | low        | high   | Pin to YT.Player constructor; integration test on every release.   |
| CSP loosening lets through a malicious YT script    | low        | medium | Use nocookie + isolated PiP capability + no `invoke` in PiP.       |
| Auto-skip-ad detection misfires on legitimate cuts  | medium     | low    | The diverged-videoId heuristic is conservative; we only seek when a different videoId persists ≥750ms. |
| Spotify/SoundCloud TOS changes break embeds         | medium     | medium | Settings escape hatch to force `external_browser` per kind.        |
| `tauri-plugin-global-shortcut` unstable on Linux    | medium     | low    | Window-level fallback already in place (`tauri.ts:151`).           |
| `localhost:8765` collides with other apps           | low        | low    | V3 only; configurable port + clear error on conflict.              |
| File path traversal via `kind=file` quick links     | low        | high   | Validate path under FS scope before shell-open; reject `..`.       |

---

## 16. Open questions

1. **Spotify scope.** Web Playback SDK requires a paid Premium account *and* an OAuth flow with a redirect URI. Should V2 ship the OAuth flow, or punt Spotify to "external only" until V3? Proposal: punt — keep §3's `external_browser` default and add an "experimental Spotify embed" toggle in V3.

2. **Group launch ordering.** When a group has 8 links and we launch them, does the user expect 4 PiPs to materialize on screen, or is that overwhelming? Proposal: cap at 4 PiPs (smallest viable workout setup); rest go to external browser. Validate with the user.

3. **Hotkey conflict policy.** If the user binds `Mod+Shift+1` to a quick link but B1's global-shortcut plugin already binds it for nav, who wins? Proposal: per-workspace user hotkeys override global defaults, but show an inline warning in `LinkEditDialog` when a conflict is detected.

---

## 17. Handoffs summary

**→ Planner B2 (storage + migrations):**
- New tables `quick_links` and `quick_link_groups` per §1.
- Dexie v9 migration string + indexing.
- Postgres DDL for cloud parity.
- Repository methods: `quickLinkRepo.{all,byGroup,touch,upsert,delete,allForActiveWorkspace,recent}` and `quickLinkGroupRepo.{all,upsert,delete,byWorkspace}`.

**→ Planner B1 (Tauri plumbing + CSP + shortcuts):**
- CSP block per §10.1.
- Capability changes: add `core:webview:allow-create-webview-window`, `global-shortcut:default`, `fs:allow-read-text-file` to `default.json`; create new `pip.json`.
- Register `tauri-plugin-global-shortcut` in `lib.rs:57`.
- Add Rust command `cmd_youtube_oembed` per §10.4.
- Wire `registerGlobalHotkey` in `tauri.ts:139` to actually call the plugin.

**→ Planner C (settings / panels) (if separate):**
- Settings → Media panel with the four toggles in §7.4.
- Inspector "Media" tab for `behavior=side_panel`.

---

End of plan.
