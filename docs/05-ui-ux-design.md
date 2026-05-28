# Jarvis - UI/UX Design Blueprint

*Working aesthetic name: **Voltage**. OLED-black, electric-accent, council-of-agents. Dense, calm, keyboard-first.*

---

## 1. Design principles

1. **Density without clutter.** Show more information per pixel than the competition without overwhelming. Linear and Raycast are the references.
2. **Keyboard-first, mouse-friendly.** Every action reachable via Cmd+K. Mouse is for browsing, keyboard is for working.
3. **Calm motion.** Spring physics. Brief. Choreographed. Never gratuitous.
4. **One accent color.** A cyan-to-violet gradient appears sparingly. Everything else is neutral OLED grays.
5. **Voice is visible.** When Jarvis is listening, the entire screen edge knows. When agents are working, you see what they're doing.
6. **Local feel even when cloud.** Avoid spinners that imply network round-trips. Optimistic UI. Skeleton states.
7. **Trust through transparency.** Show the user the trace, the cost, the model, the source. Never hide what an agent did.

## 2. Visual language

### Color system

```
Background:    #0A0A0A (OLED-friendly base canvas)
Panel:         #111111 (sidebar, top bar, panels)
Elevated:      #1A1A1A (popovers, modals, command palette)
Border (dark): #262626 (panel separators)
Border (mid):  #333333 (input outlines, dividers)

Text primary:    #FAFAFA
Text secondary:  #A3A3A3
Text tertiary:   #525252

Accent gradient: linear-gradient(135deg, #06B6D4 0%, #8B5CF6 100%)
                 (cyan -> violet, used SPARINGLY)

Per-agent color: HSL(hash(agent_name) % 360, 70%, 60%)
                 (deterministic hue per agent for instant identification)

Status:
  Success:  #10B981 (emerald-500)
  Warn:     #F59E0B (amber-500)
  Error:    #EF4444 (rose-500)
  Info:     #06B6D4 (the accent cyan)
```

The OLED `#0A0A0A` base instead of pure `#000` because pure black feels harsh in long sessions and breaks anti-aliasing on some monitors. `#0A0A0A` keeps the OLED power-savings while reading softer.

### Typography

```
Sans:   Geist Sans (fallback Inter)
Mono:   Geist Mono (fallback JetBrains Mono)

Sizes:
  metadata:   11px (timestamps, IDs, secondary status)
  secondary:  12px (table cells, captions)
  body:       13px (primary readable text - smaller than typical web!)
  ui-strong:  14px (panel headers, button labels)
  page-title: 18px (top of canvas)
  hero:       28px (only on landing / onboarding / empty states)
```

**Why 13px body?** Power users want density. Cursor and Linear both default to 13. Up-sizing per user preference is one click.

### Iconography

- **Lucide** for 95% of UI icons. Single 1.5px stroke weight project-wide.
- **Phosphor Duotone** for hero illustrations and agent-state icons (e.g., a unique "thinking" icon with a duotone wash).
- 16px icons in dense UI, 20px in panel headers, 24px in modals/heroes.

### Surface elevation rule

Surfaces never get lighter than three steps from the base:
```
#0A0A0A -> #111111 -> #1A1A1A -> #262626 (max elevation)
```
Beyond that, use border + glow instead of more brightness. The Aceternity Glowing Effect on the active agent panel is the canonical example.

## 3. Layout - the three-pane shell

```
+---------------------------------------------------------------------+
| [breadcrumb][project][branch]                  [search][+] [profile]|  <- top bar (40px)
+---------+-------------------------------------------+---------------+
|         |                                           |               |
|  NAV    |          MAIN CANVAS                      |   INSPECTOR   |
| (240px) |   (fluid - chat, council, doc, code)      |   (320px)     |
|         |                                           |               |
| projects|                                           |  Tool calls   |
| chats   |                                           |  Memory       |
| agents  |                                           |  Trace        |
| skills  |                                           |  Context refs |
| files   |                                           |               |
|         |                                           |               |
| --tasks-                                            +---------------+
| Today   |                                           |   TODO PANEL  |
| Later   |                                           |  (collapsible)|
+---------+-------------------------------------------+---------------+
| [activity strip - one row per active agent in council mode]         |
+---------------------------------------------------------------------+
```

