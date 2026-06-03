import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config/
const host = process.env.TAURI_DEV_HOST;

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
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) {
    // App code: split AI providers into their own chunk so the heavy
    // adapters don't ride the boot path. Settings sections are NOT split
    // here on purpose (see comment block above).
    if (id.includes('/src/lib/ai/providers/')) return 'ai-providers';
    return undefined;
  }

  // node_modules — vendor chunks keyed off the package name segment.
  const m = id.match(/node_modules\/(?:\.pnpm\/)?(@[^/]+\/[^/]+|[^/]+)/);
  const pkg = m ? m[1] : null;
  if (!pkg) return undefined;

  if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react';
  if (pkg === 'motion' || pkg === 'framer-motion') return 'motion';
  if (pkg.startsWith('@radix-ui/')) return 'radix';
  if (pkg === 'dexie' || pkg === 'dexie-react-hooks') return 'dexie';
  if (pkg === 'lucide-react') return 'lucide';
  if (pkg === '@supabase/supabase-js' || pkg.startsWith('@supabase/')) return 'supabase';
  if (pkg === 'livekit-client') return 'livekit';
  if (pkg === 'xterm' || pkg.startsWith('xterm-addon-')) return 'xterm';
  if (pkg === 'cmdk') return 'cmdk';
  if (pkg === 'zustand') return 'zustand';
  if (pkg === 'date-fns') return 'date-fns';
  if (pkg === 'class-variance-authority' || pkg === 'clsx' || pkg === 'tailwind-merge') {
    return 'ui-utils';
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],

  // Path aliases mirror tsconfig.json
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Vite options tailored for Tauri development
  // tauri expects a fixed port, fail if that port is not available
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },

  // Env variables prefixed with VITE_ are exposed to client bundle
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS / Linux
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: true,
    // Bumped from the default 500kB to 700kB. We've split everything we
    // can without making cold loads more expensive than warm ones; the
    // Terminals page (xterm + addons + our pane chrome) is the
    // remaining lazy-loaded outlier and lives well under the new bound.
    chunkSizeWarningLimit: 700,
    rollupOptions: process.env.TAURI_ENV_DEBUG
      ? { treeshake: false }
      : {
          output: {
            manualChunks,
          },
        },
  },
});

