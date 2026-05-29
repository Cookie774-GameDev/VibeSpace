# Plan A — UX, Theme, Motion, Sound, Accessibility, Polish

> Authored by main agent (subagent retries returned empty). Concrete, ready to paste.
> Cross-refs: plan-B1 (CSP, fonts), plan-B2 (settings backing data), plan-C (terminal theming), plan-D (player surfaces), plan-E (ambient home).

---

## 1. Cozy-meets-Voltage — design narrative

V1 shipped a clean "Voltage" surface: pure-OLED grounds, cyan-to-violet accent, electric edges. It reads cold. The user wants it to feel like Claude — warm, lived-in, calm — without losing the "council of agents" energy.

The answer: **Hearth grounds with Voltage edges.** We swap the pure 0% saturation surfaces for a warm coal palette (~28° hue, 5–10% sat), shift body type a half-step larger and a touch warmer, and **only let cyan/violet surface where AI is active** — message left-borders, voice orb, focus rings, conic glows, agent badges. We add **amber** as a third accent reserved for human actions (tasks, schedule, links) so the eye learns: cyan = AI thinking, violet = AI synthesizing, amber = you owning the day.

Texture: subtle SVG noise overlay (2% opacity), soft cursor glow, occasional drifting orb. Idle/ambient mode (Planner E) takes this further into a cinematic home screen. Sound: 12 generated SFX cues so the app feels haptic without ever being noisy. Motion: 8 named presets, all spring-based, all reduced-motion safe.

The metaphor is your study lamp at midnight, not a spaceship cockpit. The app should feel like a journal that lights up when something matters.

---

## 2. Theme tokens v2

All values are HSL channels (`H S% L%`) consumed by Tailwind via `hsl(var(--token))`. Existing token names preserved for non-breaking swap. New tokens at the bottom of each table.

### 2.1 Dark theme (default)

| Token | Old | New HSL | New hex | Role |
|---|---|---|---|---|
| `--background` | `0 0% 4%` | `28 8% 6%` | `#100E0C` | App ground, warm coal |
| `--panel` | `0 0% 7%` | `28 7% 9%` | `#1A1816` | NavPane, TopBar, Composer |
| `--elevated` | `0 0% 10%` | `28 6% 12%` | `#221F1C` | Dialogs, cards, popovers |
| `--border` | `0 0% 15%` | `28 5% 18%` | `#312D29` | Default 1px borders |
| `--border-mid` | `0 0% 20%` | `28 5% 25%` | `#403B36` | Hover/focus borders |
| `--input` | `0 0% 15%` | `28 5% 18%` | `#312D29` | Input chrome |
| `--ring` | `187 95% 43%` | `187 95% 50%` | `#11D2EC` | Focus ring (cyan, brighter) |
| `--foreground` | `0 0% 98%` | `30 10% 96%` | `#F8F4EE` | Primary text, warm parchment |
| `--muted` | `0 0% 15%` | `28 5% 16%` | `#2B2724` | Inline muted bg |
| `--muted-foreground` | `0 0% 64%` | `28 6% 65%` | `#A39C92` | Secondary text |
| `--accent-cyan` | `187 95% 43%` | `187 95% 50%` | `#11D2EC` | AI thinking, beams |
| `--accent-violet` | `258 90% 66%` | `258 92% 70%` | `#9C7CFB` | AI synthesizing |
| `--accent` | `220 90% 56%` | `220 88% 60%` | `#3D7BFA` | Mid-point fallback |
| `--accent-foreground` | `0 0% 98%` | `30 10% 96%` | `#F8F4EE` | Text on accent fills |
| `--primary` | `220 90% 56%` | `220 88% 60%` | `#3D7BFA` | Alias of accent |
| `--primary-foreground` | `0 0% 98%` | `30 10% 96%` | `#F8F4EE` | Text on primary |
| `--secondary` | `0 0% 13%` | `28 5% 14%` | `#27241F` | Secondary buttons |
| `--secondary-foreground` | `0 0% 98%` | `30 10% 96%` | `#F8F4EE` | Text on secondary |
| `--destructive` | `0 72% 56%` | `4 78% 58%` | `#E84B3F` | Errors, deletes |
| `--destructive-foreground` | `0 0% 98%` | `30 10% 96%` | `#F8F4EE` | Text on destructive |
| `--success` | `158 64% 40%` | `158 60% 45%` | `#2EBA84` | Done states |
| `--warning` | `38 92% 50%` | `32 95% 55%` | `#F59929` | High-priority badges |
| `--info` | `187 95% 43%` | `187 95% 50%` | `#11D2EC` | Info badges (matches cyan) |
| **NEW** `--accent-amber` | — | `32 95% 60%` | `#F4A641` | Human actions: tasks, schedule, quick links |
| **NEW** `--accent-amber-foreground` | — | `28 12% 8%` | `#171411` | Text on amber fills |
| **NEW** `--surface-warm` | — | `28 12% 14%` | `#26211B` | User-message bubbles, link cards |
| **NEW** `--ink-soft` | — | `30 8% 88%` | `#E2DDD3` | Body copy in cards |
| **NEW** `--grain` | — | `30 5% 8%` | `#15130F` | Noise overlay base color |
| **NEW** `--cursor-glow` | — | `187 95% 50%` | `#11D2EC` | Idle cursor halo |
| **NEW** `--ambient-deep` | — | `28 10% 4%` | `#0C0A09` | Ambient-mode darkest ground (Planner E) |
| **NEW** `--shadow-warm` | — | `28 30% 4%` | `#0F0B07` | rgba shadow base for cozy glows |

Keep `--radius: 0.625rem`.

### 2.2 Light theme (parchment)

