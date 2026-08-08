import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as nativeAuthority from './native-window-manifest.ts';

const SOURCE_COMMIT = nativeAuthority.MONOCHROME_NATIVE_SOURCE_COMMIT;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const EXPECTED_CAPABILITIES = [
  [
    'cold-start-intro.json',
    'cold-start-intro',
    ['cold-start-intro'],
    'F001AC42A3A01888CC83B86AEC9817E994AE25F5B5A5F30A1B5DB92A0A9E3648',
  ],
  [
    'default.json',
    'default',
    ['main', 'dictation', 'pet-overlay', 'pet-mini-panel', 'preview-surface'],
    '436AF8A746E4157E0BFC84FDB1E7144A3BC6022D98F99DE9BBA1D437B7D19C83',
  ],
  [
    'pet-mini-panel.json',
    'pet-mini-panel',
    ['pet-mini-panel'],
    'EE7E8C9FD6847D0182BD1A7D573BF6D23C243E7F641D73D7C8EDFB2230B65057',
  ],
  [
    'pet-overlay.json',
    'pet-overlay',
    ['pet-overlay'],
    'E46798752A90E976F01000D48AE6570FC4B2CF9CC5FB6BF5E3C6E3580662D0AC',
  ],
  [
    'taskbar-usage.json',
    'taskbar-usage',
    ['taskbar-usage'],
    'BFDCDEECC5777125C1288149CF89390BF90D056496F6A5E87F35B278A94AA6B3',
  ],
  [
    'workbench.json',
    'workbench-window',
    ['workbench-*'],
    '8719416D697B0ADC8D3C1540CF22655F1C0EEBCCDE400F6DC4408CA86AAA2559',
  ],
] as const;

const EXPECTED_SURFACES = [
  ['cold-start-intro', 'declared', 'app/src-tauri/tauri.conf.json', ['cold-start-intro']],
  ['dictation', 'declared', 'app/src-tauri/tauri.conf.json', ['default']],
  ['main', 'declared', 'app/src-tauri/tauri.conf.json', ['default']],
  ['pet-mini-panel', 'dynamic-rust', 'app/src-tauri/src/pets.rs', ['default', 'pet-mini-panel']],
  ['pet-overlay', 'dynamic-rust', 'app/src-tauri/src/pets.rs', ['default', 'pet-overlay']],
  ['preview-surface', 'dynamic-rust', 'app/src-tauri/src/preview.rs', ['default']],
  [
    'taskbar-usage',
    'dynamic-webview',
    'app/src/features/taskbar-usage/taskbarUsageNativeWindow.ts',
    ['taskbar-usage'],
  ],
  [
    'workbench-main',
    'dynamic-webview',
    'app/src/features/workbench/window.ts',
    ['workbench-window'],
  ],
] as const;

