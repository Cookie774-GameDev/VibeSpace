# Plan E — Ambient Home Screen (idle takeover)

> Authored by main agent. Ready to paste.
> Cross-refs: plan-A (theme tokens, motion presets, ambient effects), plan-B2 (events feed), plan-C (terminal scrollback), plan-D (media state).

The user's ask, verbatim (paraphrased): *"Make a home page where it's clean UI when you left the thing unattended for a long time — Jarvis posts things in the background, animations, cool effects."*

---

## 1. Concept

**Ambient Home** is an idle-triggered overlay that takes over the Jarvis window when the user has been away. It is not a screensaver replacement (the OS-level screensaver still runs above us); it is the app's own cinematic "lock screen" — a calm, glanceable surface where Jarvis quietly posts thoughts, agenda, and the occasional invitation. It exits on any input.

Tone: *your study lamp at midnight*. Big time, soft greeting, drifting cards, breathing orb. Cyan/violet appears only where Jarvis is "thinking"; everything else is the warm Hearth ground from Plan A.

What it isn't:
- Not full-screen (the Jarvis window itself transitions; if user is in fullscreen, ambient mounts inside that).
- Not interactive in the way the workspace is. Cards are glance-and-go; clicking one opens that feature in the workspace.
- Not running heavy compute. Animations cap at GPU-only transforms; feed updates throttled.

---

## 2. Trigger system

### 2.1 Idle detection

```ts
// app/src/features/ambient/useIdleTrigger.ts
export interface IdleOpts {
  thresholdMs: number;     // 30s, 2m, 5m (default), 15m, 30m, 1h, never (Infinity)
  enabled: boolean;
  ignoreWhen: () => boolean; // e.g. battery <20% if user opted in
}

export function useIdleTrigger(opts: IdleOpts) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!opts.enabled || opts.thresholdMs === Infinity) return;
    let last = Date.now();
    let timer: ReturnType<typeof setInterval>;
    const onAct = () => { last = Date.now(); if (idle) setIdle(false); };
    const events: (keyof WindowEventMap)[] = [
      'mousemove','mousedown','keydown','wheel','touchstart','focus','visibilitychange'
    ];
    events.forEach(e => window.addEventListener(e, onAct, { passive: true } as any));
    timer = setInterval(() => {
      if (opts.ignoreWhen?.()) return;
      if (Date.now() - last >= opts.thresholdMs && !idle) setIdle(true);
    }, 1000);
    return () => {
      events.forEach(e => window.removeEventListener(e, onAct as any));
      clearInterval(timer);
    };
  }, [opts.enabled, opts.thresholdMs, idle]);
  return { idle, wake: () => setIdle(false) };
}
```

Mounted in `App.tsx` — when `idle === true`, it sets `useUIStore.ambient = true`. When user input is detected via the same hook, `wake()` flips it back.

### 2.2 Manual triggers

