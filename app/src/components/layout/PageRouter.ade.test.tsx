import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PageRouter ChatGPT ADE compatibility route', () => {
  it('removes the standalone ADE page and delegates old route state to the Workbench redirect', () => {
    const source = readFileSync('src/components/layout/PageRouter.tsx', 'utf8');
    expect(source).not.toContain('ChatGptAdePage');
    expect(source).toContain('ChatGptAdeRedirect');
    expect(source).toMatch(/ade:\s*ChatGptAdeRedirect/u);
  });
});
