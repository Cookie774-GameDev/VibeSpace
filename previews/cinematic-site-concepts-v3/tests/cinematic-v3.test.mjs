import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("content defines three materially distinct worlds over one eight-beat product story", async () => {
  const contentUrl = pathToFileURL(path.join(root, "runtime", "content.mjs"));
  const { CONCEPTS, PRODUCT_BEATS, PRICING, getConcept } = await import(contentUrl.href);

  assert.deepEqual(
    CONCEPTS.map(({ id }) => id),
    ["quiet-ascent", "living-desk", "garden-of-work"],
  );
  assert.equal(PRODUCT_BEATS.length, 8);
  assert.deepEqual(
    PRODUCT_BEATS.map(({ id }) => id),
    ["arrival", "jarvis", "agents", "schedule", "workspace", "skills", "trust", "access"],
  );

  for (const concept of CONCEPTS) {
    assert.equal(getConcept(concept.id), concept);
    assert.equal(concept.beats.length, PRODUCT_BEATS.length);
    assert.equal(new Set(concept.beats.map(({ asset }) => asset)).size >= 6, true);
    assert.match(concept.loaderLabel, /ready|prepar|growing|opening|drawing/i);
    assert.equal(concept.motion.length > 20, true);
  }

  assert.equal(new Set(CONCEPTS.map(({ grammar }) => grammar)).size, 3);
  assert.equal(PRICING.access, 20);
  assert.equal(PRICING.trialDays, 30);
  assert.equal(PRICING.autoConverts, false);
  assert.deepEqual(
    PRICING.plans.map(({ name, price }) => [name, price]),
    [
      ["Spark", 0],
      ["Orbit", 10],
      ["Nova", 50],
      ["Singularity", 100],
    ],
  );
});

test("all product artwork is local, provenance-recorded, and byte-identical", async () => {
  const manifest = JSON.parse(await read("assets/product/manifest.json"));
  assert.equal(manifest.source.includes("VibeSpace UI Themes"), true);
  assert.equal(manifest.assets.length >= 8, true);

  for (const entry of manifest.assets) {
    assert.match(entry.file, /^[a-z0-9-]+\.png$/);
    assert.match(entry.source, /\.png$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(path.join(root, "assets", "product", entry.file));
    assert.equal(digest(bytes), entry.sha256, entry.file);
    assert.equal(bytes.byteLength > 250_000, true, `${entry.file} should be an original full UI surface`);
  }
});

test("each world route is a complete semantic product site", async () => {
  const routes = [
    ["quiet-ascent.html", "quiet-ascent"],
    ["living-desk.html", "living-desk"],
    ["garden-of-work.html", "garden-of-work"],
  ];

  for (const [file, id] of routes) {
    const html = await read(file);
    assert.match(html, /<main id="world"/);
    assert.match(html, new RegExp(`mountWorld\\(.*"${id}"`));
    assert.match(html, /world\.css/);
    assert.match(html, /concepts\.css/);
    assert.match(html, /<noscript>/);
    assert.match(html, /VibeSpace/);
  }
});

test("runtime includes smooth reversible travel and meaningful non-scroll input", async () => {
  const runtime = await read("runtime/world-engine.mjs");
  assert.match(runtime, /requestAnimationFrame/);
  assert.match(runtime, /pointermove/);
  assert.match(runtime, /keydown/);
  assert.match(runtime, /PageDown/);
  assert.match(runtime, /PageUp/);
  assert.match(runtime, /aria-current/);
  assert.match(runtime, /feature-marker/);
  assert.match(runtime, /detail-drawer/);
  assert.match(runtime, /scrollTo/);
  assert.match(runtime, /reducedMotion/);
});

test("styling includes accessibility, desktop boundary, and three unique spatial grammars", async () => {
  const shared = await read("world.css");
  const concepts = await read("concepts.css");
  assert.match(shared, /:focus-visible/);
  assert.match(shared, /prefers-reduced-motion/);
  assert.match(shared, /max-width:\s*1099px/);
  assert.match(shared, /--world-progress/);
  assert.match(concepts, /\[data-concept="quiet-ascent"\]/);
  assert.match(concepts, /\[data-concept="living-desk"\]/);
  assert.match(concepts, /\[data-concept="garden-of-work"\]/);
  assert.match(concepts, /mountain-plane/);
  assert.match(concepts, /paper-layer/);
  assert.match(concepts, /garden-branch/);
});

test("gallery presents three grading portals without changing their product spine", async () => {
  const [html, css, script] = await Promise.all([
    read("index.html"),
    read("gallery.css"),
    read("gallery.mjs"),
  ]);
  assert.match(html, /Three worlds\. One true VibeSpace\./);
  assert.match(html, /quiet-ascent\.html/);
  assert.match(html, /living-desk\.html/);
  assert.match(html, /garden-of-work\.html/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /pointermove/);
});

test("pricing and trust language remain truthful", async () => {
  const files = await Promise.all(
    ["runtime/content.mjs", "runtime/world-engine.mjs"].map((file) => read(file)),
  );
  const source = files.join("\n");
  assert.match(source, /\$20/);
  assert.match(source, /30-day/);
  assert.match(source, /does not auto-convert/i);
  assert.match(source, /billed separately/i);
  assert.doesNotMatch(source, /\bAI-powered\b/i);
  assert.doesNotMatch(source, /\brevolutionary\b/i);
});

test("loader and optional sound are explicit, skippable, and gesture-gated", async () => {
  const [loader, sound] = await Promise.all([
    read("runtime/loader.mjs"),
    read("runtime/sound.mjs"),
  ]);
  assert.match(loader, /100/);
  assert.match(loader, /skip/i);
  assert.match(loader, /requestAnimationFrame/);
  assert.match(sound, /AudioContext/);
  assert.match(sound, /unlock/);
  assert.match(sound, /suspend/);
});
