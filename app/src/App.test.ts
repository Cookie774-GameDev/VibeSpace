import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('workspace lazy boundaries', () => {
  test('keeps the ambient lazy module inside a Suspense boundary', () => {
    expect(appSource).toMatch(
      /<React\.Suspense fallback=\{null\}>\s*<AmbientHome\s*\/>\s*<\/React\.Suspense>/,
    );
  });
});