### Top bar (40px)

Left to right: workspace breadcrumb (clickable) -> active project -> active model badge (click to change) -> ... -> search -> "+" new -> profile dropdown.

Right side reserves room for **presence avatars** when collaboration is enabled (Phase 2+).

### Left pane (Nav, 240px, collapsible to 56px)

Sections in order:
1. Workspace switcher.
2. Pinned items (frequently-used chats, projects).
3. Projects (tree, expandable).
4. Agents (list with online/idle status dots).
5. Skills (installed workflows).
6. Files (search-focused).
7. To-do drawer (Today / This Week, expandable).

Hovering the collapsed nav shows a flyout. Cmd+B toggles.

### Main canvas (fluid)

Modes (toggleable via top-bar segmented control or Cmd+1/2/3/4):

1. **Chat mode** - linear thread with one active agent. Fastest mode.
2. **Council mode** - 2x2 / n-up grid of agent panels collaborating. Animated Beams during cross-agent activity.
3. **Doc mode** - block-based editor for long-form output (built on Tiptap or Plate).
4. **Code mode** - read-only Monaco view for files that an agent is editing. Real editing happens in the user's IDE via MCP.

Tabs above the canvas, Arc-style draggable, Cmd+T new, Cmd+W close, Cmd+1..9 switch.

### Right pane (Inspector, 320px, slide-over)

Tabs:
1. **Context** - what the active agent is using (memory items, files, current state).
2. **Tools** - tool-call history with results, expandable to full args/output.
3. **Trace** - workflow timeline with agent rows, tool spans, token costs.
4. **Refs** - all source references for the current message (clickable, opens source).

Cmd+\\ toggles. Auto-opens when a tool call needs user approval.

### Activity strip (bottom, 32px, only in council mode)

One row per active agent. Each row: agent avatar + name + current verb ("Reading docs", "Generating plan", "Waiting for tool result") + token counter. Click to focus.

## 4. Council mode (the differentiator)

A 2x2 / 3x2 / n-up grid of agent panels collaborating. Each panel is an independent scroll, agent-colored 1px left border, gradient avatar header.

### Layout
```
+-------------------+  +-------------------+
|  RESEARCHER       |  |  CODER            |
|  (cyan border)    |  |  (violet border)  |
|                   |  |                   |
|  ...messages...   |  |  ...messages...   |
|                   |  |                   |
+-------------------+  +-------------------+

  (Animated Beams visualize when agents
   cross-message during a workflow turn.
   Beams gated to "active flow" moments
   only - never persistent decoration.)

+-------------------+  +-------------------+
|  WRITER           |  |  CRITIC           |
|  (gold border)    |  |  (rose border)    |
|                   |  |                   |
|  ...messages...   |  |  ...messages...   |
|                   |  |                   |
+-------------------+  +-------------------+

[ shared canvas at bottom: synthesized result builds here ]
```

### Interactions
- **@mention routing** - typing `@coder` in the input typeahead routes that message to that agent only (cmdk-powered).
- **Broadcast** - Cmd+Shift+Enter sends to all agents in the council.
- **Synthesize** - button at top of canvas; spawns a Critic agent that reads all panels and produces one combined answer.
- **Detach a panel** - drag the panel header to a separate floating window. Useful for keeping one agent always visible.
- **Pin a thread** - star a message in any panel; pinned messages aggregate in the inspector.

## 5. Voice modal

Triggered by wake word, push-to-talk hotkey, or tray click. Slides up from the bottom-center as an overlay.

### Components
- **Spline 3D orb** at the visual center, ~200px. Color-shifts on intent classification, pulses with audio amplitude.
- **Apple-Intelligence-style glow border** wraps the entire screen edge during listening states. CSS conic-gradient with a slow rotation animation.
- **Translucent transcript caption** at the bottom of the screen showing what Jarvis heard.
- **Active agent badge** under the orb showing which agent is currently responding.
- **Timer** showing turn duration (helps users understand latency).
- **Esc to close**, **Space to push-to-talk** while modal is open.

