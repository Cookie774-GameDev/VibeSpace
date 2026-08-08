import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const cssPath = resolve(process.cwd(), 'src/styles/origami-theme.css');

describe('Origami theme presentation contract', () => {
  it('is isolated, tokenized, accessible, and references only bundled assets', () => {
    const css = readFileSync(cssPath, 'utf8');
    const root = postcss.parse(css);

    expect(css).toContain("html[data-theme='origami']");
    expect(css).toContain('--origami-paper:');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).not.toMatch(/https?:\/\//u);

    root.walkRules((rule) => {
      const parent = rule.parent;
      if (parent?.type === 'atrule' && parent.name === 'keyframes') return;
      if (rule.selector.startsWith('@')) return;
      for (const selector of rule.selectors) {
        expect(selector, `unscoped Origami selector: ${selector}`).toMatch(
          /html\[data-theme='origami'\]/u,
        );
      }
    });

    for (const match of css.matchAll(/url\(['"]?(\/assets\/themes\/origami\/[^'")]+)['"]?\)/gu)) {
      expect(existsSync(resolve(process.cwd(), 'public', match[1].slice(1)))).toBe(true);
    }
  });

  it('keeps terminal payload and authored chat message elements outside its selectors', () => {
    const css = readFileSync(cssPath, 'utf8');
    expect(css).not.toMatch(/\.xterm(?:-|\b)/u);
    expect(css).not.toMatch(/\[data-message/u);
    expect(css).not.toMatch(/\.prose/u);
  });

  it('keeps browser-preview terminal wells dark and gives Kanban real folded-paper depth', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\[data-terminal-drop='pane'\]\s+\[role='status'\]/u);
    expect(css).toContain('--origami-terminal-well:');
    expect(css).toMatch(/\[data-monochrome-surface='kanban-column'\]::before/u);
    expect(css).toContain('clip-path: polygon(100% 0, 0 0, 100% 100%)');
  });
});