| Token | New HSL | Hex | Role |
|---|---|---|---|
| `--background` | `30 30% 97%` | `#F9F5EE` | App ground, warm paper |
| `--panel` | `30 22% 95%` | `#F4EFE4` | NavPane, TopBar |
| `--elevated` | `30 20% 99%` | `#FCFAF5` | Cards, dialogs |
| `--border` | `28 14% 85%` | `#DCD2C2` | Default borders |
| `--border-mid` | `28 12% 75%` | `#C5BAA6` | Hover borders |
| `--input` | `28 14% 85%` | `#DCD2C2` | Input chrome |
| `--ring` | `187 88% 38%` | `#0FA2BC` | Focus ring |
| `--foreground` | `28 18% 12%` | `#241D14` | Primary text, ink |
| `--muted` | `30 16% 92%` | `#EDE5D5` | Inline muted bg |
| `--muted-foreground` | `28 10% 38%` | `#69604F` | Secondary text |
| `--accent-cyan` | `187 88% 38%` | `#0FA2BC` | AI thinking |
| `--accent-violet` | `258 70% 50%` | `#673CD9` | AI synthesizing |
| `--accent` | `220 80% 50%` | `#1A65E6` | Mid-point |
| `--accent-foreground` | `30 30% 97%` | `#F9F5EE` | Text on accent |
| `--accent-amber` | `28 80% 48%` | `#DC7E1F` | Human actions |
| `--accent-amber-foreground` | `30 30% 97%` | `#F9F5EE` | Text on amber |
| `--surface-warm` | `30 26% 92%` | `#EFE7D6` | User bubbles |
| `--destructive` | `4 70% 48%` | `#CD3D32` | Errors |
| `--success` | `158 56% 36%` | `#28956B` | Done |
| `--warning` | `32 90% 46%` | `#DA8418` | High-priority |
| `--ambient-deep` | `30 26% 90%` | `#EAE0CC` | Ambient ground (light) |

Light theme is provisional in V1; V2 ships polished but defaults to dark.

### 2.3 globals.css patch summary

Append the new token names to both `:root, [data-theme='dark']` and `[data-theme='light']` blocks, replace existing values per tables above. Add new utility classes:

```css
@layer components {
  .surface-warm { @apply bg-[hsl(var(--surface-warm))]; }
  .text-ink-soft { color: hsl(var(--ink-soft)); }
  .text-amber { color: hsl(var(--accent-amber)); }
  .border-amber { border-color: hsl(var(--accent-amber)); }
  .bg-amber { background-color: hsl(var(--accent-amber)); }
  .shadow-cozy { box-shadow: 0 4px 14px -2px hsl(var(--shadow-warm) / 0.6),
                              0 1px 0 0 hsl(var(--accent-cyan) / 0.06) inset; }
  .grain-overlay::after {
    content: '';
    position: absolute; inset: 0; pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>");
    opacity: 0.025; mix-blend-mode: soft-light; z-index: 0;
  }
}
```

Tailwind config: extend `colors` with `amber: 'hsl(var(--accent-amber))'`, `'amber-foreground': 'hsl(var(--accent-amber-foreground))'`, `'surface-warm': 'hsl(var(--surface-warm))'`, `'ink-soft': 'hsl(var(--ink-soft))'`.

---

## 3. Typography

### 3.1 Scale

| Token | Size / line-height / weight | Letter-spacing | Usage |
|---|---|---|---|
| `text-display` | 18 / 24 / 600 | -0.02em | Empty-state titles, ambient time |
| `text-page-title` | 16 / 22 / 600 | -0.015em | Dialog titles |
| `text-title` | 15 / 22 / 600 | -0.01em | Section headers |
| `text-body` | **13.5** / 20 / 400 | -0.005em | Default body, chat, settings |
| `text-secondary` | 12.5 / 18 / 400 | 0 | Secondary copy, hints |
| `text-metadata` | 11 / 14 / 500 | 0.02em | Timestamps, kbd chips, badges |
| `text-ui-strong` | 13 / 18 / 600 | -0.01em | Buttons, agent names, nav |
| `text-mono` | 12 / 18 / 400 | 0 (`tnum`) | Code, model strings |

Reasoning: 13.5px body is one notch warmer than 13px without breaking 8px-grid math (`line-height: 20px` keeps it grid-aligned). The half-step matches Linear and recent Vercel surfaces. Cozy means slightly more leading too — bumped from 19 to 20.

### 3.2 Fonts

- **Sans**: Inter v4 (variable) — features `'cv11','ss01','ss03','tnum','calt'`. Weight range 400–700.
- **Mono**: JetBrains Mono — features `'tnum','calt'`. Weights 400–600.
- **Self-hosted via `@fontsource-variable/inter` + `@fontsource/jetbrains-mono`** (Planner B1 enforces — no CDN).

### 3.3 Tailwind extension

Add to `tailwind.config.ts -> theme.extend.fontSize`:

```ts
fontSize: {
  display:    ['18px',  { lineHeight: '24px', letterSpacing: '-0.02em',  fontWeight: '600' }],
  'page-title': ['16px', { lineHeight: '22px', letterSpacing: '-0.015em', fontWeight: '600' }],
  title:      ['15px',  { lineHeight: '22px', letterSpacing: '-0.01em',  fontWeight: '600' }],
  body:       ['13.5px',{ lineHeight: '20px', letterSpacing: '-0.005em', fontWeight: '400' }],
  secondary:  ['12.5px',{ lineHeight: '18px', letterSpacing: '0',        fontWeight: '400' }],
  metadata:   ['11px',  { lineHeight: '14px', letterSpacing: '0.02em',   fontWeight: '500' }],
  'ui-strong':['13px',  { lineHeight: '18px', letterSpacing: '-0.01em',  fontWeight: '600' }],
  mono:       ['12px',  { lineHeight: '18px', letterSpacing: '0',        fontWeight: '400' }],
}
```

---

## 4. Motion presets

Centralized in `app/src/lib/motion.ts`. Each preset returns Motion-compatible `transition` and `variants`. All gated by `<MotionConfig reducedMotion="user">` already mounted in `AppShell.tsx:65`.

### 4.1 Preset table

