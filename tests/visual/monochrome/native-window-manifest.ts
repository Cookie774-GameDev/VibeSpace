export const MONOCHROME_NATIVE_SOURCE_COMMIT = '7a1f535522b4c666cf9e697f872d56127fd0f87d';

export type MonochromeNativeSurfaceCreation = 'declared' | 'dynamic-rust' | 'dynamic-webview';

export interface MonochromeCapabilityEntry {
  readonly file: string;
  readonly identifier: string;
  readonly windows: readonly string[];
  readonly sha256: string;
}

export interface MonochromeNativeSurface {
  readonly label: string;
  readonly creation: MonochromeNativeSurfaceCreation;
  readonly sourcePath: string;
  readonly capabilityIds: readonly string[];
}

export interface MonochromeNativeWindowManifest {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly captureMode: 'retroactive-source-freeze';
  readonly hashMode: 'sha256-canonical-lf-bytes';
  readonly ownedPaths: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly fixtureHashes: Readonly<Record<string, string>>;
  readonly consumerTasks: readonly string[];
  readonly validatorCommand: string;
  readonly capabilities: readonly MonochromeCapabilityEntry[];
  readonly surfaces: readonly MonochromeNativeSurface[];
}

const capability = (
  file: string,
  identifier: string,
  windows: readonly string[],
  sha256: string,
): MonochromeCapabilityEntry =>
  Object.freeze({
    file,
    identifier,
    windows: Object.freeze(windows),
    sha256,
  });

const surface = (
  label: string,
  creation: MonochromeNativeSurfaceCreation,
  sourcePath: string,
  capabilityIds: readonly string[],
): MonochromeNativeSurface =>
  Object.freeze({
    label,
    creation,
    sourcePath,
    capabilityIds: Object.freeze(capabilityIds),
  });

export const MONOCHROME_NATIVE_WINDOW_MANIFEST: MonochromeNativeWindowManifest = Object.freeze({
  schemaVersion: 1,
  sourceCommit: MONOCHROME_NATIVE_SOURCE_COMMIT,
  captureMode: 'retroactive-source-freeze',
  hashMode: 'sha256-canonical-lf-bytes',
  ownedPaths: Object.freeze([
    'tests/visual/monochrome/native-window-manifest.test.ts',
    'tests/visual/monochrome/native-window-manifest.ts',
  ]),
  fixtureIds: Object.freeze(['chat', 'settings-appearance', 'terminal-workbench']),
  fixtureHashes: Object.freeze({
    chat: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
    'settings-appearance': '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
    'terminal-workbench': 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
  }),
  consumerTasks: Object.freeze(['MC9']),
  validatorCommand: 'node --test tests/visual/monochrome/native-window-manifest.test.ts',
  capabilities: Object.freeze([
    capability(
      'cold-start-intro.json',
      'cold-start-intro',
      ['cold-start-intro'],
      'F001AC42A3A01888CC83B86AEC9817E994AE25F5B5A5F30A1B5DB92A0A9E3648',
    ),
    capability(
      'default.json',
      'default',
      ['main', 'dictation', 'pet-overlay', 'pet-mini-panel', 'preview-surface'],
      '436AF8A746E4157E0BFC84FDB1E7144A3BC6022D98F99DE9BBA1D437B7D19C83',
    ),
    capability(
      'pet-mini-panel.json',
      'pet-mini-panel',
      ['pet-mini-panel'],
      'EE7E8C9FD6847D0182BD1A7D573BF6D23C243E7F641D73D7C8EDFB2230B65057',
    ),
    capability(
      'pet-overlay.json',
      'pet-overlay',
      ['pet-overlay'],
      'E46798752A90E976F01000D48AE6570FC4B2CF9CC5FB6BF5E3C6E3580662D0AC',
    ),
    capability(
      'taskbar-usage.json',
      'taskbar-usage',
      ['taskbar-usage'],
      'BFDCDEECC5777125C1288149CF89390BF90D056496F6A5E87F35B278A94AA6B3',
    ),
    capability(
      'workbench.json',
      'workbench-window',
      ['workbench-*'],
      '8719416D697B0ADC8D3C1540CF22655F1C0EEBCCDE400F6DC4408CA86AAA2559',
    ),
  ]),
  surfaces: Object.freeze([
    surface('cold-start-intro', 'declared', 'app/src-tauri/tauri.conf.json', ['cold-start-intro']),
    surface('dictation', 'declared', 'app/src-tauri/tauri.conf.json', ['default']),
    surface('main', 'declared', 'app/src-tauri/tauri.conf.json', ['default']),
    surface('pet-mini-panel', 'dynamic-rust', 'app/src-tauri/src/pets.rs', [
      'default',
      'pet-mini-panel',
    ]),
    surface('pet-overlay', 'dynamic-rust', 'app/src-tauri/src/pets.rs', ['default', 'pet-overlay']),
    surface('preview-surface', 'dynamic-rust', 'app/src-tauri/src/preview.rs', ['default']),
    surface(
      'taskbar-usage',
      'dynamic-webview',
      'app/src/features/taskbar-usage/taskbarUsageNativeWindow.ts',
      ['taskbar-usage'],
    ),
    surface('workbench-main', 'dynamic-webview', 'app/src/features/workbench/window.ts', [
      'workbench-window',
    ]),
  ]),
});

