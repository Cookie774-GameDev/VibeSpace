import { describe, expect, it } from 'vitest';
import { OPEN_SOURCE_CREDITS } from './OpenSourceCredits';

describe('open-source credits', () => {
  it('credits the pinned browser and MCP foundations without claiming bundled browsers', () => {
    expect(OPEN_SOURCE_CREDITS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'MCP TypeScript SDK',
          repository: 'https://github.com/modelcontextprotocol/typescript-sdk',
          license: 'MIT',
          version: '1.30.0',
          status: 'production dependency',
        }),
        expect.objectContaining({
          name: 'Microsoft Playwright',
          repository: 'https://github.com/microsoft/playwright',
          license: 'Apache-2.0',
          version: '1.61.1',
          status: 'optional feature pack',
        }),
      ]),
    );
    expect(
      OPEN_SOURCE_CREDITS.find(({ name }) => name === 'Microsoft Playwright')?.contribution,
    ).toMatch(/without bundling browsers into the default app/i);
  });
});
