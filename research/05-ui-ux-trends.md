# UI/UX Design Direction for an AI/Multi-Agent App (2026)

*Subagent #5 - competitive aesthetic intelligence pass.*

## TL;DR - recommended direction

Build a **dark-first, OLED-grounded, keyboard-driven workspace** with three core moves that competitors (BridgeMind, Cursor, Linear, Raycast) already exploit but rarely combine well:

1. **Layout:** A Linear-style three-pane split (collapsible nav + agent council + live canvas) with Arc-style draggable tabs and a global Cmd+K command palette as the universal entry point.
2. **Aesthetic:** Near-black base (`#0A0A0A`) + a single neon-electric accent gradient (cyan to violet) + occasional **warm scene-painted ambient backdrops** for hero/voice/empty states - this is the contrast trick Cursor 3 used in their April 2026 redesign and it instantly differentiates from the sea of cold-blue AI dashboards.
3. **Stack:** **shadcn/ui** as the foundation, **Magic UI + Aceternity UI** for the showy accents (animated beams, aurora, spotlight, glowing border), **Motion** (formerly Framer Motion, v12.40 as of May 2026) for choreography, **cmdk** for the palette, **Geist Sans + Geist Mono** for type, **Lucide** for icons, and a single **Spline** embed for the voice/ambient orb hero - no heavy Three.js elsewhere.

The full justification follows.

---

## 1. 2026 design trends in AI apps

Walking the last 18 months of AI-app launches (Cursor 3.0 in Apr 2026, Composer 2.5, Vercel Ship, Limitless, Diagram, Phantom, Reflect, Amie, AuthKit) plus the Awwwards AI category, four trends are consolidating and three are dying.

**Consolidating:**

- **OLED-black + single neon accent.** Pure `#000` or `#0A0A0A` with one saturated brand color. Linear, Raycast, Cursor, Phantom, Vercel all sit here. Glass and translucency now appear as *accents* (the Raycast command bar, macOS materials) - never as the whole shell.
- **Animated beams / orbital diagrams** as the default way to show an AI "doing something." Magic UI's Animated Beam component ([magicui.design/docs/components/animated-beam](https://magicui.design/docs/components/animated-beam)) is now functionally an industry pattern - Vercel, Clerk, Zapier, OpenAI's marketing site all use the same connect-the-dots-with-light gradient. Aceternity UI ships almost the same effect under "Background Beams" and "Google Gemini Effect."
- **Bento-grid landing pages and dashboards.** Aceternity, Magic UI, and shadcn all ship bento grids as a hero block. Cursor's marketing page is essentially three bento cards with embedded interactive demos.
- **Generative / animated backgrounds at low intensity.** Aurora, vortex, dotted glow, ripple, light rays. The mistake is running them at full opacity - winners (Linear, Raycast) keep them at ~10-20% opacity behind real content.

**Dying:**

- **Heavy glassmorphism.** It peaked in 2022. Over-blurred panels make text hard to read and look dated. Apple still uses it in macOS materials, but software UIs are pulling back.
- **Soft neumorphism.** Never really revived. Skip it.
- **Brutalist + Comic Sans-y AI marketing.** Briefly trendy in 2024 (Pi, some early agent startups). Now reads as gimmicky.

