import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function compactCss(css: string): string {
  return css.replace(/\s+/g, ' ').trim();
}

const css = compactCss(
  readFileSync(join(process.cwd(), 'src/components/layout/sakura-shell.css'), 'utf8'),
);

describe('Sakura shell source geometry', () => {
  it('uses the native application edge with no inset demo frame', () => {
    expect(css).toMatch(/\[data-sakura-shell='true'\] \{ padding: 0; border-radius: 0;/);
    expect(css).toMatch(
      /\[data-sakura-shell='true'\] > \.sakura-shell-frame \{ overflow: hidden; border: 0; border-radius: 0; box-shadow: none;/,
    );
    expect(css).not.toContain('--sakura-shell-inset');
  });

  it('preserves chrome and optional inspector bounds', () => {
    expect(css).toMatch(/\.sakura-shell-top-bar \{ min-height: 40px; max-height: 48px;/);
    expect(css).toMatch(/\.sakura-shell-tab-strip \{ min-height: 32px; max-height: 40px;/);
    expect(css).toMatch(/\.sakura-shell-inspector \{ max-width: 320px;/);
  });

  it('keeps expanded and collapsed nav geometry explicit and yields width in narrow layouts', () => {
    expect(css).toMatch(
      /\.sakura-shell-navigation\[data-nav-state='expanded'\] \{ min-width: 226px; max-width: 240px;/,
    );
    expect(css).toMatch(
      /\.sakura-shell-navigation\[data-nav-state='collapsed'\] \{ min-width: 56px; max-width: 56px;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]*\.sakura-shell-navigation\[data-nav-state='expanded'\] \{ max-width: 226px;/,
    );
  });

  it('uses the 1024x768/narrow overlay boundary and an opaque forced-colors surface', () => {
    expect(css).toContain('@media (max-width: 1100px), (max-height: 760px)');
    expect(css).toMatch(
      /\.sakura-shell-inspector \{ position: absolute;[\s\S]*max-width: clamp\(278px, 32vw, 320px\);/,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*background: Canvas; border: 0; box-shadow: none;/,
    );
  });

  it('keeps inspector controls at the WCAG target-size floor', () => {
    expect(css).toMatch(/\.sakura-shell-inspector button \{ min-width: 24px; min-height: 24px;/);
  });

  it('sizes the inspector without specificity overrides', () => {
    expect(css).not.toContain('!important');
    expect(css).toMatch(/\.sakura-shell-inspector-content \{ max-width: 100%;/);
  });
});