const OWNED_PATHS = [
  'tests/visual/monochrome/native-window-manifest.test.ts',
  'tests/visual/monochrome/native-window-manifest.ts',
] as const;

function stableUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0)
  );
}

function capabilityTuple(entry: MonochromeCapabilityEntry): readonly unknown[] {
  return [entry.file, entry.identifier, entry.windows, entry.sha256];
}

function surfaceTuple(entry: MonochromeNativeSurface): readonly unknown[] {
  return [entry.label, entry.creation, entry.sourcePath, entry.capabilityIds];
}

export function validateMonochromeNativeWindowManifest(
  manifest: MonochromeNativeWindowManifest,
  historicalCapabilities: readonly MonochromeCapabilityEntry[],
  currentCapabilities: readonly MonochromeCapabilityEntry[],
  historicalSurfaces: readonly MonochromeNativeSurface[],
  currentSurfaces: readonly MonochromeNativeSurface[],
): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push('unsupported schema version');
  if (manifest.sourceCommit !== MONOCHROME_NATIVE_SOURCE_COMMIT) {
    errors.push('source commit provenance drift');
  }
  if (manifest.hashMode !== 'sha256-canonical-lf-bytes') {
    errors.push('capability hash mode drift');
  }

  const files = manifest.capabilities.map((entry) => entry.file);
  const identifiers = manifest.capabilities.map((entry) => entry.identifier);
  if (!stableUnique(files)) errors.push('duplicate capability file or unstable order');
  if (new Set(identifiers).size !== identifiers.length)
    errors.push('duplicate capability identifier');

  const frozenCapabilities = manifest.capabilities.map(capabilityTuple);
  if (
    JSON.stringify(frozenCapabilities) !==
    JSON.stringify(historicalCapabilities.map(capabilityTuple))
  ) {
    errors.push('historical capability closure, identifier, windows, or hash drift');
  }
  if (
    JSON.stringify(frozenCapabilities) !== JSON.stringify(currentCapabilities.map(capabilityTuple))
  ) {
    errors.push('current capability closure, identifier, windows, or hash drift');
  }

  const labels = manifest.surfaces.map((entry) => entry.label);
  if (!stableUnique(labels)) {
    errors.push('duplicate native surface label or unstable order');
  }
  const frozenSurfaces = manifest.surfaces.map(surfaceTuple);
  if (JSON.stringify(frozenSurfaces) !== JSON.stringify(historicalSurfaces.map(surfaceTuple))) {
    errors.push('historical native creation seam drift');
  }
  if (JSON.stringify(frozenSurfaces) !== JSON.stringify(currentSurfaces.map(surfaceTuple))) {
    errors.push('current native surface creation seam drift');
  }
  if (
    labels.some((label) => label.includes('monochrome-test')) ||
    manifest.capabilities.some(
      (entry) =>
        entry.file.includes('monochrome-test') ||
        entry.identifier.includes('monochrome-test') ||
        entry.windows.some((window) => window.includes('monochrome-test')),
    )
  ) {
    errors.push('production manifest contains a monochrome test window');
  }
  const knownCapabilities = new Set(identifiers);
  for (const nativeSurface of manifest.surfaces) {
    for (const identifier of nativeSurface.capabilityIds) {
      if (!knownCapabilities.has(identifier)) {
        errors.push(`native surface references absent capability: ${identifier}`);
      }
    }
  }
  if (JSON.stringify(manifest.ownedPaths) !== JSON.stringify(OWNED_PATHS)) {
    errors.push('owned path overlap or drift');
  }
  return errors;
}
