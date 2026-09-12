// @vitest-environment node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import viteConfig from '../vite.config';

describe('Vite self-hosted font access', () => {
  it('allows the hoisted workspace dependency directory used by @fontsource', () => {
    const allowed = viteConfig.server?.fs?.allow ?? [];
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const workspaceNodeModules = path.resolve(testDirectory, '..', '..', 'node_modules');

    expect(allowed.map((entry) => path.resolve(entry))).toContain(workspaceNodeModules);
  });
});
