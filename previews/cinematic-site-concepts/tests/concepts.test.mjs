import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('exports five distinct worlds with three scenes each', async () => {
  const { CONCEPT_ORDER, CONCEPTS, getConcept } = await import('../concepts.mjs');

  assert.deepEqual(CONCEPT_ORDER, ['aperture', 'desk', 'cosmos', 'foundry', 'archive']);
  assert.equal(Object.keys(CONCEPTS).length, 5);

  const signatures = new Set();
  const palettes = new Set();
  for (const id of CONCEPT_ORDER) {
    const concept = CONCEPTS[id];
    assert.equal(getConcept(id), concept);
    assert.equal(concept.scenes.length, 3);
    assert.deepEqual(
      concept.scenes.map((scene) => scene.phase),
      ['Awakening', 'Orchestration', 'Release'],
    );
    signatures.add(concept.signature);
    palettes.add(concept.palette.join(','));
  }

  assert.equal(signatures.size, 5);
  assert.equal(palettes.size, 5);
  assert.equal(getConcept('missing'), CONCEPTS.aperture);
});

test('comparison hub exposes all worlds as buttons and direct previews', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /id="concept-frame"/);
  assert.match(html, /id="open-concept"/);
  for (const id of ['aperture', 'desk', 'cosmos', 'foundry', 'archive']) {
    assert.match(html, new RegExp(`data-concept-target="${id}"`));
  }
  assert.match(html, /hub\.mjs/);
});

test('maps native scroll to bounded journey progress and three stable scenes', async () => {
  const { clamp, resolveJourney, resolveScene } = await import('../cinematic.mjs');

  assert.equal(clamp(-4, 0, 1), 0);
  assert.equal(clamp(4, 0, 1), 1);
  assert.equal(clamp(0.4, 0, 1), 0.4);
  assert.equal(resolveJourney(0, 1000, 4000), 0);
  assert.equal(resolveJourney(1500, 1000, 4000), 0.5);
  assert.equal(resolveJourney(6000, 1000, 4000), 1);
  assert.deepEqual(resolveScene(0, 3), { index: 0, local: 0 });
  assert.deepEqual(resolveScene(0.5, 3), { index: 1, local: 0.5 });
  assert.deepEqual(resolveScene(1, 3), { index: 2, local: 1 });
});

test('every world entrypoint exposes the same usable three-chapter journey', async () => {
  const entries = {
    aperture: 'aperture.html',
    desk: 'infinite-desk.html',
    cosmos: 'context-cosmos.html',
    foundry: 'agent-foundry.html',
    archive: 'living-archive.html',
  };

  for (const [id, file] of Object.entries(entries)) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<body[^>]+data-concept="${id}"`));
    assert.equal((html.match(/class="journey-copy(?:\s|")/g) || []).length, 3);
    assert.match(html, /id="world-canvas"/);
    assert.match(html, /href="https:\/\/github\.com\/Cookie774-GameDev\/VibeSpace\/releases\/latest"/);
    assert.match(html, /Download VibeSpace/);
    assert.match(html, /cinematic\.mjs/);
  }
});

test('cinematic stylesheet includes responsive and reduced-motion paths', async () => {
  const css = await readFile(new URL('../concept.css', import.meta.url), 'utf8');

  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.journey-copy\.is-active/);
  assert.match(css, /#world-canvas/);
});
