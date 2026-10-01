import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const assetUrl = new URL('app/src/features/appearance/sakura/sakura-scene.svg', ROOT);
const sceneUrl = new URL('app/src/features/appearance/sakura/SakuraScene.tsx', ROOT);
const petalsUrl = new URL('app/src/features/appearance/sakura/SakuraPetals.tsx', ROOT);
const backdropUrl = new URL('app/src/features/appearance/sakura/SakuraBackdrop.tsx', ROOT);
const manifestUrl = new URL('docs/appearance/sakura/asset-manifest.json', ROOT);

function canonicalTextBytes(source) {
  return Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
}

test('Sakura scene is a bounded local owner-supplied layered SVG with a stable crop contract', async () => {
  const svg = await readFile(assetUrl, 'utf8');
  assert.match(svg, /viewBox="0 0 1600 1000"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
  assert.match(svg, /<linearGradient id="sky"[\s\S]*?#f8d3c9[\s\S]*?#140e30/u);
  assert.match(svg, /fill="url\(#mountA\)"/u);
  assert.match(svg, /fill="url\(#mountB\)"/u);
  assert.match(svg, /fill="url\(#water\)"/u);
  assert.match(svg, /<!-- pavilion -->[\s\S]*?transform="translate\(132 485\)"/u);
  assert.match(svg, /<!-- lantern -->[\s\S]*?transform="translate\(1368 635\)"/u);
  assert.match(svg, /<!-- branch and blossoms -->/u);
});

test('Sakura asset is CSP-safe original vector content without prototype/runtime leakage', async () => {
  const svg = await readFile(assetUrl, 'utf8');
  const withoutCanonicalNamespace = svg.replace(
    'xmlns="http://www.w3.org/2000/svg"',
    'xmlns="[canonical-svg-namespace]"',
  );
  assert.doesNotMatch(
    withoutCanonicalNamespace,
    /<script|<foreignObject|<image|data:|https?:|javascript:|on(?:click|load|error)\s*=|<metadata/i,
  );
  assert.doesNotMatch(svg, /[\u3040-\u30ff\u3400-\u9fff]/u);
  assert.ok(Buffer.byteLength(svg) < 32_000, 'scene SVG must remain below 32 KiB');
});

test('scene host has no business store, random, timer, or continuous animation imports', async () => {
  const sources = await Promise.all(
    [sceneUrl, petalsUrl, backdropUrl].map((url) => readFile(url, 'utf8')),
  );
  const source = sources.join('\n');
  assert.doesNotMatch(source, /stores\/(auth|chat|project|workspace)|useAuthStore|useChatStore/);
  assert.doesNotMatch(source, /Math\.random|setInterval|setTimeout/);
  assert.doesNotMatch(sources[1], /requestAnimationFrame|useState|useEffect/);
});

test('production asset manifest freezes provenance, crop, size, and exact bytes', async () => {
  const svg = canonicalTextBytes(await readFile(assetUrl));
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const asset = manifest.productionAssets?.find(
    (entry) => entry.path === 'app/src/features/appearance/sakura/sakura-scene.svg',
  );

  assert.ok(asset, 'production Sakura scene must be recorded');
  assert.equal(asset.origin, 'owner-authorized-reference-extract');
  assert.equal(asset.referenceCopyPolicy, 'exact-owner-provided-scene-extract');
  assert.equal(asset.viewBox, '0 0 1600 1000');
  assert.equal(asset.preserveAspectRatio, 'xMidYMid slice');
  assert.equal(asset.bytes, svg.byteLength);
  assert.equal(asset.sha256, createHash('sha256').update(svg).digest('hex').toUpperCase());
});