const TEST_ONLY_CAPABILITY_FILES = ['monochrome-test.json'];
const PRODUCTION_CAPABILITY_IDENTIFIERS = [
  'cold-start-intro',
  'default',
  'pet-mini-panel',
  'pet-overlay',
  'taskbar-usage',
  'workbench-window',
];
const TEST_ONLY_CAPABILITY_IDENTIFIER = 'monochrome-test';
const MONOCHROME_TEST_ALLOWED_PERMISSIONS = [
  'core:default',
  'core:event:default',
  'core:window:default',
  'core:webview:default',
  'core:app:default',
  'core:path:default',
  'os:default',
  'dialog:allow-open',
];
const MONOCHROME_TEST_FORBIDDEN_PERMISSION_TOKENS = [
  'notification',
  'process',
  'updater',
  'shell',
  'http',
  'global-shortcut',
  'deep-link',
  'autostart',
  'create-webview-window',
];
function sourceAtCommit(relativePath: string): string {
  return execFileSync('git', ['show', `${SOURCE_COMMIT}:${relativePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function capabilityFilesAtCommit(): string[] {
  return execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', SOURCE_COMMIT, 'app/src-tauri/capabilities'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .filter((sourcePath) => sourcePath.endsWith('.json'))
    .map((sourcePath) => path.basename(sourcePath))
    .filter((file) => !TEST_ONLY_CAPABILITY_FILES.includes(file))
    .sort();
}

interface CapabilitySnapshot {
  readonly file: string;
  readonly identifier: string;
  readonly windows: readonly string[];
  readonly sha256: string;
}

interface NativeSurfaceSnapshot {
  readonly label: string;
  readonly creation: 'declared' | 'dynamic-rust' | 'dynamic-webview';
  readonly sourcePath: string;
  readonly capabilityIds: readonly string[];
}

function canonicalHash(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n/gu, '\n')).digest('hex').toUpperCase();
}

function capabilitySnapshotsAtCommit(): CapabilitySnapshot[] {
  return capabilityFilesAtCommit().map((file) => {
    const raw = sourceAtCommit(`app/src-tauri/capabilities/${file}`);
    const parsed = JSON.parse(raw) as { identifier: string; windows: string[] };
    return {
      file,
      identifier: parsed.identifier,
      windows: parsed.windows,
      sha256: canonicalHash(raw),
    };
  });
}

const CAPABILITIES_DIRECTORY = path.join(REPO_ROOT, 'app/src-tauri/capabilities');

function snapshotCapability(directory: string, file: string): CapabilitySnapshot {
  const raw = readFileSync(path.join(directory, file), 'utf8');
  const parsed = JSON.parse(raw) as { identifier: string; windows: string[] };
  return {
    file,
    identifier: parsed.identifier,
    windows: parsed.windows,
    sha256: canonicalHash(raw),
  };
}

function listCapabilityFiles(): string[] {
  return readdirSync(CAPABILITIES_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

// Production capability auto-discovery must never include the explicitly
// classified test-only capability. Tauri otherwise auto-discovers every file
// under capabilities/, so the production closure excludes the test-only files
// here and the base config pins an explicit production allowlist.
function currentCapabilitySnapshots(): CapabilitySnapshot[] {
  return listCapabilityFiles()
    .filter((file) => !TEST_ONLY_CAPABILITY_FILES.includes(file))
    .map((file) => snapshotCapability(CAPABILITIES_DIRECTORY, file));
}

function currentTestOnlyCapabilitySnapshots(): CapabilitySnapshot[] {
  return listCapabilityFiles()
    .filter((file) => TEST_ONLY_CAPABILITY_FILES.includes(file))
    .map((file) => snapshotCapability(CAPABILITIES_DIRECTORY, file));
}

function readCapabilityPermissions(file: string): string[] {
  const raw = readFileSync(path.join(CAPABILITIES_DIRECTORY, file), 'utf8');
  const parsed = JSON.parse(raw) as { permissions?: unknown[] };
  return (parsed.permissions ?? []).map((permission) =>
    typeof permission === 'string'
      ? permission
      : ((permission as { identifier?: string }).identifier ?? ''),
  );
}

function capabilityIdsForLabel(
  label: string,
  capabilities: readonly CapabilitySnapshot[],
): string[] {
  return capabilities
    .filter((entry) =>
      entry.windows.some((pattern) => {
        const expression = new RegExp(
          `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll('\\*', '.*')}$`,
          'u',
        );
        return expression.test(label);
      }),
    )
    .map((entry) => entry.identifier)
    .sort();
}

function discoverNativeSurfaces(
  readSource: (relativePath: string) => string,
  capabilities: readonly CapabilitySnapshot[],
): NativeSurfaceSnapshot[] {
  const declared = JSON.parse(readSource('app/src-tauri/tauri.conf.json')) as {
    app: { windows: Array<{ label: string }> };
  };
  const surfaces: NativeSurfaceSnapshot[] = declared.app.windows.map(({ label }) => ({
    label,
    creation: 'declared',
    sourcePath: 'app/src-tauri/tauri.conf.json',
    capabilityIds: capabilityIdsForLabel(label, capabilities),
  }));
  const dynamicRules = [
    {
      creation: 'dynamic-rust' as const,
      sourcePath: 'app/src-tauri/src/pets.rs',
      predicate: /pub const PET_[A-Z_]+_LABEL: &str = "([^"]+)"/gu,
    },
    {
      creation: 'dynamic-rust' as const,
      sourcePath: 'app/src-tauri/src/preview.rs',
      predicate: /const PREVIEW_LABEL: &str = "([^"]+)"/gu,
    },
    {
      creation: 'dynamic-webview' as const,
      sourcePath: 'app/src/features/workbench/window.ts',
      predicate: /WORKBENCH_WINDOW_LABEL = '([^']+)'/gu,
    },
    {
      creation: 'dynamic-webview' as const,
      sourcePath: 'app/src/features/taskbar-usage/taskbarUsageNativeWindow.ts',
      predicate: /TASKBAR_USAGE_WINDOW_LABEL = '([^']+)'/gu,
    },
  ];
  for (const rule of dynamicRules) {
    const source = readSource(rule.sourcePath);
    for (const match of source.matchAll(rule.predicate)) {
      const label = match[1];
      surfaces.push({
        label,
        creation: rule.creation,
        sourcePath: rule.sourcePath,
        capabilityIds: capabilityIdsForLabel(label, capabilities),
      });
    }
  }
  return surfaces.sort((left, right) => left.label.localeCompare(right.label));
}

function currentSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('the source-derived native-window authority exists before MC9 runs', () => {
  const manifestPath = fileURLToPath(new URL('./native-window-manifest.ts', import.meta.url));
  assert.equal(existsSync(manifestPath), true, 'missing native-window manifest');
});

test('native authority freezes every production capability file and content hash', () => {
  const manifest = nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST as Record<string, unknown>;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceCommit, SOURCE_COMMIT);
  assert.equal(manifest.captureMode, 'retroactive-source-freeze');
  assert.equal(manifest.hashMode, 'sha256-canonical-lf-bytes');
  assert.deepEqual(
    (
      manifest.capabilities as Array<{
        file: string;
        identifier: string;
        windows: string[];
        sha256: string;
      }>
    ).map(({ file, identifier, windows, sha256 }) => [file, identifier, windows, sha256]),
    EXPECTED_CAPABILITIES,
  );
  assert.deepEqual(manifest.consumerTasks, ['MC9']);
  assert.equal(
    manifest.validatorCommand,
    'node --test tests/visual/monochrome/native-window-manifest.test.ts',
  );
});

test('capability inventory is closed over JSON files and parsed identifiers at the frozen commit', () => {
  assert.equal(
    Array.isArray(nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities),
    true,
    'missing capability entries',
  );
  if (!Array.isArray(nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities)) return;

  assert.deepEqual(
    nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities.map((entry) => entry.file),
    capabilityFilesAtCommit(),
  );
  for (const entry of nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities) {
    const raw = currentSource(`app/src-tauri/capabilities/${entry.file}`);
    const parsed = JSON.parse(raw) as { identifier: string; windows: string[] };
    assert.equal(entry.identifier, parsed.identifier);
    assert.deepEqual(entry.windows, parsed.windows);
    assert.equal(canonicalHash(raw), entry.sha256);
  }
});

test('native surface inventory freezes declared and dynamic creation seams', () => {
  assert.equal(
    Array.isArray(nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces),
    true,
    'missing native surface entries',
  );
  if (!Array.isArray(nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces)) return;

  assert.deepEqual(
    nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces.map(
      ({ label, creation, sourcePath, capabilityIds }) => [
        label,
        creation,
        sourcePath,
        capabilityIds,
      ],
    ),
    EXPECTED_SURFACES,
  );
  for (const surface of nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces) {
    const source = currentSource(surface.sourcePath);
    assert.ok(source.includes(surface.label), `surface label missing: ${surface.label}`);
  }
});

test('native validator rejects duplicate identifiers, drift, unrepresented files, and test windows', () => {
  const validate = nativeAuthority.validateMonochromeNativeWindowManifest;
  assert.equal(typeof validate, 'function', 'missing native-window manifest validator');
  if (typeof validate !== 'function') return;

  const manifest = nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST;
  assert.equal(Array.isArray(manifest.capabilities), true, 'missing capability entries');
  assert.equal(Array.isArray(manifest.surfaces), true, 'missing surface entries');
  if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.surfaces)) return;

  const historicalCapabilities = capabilitySnapshotsAtCommit();
  const currentCapabilities = currentCapabilitySnapshots();
  const historicalSurfaces = discoverNativeSurfaces(sourceAtCommit, historicalCapabilities);
  const currentSurfaces = discoverNativeSurfaces(currentSource, currentCapabilities);
  assert.deepEqual(
    validate(
      manifest,
      historicalCapabilities,
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ),
    [],
  );
  assert.match(
    validate(
      { ...manifest, capabilities: [...manifest.capabilities, manifest.capabilities[0]] },
      historicalCapabilities,
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /duplicate|stable order/iu,
  );
  assert.match(
    validate(
      manifest,
      historicalCapabilities,
      [
        ...currentCapabilities.slice(0, 1),
        { ...currentCapabilities[1], identifier: 'current-drift' },
        ...currentCapabilities.slice(2),
      ],
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /current.*drift|identifier/iu,
  );
  assert.match(
    validate(
      manifest,
      historicalCapabilities,
      [
        ...currentCapabilities.slice(0, 1),
        { ...currentCapabilities[1], windows: ['current-window-pattern-drift'] },
        ...currentCapabilities.slice(2),
      ],
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /current.*drift|windows/iu,
  );
  assert.match(
    validate(
      manifest,
      historicalCapabilities,
      [
        ...currentCapabilities.slice(0, 1),
        { ...currentCapabilities[1], sha256: '0'.repeat(64) },
        ...currentCapabilities.slice(2),
      ],
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /current.*drift|sha256/iu,
  );
  assert.match(
    validate(
      { ...manifest, sourceCommit: '0'.repeat(40) },
      historicalCapabilities,
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /source commit|provenance/iu,
  );
  assert.match(
    validate(
      manifest,
      [...historicalCapabilities, { ...historicalCapabilities[0], file: 'unrepresented.json' }],
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /historical.*closure|unrepresented/iu,
  );
  assert.match(
    validate(manifest, historicalCapabilities, currentCapabilities, historicalSurfaces, [
      { ...currentSurfaces[0], label: 'current-window-drift' },
      ...currentSurfaces.slice(1),
    ]).join('\n'),
    /current.*surface|creation seam/iu,
  );
  assert.match(
    validate(
      {
        ...manifest,
        surfaces: [
          ...manifest.surfaces,
          {
            label: 'monochrome-test',
            creation: 'dynamic-webview',
            sourcePath: 'tests/visual/monochrome/native-window-manifest.test.ts',
            capabilityIds: [],
          },
        ],
      },
      historicalCapabilities,
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /test window/iu,
  );
});

test('production capability auto-discovery excludes the test-only file and stays closed', () => {
  assert.ok(
    listCapabilityFiles().includes('monochrome-test.json'),
    'expected committed monochrome-test.json capability on disk',
  );
  const productionFiles = currentCapabilitySnapshots().map((entry) => entry.file);
  assert.deepEqual(productionFiles, [
    'cold-start-intro.json',
    'default.json',
    'pet-mini-panel.json',
    'pet-overlay.json',
    'taskbar-usage.json',
    'workbench.json',
  ]);
  assert.equal(productionFiles.includes('monochrome-test.json'), false);
  const productionIdentifiers = currentCapabilitySnapshots()
    .map((entry) => entry.identifier)
    .sort();
  assert.deepEqual(productionIdentifiers, [...PRODUCTION_CAPABILITY_IDENTIFIERS].sort());
});

test('base tauri.conf.json pins an explicit production capability allowlist equal to the frozen set', () => {
  const config = JSON.parse(currentSource('app/src-tauri/tauri.conf.json')) as {
    app?: { security?: { capabilities?: string[] } };
  };
  const allowlist = config.app?.security?.capabilities;
  assert.ok(Array.isArray(allowlist), 'missing app.security.capabilities allowlist');
  if (!Array.isArray(allowlist)) return;
  assert.deepEqual([...allowlist].sort(), [...PRODUCTION_CAPABILITY_IDENTIFIERS].sort());
  assert.equal(allowlist.includes(TEST_ONLY_CAPABILITY_IDENTIFIER), false);
});

test('exactly one explicitly classified test-only capability is permitted and mutually exclusive', () => {
  const testOnly = currentTestOnlyCapabilitySnapshots();
  assert.equal(testOnly.length, 1, 'expected exactly one test-only capability');
  assert.deepEqual(
    testOnly.map((entry) => entry.file),
    TEST_ONLY_CAPABILITY_FILES,
  );
  const entry = testOnly[0];
  assert.equal(entry.file, 'monochrome-test.json');
  assert.equal(entry.identifier, TEST_ONLY_CAPABILITY_IDENTIFIER);
  assert.deepEqual(entry.windows, ['monochrome-test']);
  const productionIdentifiers = new Set(
    currentCapabilitySnapshots().map((capability) => capability.identifier),
  );
  assert.equal(productionIdentifiers.has(entry.identifier), false);
  const intersection = [...productionIdentifiers].filter((identifier) =>
    [entry.identifier].includes(identifier),
  );
  assert.deepEqual(intersection, []);
});

test('test-only capability is least-privilege and excludes unscoped webview creation', () => {
  const permissions = readCapabilityPermissions('monochrome-test.json').sort();
  assert.deepEqual(permissions, [...MONOCHROME_TEST_ALLOWED_PERMISSIONS].sort());
  for (const token of MONOCHROME_TEST_FORBIDDEN_PERMISSION_TOKENS) {
    assert.equal(
      permissions.some((permission) => permission.includes(token)),
      false,
      `forbidden permission present: ${token}`,
    );
  }
});

test('production closure fails when a production capability is removed or the test capability appended', () => {
  const validate = nativeAuthority.validateMonochromeNativeWindowManifest;
  const manifest = nativeAuthority.MONOCHROME_NATIVE_WINDOW_MANIFEST;
  const historicalCapabilities = capabilitySnapshotsAtCommit();
  const currentCapabilities = currentCapabilitySnapshots();
  const historicalSurfaces = discoverNativeSurfaces(sourceAtCommit, historicalCapabilities);
  const currentSurfaces = discoverNativeSurfaces(currentSource, currentCapabilities);

  assert.match(
    validate(
      { ...manifest, capabilities: manifest.capabilities.slice(1) },
      historicalCapabilities,
      currentCapabilities,
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /closure|drift/iu,
  );

  const testOnlyEntry = {
    file: 'monochrome-test.json',
    identifier: 'monochrome-test',
    windows: ['monochrome-test'],
    sha256: '0'.repeat(64),
  };
  assert.match(
    validate(
      { ...manifest, capabilities: [...manifest.capabilities, testOnlyEntry] },
      historicalCapabilities,
      [...currentCapabilities, testOnlyEntry],
      historicalSurfaces,
      currentSurfaces,
    ).join('\n'),
    /test window|monochrome test|closure|drift/iu,
  );
});

test('broadening the test-only capability permissions fails the least-privilege contract', () => {
  const permissions = readCapabilityPermissions('monochrome-test.json');
  const stillMinimal = permissions.every((permission) =>
    MONOCHROME_TEST_ALLOWED_PERMISSIONS.includes(permission),
  );
  assert.equal(stillMinimal, true, 'committed test capability must stay within the allowed set');
  const broadened = [...permissions, 'shell:allow-open'];
  const trips = broadened.some((permission) =>
    MONOCHROME_TEST_FORBIDDEN_PERMISSION_TOKENS.some((token) => permission.includes(token)),
  );
  assert.equal(trips, true, 'broadened permission set must trip the forbidden-token guard');
});
