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
import fs from 'node:fs';
import path from 'node:path';

function allowedFsRoots(): string[] {
  const candidates = [
    path.resolve(__dirname),
    path.resolve(__dirname, 'node_modules'),
    path.resolve(__dirname, '../node_modules'),
    path.resolve(__dirname, 'node_modules/web-tree-sitter'),
    path.resolve(__dirname, '../node_modules/web-tree-sitter'),
    path.resolve(__dirname, 'node_modules/gpt-tokenizer'),
  ];
  const allowed = new Set<string>();
  for (const candidate of candidates) {
    allowed.add(candidate);
    try {
      if (fs.existsSync(candidate)) allowed.add(fs.realpathSync(candidate));
    } catch {
      /* keep the unresolved path */
    }
  }
  return [...allowed];
}

const localTreeSitter = path.resolve(__dirname, '../node_modules/web-tree-sitter');

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: allowedFsRoots(),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      ...(fs.existsSync(localTreeSitter) ? { 'web-tree-sitter': localTreeSitter } : {}),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Keep the full repository suite bounded. Several CPU/filesystem-heavy
    // security and native-adapter tests are fast in isolation but can starve
    // under Vitest's host-derived worker count; bound file workers instead of
    // weakening per-test timeouts or assertions.
    maxWorkers: 2,
    // Tauri's `@tauri-apps/api` does dynamic imports of native bridges that
    // jsdom can't resolve. We mock it in setup.ts.
    server: {
      deps: {
        inline: [/@tauri-apps\/api/],
      },
    },
  },
});