| Name | Type | Spring / easing | Duration | Distance | Reduced-motion fallback |
|---|---|---|---|---|---|
| `entrance-fade` | spring | s=320 d=28 m=0.7 | ~280ms | y: 8→0 | opacity only |
| `hover-lift` | spring | s=520 d=24 | ~120ms | y: -1, scale: 1.005 | none (no transform) |
| `expand-row` | spring | s=400 d=34 | ~340ms | height auto | instant height |
| `soft-bounce` | spring | s=180 d=14 m=0.9 | ~600ms | scale 0.95→1.04→1 | scale 1 instant |
| `pulse-active` | tween | easeInOut, repeat ∞ | 2400ms | opacity 0.6→1 | static opacity 1 |
| `panel-slide` | spring | s=380 d=34 | ~360ms | x: 240→0 | opacity 0→1 |
| `voice-listening` | tween | easeInOut, repeat ∞ | 1600ms | scale 1→1.04→1 | static |
| `route-cross-fade` | tween | easeOut | 220ms | opacity 0→1 | instant |
| `cozy-tilt` | spring | s=300 d=22 | ~180ms | rotate 0→0.4° | static |

### 4.2 Code

```ts
// app/src/lib/motion.ts
import type { Transition, Variants } from 'motion/react';

export const SPRING = {
  responsive: { type: 'spring', stiffness: 400, damping: 30, mass: 0.8 },
  bouncy:     { type: 'spring', stiffness: 180, damping: 14, mass: 0.9 },
  snappy:     { type: 'spring', stiffness: 520, damping: 24, mass: 0.6 },
  gentle:     { type: 'spring', stiffness: 320, damping: 28, mass: 0.7 },
  slide:      { type: 'spring', stiffness: 380, damping: 34 },
} satisfies Record<string, Transition>;

export const VARIANTS = {
  entranceFade: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: SPRING.gentle },
    exit:    { opacity: 0, y: -4, transition: { duration: 0.18 } },
  },
  hoverLift: {
    rest:  { y: 0,  scale: 1 },
    hover: { y: -1, scale: 1.005, transition: SPRING.snappy },
    press: { y: 0,  scale: 0.985, transition: { duration: 0.08 } },
  },
  expandRow: {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto', transition: SPRING.slide },
    exit:    { opacity: 0, height: 0,    transition: SPRING.slide },
  },
  softBounce: {
    initial: { scale: 0.95, opacity: 0 },
    animate: { scale: 1,    opacity: 1, transition: SPRING.bouncy },
  },
  pulseActive: {
    animate: { opacity: [0.6, 1, 0.6], transition: { duration: 2.4, ease: 'easeInOut', repeat: Infinity } },
  },
  panelSlide: {
    initial: { x: 240, opacity: 0 },
    animate: { x: 0,   opacity: 1, transition: SPRING.slide },
    exit:    { x: 240, opacity: 0, transition: SPRING.slide },
  },
  voiceListening: {
    animate: { scale: [1, 1.04, 1], transition: { duration: 1.6, ease: 'easeInOut', repeat: Infinity } },
  },
  routeCrossFade: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.22, ease: 'easeOut' } },
    exit:    { opacity: 0, transition: { duration: 0.16 } },
  },
  cozyTilt: {
    rest:  { rotate: 0 },
    hover: { rotate: 0.4, transition: SPRING.snappy },
  },
} satisfies Record<string, Variants>;
```

---

## 5. SFX cues

Generated entirely via Web Audio oscillators — no asset bundle, no licensing, no network. Single shared `AudioContext` lazily created on first user gesture (initial mute until then to satisfy autoplay policies).

### 5.1 Cue table

| Cue | Oscillator(s) | Freq Hz | Attack ms | Release ms | Gain dB | Trigger |
|---|---|---|---|---|---|---|
| `send-message` | sine | 880 | 5 | 40 | -18 | `jarvis:send` dispatched |
| `receive-message` | sine | 660 | 5 | 60 | -20 | runtime stream `done: true` |
| `agent-stream-start` | triangle | 440 | 5 | 120 | -22 | first chunk of stream |
| `agent-stream-end` | sine | 660 | 5 | 40 | -22 | `setRunState(id,'done')` |
| `task-create` | square | 1320 | 3 | 30 | -26 | `TaskService.createTask` resolved |
| `task-complete` | sine + sine | 880 + 1320 | 5 | 200 | -18 | `TaskService.completeTask` |
| `palette-open` | sawtooth | 220 | 1 | 10 | -28 | `setPaletteOpen(true)` |
| `palette-confirm` | sine | 880 | 3 | 40 | -22 | palette action invoked |
| `voice-wake` | triangle | 660 | 10 | 200 | -16 | wake word fired |
| `voice-listening-loop` | sine (low gain, looped) | 440 | 200 | — | -32 | `voiceListening = true` |
| `error` | sawtooth | 220 | 5 | 120 | -18 | `toast.error()` |
| `success-ding` | sine | 1760 | 5 | 300 | -16 | `toast.success()` |

All cues gated by:
1. `useUIStore.sfxMuted` (false by default; surfaced in Settings → Appearance).
2. `prefers-reduced-motion: reduce` user CSS pref (treated as also wanting calm).
3. AudioContext suspended until first user gesture (auto-resumed by hook).

### 5.2 Hook spec

```ts
// app/src/lib/sfx.ts
type CueId = 'send-message' | 'receive-message' | 'agent-stream-start'
  | 'agent-stream-end' | 'task-create' | 'task-complete'
  | 'palette-open' | 'palette-confirm' | 'voice-wake'
  | 'voice-listening-loop' | 'error' | 'success-ding';

interface CueSpec {
  type: OscillatorType;
  freq: number | [number, number]; // chord
  attack: number; release: number; gainDb: number;
  loop?: boolean;
}

export const CUES: Record<CueId, CueSpec> = { /* table above */ };

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

export function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.6;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function playCue(id: CueId): void {
  const muted = useUIStore.getState().sfxMuted;
  if (muted) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = ensureCtx();
  if (!c || !masterGain) return;

  const spec = CUES[id];
  const freqs = Array.isArray(spec.freq) ? spec.freq : [spec.freq];
  const now = c.currentTime;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = spec.type; osc.frequency.value = f;
    const peak = Math.pow(10, spec.gainDb / 20);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + spec.attack / 1000);
    g.gain.exponentialRampToValueAtTime(0.0001, now + (spec.attack + spec.release) / 1000);
    osc.connect(g).connect(masterGain);
    osc.start(now);
    osc.stop(now + (spec.attack + spec.release) / 1000 + 0.05);
  }
}

export function useSfx() {
  return { play: playCue };
}
```

