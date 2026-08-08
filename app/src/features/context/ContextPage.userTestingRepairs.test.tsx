import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Context Map focused user-testing repairs', () => {
  it('opens a focused graph with top instructions and a compact inspector', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('data-context-focused-map');
    expect(source).toContain('Select a node to inspect details, links, and backlinks');
    expect(source).toContain('Esc closes focused view');
    expect(source).toContain('compact');
    expect(source).toContain('await selectMap(mapId)');
  });

  it('keeps every source picker in Context and places nightly maintenance after creation', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain("chooseProjectFiles(false");
    expect(source).toContain("setWorkspaceSection('sources')");
    expect(source).not.toContain('<ContextRecoveryNotice');
    expect(source.indexOf('<ContextSourceCards')).toBeLessThan(
      source.indexOf('<NightlySecondBrainPanel'),
    );
    expect(source).toContain('Create map');
  });
});
