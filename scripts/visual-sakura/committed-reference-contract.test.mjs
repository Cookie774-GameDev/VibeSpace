import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve();
const css = readFileSync(path.join(repoRoot, 'app', 'src', 'styles', 'sakura-theme.css'), 'utf8');
const shellCss = readFileSync(
  path.join(repoRoot, 'app', 'src', 'components', 'layout', 'sakura-shell.css'),
  'utf8',
);
const petalsSource = readFileSync(
  path.join(repoRoot, 'app', 'src', 'features', 'appearance', 'sakura', 'SakuraPetals.tsx'),
  'utf8',
);
const reference = JSON.parse(
  readFileSync(path.join(repoRoot, 'docs', 'appearance', 'sakura', 'reference-spec.json'), 'utf8'),
);

test('committed Sakura palette and geometry retain the supplied design authority', () => {
  const expectedColors = {
    night: '#140e30',
    'night-2': '#232051',
    indigo: '#2f2b71',
    periwinkle: '#4e518a',
    lavender: '#a082aa',
    orchid: '#916285',
    pink: '#eeabb7',
    coral: '#ef6f88',
    peach: '#f5cec8',
    ivory: '#fff7f2',
    gold: '#ffd978',
    mint: '#9ed0b8',
  };
  for (const [token, color] of Object.entries(expectedColors)) {
    assert.match(css, new RegExp(`--sakura-${token}:\\s*${color}`, 'i'));
  }

  assert.match(css, /--sakura-radius-shell:\s*24px/);
  assert.match(css, /--sakura-blur:\s*14px/);
  assert.match(
    shellCss,
    /\[data-sakura-shell='true'\]\s*\{[^}]*padding:\s*0;[^}]*border-radius:\s*0;/s,
  );
  assert.doesNotMatch(shellCss, /--sakura-shell-inset:/);
  assert.match(
    shellCss,
    /\.sakura-shell-top-bar\s*\{[^}]*min-height:\s*40px;[^}]*max-height:\s*48px/s,
  );
  assert.match(
    shellCss,
    /\.sakura-shell-navigation\[data-nav-state='expanded'\]\s*\{[^}]*min-width:\s*226px;[^}]*max-width:\s*240px/s,
  );
  assert.equal(reference.observedPrototypeGeometry.shellRadiusPx, 24);
  assert.equal(reference.referenceViewport.width, 1440);
  assert.equal(reference.referenceViewport.height, 900);
});

test('committed Sakura materials and effects preserve depth without prototype runtime leakage', () => {
  assert.match(css, /backdrop-filter:\s*blur\(var\(--sakura-blur\)\)\s+saturate\(1\.08\)/);
  assert.match(css, /@keyframes\s+sakura-petal-drift/);
  assert.match(css, /animation:\s*sakura-petal-drift/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(petalsSource, /Math\.random|setInterval|requestAnimationFrame/);

  const petalRows = [...petalsSource.matchAll(/\{\s*delay:\s*'[^']+'/g)];
  assert.equal(petalRows.length, 12, 'production must keep exactly twelve deterministic petals');
});
