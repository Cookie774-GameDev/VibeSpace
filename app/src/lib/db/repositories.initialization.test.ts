import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it, vi } from 'vitest';

const databaseAccess = vi.hoisted(() => ({
  properties: [] as PropertyKey[],
}));

vi.mock('./index', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        databaseAccess.properties.push(property);
        throw new Error(`database accessed during module initialization: ${String(property)}`);
      },
    },
  ),
}));

it('does not access database tables during module initialization', async () => {
  await expect(import('./repositories')).resolves.toBeDefined();
  expect(databaseAccess.properties).toEqual([]);
});

it('does not bind the database into a repository during module initialization', () => {
  const source = readFileSync(resolve('src/lib/db/repositories.ts'), 'utf8');
  expect(source).not.toMatch(
    /export const memoryEvidenceRepo\s*=\s*createMemoryEvidenceRepository\(db\);/u,
  );
});

it('does not evaluate the circular database binding while constructing reminder claims', () => {
  const source = readFileSync(resolve('src/lib/db/repositories.ts'), 'utf8');
  expect(source).not.toMatch(
    /createReminderClaimRepository\s*\(\s*database:\s*JarvisDexie\s*=\s*db\s*\)/u,
  );
});
