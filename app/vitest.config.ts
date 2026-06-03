/**
 * Vitest configuration.
 *
 * Mirrors the path aliases from `vite.config.ts` so test files can use
 * the same `@/foo` imports as runtime code. We use `jsdom` so React
 * components and `window`-bound stores (zustand persist, localStorage,
 * the action runtime listener) work without per-test setup.
 *
 * Test files live next to the code they cover (`*.test.ts(x)` siblings).
 * The Tauri Rust crate is not in scope here; that has its own
 * `cargo test` runner.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Tauri's `@tauri-apps/api` does dynamic imports of native bridges that
    // jsdom can't resolve. We mock it in setup.ts.
    server: {
      deps: {
        inline: [/@tauri-apps\/api/],
      },
    },
  },
});
