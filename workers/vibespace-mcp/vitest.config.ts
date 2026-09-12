import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          RELAY_TICKET_KEY: 'test-only-relay-ticket-signing-key-0000000000000000',
          SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_value',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15_000,
  },
});