- `Mod+Shift+.` toggles ambient mode (per Plan A §8.1).
- Voice intent `"ambient mode"` / `"jarvis ambient"` (Planner D's IntentClassifier extension).
- Settings → Appearance → Ambient → "Try ambient now" button.

### 2.3 Battery awareness

If `navigator.getBattery()` is available **and** Settings → Ambient → "Pause on battery <20%" is on (default on), `ignoreWhen` returns true when `level < 0.2 && !charging`. This prevents draining a laptop with constant animations.

### 2.4 Network and notifications

- New Tauri OS notification or in-app toast → does **not** auto-wake. A toast shows in ambient as a `system` card briefly.
- Incoming sync ops → no wake.
- The window being focus-stolen (e.g. user clicks Jarvis from another app) → `focus` event wakes.

---

## 3. Visual layout

File tree:
```
app/src/features/ambient/
├─ AmbientHome.tsx          // root overlay
├─ AmbientCard.tsx          // generic card frame
├─ cards/
│  ├─ AgentThoughtCard.tsx
│  ├─ TaskGlanceCard.tsx
│  ├─ SchedulePeekCard.tsx
│  ├─ NowPlayingCard.tsx
│  ├─ TerminalGlanceCard.tsx
│  ├─ LinkHintCard.tsx
│  ├─ SystemCard.tsx
│  └─ QuoteCard.tsx
├─ AmbientOrb.tsx           // bigger, calmer variant of voice/Orb.tsx
├─ DriftField.tsx           // particle layer
├─ useAmbientFeed.ts
├─ useIdleTrigger.ts
├─ store.ts
├─ quotes.ts
└─ index.ts
```

### 3.1 Stack

```
<AmbientHome>          z-90, fixed inset-0
├─ background          // bg-[hsl(var(--ambient-deep))] + radial vignette
├─ DriftField          // 40 particles, opacity 0.05, drift up
├─ Top region          // time + greeting
├─ Card field          // 6-12 floating cards
└─ Bottom region       // breathing orb + status pills + exit hint
```

### 3.2 Top region

```
┌──────────────────────────────────────────────┐
│                                              │
│              09:42                            │  // 84px Inter Light, tnum, letter-spacing -2%
│              Wednesday, May 28                │  // 18px Inter Regular, muted-fg
│                                              │
│      Quiet evening, viper. 5 things tomorrow.│  // 15px greeting, rotates every 10 min
│                                              │
└──────────────────────────────────────────────┘
```

Greeting templates (10 rotated):
- "Good morning, {name}."
- "Quiet morning."
- "It's getting late, {name}."
- "Late night."
- "{n} things scheduled today."
- "Nothing on the books."
- "Halfway through Tuesday, {name}."
- "Almost the weekend."
- "Welcome back."
- "Just resting."

`{name}` falls back to "you" if no display name.

### 3.3 Card field (mid)

6-12 floating cards. Selection logic in `useAmbientFeed`. Each card:
- ~280×120px content, 16px corner radius, `bg-elevated/60`, `backdrop-blur-md`, 1px border `--border` 50% opacity, `shadow-cozy`.
- Drifts in a slow random-direction Bezier path (60s loop, ease-in-out), opacity 0.6→0.95 oscillating, 4-8s fade in / 4-8s fade out before despawn.
- Rotation tilt ±0.4° (cozy-tilt motion preset from Plan A §4.1).
- Random parallax response to mouse: cards within 200px of cursor shift 3–8px in opposite direction.

Card priority for slot allocation:
1. SchedulePeekCard (always show if event in next 8h)
2. NowPlayingCard (if MediaPlayer state ≠ idle)
3. SystemCard (if active system event, e.g. update available, sync error)
4. AgentThoughtCard (up to 3)
5. TaskGlanceCard (up to 2)
6. LinkHintCard (1 if a stale quick_link exists)
7. TerminalGlanceCard (1 if recent terminal output in last 5 min)
8. QuoteCard (fills remaining slots)

Slot count: 12 in `lively`, 8 in default, 6 on battery <20%.

### 3.4 Bottom region

```
┌──────────────────────────────────────────────┐
│                                              │
│                  ┌────┐                      │
│                  │  ◌ │  AmbientOrb 220px    │
│                  └────┘                      │
│                                              │
│   ●Jarvis  ●Athena   ⌁synced   GPT-4o        │  // status pills
│                                              │
│        Press any key to wake                  │  // exit hint
└──────────────────────────────────────────────┘
```

AmbientOrb: same 5-layer construction as `voice/Orb.tsx` but:
- Always in `idle` style (gentle 4s breathe).
- Tinted with current persona color (Jarvis = cyan/violet, Athena = teal, etc.).
- Tap (or `Enter`) starts voice → opens VoiceModal in ambient.

Status pills (right-aligned, small):
- Active agents (council mode if any are streaming): tiny dot + name.
- Sync state: `⌁ synced`, `↻ syncing`, `◔ offline`.
- Default model name (e.g. `claude-3.5-sonnet`).

Exit hint: muted, fades to 30% after 4s.

---

## 4. Card system & feed

### 4.1 Feed composer

```ts
// app/src/features/ambient/useAmbientFeed.ts
import type { AmbientCardSpec } from './types';

export function useAmbientFeed(maxCards: number): AmbientCardSpec[] {
  const events = useEvents({ fromMs: Date.now(), toMs: Date.now() + 8*3600_000 });
  const tasks = useOpenTasks();
  const memory = useRecentMemoryItems(24*3600_000);     // last 24h
  const media = useMediaState();                          // from Plan D
  const terminals = useRecentTerminalOutputs(5*60_000);   // last 5 min
  const staleLinks = useStaleQuickLinks(7*24*3600_000);   // unused 7d+
  const systemEvents = useSystemEvents();
  const quotes = useShuffledQuotes();

  return useMemo(() => {
    const out: AmbientCardSpec[] = [];

    for (const e of events.slice(0, 2)) out.push({ kind:'schedule-peek', priority:1, data:e });
    if (media.state === 'playing') out.push({ kind:'now-playing', priority:2, data:media });
    for (const s of systemEvents.slice(0, 1)) out.push({ kind:'system', priority:3, data:s });
    for (const m of memory.slice(0, 3)) out.push({ kind:'agent-thought', priority:4, data:m });
    for (const t of tasks.slice(0, 2)) out.push({ kind:'task-glance', priority:5, data:t });
    if (staleLinks.length) out.push({ kind:'link-hint', priority:6, data:staleLinks[0] });
    if (terminals.length) out.push({ kind:'terminal-glance', priority:7, data:terminals[0] });

    while (out.length < maxCards) {
      const q = quotes[out.length % quotes.length];
      out.push({ kind:'quote', priority:8, data: q });
    }
    return out.slice(0, maxCards);
  }, [events, tasks, memory, media, terminals, staleLinks, systemEvents, quotes, maxCards]);
}
```

Refresh interval: every 8s the feed re-evaluates. Existing cards keep their drift state if their kind+id matches a new one (using `id` as key).

### 4.2 Card spec

```ts
export type AmbientCardKind =
  | 'agent-thought' | 'task-glance' | 'schedule-peek' | 'now-playing'
  | 'terminal-glance' | 'link-hint' | 'system' | 'quote';

export interface AmbientCardSpec {
  kind: AmbientCardKind;
  priority: number;
  data: unknown;
  id?: string;  // stable id per (kind, source)
}
```

### 4.3 Per-card mini-specs

**AgentThoughtCard**
```
┌──────────────────────────────┐
│ ● Jarvis  · 12m ago          │   // agent badge + relative time
│                              │
│ "Watching the deploy log     │   // 1-2 sentences from memory_items.content
│  — staging is green again."  │
└──────────────────────────────┘
```
On click: opens chat thread that produced the memory item.

**TaskGlanceCard**
```
┌──────────────────────────────┐
│ ◐ Today                      │   // amber dot + date label
│                              │
│ Ship V2 plan to repo         │   // task.title
│ Due in 2h · High             │   // due_at + priority
└──────────────────────────────┘
```
On click: opens task in TodoPanel.

**SchedulePeekCard**
```
┌──────────────────────────────┐
│ ▣ 15:00–16:00                │
│                              │
│ Coffee with mom              │
│ Café Otto · in 2h            │   // location · relative
└──────────────────────────────┘
```
On click: opens Schedule view at that day.

**NowPlayingCard**
```
┌─────────┬────────────────────┐
│ [thumb] │ Track title        │
│ 60×60   │ Artist · 2:14/4:32 │
│         │ ▶ ⏸ ⏭              │   // controls inline
└─────────┴────────────────────┘
```
Inline controls work without leaving ambient. Click thumb opens MediaPlayer pane (which means ambient stays up — see §6 voice integration for the rule).

**TerminalGlanceCard**
```
┌──────────────────────────────┐
│ ▣ npm dev · 2 min ago        │
│                              │
│ vite v5.4.11 dev server     │   // last 1-2 lines, monospace
│ → http://localhost:5173      │
└──────────────────────────────┘
```
On click: focuses that terminal in the workspace.

**LinkHintCard**
```
┌──────────────────────────────┐
│ ★ Suggestion                 │
│                              │
│ Try your "Workout playlist"? │
│ Last opened 12 days ago      │
└──────────────────────────────┘
```
On click: launches the quick link.

**SystemCard**
```
┌──────────────────────────────┐
│ ⓘ System                     │
│                              │
│ Update available: v2.1.0     │
│                              │
└──────────────────────────────┘
```

**QuoteCard**
```
┌──────────────────────────────┐
│                              │
│ "The best way to predict the │
│  future is to invent it."    │
│ — Alan Kay                    │
└──────────────────────────────┘
```
30 quotes in `quotes.ts` (curated, no political/divisive content).

### 4.4 Live feed announcements

When a new card enters the field:
- Soft "agent-thought" or "schedule-peek" → fade in over 800ms in random edge.
- "system" cards → enter from top with `softBounce` motion.
- Reduced motion → no drift, just static placement; `aria-live="polite"` announces card title to screen reader.

---

## 5. Animation choreography

### 5.1 Entrance

```
state: ambient = false → true
  AppShell (underneath)  → animate opacity 1 → 0.30  (1200ms ease-out)
  AmbientHome             → animate opacity 0 → 1     (1200ms ease-out)
                            cards stagger in (0.08s each, first 6 cards)
  ambient drone fade-in   → -∞ → -42dB              (4000ms)  (only if enabled)
```

### 5.2 Idle behavior (looped while ambient)

- Cards drift continuously (60s Bezier loops).
- Time + greeting tick (greeting rotates every 10 min).
- Orb breathes (existing `Orb.tsx` `idle` style).
- DriftField particles: 40 small dots, 0.05 opacity, drift upward 30-60s, respawn at bottom.
- Cursor parallax: cards within 200px of cursor shift 3-8px opposite.
- Sound: optional drone (sine triad 220/330/440Hz at -42dB) — off by default.

### 5.3 Wake transition

```
state: ambient = true → false (any input)
  AmbientHome  → scale 1 → 1.02, opacity 1 → 0       (400ms ease-in)
  AppShell      → opacity 0.30 → 1                    (300ms ease-out)
  drone        → fade out                             (300ms)
  cards        → all fade out simultaneously
```

### 5.4 Reduced motion

When `prefers-reduced-motion: reduce`:
- No drift, no parallax, no particles.
- Entrance: simple opacity fade (220ms).
- Cards laid out in a static masonry grid.
- Orb: no breathe; static.
- Time + greeting still update.

### 5.5 Performance

- All animations are GPU-only (`transform`, `opacity`, `filter`).
- Cap concurrent cards at 12.
- Pause everything when `document.hidden` is true (RAF gate).
- Battery-aware: drop to 6 cards, disable drift, when battery <20% AND user has the toggle on.

---

## 6. Sound

### 6.1 Ambient drone (optional)

Off by default. Settings → Appearance → Ambient → "Background drone" toggle + volume slider.

```ts
// app/src/features/ambient/drone.ts
export class AmbientDrone {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  start() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.ctx.destination);
    for (const f of [220, 330, 440]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(this.gain);
      o.start();
      this.oscs.push(o);
    }
    this.gain.gain.linearRampToValueAtTime(
      Math.pow(10, -42/20), this.ctx.currentTime + 4
    );
  }
  stop() {
    if (!this.ctx || !this.gain) return;
    this.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.3);
    setTimeout(() => { this.oscs.forEach(o => o.stop()); this.ctx?.close(); }, 350);
  }
}
```

### 6.2 SFX

While in ambient: SFX cues are **suppressed** (per Plan A §5.2 — adds an `inAmbient` gate). Notification toasts are in-app only (no desktop pop-ups breaking immersion).

---

## 7. Voice integration

### 7.1 Wake word

Voice service stays running in idle. Saying "Jarvis" wakes ambient mode + opens VoiceModal. (V2 minimal: Web Speech keyword detection. Phase 3 swaps in proper wake-word engine.)

### 7.2 Jarvis speaking unprompted

Rate-limited to **1 per 30 minutes** unless urgent (a fired event reminder). When firing, AmbientHome shows a `system` card with the spoken text + `aria-live="assertive"`. Uses Web Speech `speechSynthesis` (V2 minimal).

Triggers:
- 5 min before a calendar event (urgent).
- "Daily briefing" — 3x daily (configurable hours): "Good morning. 3 things on the books today."
- Long-running terminal completes with exit_code != 0 (urgent error).
- New incoming notification with priority=high.

### 7.3 Ambient + voice coexistence

When VoiceModal opens from ambient: the modal mounts above ambient (z-100), the overlay fades to 0.4 opacity briefly. Closing the voice modal restores ambient.

---

## 8. Settings

Settings → Appearance → Ambient Mode (new sub-section):

- **Enable ambient mode** (toggle, default on).
- **Idle threshold**: 30s | 2m | **5m** (default) | 15m | 30m | 1h | never.
- **Pause on battery <20%** (toggle, default on).
- **Posts** (per-kind toggles):
  - Agent thoughts (default on)
  - Tasks (default on)
  - Schedule (default on)
  - Now playing (default on)
  - Terminal (default off — can be noisy)
  - Link hints (default on)
  - System (default on)
  - Quotes (default on)
- **Posts feed rate**: relaxed | moderate (default) | chatty.
- **Background drone**: toggle (default off) + volume slider (when on).
- **Wake-word in ambient**: toggle (default on; respects global voice toggle).
- **Auto-darken**: toggle (default on; adds `--ambient-deep` ground; off uses `--background`).
- **Try ambient now** button — preview without waiting for idle.

Backed by `useUIStore.ambient*` keys + persisted via `settingsRepo`.

---

## 9. Performance + a11y

### 9.1 Performance budget

- Cap visible cards at 12.
- Limit concurrent particles to 40 (DriftField).
- Pause all RAF when `document.hidden`.
- Throttle feed recompute to 8s.
- Avoid layout thrash: cards transform via CSS only (no width/height animations).
- AudioContext only created when drone enabled.

### 9.2 Accessibility

- Outer overlay: `role="region" aria-label="Ambient mode"`.
- Time text: `aria-live="off"` (changes too frequently); a separate `aria-live="polite"` div announces only persona greeting changes.
- Cards: each has `role="button"` (or `<button>`), focusable, Tab cycles between them, Enter activates.
- AmbientOrb: `role="button" aria-label="Start voice"` — Enter starts voice.
- Wake conditions exhaustive (§10) → keyboard users wake on any keypress; mouse users on movement; focus events from screen-reader navigation also wake.
- Reduced-motion path: static layout, no drift, no parallax.
- Reduced-transparency: drop backdrop-blur on cards.
- High-contrast: borders bumped to 2px and at full opacity.

---

## 10. Wake conditions (exhaustive)

| Source | Condition | Behavior |
|---|---|---|
| Mouse | move >5px since idle, click, wheel | Wake immediately |
| Keyboard | any keydown | Wake immediately |
| Touch | touchstart anywhere | Wake immediately |
| Focus | window/document focus event | Wake |
| Voice wake-word | "Jarvis" detected | Wake + open VoiceModal |
| Global hotkey | `Mod+Space` PTT | Wake + open VoiceModal |
| Manual hotkey | `Mod+Shift+.` | Toggle (so it can also force OFF) |
| OS notification | incoming (Tauri) | **Don't wake**; show as system card |
| Sync | sync started | Don't wake |
| New chat (programmatic) | `jarvis:new-chat` event | Don't wake (dedicated wake required) |
| Network reconnect | offline → online | Don't wake; refresh feed |
| Visibility | document.visibilityState=visible after hidden | Wake |

---

## 11. Coordination with other planners

| Need | Source | API expected |
|---|---|---|
| Agent thoughts | memory_items table | `useRecentMemoryItems(sinceMs)` query (existing repo) |
| Schedule events | events table | Plan B2 §4 `useEvents({ fromMs, toMs })` hook |
| Now-playing state | MediaPlayer | Plan D `useMediaStore` exposing `{ state, track, ad }` |
| Terminal output | terminal_scrollback | Plan C `useRecentTerminalOutputs(sinceMs)` reading last N chunks |
| Stale quick links | quick_links | Plan D `useStaleQuickLinks(sinceMs)` filtering on `last_used_at` |
| System events | local in-memory | New `useSystemEvents()` hook subscribing to update/sync/error events |
| Voice TTS | speechSynthesis | Plan B2 §4.5 + Plan E §7.2 share helper `speakReminder(event)` |
| Theme tokens | globals.css `--ambient-deep` | Plan A §2.1 |
| Motion presets | `lib/motion.ts` | Plan A §4.2 |
| SFX gate `inAmbient` | `useUIStore.ambient` | Plan A §5.2 reads it |
| Reduced motion | `prefers-reduced-motion` | Already enforced by MotionConfig |

End of plan-E.
