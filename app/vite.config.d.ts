/**
 * Manual chunk strategy.
 *
 * The default Vite split puts everything that's reachable at boot into a
 * single ~1.6MB index chunk. We split it along three seams the runtime
 * naturally tolerates:
 *
 *   `react`         — react + react-dom + jsx runtime. Stable; long cache life.
 *   `motion`        — animation runtime used by ~25 components. Big and
 *                     largely independent; shipping it as its own chunk
 *                     lets the browser cache it across deploys.
 *   `radix`         — every Radix UI primitive. Used everywhere in modals
 *                     and menus, so it stays eagerly loaded but as its
 *                     own chunk for caching.
 *   `dexie`         — IndexedDB layer. Eager (boot calls openDb) but
 *                     stable.
 *   `lucide`        — icon set. Tree-shakes per import but the metadata
 *                     still adds up; isolating helps caching.
 *   `ai-providers`  — every LLM adapter (Anthropic / OpenAI / Google /
 *                     Groq / Ollama / SSE parser). Imported lazily by
 *                     the router on first chat call (see lib/ai/router.ts).
 *   `supabase`      — Supabase JS client. Only imported when sign-in or
 *                     billing flows mount.
 *   `livekit`       — LiveKit voice transport. Only loaded when the user
 *                     actually starts a Jarvis Call.
 *   `xterm`         — terminal emulator. Already lazy via Terminals page.
 *   `cmdk`          — Cmd+K palette + mention typeahead.
 *   `gpt-o200k`     — immutable o200k rank data used by repository token budgets.
 *                     Isolated from the application bootstrap for stable caching
 *                     without pulling the separately lazy cl100k table forward.
 *
 * Settings-sections — deliberately NOT in this list.
 *
 * v0.1.5: We previously had `if (id.includes('/src/features/settings/sections/')) return 'settings-sections'`
 * here. That rule looked harmless but was actively counterproductive:
 * Rollup, when forced to put 11 section files in a named chunk, started
 * relocating shared code (`useUIStore`, Button/Badge/Switch/Separator,
 * Lucide re-exports, ~22 bindings total) into that chunk because both
 * the eager boot graph and the lazy sections used them. The boot chunk
 * then had to STATICALLY import the named chunk to recover its own
 * shared symbols, which forced `settings-sections-*.js` into the
 * `<link rel="modulepreload">` list at boot — and `settings-sections`
 * itself statically imports `@/lib/supabase/client` (PhoneVoice section)
 * AND `@/features/call/CallService` (PhoneVoice section), so supabase
 * (~210KB) and livekit (~504KB) rode along on the modulepreload list
 * for every cold load — even for users who never opened Settings.
 *
 * Dropping the rule lets Rollup naturally place the section files in
 * the lazy `SettingsModal` chunk (the one the `App.tsx` `React.lazy`
 * boundary creates), keeps shared symbols in the boot chunk, and stops
 * the back-edge that was preloading supabase + livekit at startup.
 */
declare const _default: import("vite").UserConfig;
export default _default;