### States
- **Idle** - orb gently breathes, glow border off.
- **Listening** - orb expands ~10%, glow border lit, mic pulse animation.
- **Thinking** - orb has a slow swirl shader, no glow border.
- **Speaking** - orb amplitude-reacts to TTS output, glow border off.
- **Error** - orb briefly tints rose, glow border off, transcript shows the error.

## 6. To-do panel UI

The to-do panel docks in the right pane (in chat mode) or in the floating tray drawer.

### Sections (top to bottom)
1. **Now** - in_progress tasks + urgent due today. Highlighted with accent gradient.
2. **Today** - everything else due or scheduled for today.
3. **This Week** - rest of the week.
4. **Later** - everything beyond.
5. **Suggested** - drafts from the Action Extractor (with confidence pip).

### Task card

```
+-----------------------------------------+
| [ ] Review PR #1234            [URGENT] |
|     #engineering #review                |
|     Due: Fri 4pm  ·  Reminder: Fri 9am  |
|     ----------------------------------- |
|     "...so I'll review Alex's PR before |
|     ship Friday." - voice 2:14pm        |
+-----------------------------------------+
```

- Checkbox left edge (toggle done).
- Title row: title + priority pill (color-coded) + project tag.
- Tag row: hashtag-style context tags.
- Time row: due, scheduled, reminder. Click any to edit inline.
- Source row (collapsible): trigger phrase + context ref.
- Hover: drag handle on the right for reorder.
- Right-click / long-press: context menu (Snooze, Reschedule, Convert to subtask, Delete, Open source).

### Inline edit
- Click any time field -> calendar popover.
- Click title -> inline edit with auto-save on blur.
- Drag-drop between sections to change scheduling.

### Voice creation feedback
When Jarvis creates a task via voice, the new card animates in with an accent-gradient flash on the left border for ~1 second.

## 7. Notification design

### Desktop banner

Compact (matching macOS / Windows native):

```
+------------------------------------------+
| Jarvis  ·  Reminder           [x]        |
| Review PR #1234 (urgent)                 |
| Due in 1h - your morning is clear.       |
| [ Done ]  [ Snooze v ]  [ Open ]         |
+------------------------------------------+
```

### Tray badge

Tray icon with a small accent-color dot when unread reminders exist. Number badge for >1.

### In-app toast

Drops from top-center for 3 seconds for non-critical notifications. Long-press to expand to full card.

### Mobile push

Standard iOS/Android push notification with category-defined actions: Done, Snooze, Open. Custom snooze picker via Notification Service Extension on iOS.

## 8. Onboarding flow

5 steps, each takes <1 minute:

1. **Welcome screen** with Aceternity Aurora Background, Spline orb hero. "Meet Jarvis." CTA: Continue.
2. **Pick personality** - Jarvis (default), Athena, Edge, Watson, HAL. Click to preview voice + style.
3. **Connect models** - one-click providers (or BYOK). Skip-able to local-only.
4. **Mic + notification permissions.** Required for voice and reminders. Clear explanation of why.
5. **Quick demo** - Jarvis says "Try this: 'Hey Jarvis, what can you do?'". User says it. Glow border lights up. Magic moment.

After onboarding, drop the user into a fresh project with the to-do panel showing one example task ("Try saying 'mark this done'").

## 9. Empty states

Empty states matter in this product because users might land in many of them (no chats, no tasks, no projects). Each empty state:
- Single Phosphor Duotone illustration (small, soft accent gradient).
- One-line title ("No tasks today.").
- Encouraging body ("Add one with voice or hit Cmd+N.").
- Single primary action.

Never use stock empty-state illustrations. Commission a small custom set (8-10 illustrations) from a single illustrator for cohesion.

## 10. Animation choreography

Default Motion config:
```
transition: {
  type: 'spring',
  stiffness: 400,
  damping: 30,
  mass: 0.8
}
```

