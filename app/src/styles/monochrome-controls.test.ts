import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'monochrome-theme.css'), 'utf8');

describe('MonoChrome control sizing', () => {
  it('keeps form controls compact without collapsing content-bearing buttons', () => {
    expect(css).toMatch(
      /button:not\(\.rounded-full\):not\(\[data-monochrome-control-size='preserve'\]\)\s*\{\s*min-height:\s*28px;\s*\}/,
    );
    expect(css).not.toMatch(
      /button:not\(\.rounded-full\):not\(\[data-monochrome-control-size='preserve'\]\)[^{]*\{[^}]*max-height:/,
    );
    expect(css).toMatch(
      /select:not\(\[data-monochrome-control-size='preserve'\]\)\s*\{[^}]*height:\s*32px;[^}]*max-height:\s*36px;/,
    );
  });
});