**Bento-grid layouts** specifically remain strong: see [ui.aceternity.com/blocks/bento-grids](https://ui.aceternity.com/blocks/bento-grids) and the shadcn dashboard examples. Use them for feature surfacing and dashboards, not for in-app working spaces.

**Spatial UI / VisionOS-inspired floating panels** are showing up in product mocks but rarely shipping in production web apps - too costly for limited payoff. Skip unless you're building for visionOS specifically.

## 2. Multi-pane / split-view patterns

The shipping reference apps converge on a small number of patterns:

- **Linear** ([linear.app](https://linear.app)): 240px collapsible left nav, fluid main area, contextual right inspector that slides over. Drag-to-reorder issues, full-keyboard navigation, command palette as the universal entry point. Their *Linear Method* writeup ([linear.app/method](https://linear.app/method)) explicitly calls out density and momentum as core principles.
- **Raycast** ([raycast.com](https://raycast.com)): Command-first, with a floating overlay that hosts *everything*. Their detail view pattern (list left, preview right, action bar bottom) is the cleanest two-pane I've seen and worth borrowing for the agent council view.
- **Arc Browser:** Vertical tabs, split view (drag a tab to the side to split), pinned + favorited tabs as a stable row. The "drag to split" gesture is the killer interaction - Cursor 3 adopted a version of it for their tab/agent view.
- **Cursor 3.0** (cursor.com, April 2026 redesign): Editor + agents panel + tab strip + cloud agents dashboard. They show running agents as cards in a "This Week / This Month" grouping with a persistent status (e.g., "Worked for 14m 22s - processed screen recording"). Mobile agents run in a separate timeline view.
- **Notion:** Multi-column page layouts with drag-to-resize. Less relevant for an agent app than for content tools.

**Recommendation:** Three-pane shell (nav + main + context) with a fourth ephemeral layer for the command palette and modals. Borrow Arc's drag-tab-to-split for power users. Allow agent panels to be **detached into floating windows** for "council mode" - this is your differentiator vs. Cursor's single-stream view.

## 3. Chat UI patterns for multiple agents

This is where most competitors are weakest. Current state of the art:

- **Cursor's Composer / agents panel:** A single chat thread with an agent picker dropdown ("Composer 2.5 / GPT-5.5 / Opus 4.8 / Gemini 3.1 Pro / Grok 4.3"). Users *switch* agents, they don't *converse with multiple at once*. This is a real gap.
- **Slack-style mention-routing:** `@cursor` in a Slack thread routes the message to the AI. Cursor markets this aggressively in their Slack integration. The pattern works because Slack is already a multi-participant interface - agents just join as additional members.
- **Side-by-side comparison views:** OpenRouter, Poe, and a few experimental apps render two model responses in parallel columns. Useful for evaluation, not for collaborative work.
- **"Council mode" / multi-agent debate:** Mostly demoware (LangChain examples, AutoGen). No mainstream UI standard yet. **This is your opening.**

**Recommended pattern for our app:**

- One canonical thread per project, with **agent avatars + colored accent borders on each message** (a la Slack but more visually distinct).
- `@agent_name` mention-routing as a first-class typeahead in the input (built on cmdk).
- Toggle between **"chat mode"** (linear thread) and **"council mode"** (a 2x2 or n-up grid of agent panels, each with its own scroll, collaborating on the same task with a shared canvas in the center). Use Magic UI's Animated Beam between agent panels and the central canvas to make the "swarm" legible.
- Threaded sub-conversations under any agent message, so a user can dig into one agent's reasoning without losing the main flow.

## 4. Voice UI patterns

Voice has converged on a small grammar:

- **Apple Intelligence glow border:** A continuous animated rainbow gradient that wraps the entire screen edge while listening. Best demonstrated on the Apple Intelligence marketing pages and replicated in Cursor's "ambient listening" prototypes.
- **Siri orb:** A 3D blobby sphere that pulses, deforms, and color-shifts. Apple's implementation uses Metal; web versions typically use Three.js or shader-rendered canvases.
- **ChatGPT advanced voice mode:** A cleaner, animated white/blue blob with subtle Perlin noise deformation. Less "alien" than Siri.
- **Pi waveform:** A horizontal symmetric waveform that reacts to amplitude. Calmer, more clinical.
- **OpenAI's voice ring:** A circular ring of dots that animate in waves around the perimeter - used during listening states.

**Recommendation:** Don't try to out-Siri Apple. Pick **two** elements:

1. An **Apple-Intelligence-style glow border** during listening states, achievable in pure CSS with a conic gradient + `mask-image` + a slow rotating `@keyframes`. Cheap, instantly recognizable, ships in a day.
2. A **single ambient orb** in the voice modal, embedded as a Spline 3D scene ([spline.design](https://spline.design)). Spline embeds are ~40-80kb of runtime + the scene asset, and a single orb scene is ~200kb. Acceptable cost for the moment users *expect* visual richness. Use react-three-fiber only if you need real-time audio-reactive deformation.

Avoid Lottie for this - it can't react to live audio amplitude smoothly.

## 5. Agent visualization

Showing what each agent is doing is the single biggest UX challenge in multi-agent apps. Patterns:

- **Status-dot + verb timeline:** "Reading docs - Fetching data - Generating plan." Cursor and Linear both use this. Ship it as table stakes.
- **Per-agent avatar circles** (often colored gradient initials, sometimes generative based on agent name hash). HeroUI and Geist both have Avatar primitives.
- **Activity timelines / "swarm view":** A horizontal Gantt-like strip showing each agent's work across time, with overlapping activities visually stacked. Linear's project view is the closest reference.
- **Animated Beams between agents:** Visually striking but only meaningful if data really is flowing. Use them in "council mode" or in onboarding/landing, not in dense work views.
- **Tool-call cards:** Inline collapsible cards showing each tool call (read_file, run_command, web_search) with an icon + status pill. Cursor and Claude's claude.ai both use this.

**Recommendation stack:**

- Agent avatar (gradient circle, generated from agent name hash) + a colored 1px left-border on its messages.
- A **persistent activity strip** at the top of the agent council view: one row per active agent, each row a horizontal timeline with status verbs.
- **Tool-call cards** inline in messages, collapsible, with Lucide icons.
- **Animated Beams** reserved for the landing page hero and the "council mode" overview - *not* spammed throughout the working UI, where they become noise.

## 6. Command palettes & keyboard-first UX

The reference implementations:

- **cmdk** by Paco Coursey ([github.com/dip/cmdk](https://github.com/dip/cmdk)): The de facto React command menu primitive. Used by Vercel, Linear's web build, and most modern tools. Composable, unstyled, accessible. Drop-in.
- **Raycast:** The native-app gold standard. Ergonomically perfect: Cmd+K toggle, fuzzy filter, nested pages (push/pop), inline actions menu (Cmd+K within the palette).
- **Vercel/Geist Command Menu:** Documented in [vercel.com/geist/command-menu](https://vercel.com/geist/command-menu). Built on cmdk.
- **Linear:** Command palette is the central nervous system - every action is reachable via Cmd+K, and they expose this as a public learning principle.

**Recommendation:** Use **cmdk** as the engine. Wrap it in a Radix Dialog for the modal. Implement nested pages (the "Change theme to Dark theme / Light theme" pattern is in the cmdk README and is exactly what you want for `Switch agent to Composer / Opus / Gemini`).

Bind:
- `Cmd+K` - global palette
- `Cmd+P` - file/project switcher
- `Cmd+\` - toggle right pane
- `Cmd+B` - toggle left pane
- `Cmd+Enter` - send to current agent
- `Cmd+Shift+Enter` - broadcast to all agents (council mode)
- `@` in input - mention-routing typeahead

This keystroke alphabet matches Linear and Cursor closely enough that power users transfer instantly.

## 7. Animation libraries & techniques

Landscape as of May 2026:

- **Motion** ([motion.dev](https://motion.dev), v12.40, MIT-licensed, formerly Framer Motion): The dominant React animation library. New "hybrid engine" pairs JS with hardware acceleration. AI-Kit ships agent-compatible documentation. Trusted by Framer, Figma, Linear, Sanity, Clerk. **This is the safe pick.**
- **GSAP:** Still excellent for complex scroll-linked timelines and SVG morphing. Now MIT-licensed (no more Club GreenSock paywall for standard plugins). Heavier than Motion. Use only if you need timeline orchestration that Motion can't do.
- **Motion One:** Smaller WAPI-only sibling. Useful for landing pages where bundle size matters. For an in-app workspace, Motion proper is fine.
- **Lottie:** Best for prebaked illustrative animations (empty states, mascots). Bad for interactive/responsive work.
- **Rive:** Better than Lottie for state-machine-driven assets (e.g., a voice orb that has idle/listening/speaking states). Worth a look for the voice UI but adds runtime.

**Spring physics + choreographed entrances + micro-interactions:**

- Use Motion's `spring` transitions everywhere by default - `type: "spring", stiffness: 400, damping: 30` is a sensible global preset. Avoid `tween` curves except for opacity fades.
- Stagger children with `stagger(0.04)` for list mounts.
- Use `layout` for any panel/tab rearrangement - it handles the FLIP animation automatically and is the cleanest way to make Arc-style drag-to-rearrange feel native.
- Use `AnimatePresence` for modal / palette / toast lifecycle.

**Recommendation:** Motion + Magic UI accents (Animated Beam, Border Beam, Shine Border, Particles) + a Rive file for the voice orb if you go that route.

## 8. Typography & color systems

**Type:**

- **Geist Sans + Geist Mono** (Vercel, [vercel.com/font](https://vercel.com/font)): Free, designed for developer tools, excellent at small sizes, good rendering on dense data tables. Used by Vercel, Cursor, ai.dev. **Strong default.**
- **Inter:** Still everywhere. Slightly more humanist than Geist. Linear, Raycast, GitHub. Safe second choice.
- **Sohne / Sohne Mono** (Klim Type Foundry): Premium, paid, used by OpenAI and Stripe. Beautiful but $$$ - only worth it if you have brand budget.
- **JetBrains Mono:** Free dev mono, slightly heavier than Geist Mono. Use it if you want a "we are a coding tool" cue.

**Color:**

- Background: `#0A0A0A` (true OLED-friendly) for main canvas, `#111` and `#1A1A1A` for elevated surfaces. Avoid the `#1E1E1E` VS Code gray - it reads as "yet another code editor."
- Border: `#262626` (dark) and `#333` (medium-dark).
- Text: `#FAFAFA` primary, `#A3A3A3` secondary, `#525252` tertiary.
- **Single accent:** A cyan-to-violet diagonal gradient - `linear-gradient(135deg, #06B6D4 0%, #8B5CF6 100%)`. Use it sparingly (focused buttons, active agent border, animated beam stroke) so it stays special.
- Per-agent colors: assign a deterministic hue per agent (HSL hue from name hash, fixed 70% saturation, 60% lightness). This makes "council mode" instantly readable.
- Status: Tailwind's emerald-500, amber-500, rose-500 for ok/warn/error.

**Accessibility:** Maintain >= 4.5:1 contrast on all body text against the OLED background. The accent gradient has marginal contrast on dark - never use it as text color, only as fills/borders.

The Geist color system ([vercel.com/geist/colors](https://vercel.com/geist/colors)) is a good reference for an accessible high-contrast palette and is structured around the same primary-blue + neutral grays approach.

## 9. Iconography

- **Lucide** ([lucide.dev](https://lucide.dev), v1.17.0, ISC-licensed): 1,714 icons, consistent 24x24 grid, customizable stroke width. The de facto choice for shadcn-stack apps. **Default pick.**
- **Phosphor** ([phosphoricons.com](https://phosphoricons.com)): Six weights (thin to fill). More personality than Lucide. Use for *accent* icons (e.g., the agent avatars or empty-state illustrations).
- **Tabler Icons:** 4,000+ icons, similar to Lucide. Use only if Lucide doesn't have what you need.
- **Custom set:** Cursor commissioned their own. Worth doing eventually for brand assets (sidebar toggles, agent badges) but not from day one.

**Recommendation:** Lucide for 95% of the UI, Phosphor (Duotone weight) for hero illustrations and agent-state icons (e.g., a unique "thinking" icon). Stick to one stroke weight (1.5px) project-wide.

## 10. Component libraries to consider

| Library | Verdict |
|---|---|
| **shadcn/ui** ([ui.shadcn.com](https://ui.shadcn.com)) | **Use as foundation.** Copy-paste components, full ownership of the code, Radix-powered, 115k stars. The introduction page and dashboard examples are exactly the kind of dense data UI we need. |
| **Radix UI** | Already underneath shadcn. No need to use directly. |
| **Magic UI** ([magicui.design](https://magicui.design)) | **Use for accents.** Animated Beam, Border Beam, Shine Border, Particles, Bento Grid, Marquee. AI-agent landing-page mainstay. Free, MIT, shadcn-compatible. |
| **Aceternity UI** ([ui.aceternity.com](https://ui.aceternity.com)) | **Use selectively.** Spotlight, Aurora Background, 3D Card, Glowing Effect (literally "as seen on Cursor's website"), Floating Dock, Sidebar. Mix of free + paid. Stylistically heavier than Magic UI - pick a few hero components, don't over-apply. |
| **Tremor** ([tremor.so](https://tremor.so)) | **Use for charts only.** Now joined Vercel. Best-in-class dashboard primitives, charts, KPI cards. Use for any analytics/usage views. |
| **Park UI** ([park-ui.com](https://park-ui.com)) | Recently joined Chakra. Good if you're on Panda CSS. Skip if you're committing to Tailwind+shadcn. |
| **HeroUI** | Good React Aria-based alternative, but the ecosystem momentum is firmly with shadcn. Skip. |
| **Mantine** | Solid but more "all-batteries-included" than the modular shadcn approach. Skip. |
| **NextUI** | Renamed to HeroUI. Same comment. |

**Stack:** shadcn/ui (foundation) + Magic UI (animated accents) + Aceternity UI (hero/marketing components only) + Tremor (charts) + cmdk (palette).

## 11. 3D & WebGL accents

- **Spline** ([spline.design](https://spline.design)): The fastest way to ship a single 3D scene. Designer-friendly, ships a runtime viewer, customers include Resend and Oscilar. Use for the voice orb.
- **react-three-fiber + drei:** The full-power option. Use only if you need audio-reactive shaders or live data-driven 3D.
- **Three.js (raw):** Same comment, more boilerplate.
- **Gradient mesh shaders / WebGL gradient backgrounds:** A subtle GLSL fragment shader for the homepage hero (a la stripe.com or linear.app circa 2023) is cheap and effective. Aceternity's "Aurora Background," "Vortex," and "Wavy Background" are CSS/SVG-only equivalents that get 90% of the look at 5% of the cost - start there.

**Recommendation:** One Spline embed (voice orb hero only) + Aceternity Aurora Background or Magic UI Light Rays for the landing page. Zero WebGL inside the working app - it kills perf on lower-end laptops, which your power users will notice.

## 12. Inspiration - 10 specific reference apps to mine

In rough priority order for our use case:

1. **Cursor 3.0** ([cursor.com](https://www.cursor.com)) - Multi-agent dashboard, mobile agent timeline, painted-scene backdrop, agent picker. The bar to clear.
2. **Linear** ([linear.app](https://linear.app)) - Density, command palette, dark UI, keyboard-first.
3. **Raycast** ([raycast.com](https://www.raycast.com)) - Command-palette ergonomics, ambient native feel, AI integration.
4. **Vercel Ship 2025** ([vercel.com/ship](https://vercel.com/ship), featured on Godly) - Geist-system showcase, gradient meshes, dev-tool aesthetic.
5. **Limitless** ([limitless.ai](https://limitless.ai)) - Ambient-AI personal-assistant UI, calm dark surfaces.
6. **Diagram** ([diagram.com](https://diagram.com)) - AI design tool, before being acquired by Figma. Great pattern reference for inline AI affordances.
7. **Reflect** ([reflect.app/home](https://reflect.app/home)) - AI-augmented note-taking with elegant dark theme.
8. **Phantom** ([phantom.app](https://phantom.app)) - Crypto wallet but a masterclass in micro-interactions and OLED dark mode.
9. **Amie** ([amie.so](https://amie.so)) - Calendar with AI, soft gradients, thoughtful animations.
10. **Augen** ([augen.pro](https://augen.pro)) - From the Godly index, modern AI aesthetic with subtle generative backgrounds.

Plus showcases worth bookmarking: [godly.website](https://godly.website), [ui.aceternity.com/showcase](https://ui.aceternity.com/showcase), and the Awwwards "AI / artificial-intelligence" tag at [awwwards.com/websites/?text=artificial-intelligence](https://www.awwwards.com/websites/?text=artificial-intelligence).

---

## 13. Concrete UI direction recommendation (final)

**Aesthetic name (working title):** *Voltage* - OLED-black, electric-accent, council-of-agents.

### Layout
- **Three-pane shell.** Left (240px, collapsible): project nav + agent list. Center (fluid): main canvas - chat thread, document, code, or split. Right (320px, slide-over): context inspector + tool-call history.
- **Top bar (40px):** project breadcrumb - global Cmd+K trigger - active agent picker - presence avatars.
- **Tab strip** above the main canvas: Arc-style draggable, drop-to-split, Cmd+T to open, Cmd+W to close. Layout transitions handled by Motion's `layout` prop.
- **"Council mode" toggle** in the top bar: morphs the center pane into an n-up grid of agent panels with a shared canvas in the middle. Animated Beams visualize routing during this mode only.

### Color system
- Base: `#0A0A0A` background - `#111` panel - `#1A1A1A` elevated - `#262626` border.
- Text: `#FAFAFA` / `#A3A3A3` / `#525252`.
- Accent: `linear-gradient(135deg, #06B6D4, #8B5CF6)` - used for focus rings, active states, animated beam strokes, voice glow border.
- Per-agent color: HSL `hue=hash(name) % 360, sat=70%, light=60%`. Render as 1px left border + avatar gradient.
- Special-moment backdrop (voice modal, onboarding, empty state): a warm painted scene image at 30% opacity, a la Cursor's wallpaper backdrops. This is the differentiator - most competitors stay clinical-cold.

### Typography
- Geist Sans (`Inter` as fallback) for UI.
- Geist Mono for code, file paths, agent IDs, timestamps.
- Sizes: 13px body, 12px secondary, 11px metadata, 14px panel headers, 18px page titles. No giant marketing type inside the app.

### Animation
- Motion v12 as the only animation library inside the app.
- Global preset: `transition: { type: "spring", stiffness: 400, damping: 30 }`.
- Magic UI's Animated Beam in council mode and on the marketing page only.
- Aceternity Glowing Effect on the active agent panel border (referenced as "as seen on Cursor's website" in their docs).
- `AnimatePresence` for palette, modals, toasts.
- No scroll-linked parallax inside the app - reserve that for the marketing site.

### Component stack
- shadcn/ui (foundation, Tailwind v4)
- cmdk (command palette engine)
- Magic UI (Animated Beam, Border Beam, Shine Border, Particles, Marquee)
- Aceternity UI (Spotlight, Aurora Background, Glowing Effect, Floating Dock - selectively)
- Tremor (charts in the analytics view)
- Lucide icons (1.5px stroke) + Phosphor Duotone for hero/agent-state icons
- Spline embed for the voice orb hero (one scene, lazy-loaded)
- Motion v12 for all in-app animation

### Multi-agent specifics
- Mention-routing via `@` typeahead built on cmdk
- Agent avatars: deterministic gradient circles
- Tool-call cards: inline, collapsible, Lucide-iconed
- Activity strip at the top of council mode: one timeline row per agent
- Council-mode beams: Magic UI Animated Beam, accent gradient stroke, ~3s duration

### Voice
- Apple-Intelligence-style CSS conic-gradient glow border during listening
- Spline orb in the voice modal
- ChatGPT-style amorphous waveform behind the orb (canvas + audio amplitude)

### Keyboard alphabet
`Cmd+K` palette - `Cmd+P` file/project - `Cmd+B` left pane - `Cmd+\` right pane - `Cmd+Enter` send - `Cmd+Shift+Enter` broadcast - `Cmd+T` new tab - `Cmd+W` close tab - `Cmd+1..9` switch tab - `Esc` exit modal/council.

### What to skip (explicitly)
- Heavy glassmorphism / neumorphism
- Three.js outside the voice orb
- More than two animation libraries
- More than one icon family in the same view
- Generative backgrounds at >20% opacity
- Brutalist/Comic-Sans marketing aesthetic
- VisionOS-style spatial floating panels (until visionOS is a real market)

This direction lands cleanly above Cursor (denser, more agent-aware), beside Linear (warmer, more visual), past Raycast (full app, not just a launcher), and beyond BridgeMind (which leans on standard chat-app patterns without the multi-agent scaffolding).

---

## Sources

- [ui.aceternity.com](https://ui.aceternity.com) - [magicui.design](https://magicui.design) - [ui.shadcn.com](https://ui.shadcn.com) - [godly.website](https://godly.website) - [motion.dev](https://motion.dev) - [vercel.com/geist](https://vercel.com/geist/introduction) - [lucide.dev](https://lucide.dev) - [phosphoricons.com](https://phosphoricons.com) - [cursor.com](https://www.cursor.com) - [linear.app/method](https://linear.app/method) - [raycast.com](https://www.raycast.com) - [github.com/dip/cmdk](https://github.com/dip/cmdk) - [tremor.so](https://tremor.so) - [park-ui.com](https://park-ui.com) - [heroui.com](https://heroui.com) - [spline.design](https://spline.design) - [awwwards.com - AI tag](https://www.awwwards.com/websites/?text=artificial-intelligence)