Layout transitions: `<motion.div layout>` for any reorderable list.
Modal lifecycle: `<AnimatePresence>` with `initial={{ opacity: 0, scale: 0.96 }}`, `animate={{ opacity: 1, scale: 1 }}`.
Stagger lists on mount: `staggerChildren: 0.04`.

**What we explicitly avoid:**
- Long entrances (>400ms).
- Bouncy spring overshoot (`stiffness < 200`).
- Scroll-linked parallax inside the app (only on the marketing site).
- Anything that delays a click response by more than 100ms.

## 11. Accessibility

- Maintain >= 4.5:1 contrast on all body text.
- Don't use the accent gradient as text color (marginal contrast). Only as fills/borders.
- Respect `prefers-reduced-motion` (cuts spring physics, halves all durations).
- Full keyboard navigation. Visible focus rings (2px accent ring).
- Screen reader: aria-label everything that isn't text. Live regions for streaming agent output.
- Voice modal has visible transcript at all times for hearing-impaired users.

## 12. Component inventory (build order)

Phase 1 components needed:

**Foundations**
- ThemeProvider (dark default, light variant later)
- Button (5 variants: primary, secondary, ghost, destructive, accent-gradient)
- Input, Textarea (with mention typeahead)
- Select, Popover, Tooltip, Toast (shadcn primitives)
- Dialog, Sheet (modal/drawer)
- Tabs, Segmented Control
- Avatar (deterministic gradient based on agent_name hash)
- Badge (priority pills, status dots)
- Skeleton (loading)

**App-specific**
- ThreePaneShell (the main layout)
- TopBar
- NavPane
- TabStrip (Arc-style, draggable, splittable)
- AgentPanel (council mode panel)
- ChatBubble (per-agent colored)
- ToolCallCard (collapsible inline tool)
- TraceTimeline (inspector tab)
- TaskCard (with all states)
- TodoPanel
- VoiceModal (with Spline orb)
- GlowBorder (Apple-Intelligence-style)
- ActivityStrip
- CommandPalette (cmdk + Radix Dialog)
- AnimatedBeam (Magic UI)
- BorderBeam (Magic UI - active agent panel)

**Marketing/landing**
- Hero (Aurora Background, Spline orb)
- BentoGrid (feature surfacing)
- AnimatedBeams (showing the council connection)

## 13. Keyboard alphabet

```
Cmd+K          Global command palette
Cmd+P          File / project switcher
Cmd+B          Toggle left pane
Cmd+\          Toggle right pane
Cmd+T          New tab
Cmd+W          Close tab
Cmd+1..9       Switch tab
Cmd+N          New chat
Cmd+Shift+T    Open tray drawer
Cmd+Space      Push-to-talk (global)
Cmd+Enter      Send to current agent
Cmd+Shift+Enter Broadcast to all agents (council)
Cmd+/          Toggle inspector tab
Cmd+,          Settings
Esc            Close modal / exit council to chat
@              Mention typeahead
```

## 14. Reference apps to mine

In priority order (full annotations in `research/05-ui-ux-trends.md`):

1. **Cursor 3.0** - multi-agent dashboard, agent picker pattern.
2. **Linear** - density, command palette, dark UI.
3. **Raycast** - command palette ergonomics.
4. **Vercel Geist** - color/type system showcase.
5. **Limitless** - calm dark surfaces for AI assistants.
6. **Phantom** - micro-interactions and OLED dark.
7. **Amie** - calendar UI, soft gradients, thoughtful animations.
8. **Granola** - meeting capture UI.

## 15. What we explicitly avoid

- Heavy glassmorphism (peaked in 2022).
- Soft neumorphism.
- Brutalist / Comic Sans AI marketing.
- Generative backgrounds at >20% opacity inside the app.
- Three.js outside the voice orb scene.
- More than two animation libraries.
- More than one icon family in the same view.
- VisionOS-style spatial floating panels (for now).
- Big colored pills for everything; reserve color for meaning.

---

*See `research/05-ui-ux-trends.md` for the underlying research and references.*
