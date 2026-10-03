import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'app/src-tauri');
const base = JSON.parse(await readFile(path.join(native, 'tauri.conf.json'), 'utf8'));
const windows = JSON.parse(await readFile(path.join(native, 'tauri.windows.conf.json'), 'utf8'));

// Tauri applies RFC 7396: objects merge recursively; arrays replace, never concatenate.
function mergePatch(document, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  const result =
    document !== null && typeof document === 'object' && !Array.isArray(document)
      ? structuredClone(document)
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function connectorResourceFiles(config) {
  const resources = config.bundle.resources;
  assert.ok(
    Array.isArray(resources)
      ? resources.includes('resources/desktop-connector/*')
      : resources?.['resources/desktop-connector/*'] === 'resources/desktop-connector/',
    'Effective Windows resources must include the connector archive and manifest',
  );
  // Both files are immediate children of this glob. No generated runtime is needed in CI.
  return ['manifest.json', 'runtime.zip'].map((name) => `resources/desktop-connector/${name}`);
}

test('effective Windows configuration includes the packaged connector resource closure', () => {
  const merged = mergePatch(base, windows);
  assert.deepEqual(connectorResourceFiles(merged), [
    'resources/desktop-connector/manifest.json',
    'resources/desktop-connector/runtime.zip',
  ]);
  assert.deepEqual(merged.bundle.resources, windows.bundle.resources);
  for (const [key, command] of Object.entries(base.build)) {
    assert.deepEqual(merged.build[key], command, `Windows overlay retains ${key}`);
  }
  assert.equal(merged.build.beforeBundleCommand, 'node ../scripts/prepare-windows-runtime-dlls.mjs');
});

// These destinations are the native release contract, independent of the overlay.
const existingDestinations = {
  'resources/desktop-connector/*': 'resources/desktop-connector/',
  'resources/intro/*': 'resources/intro/',
  '../../docs/oss/dependency-lock.json': '_up_/_up_/docs/oss/dependency-lock.json',
  '../../docs/oss/grammar-license-inventory.md': '_up_/_up_/docs/oss/grammar-license-inventory.md',
  '../../docs/oss/THIRD_PARTY_NOTICES.md': '_up_/_up_/docs/oss/THIRD_PARTY_NOTICES.md',
  '../../docs/oss/sbom-pr31.cdx.json': '_up_/_up_/docs/oss/sbom-pr31.cdx.json',
  '../../docs/oss/browser-agent-feature-pack.json': '_up_/_up_/docs/oss/browser-agent-feature-pack.json',
  '../../docs/oss/licenses/*': '_up_/_up_/docs/oss/licenses/',
  'resources/siyuan-runtime/': 'resources/siyuan-runtime/',
  'resources/relay-runtime/*': 'resources/relay-runtime/',
};

function assertExistingDestinations(resources) {
  for (const [source, destination] of Object.entries(existingDestinations)) {
    if (Array.isArray(resources)) {
      const oldSource = source === 'resources/siyuan-runtime/' ? `${source}**/*` : source;
      assert.ok(resources.includes(oldSource), `Retain ${oldSource}`);
    } else {
      assert.equal(resources?.[source], destination, `Retain destination for ${source}`);
    }
  }
}

test('Windows resource declarations preserve all existing packaged destinations', () => {
  assertExistingDestinations(windows.bundle.resources);
  assert.equal(windows.bundle.resources['resources/windows-runtime-dlls/'], '', 'DLLs install beside the executable');
});

test('the resource contract accepts legacy arrays and equivalent directory maps', () => {
  const legacy = Object.keys(existingDestinations).map(source =>
    source === 'resources/siyuan-runtime/' ? `${source}**/*` : source);
  assertExistingDestinations(legacy);
  assertExistingDestinations(existingDestinations);
  connectorResourceFiles({ bundle: { resources: legacy } });
  connectorResourceFiles({ bundle: { resources: existingDestinations } });
});

test('any omitted or relocated original resource fails the Windows contract', () => {
  for (const source of Object.keys(existingDestinations)) {
    const omitted = { ...existingDestinations };
    delete omitted[source];
    assert.throws(() => assertExistingDestinations(omitted), /Retain destination/u);
    const relocated = { ...existingDestinations, [source]: 'wrong-destination/' };
    assert.throws(() => assertExistingDestinations(relocated), /Retain destination/u);
  }
});

test('a base connector glob cannot hide an omission in the Windows overlay', () => {
  assert.ok(base.bundle.resources.includes('resources/desktop-connector/*'));
  const missing = structuredClone(windows);
  if (Array.isArray(missing.bundle.resources)) {
    missing.bundle.resources = missing.bundle.resources.filter(resource => resource !== 'resources/desktop-connector/*');
  } else {
    delete missing.bundle.resources['resources/desktop-connector/*'];
  }
  assert.throws(() => connectorResourceFiles(mergePatch(base, missing)), /Effective Windows/u);
});

test('native connector looks in packaged resources and restricts source fallback to debug', async () => {
  const source = await readFile(path.join(native, 'src/desktop_connector.rs'), 'utf8');
  const lookup = source.split('fn resources(app: &AppHandle)')[1]?.split('fn packaged(')[0];
  assert.ok(lookup, 'Inspect the actual native resource lookup function');
  assert.match(lookup, /\.resource_dir\(\)[\s\S]*?\.join\("resources\/desktop-connector"\)/u);
  assert.match(
    lookup,
    /#\[cfg\(debug_assertions\)\]\s*let debug_source\s*=\s*Some\(PathBuf::from\(env!\("CARGO_MANIFEST_DIR"\)\)\.join\("resources\/desktop-connector"\)\);/u,
  );
  assert.match(lookup, /#\[cfg\(not\(debug_assertions\)\)\]\s*let debug_source = None;/u);
  assert.match(lookup, /select_resources\(packaged, debug_source\)/u);
  const merged = mergePatch(base, windows);
  assert.ok(merged.build.beforeBuildCommand.includes('prepare-desktop-connector.mjs'));
  connectorResourceFiles(merged);
});