Wire `playCue` into existing dispatchers:
- `Composer.tsx:172` — `playCue('send-message')` after `dispatchEvent('jarvis:send')`.
- `runtime.ts:218` — first chunk → `playCue('agent-stream-start')`; on success → `playCue('receive-message')`.
- `TaskService.completeTask` → `playCue('task-complete')`.
- `command-palette/store.ts` set open → `playCue('palette-open')`; action invoke → `playCue('palette-confirm')`.
- `toast.ts` → `playCue('success-ding' | 'error')`.

### 5.3 Settings → Appearance → Sound

- Master mute (default on; first launch UI prompts user with onboarding).
- Volume slider (0–100, mapped 0→-∞ dB, 100→-6dB).
- Per-cue toggles (12 checkboxes for advanced users) collapsed under "Customize".

---

## 6. Ambient effects (always-on, not idle-mode)

### 6.1 Cursor glow

200px radial halo at 4% cyan opacity, fixed-position, following pointer with damped lag (60ms exponential, RAF-driven). Mounts in `App.tsx` next to `<Toaster />` as `<CursorGlow />`. Hidden on touch devices (`pointer: coarse`).

### 6.2 Grain overlay

SVG noise data-URI as `::after` pseudo on `body`, 2% opacity, `mix-blend-mode: soft-light`, `pointer-events: none`. CSS in `globals.css` (already drafted in §2.3).

### 6.3 Drift orb (passive ambient)

A small (16px), low-opacity (6%) orb that spawns once per minute, drifts across the canvas in 8s on a curved path, then despawns. Caps at 1 concurrent. Pure CSS via Motion `useAnimate`.

```ts
// app/src/components/ambient/DriftOrb.tsx — separate from voice Orb.tsx
```

### 6.4 Levels & gating

`useUIStore.ambientLevel: 'off' | 'subtle' | 'lively'` (default `subtle`):
- `off` — disable all three above.
- `subtle` — cursor glow only, no grain, no drift.
- `lively` — all three on.

Always disabled when `prefers-reduced-motion: reduce`. Battery-aware downgrade on `<20%` if Battery API available.

> **Coordination with Planner E**: ambient *home screen* (idle takeover) is a separate surface (`features/ambient/`). The §6 effects are background ambience that runs in normal usage. Both honor `ambientLevel` and reduced-motion.

---

## 7. Broken-UI inventory

Cited file:line numbers from V1 source. Priorities: **P0** = looks broken / unwired / blocking, **P1** = cosmetic placeholder / weak polish, **P2** = a11y or edge cases.

