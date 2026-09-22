import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const MONO_WORKBENCH = "html[data-theme='monochrome'] .workbench-shell";
const css = readFileSync(resolve(__dirname, 'workbench.css'), 'utf8');
const parsed = postcss.parse(css);

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

function lastDeclaration(selector: string, property: string): Declaration | undefined {
  let match: Declaration | undefined;

  parsed.walkRules((rule: Rule) => {
    if (rule.selectors.some((candidate) => normalizeSelector(candidate) === selector)) {
      rule.walkDecls(property, (declaration) => {
        match = declaration;
      });
    }
  });

  return match;
}

function expectDeclaration(selector: string, property: string, value: string): void {
  expect(
    lastDeclaration(selector, property)?.value,
    `expected ${selector} to set ${property}: ${value}`,
  ).toBe(value);
}

describe('MonoChrome detached Workbench appearance', () => {
  it('flattens the mounted Workbench effect owners beneath the exact theme gate', () => {
    const backgroundOwners = [
      '.workbench-wallpaper',
      '.workbench-wallpaper::before',
      '.workbench-wallpaper::after',
      '.workbench-wallpaper-vignette',
      '.workbench-toolbar',
      '.workbench-wordmark > span',
      '.workbench-grid',
      '.workbench-panel-header',
      '.workbench-panel-resize',
      '.workbench-jarvis-new-chat',
      '.workbench-jarvis-new-chat:hover:not(:disabled)',
      '.workbench-exit-hold',
      '.workbench-exit-hold-fill',
    ] as const;
    const shadowOwners = [
      '.workbench-wallpaper::before',
      '.workbench-wallpaper::after',
      '.workbench-toolbar',
      '.workbench-wordmark > span',
      '.workbench-canvas:focus-visible',
      '.workbench-panel',
      '.workbench-panel::before',
      ".workbench-panel[data-selected='true']",
      '.workbench-panel-status',
      '.workbench-minimap',
      '.workbench-jarvis-new-chat',
      '.workbench-jarvis-new-chat:hover:not(:disabled)',
      '.workbench-exit-hold',
      ".workbench-panel-body > [role='status'].shadow-soft",
    ] as const;

    for (const owner of backgroundOwners) {
      expectDeclaration(`${MONO_WORKBENCH} ${owner}`, 'background-image', 'none');
    }
    for (const owner of shadowOwners) {
      expectDeclaration(`${MONO_WORKBENCH} ${owner}`, 'box-shadow', 'none');
    }
    for (const owner of ['.workbench-wallpaper::before', '.workbench-wallpaper::after']) {
      expectDeclaration(`${MONO_WORKBENCH} ${owner}`, 'filter', 'none');
    }
    for (const owner of ['.workbench-toolbar', '.workbench-panel-header']) {
      expectDeclaration(`${MONO_WORKBENCH} ${owner}`, 'background-color', 'hsl(var(--panel))');
    }
    expectDeclaration(`${MONO_WORKBENCH} .workbench-toolbar`, 'backdrop-filter', 'none');
  });

  it('replaces shadow-only keyboard focus with a visible outline', () => {
    for (const owner of ['.workbench-canvas:focus-visible', '.workbench-exit-hold:focus-visible']) {
      const selector = `${MONO_WORKBENCH} ${owner}`;
      expect(lastDeclaration(selector, 'outline')?.value).not.toBe('none');
      expectDeclaration(selector, 'outline-offset', '2px');
    }
  });
});

describe('Workbench panel target sizing', () => {
  it('keeps the resize target at least 24 CSS pixels after the default 78% canvas scale', () => {
    expectDeclaration('.workbench-panel-resize', 'width', 'var(--wb-resize-corner, 32px)');
    expectDeclaration('.workbench-panel-resize', 'height', 'var(--wb-resize-corner, 32px)');
  });
});