| Pri | Area | File:line | Problem | Fix (executor wave) |
|---|---|---|---|---|
| P0 | Composer | `chat/Composer.tsx:226` | Send button has no streaming/loading state — user can re-fire while a stream is in flight | Wire `useAgentStore` `runState` to disable + swap icon to `Loader2` when streaming. (E5) |
| P0 | Composer | `chat/Composer.tsx:32-39` | Provider list hardcoded; doesn't include xAI/Ollama/OpenCode (Planner B2 adds) | Replace with dynamic list from registered providers. (E2) |
| P0 | NavPane | `layout/NavPane.tsx:38-42` | "Projects" / "Chats" sections show only EmptyHint — never wired to data | Wire to `chatRepo.listAll()` + `useProjectStore`. (E5) |
| P0 | TopBar | `layout/TopBar.tsx:35` | Workspace shows literal string `'Workspace'` not real name | Wire to `workspaceRepo` + auth store. Already flagged in source comment. (E5) |
| P0 | Inspector | `layout/Inspector.tsx` | Slide-over content is placeholder | Replace with route-aware contents (chat info / agent profile / task drawer). (E5) |
| P0 | TabStrip | `layout/TabStrip.tsx` | Tabs static; no state mgmt for opened canvases | Wire to `useUIStore.tabs` array; persist. (E5) |
| P0 | Chat | `chat/ChatThread.tsx` | No virtualization → 1k messages will lag. No streaming caret. | Add `react-virtual`, add caret on last assistant msg while streaming. (E5) |
| P0 | Onboarding | `onboarding/Onboarding.tsx:99` | Step transitions slide both axes; persona step has no visual differentiation between presets | Persona cards need icon + amber selected-state. (E10) |
| P0 | Settings | `settings/SettingsModal.tsx:84-117` | Left rail tab indicator is flat `bg-elevated` — no shared layout id, no underline | Add `motion.span layoutId="settings-tab-pill"` behind active tab. (E10) |
| P0 | Settings | `settings/sections/Providers.tsx` | Only 4 providers, no per-provider model picker, no effort slider | Rebuild as per Planner B2 §1+§2. (E2) |
| P0 | Voice | `voice/VoiceModal.tsx:128-186` | Orb doesn't react to mic RMS — STYLES table is static; no AudioContext analyzer | Add `AnalyserNode` in VoiceService; pipe RMS to Orb scale via `useMotionValue`. (E6) |
| P0 | Voice | `voice/VoiceService.ts` | Web Speech API only, no real TTS speaking back | Add Web Speech `speechSynthesis` for V2 minimal "Jarvis talks back"; better engines deferred. (E6) |
| P0 | Tasks | `tasks/TodoPanel.tsx:148` | TaskComposer parses NL but no schedule/event detection | Hook into `parseEventInput` (Planner B2 §4) when input mentions a time. (E3) |
| P0 | Council | `council/CouncilView.tsx` | Static beam layer, not bound to real agent stream events | Subscribe each panel to its agent's `runState`; trigger beam on streaming. (E5) |
| P1 | Dialog | `ui/dialog.tsx:38` | Dialog has no shadow-cozy variant; uses raw `shadow-2xl` | Add `shadow-cozy` (defined §2.3) and apply. (E10) |
| P1 | Dialog | `ui/dialog.tsx:39` | Animation is `animate-scale-in` (CSS keyframe) — switch to Motion spring | Use `motion.div` content with `softBounce` variant. (E10) |
| P1 | Button | `ui/button.tsx:6-33` | No press-state ripple, no `accent-amber` variant | Add `amber` variant + `active:scale-[0.985]` + optional ripple. (E10) |
| P1 | Composer | `chat/Composer.tsx:240-264` | Border focus ring is faint; no warm hover on border | `focus-within:border-accent-cyan/60` + `focus-within:shadow-[0_0_0_3px_hsl(var(--accent-cyan)/0.08)]`. (E10) |
| P1 | MessageBubble | `chat/MessageBubble.tsx:100` | User bubble uses `bg-muted` → cold; should be `bg-surface-warm` | Swap. (E10) |
| P1 | MessageBubble | `chat/MessageBubble.tsx:141-153` | Assistant message border is 1px static; should hover-lift | Wrap in `motion.div` with `hoverLift`. Add streaming caret (`▌` blink) when last msg + streaming. (E10) |
| P1 | EmptyChat | `chat/EmptyChat.tsx:42-46` | Generic copy; doesn't address user by name or persona | Pull `displayName` + persona greeting templates (rotate). (E10) |
| P1 | NavPane | `layout/NavPane.tsx:80-89` | Collapsed-state items have no Tooltip; only `title=` | Wrap each `NavItem` in `<Hint>` from ui primitives. (E10) |
| P1 | NavPane | `layout/NavPane.tsx:25-31` | Width animation is spring but no `overflow: hidden` mask on text → flickers during collapse | Animate text opacity separately, fade out at 0.5 progress. (E10) |
| P1 | TopBar | `layout/TopBar.tsx:135-142` | Avatar has no profile menu | Wrap in Popover with Sign In / Sign Out / Settings / About. (E5) |
| P1 | TopBar | `layout/TopBar.tsx:117-120` | Voice listening pulse uses generic `animate-pulse` — should match orb cadence | Use `voiceListening` motion variant, sync 1.6s. (E10) |
| P1 | Toast | `ui/toast.tsx` | Stacks without rotation alternation; no warm shadow | Apply 0.5deg alternating tilt + shadow-cozy. (E10) |
| P1 | TaskCard | `tasks/TaskCard.tsx:117` | Hover uses `border-border-mid`; should warm via amber tint when due-soon | Conditional border tint by due proximity. (E10) |
| P1 | TaskCard | `tasks/TaskCard.tsx:140` | Checkbox check has no draw animation | Wrap check icon in `motion.svg` with stroke pathLength animation. (E10) |
| P1 | Onboarding | `onboarding/Onboarding.tsx:166-170` | Progress dot active state width is static `w-8` | `motion.div layoutId="onboarding-dot"` shared between active/inactive. (E10) |
| P1 | Settings/Account | `settings/sections/Account.tsx` | No avatar editor, no display-name inline edit affordance | Add inline-edit pattern. (E2) |
| P1 | Settings/Hotkeys | `settings/sections/Hotkeys.tsx` | List is read-only; no rebind affordance | Implement keybind capture; persist to `useUIStore.hotkeys`. (E2) |
| P1 | globals.css | `styles/globals.css:105-118` | Scrollbar only thumb visible; no `:hover:wider` | Slightly widen thumb on hover, matches macOS ergonomics. (E10) |
| P1 | globals.css | `styles/globals.css:127-131` | Focus ring is hard outline | Replace with cyan/violet glow per §8. (E10) |
| P2 | Dialog | `ui/dialog.tsx:32-50` | DialogContent missing `aria-describedby` plumbing — relies on consumers to pass DialogDescription, which is fine but not enforced | Document + lint. (E10) |
| P2 | Composer | `chat/Composer.tsx:244-264` | Textarea has no `aria-label` for the placeholder context | Already `aria-label="Message"` — add `aria-multiline="true"`. (E10) |
| P2 | Voice | `voice/VoiceModal.tsx:138-141` | `aria-live="polite"` good; but error state should be `assertive` | Conditional `aria-live`. (E6) |
| P2 | TopBar | `layout/TopBar.tsx:65-70` | Avatar has only `seed` and decorative — workspace label should be the live region | `aria-live="polite"` on label, `aria-hidden` on avatar. (E10) |
| P2 | NavPane | `layout/NavPane.tsx:32` | Scroll region `overflow-y-auto` with no scroll shadows | Add scroll shadow utility. (E10) |
| P2 | TodoPanel | `tasks/TodoPanel.tsx:152` | Scroll region likewise | Same. (E10) |
| P2 | Onboarding | `onboarding/Onboarding.tsx:153-172` | Progress dots not announced; use `aria-current="step"` | Add. (E10) |
| P2 | Globals | `styles/globals.css:79-82` | `border-border` applied universally via `*` — fine, but means every element pays a paint cost | No-op; document. |
| P2 | Onboarding | `onboarding/Onboarding.tsx:87` | Outer dialog uses `role="dialog"` but no `aria-modal` | Add `aria-modal="true"`. (E10) |

> **Total: 41 entries** (≥25 required). Executor E10 owns all polish-only items; E2/E3/E5/E6 own the structural ones tagged in their wave.

---

## 8. Accessibility plan

### 8.1 Keyboard map

| Action | Hotkey | Scope | Notes |
|---|---|---|---|
| Toggle nav | `Mod+B` | global | already wired (`AppShell.tsx:43`) |
| Toggle inspector | `Mod+I` | global | already wired |
| Open palette | `Mod+K` | global, even in inputs | already wired |
| Push to talk | `Mod+Space` | global, even in inputs | already wired |
| Open settings | `Mod+,` | global | already wired |
| New chat | `Mod+N` | global | E5 wires |
| Send message | `Mod+Enter` | composer | already wired |
| Quick add task | `Mod+Shift+T` | global | already used; E3 confirms |
| Toggle todo drawer | `Mod+Shift+L` | global | new; collisions documented in plan-C §7 |
| Toggle terminal grid focus | `` Ctrl+` `` | global | E1 wires |
| Focus terminal pane N | `Ctrl+1..8` | terminal grid | E1 |
| New event quick-add | `Mod+Shift+E` | global | E3 |
| Cycle agent (council) | `Mod+]` / `Mod+[` | council mode | E5 |
| Picture-in-picture media | `Mod+Shift+P` | global | E4 wires |
| Ambient mode toggle | `Mod+Shift+.` | global | E7 |
| Mute SFX | `Mod+Shift+M` | global | E10 |

### 8.2 Focus ring strategy

Replace hard outline (`globals.css:127-131`) with:
```css
:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px hsl(var(--background)),
              0 0 0 4px hsl(var(--ring) / 0.65);
  border-radius: var(--radius);
}
.dark :focus-visible { /* same; the double shadow makes the ring read on either ground */ }
```

Stronger 4px outer halo at 30% opacity around primary actions (Buttons, Tabs).

### 8.3 ARIA checklist

- Every `<Dialog>`: `<DialogTitle>` + `<DialogDescription>` (sr-only acceptable). VoiceModal already does this. Audit all dialogs.
- Toasts: `role="status"` for info/success, `role="alert"` for error/warning.
- Streaming chat: container `aria-live="polite"`, `aria-busy={isStreaming}`. Each new message announced once via `aria-atomic="false"`.
- TaskCard checkbox: already labelled. Add `aria-pressed` to action buttons.
- VoiceModal state: `aria-live="polite"` for label; `aria-live="assertive"` for error.
- Onboarding dots: `role="tablist"` + `aria-current="step"` on active.
- NavPane sections: `role="region"` + `aria-label`.

### 8.4 WCAG AA contrast verification

Verified ratios for new dark theme (foreground on background):

| FG | BG | Ratio | Pass AA |
|---|---|---|---|
| `#F8F4EE` foreground | `#100E0C` background | 17.4 : 1 | ✓ |
| `#F8F4EE` foreground | `#1A1816` panel | 14.2 : 1 | ✓ |
| `#A39C92` muted-fg | `#100E0C` background | 7.6 : 1 | ✓ AA Large/UI |
| `#A39C92` muted-fg | `#1A1816` panel | 6.2 : 1 | ✓ AA Large/UI |
| `#11D2EC` accent-cyan | `#100E0C` background | 9.3 : 1 | ✓ |
| `#9C7CFB` accent-violet | `#100E0C` background | 6.1 : 1 | ✓ AA Normal |
| `#F4A641` accent-amber | `#100E0C` background | 9.0 : 1 | ✓ |
| `#E84B3F` destructive | `#100E0C` background | 5.4 : 1 | ✓ AA Normal |
| `#2EBA84` success | `#100E0C` background | 6.3 : 1 | ✓ |

All primary pairs ≥4.5:1 (AA Normal). Muted-fg pairs ≥4.5:1 only at large/UI text — body uses `foreground` so this is fine. Settings UI uses ≥13.5px body which qualifies as Normal text.

### 8.5 Reduced motion

Already enforced via `MotionConfig reducedMotion="user"` (`AppShell.tsx:65`) plus the `@media (prefers-reduced-motion)` rule in `globals.css:134`. Add: SFX cues gated by same media query (§5.2). Drift orb + grain disabled (§6.4). Streaming caret falls back to static `▌` (no blink).

### 8.6 Reduced transparency / contrast

- Detect `prefers-contrast: more` → swap to a "high-contrast" preset that lifts borders to `28 5% 35%`, foreground to `30 12% 99%`, raises focus ring to 3px with no inner halo.
- Detect `prefers-reduced-transparency: reduce` → drop all `backdrop-blur` and `bg-*/N` translucency to solid panel colors.

### 8.7 Screen-reader announcements

Announce these via a single `<div className="sr-only" aria-live="polite">` mounted in `App.tsx`:
- Streaming start: "Agent Jarvis is responding."
- Streaming end (>3s): "Response finished."
- Task created: "Task added: {title}."
- Task completed: "{title} completed."
- Voice state: "Listening." / "Thinking." / "Speaking."
- Schedule reminder fired: "Event in 5 minutes: {title}."

Throttle to one announcement / 1.5s; queue overflow.

---

## 9. Settings expansion blueprint

Current file: `app/src/features/settings/SettingsModal.tsx` lines 26-32 enumerate 6 tabs. Replace with the 12 sections below. Each section is its own component under `app/src/features/settings/sections/`.

### 9.1 Account
- Display name (inline edit)
- Avatar seed (color picker, regenerate)
- Email (only if cloud session)
- Sign in / Sign out (opens SignInDialog)
- Local user ID (read-only, copyable)
- Delete local data (destructive, confirmation modal)

### 9.2 Providers
For each provider (Anthropic, OpenAI, Google, xAI, Ollama, OpenCode, OpenAI-compatible custom #1..N, Anthropic-compatible custom #1..N, Mock):
- Enable toggle
- API key input (masked, "show" toggle, paste-from-clipboard)
- Custom base URL (for *-compatible)
- Custom auth header name (for *-compatible)
- Test connection button (calls `isAvailable()` + tiny ping)
- Status pill (Connected / Not configured / Error)
- "+ Add custom endpoint" for OpenAI-compatible / Anthropic-compatible

### 9.3 Models
Per-built-in agent (Jarvis, Athena, Edge, Watson, Hal, Claude, GPT, Gemini, Sage):
- Provider dropdown (from configured providers)
- Model dropdown (per-provider list, refreshable)
- Effort slider: minimal | low | medium | high | max | custom
- Custom temperature + max_tokens fields when effort=custom
- Reasoning effort flag (OpenAI o-class only) when applicable
- Anthropic thinking budget (anthropic models only)

### 9.4 Appearance
- Theme: System / Dark / Light
- Accent: Voltage (cyan/violet) / Amber / Custom hue
- Density: Compact / Cozy (default) / Comfortable
- Font: Inter (default) / System
- Motion level: Off / Reduced / Standard / Lively
- SFX: master mute, volume, per-cue toggles (collapsed)
- Cursor glow toggle
- Grain overlay toggle
- Ambient drift orb toggle
- Ambient level: Off / Subtle / Lively

### 9.5 Voice
- TTS engine: System (Web Speech) / Cartesia (Phase 3) / ElevenLabs (Phase 3)
- Voice (per engine; native voice list for Web Speech)
- Persona: Jarvis / Athena / Edge / Watson / Hal / Custom MD
- Wake-word toggle (V2 minimal: keyword detection on Web Speech)
- Push-to-talk hotkey rebinder
- Auto-listen-after-response toggle
- Mic device picker (when more than one)
- VAD sensitivity slider (deferred to Phase 3 - show as disabled with note)

### 9.6 Hotkeys
Editable list of every action above (§8.1). Click row → press combo to rebind. Reset to default per row + global.

### 9.7 Integrations
For each: status pill + Connect / Disconnect + manage button.
- Supabase (URL + anon key form, Apply migrations button) → Planner B2 §5.1
- GitHub (Device Flow, default repo per workspace) → §5.2
- Google (PKCE; calendar scope toggle, gmail off by default) → §5.3
- OpenCode (autodetect localhost, port input) → §5.4
- Ollama (autodetect localhost:11434, list installed models) → §5.5

### 9.8 Workspaces
- List workspaces, add, rename, delete, switch, default-on-launch.
- Per workspace: default project, color hue, avatar.
- Cloud workspace ↔ local workspace mapping (when Supabase connected).

### 9.9 Agents
- List built-in agents (read-only effort + persona override).
- Custom agents section: list, edit (inline form OR raw MD textarea), delete.
- Import `.jarvis-agent.md` button (file picker).
- Export selected agent as MD.
- Skill catalog viewer (read-only list of 16 skills).

### 9.10 Schedule
- Default reminder offsets list (e.g. -10m, -1h)
- Default event duration (15 / 30 / 60 / 90)
- Quiet hours (start/end + "block reminders" toggle)
- Calendar sync (when Google connected)

### 9.11 Notifications
Per channel, per severity matrix:

| | desktop | in-app | voice |
|---|---|---|---|
| task reminders | ✓ | ✓ | — |
| schedule reminders | ✓ | ✓ | ✓ |
| agent done | — | ✓ | — |
| errors | ✓ | ✓ | — |
| sync issues | — | ✓ | — |
| daily briefing | — | ✓ | ✓ |

Plus: quiet hours, allow during ambient mode, sound, vibrate (where supported).

### 9.12 Privacy / Telemetry
- Telemetry opt-in toggle (off default)
- Send crash reports (off default; would send only on opt-in)
- Anonymous usage stats (off default)
- Cloud sync toggle (binds to Supabase configured state)
- Reset all telemetry data button

### 9.13 Storage
- Database size (live IndexedDB usage estimate)
- Cache size, clear cache button
- Export everything (JSON download)
- Import everything (file picker → merge / replace prompt)
- Vacuum DB button (Dexie compaction)

### 9.14 Quick Launch (NEW — Planner D)
- List groups, reorder, rename, delete
- List links per group, reorder, edit, delete
- Default behavior per kind (web → external_browser etc.)
- Bookmark HTML import button
- Hotkey assignment hints

### 9.15 Terminals (NEW — Planner C)
- Default shell per OS (override $SHELL)
- Default cwd policy: project / workspace / home / advanced (allow anywhere)
- Detach on app close (per-preset checkbox grid)
- Scrollback lines limit
- Tmux opt-in (Unix only, hidden by default)
- Built-in presets list (read-only)
- User presets (CRUD)

### 9.16 About + Diagnostics
- Version (from `tauri.ts:getAppVersion`)
- Build channel, commit hash
- Update channel: Stable / Beta (from updater plugin)
- Check for updates now
- Open log directory (Tauri `shell.open(appLogDir)`)
- Copy diagnostics bundle (system info + recent log tail) to clipboard
- Acknowledgments / OSS licenses
- Apache 2.0 license link

> Tabs grow to 12 visible + Quick Launch + Terminals + About = 16 sections. Settings sidebar must scroll or group into "Personal / Connections / Workspace / System" headers. Recommend grouped headers.

---

## 10. Component polish list

Cited file:line. **Total ≥30**. Owned by E10 unless marked otherwise.

| File:line | Change | Why |
|---|---|---|
| `chat/MessageBubble.tsx:100` | Swap `bg-muted` → `bg-surface-warm` on user bubble | Cozy ground |
| `chat/MessageBubble.tsx:131` | Wrap agent name in span colored by `hsl(var(--agent-color, accent-cyan))` | Identity at a glance |
| `chat/MessageBubble.tsx:153` | Add streaming caret (`▌`) when agent message is the last one and stream open | Live feel |
| `chat/MessageBubble.tsx:122-126` | Wrap entire bubble in `motion.div` with `hoverLift` | Tactility |
| `chat/Composer.tsx:240` | Add `focus-within:shadow-[0_0_0_3px_hsl(var(--accent-cyan)/0.08)]` | Warm glow on focus |
| `chat/Composer.tsx:282` | Send button: `Loader2` icon when sending, `Send` icon otherwise | Status clarity |
| `chat/Composer.tsx:265` | ModelPicker text scales `text-metadata` → ensure tabular nums, lock width | No layout jump |
| `chat/EmptyChat.tsx:42` | Replace static Mic icon with `motion.div` doing `pulseActive` | Lively idle |
| `chat/EmptyChat.tsx:46-52` | Pull display name + persona greeting; rotate every 12s | Personalization |
| `tasks/TaskCard.tsx:117` | Conditional `border-amber/40` when `due_at - now < 1h` | Urgency |
| `tasks/TaskCard.tsx:140` | Wrap Check icon in `motion.svg` with stroke pathLength | Satisfying done |
| `tasks/TaskCard.tsx:127-135` | flash strip color: cyan→violet→amber gradient, fades over 1s | Welcome new task |
| `tasks/TodoPanel.tsx:107-115` | Add scroll-shadow utility at top/bottom of scroll region | Depth perception |
| `tasks/TodoPanel.tsx:121` | Header gets `bg-panel/80 backdrop-blur` + bottom border faded | Sticky header polish |
| `voice/Orb.tsx:104-114` | Subscribe to mic RMS via Zustand `useVoiceStore.rmsLevel`, drive scale 0.95→1.05 | Reactive orb (E6) |
| `voice/VoiceModal.tsx:117` | Backdrop should be `bg-elevated/80 backdrop-blur-2xl` not `/90` | Frostier |
| `command-palette/CommandPalette.tsx` | Active item: `motion.span layoutId` underline | Tracking pointer |
| `command-palette/CommandPalette.tsx` | Result kbd chips on each row | Hotkey discoverability |
| `layout/AppShell.tsx:78-83` | Add `<CursorGlow />` mount; listen `useUIStore.ambientLevel` | Ambience |
| `layout/AppShell.tsx:64-67` | `MotionConfig` already there — extend with `reducedMotion="user"` confirmed | (verify) |
| `layout/TopBar.tsx:117-120` | Voice listening pulse swap from `animate-pulse` to `voiceListening` motion variant | Coherence |
| `layout/TopBar.tsx:135-142` | Avatar → Popover with profile menu | Discoverability |
| `layout/NavPane.tsx:25-31` | Inner content fade out at 0.5 progress when collapsing | No flicker |
| `layout/NavPane.tsx:80` | Wrap collapsed nav buttons in `<Hint label>` | Tooltips |
| `layout/Inspector.tsx` | Slide-in: spring 380/34, opacity 0→1 over 220ms | Smooth |
| `layout/TabStrip.tsx` | Active underline: `motion.span layoutId="tab-underline"` | Shared transitions |
| `ui/dialog.tsx:38` | Add `shadow-cozy`, replace `shadow-2xl`; add 1px inner ring `ring-1 ring-accent-cyan/10` | Hearth dialogs |
| `ui/dialog.tsx:39` | Replace CSS keyframe `animate-scale-in` with Motion `softBounce` | Centralized motion |
| `ui/dialog.tsx:46` | Close button: amber on hover instead of opacity-only | Warmth |
| `ui/button.tsx:6-33` | Add `amber` variant (`bg-amber text-amber-foreground`) | Human actions |
| `ui/button.tsx:8` | Add `active:scale-[0.985] transition-transform duration-75` on base | Press feedback |
| `ui/button.tsx:18` | Accent variant: shadow blooms on hover (already done) — add small ripple via pseudo on click | Tactility |
| `ui/toast.tsx` | Stack with 4px gap, 0.5deg alternating tilt, `shadow-cozy` | Personality |
| `ui/badge.tsx` | Add `amber` variant | Match button |
| `ui/checkbox.tsx` | Check mark draws via stroke pathLength on check; falls back to static on reduced-motion | Joy |
| `globals.css:80` | `*` border to `border-color: hsl(var(--border))` (no @apply needed) | Reduce specificity |
| `globals.css:105-118` | Scrollbar thumb width: 8 → 6 default, 8 on hover. Track keeps subtle inset shadow | Mac-like |
| `globals.css:127` | Replace focus outline with the box-shadow ring from §8.2 | Brand consistency |
| `globals.css:147-153` | `.text-accent-gradient` cap fallback color so unsupported browsers don't show transparent | Robustness |
| `globals.css` | Add `.scroll-shadow-y` utility (linear-gradient masks) | Reuse |
| `globals.css` | Add `.shadow-cozy` (defined §2.3) | Reuse |
| `globals.css` | Add `.grain-overlay` (defined §2.3) | Reuse |
| `App.tsx:178-198` | Mount `<CursorGlow />`, `<GrainOverlay />`, `<DriftOrb />` (all gated by `ambientLevel`) | Wire ambience |
| `App.tsx` | Mount `<AmbientHome />` from Planner E above WorkspaceRoot; controlled by `useUIStore.ambient` | Idle takeover |
| `App.tsx` | Mount `<MediaPlayerHost />` from Planner D inside WorkspaceRoot | Player |
| `lib/sfx.ts` (new) | Implement `useSfx` per §5.2 | Audio |
| `lib/motion.ts` (new) | Implement preset library per §4.2 | Motion |
| `lib/cursor-glow.tsx` (new) | Implement DOM-position-tracking glow | Ambience |

> **Total: 47 polish items.** All within E10 unless noted. Most are 5-15 lines of code.

---

## 11. Coordination notes

- **Planner B1 (security/installer)** must self-host fonts (drop Google CDN in `index.html:11-14`) and add `connect-src 'self' https:` for the API providers — done in their plan. Themes do not require any new connect-src.
- **Planner B2 (providers/agents/schedule)** must ship the data model behind Settings → Models § 9.3 and Settings → Agents § 9.9.
- **Planner C (terminals)** must theme xterm via these tokens: bg `--background`, fg `--foreground`, cursor `--accent-cyan`, selection `--accent-cyan/30%`, ANSI colors mapped to `--accent-amber` (yellow), `--accent-cyan` (cyan), `--accent-violet` (magenta), etc. Provide the bridge in their `Terminal.tsx`.
- **Planner D (launcher/media)** Quick Launch tiles use `--accent-amber` for default kind tint; YouTube cards use `--accent-violet` band; per-link `color_hue` overrides.
- **Planner E (ambient home)** uses `--ambient-deep` ground, leans on the `softBounce`/`pulseActive` motion presets, mutes SFX while in ambient mode.

End of plan-A.
