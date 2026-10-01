import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as primitiveAuthority from '../../app/src/features/appearance/monochromePrimitiveManifest.ts';
import * as fixtureAuthority from '../../tests/visual/monochrome/fixture-manifest.ts';
import {
  MONOCHROME_BASELINE_MANIFEST,
  MONOCHROME_MC9_BASELINE_MANIFEST,
} from '../../tests/visual/monochrome/baseline-manifest.ts';
import {
  MONOCHROME_NATIVE_SOURCE_COMMIT,
  MONOCHROME_NATIVE_WINDOW_MANIFEST,
  validateMonochromeNativeWindowManifest,
} from '../../tests/visual/monochrome/native-window-manifest.ts';
import * as routeAuthority from '../../tests/visual/monochrome/route-manifest.ts';
import * as shellAuthority from '../../tests/visual/monochrome/shell-overlay-manifest.ts';

const SOURCE_COMMIT = '7eb708e184ee4f054a49d3e70d73e80fd4eb97ae';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FRAME_MANIFEST_PATH = path.join(REPO_ROOT, 'docs/appearance/monochrome/FRAME_MANIFEST.json');
const FRAME_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'docs/appearance/monochrome/schemas/frame-manifest.schema.json',
);
const FRAME_SCHEMA_SHA256 = 'AB4C3BA00B2E8ABBD6A4B1223705DA94F6039A8BEB06BC1230EEEF12AE17B546';

function canonicalTextSha256(source) {
  return createHash('sha256')
    .update(source.toString('utf8').replace(/\r\n?/gu, '\n'))
    .digest('hex')
    .toUpperCase();
}

function validateFrameAuthority(manifest, schema) {
  const errors = [];
  const frameIds = manifest.frames.map(({ id }) => id);
  const frameNumbers = manifest.frames.map(({ frameNumber }) => frameNumber);
  const timestamps = manifest.frames.map(({ timestampMs }) => timestampMs);
  const measuredBranch = schema.oneOf?.find(
    (branch) => branch.properties?.status?.const === 'measured',
  );

  if (manifest.status !== 'measured') errors.push('frame manifest status drift');
  if (manifest.sourceSha256 !== manifest.source?.sha256) {
    errors.push('frame manifest source hash drift');
  }
  if (!/^[A-F0-9]{64}$/u.test(manifest.sourceSha256)) {
    errors.push('frame manifest source hash format drift');
  }
  if (
    manifest.expectedFileName !== path.posix.basename(manifest.expectedFileName) ||
    manifest.expectedFileName.includes('..')
  ) {
    errors.push('unsafe frame source filename');
  }
  if (manifest.frames.length !== 22) errors.push('selected frame closure drift');
  if (manifest.sampling?.sampleCount !== 395) errors.push('sample count drift');
  if (new Set(frameIds).size !== frameIds.length) errors.push('duplicate frame id');
  if (new Set(frameNumbers).size !== frameNumbers.length) errors.push('duplicate frame number');
  if (!frameIds.every((value, index) => index === 0 || frameIds[index - 1] < value)) {
    errors.push('frame id order drift');
  }
  if (!frameNumbers.every((value, index) => index === 0 || frameNumbers[index - 1] < value)) {
    errors.push('frame number order drift');
  }
  if (!timestamps.every((value, index) => index === 0 || timestamps[index - 1] < value)) {
    errors.push('frame timestamp order drift');
  }
  if (
    manifest.frames.some(
      ({ frameNumber, timestampMs }) =>
        frameNumber >= manifest.sampling.sampleCount || timestampMs >= manifest.source.durationMs,
    )
  ) {
    errors.push('frame bounds drift');
  }
  if (
    schema.properties?.schemaVersion?.const !== 1 ||
    schema.properties?.artifactId?.const !== 'frame-manifest' ||
    measuredBranch?.properties?.frames?.minItems !== 1
  ) {
    errors.push('frame schema drift');
  }
  return errors;
}

test('measured frame authority is source-locked, unique, ordered, bounded, and schema-bound', () => {
  const manifest = JSON.parse(readFileSync(FRAME_MANIFEST_PATH, 'utf8'));
  const schemaSource = readFileSync(FRAME_SCHEMA_PATH);
  const schema = JSON.parse(schemaSource.toString('utf8'));
  assert.deepEqual(validateFrameAuthority(manifest, schema), []);
  assert.equal(canonicalTextSha256(schemaSource), FRAME_SCHEMA_SHA256);
  assert.equal(
    canonicalTextSha256(
      Buffer.from(schemaSource.toString('utf8').replace(/\r\n?/gu, '\n').replace(/\n/gu, '\r\n')),
    ),
    FRAME_SCHEMA_SHA256,
  );
  assert.equal(MONOCHROME_BASELINE_MANIFEST.captures.length, 10);
  assert.equal(MONOCHROME_MC9_BASELINE_MANIFEST.entries.length, 111);
});

test('frame authority rejects duplicate, missing, orphan, unsafe, stale-hash, and schema drift', () => {
  const manifest = JSON.parse(readFileSync(FRAME_MANIFEST_PATH, 'utf8'));
  const schema = JSON.parse(readFileSync(FRAME_SCHEMA_PATH, 'utf8'));
  const mutations = [
    { ...manifest, frames: manifest.frames.slice(1) },
    {
      ...manifest,
      frames: [...manifest.frames, { ...manifest.frames.at(-1), id: 'frame.orphan' }],
    },
    { ...manifest, frames: [...manifest.frames, manifest.frames[0]] },
    { ...manifest, expectedFileName: '../private.mp4' },
    { ...manifest, sourceSha256: '0'.repeat(64) },
  ];
  for (const mutation of mutations) {
    assert.notDeepEqual(validateFrameAuthority(mutation, schema), []);
  }
  const schemaDrift = structuredClone(schema);
  schemaDrift.properties.schemaVersion.const = 2;
  assert.match(validateFrameAuthority(manifest, schemaDrift).join('\n'), /schema drift/iu);
});

test('Tauri macOS private API feature and application config stay aligned', () => {
  const cargo = readFileSync(path.join(REPO_ROOT, 'app/src-tauri/Cargo.toml'), 'utf8');
  const config = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'app/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const featureEnabled =
    /tauri\s*=\s*\{[^}\r\n]*features\s*=\s*\[[^\]]*["']macos-private-api["']/u.test(cargo);

  assert.equal(featureEnabled, true, 'the frozen Cargo feature must remain explicit');
  assert.equal(
    config.app?.macOSPrivateApi,
    true,
    'Tauri build contract requires app.macOSPrivateApi=true when the Cargo feature is enabled',
  );
});

const requiredAuthorities = [
  '../../tests/visual/monochrome/fixture-manifest.ts',
  '../../tests/visual/monochrome/route-manifest.ts',
  '../../tests/visual/monochrome/shell-overlay-manifest.ts',
  '../../tests/visual/monochrome/native-window-manifest.ts',
  '../../app/src/features/appearance/monochromePrimitiveManifest.ts',
];
const COMMON_FIXTURE_IDS = ['chat', 'settings-appearance', 'terminal-workbench'];
const COMMON_FIXTURE_HASHES = {
  chat: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
  'settings-appearance': '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
  'terminal-workbench': 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
};
const TEST_ONLY_CAPABILITY_FILES = ['monochrome-test.json'];
const COMMON_MANIFEST_AUTHORITIES = [
  {
    name: 'fixture',
    manifest: fixtureAuthority.MONOCHROME_FIXTURE_MANIFEST,
    expectedSourceCommit: SOURCE_COMMIT,
    ownedPaths: [
      'tests/visual/monochrome/fixture-manifest.test.ts',
      'tests/visual/monochrome/fixture-manifest.ts',
      'tests/visual/monochrome/fixtures.ts',
    ],
    consumerTasks: ['MC4', 'MC5', 'MC6'],
    validatorCommand: 'node --test tests/visual/monochrome/fixture-manifest.test.ts',
  },
  {
    name: 'native-window',
    manifest: MONOCHROME_NATIVE_WINDOW_MANIFEST,
    expectedSourceCommit: MONOCHROME_NATIVE_SOURCE_COMMIT,
    ownedPaths: [
      'tests/visual/monochrome/native-window-manifest.test.ts',
      'tests/visual/monochrome/native-window-manifest.ts',
    ],
    consumerTasks: ['MC9'],
    validatorCommand: 'node --test tests/visual/monochrome/native-window-manifest.test.ts',
  },
  {
    name: 'primitive',
    manifest: primitiveAuthority.MONOCHROME_PRIMITIVE_MANIFEST,
    expectedSourceCommit: SOURCE_COMMIT,
    ownedPaths: [
      'app/src/features/appearance/monochromePrimitiveManifest.test.ts',
      'app/src/features/appearance/monochromePrimitiveManifest.ts',
    ],
    consumerTasks: ['MC4', 'MC6'],
    validatorCommand:
      'npm --prefix app test -- src/features/appearance/monochromePrimitiveManifest.test.ts',
  },
  {
    name: 'route',
    manifest: routeAuthority.MONOCHROME_ROUTE_MANIFEST,
    expectedSourceCommit: SOURCE_COMMIT,
    ownedPaths: [
      'tests/visual/monochrome/route-manifest.test.ts',
      'tests/visual/monochrome/route-manifest.ts',
    ],
    consumerTasks: ['MC5', 'MC6', 'MC7'],
    validatorCommand: 'node --test tests/visual/monochrome/route-manifest.test.ts',
  },
  {
    name: 'shell-overlay',
    manifest: shellAuthority.MONOCHROME_SHELL_OVERLAY_MANIFEST,
    expectedSourceCommit: SOURCE_COMMIT,
    ownedPaths: [
      'tests/visual/monochrome/shell-overlay-manifest.test.ts',
      'tests/visual/monochrome/shell-overlay-manifest.ts',
    ],
    consumerTasks: ['MC6', 'MC9'],
    validatorCommand: 'node --test tests/visual/monochrome/shell-overlay-manifest.test.ts',
  },
];

const SIDE_EFFECT_DISCOVERY_RULES = Object.freeze([
  {
    sourcePath: 'app/src-tauri/src/lib.rs',
    predicates: [
      [
        'plugin-registration',
        'plugin-registration',
        /tauri_plugin_[a-z_]+::(?:init|Builder::new)/u,
      ],
      ['startup-hook', 'startup', /\.setup\(\|app\|/u],
      ['terminal-cli-start', 'startup', /terminal_cli::start_terminal_cli_server\(/u],
      ['tray-create', 'tray', /TrayIconBuilder::with_id\(/u],
      ['global-shortcut-register', 'global-shortcut', /global_shortcut\(\)\.register\(/u],
      ['app-run-lifecycle', 'process-lifecycle', /\.run\(\|app_handle, event\|/u],
    ],
  },
  {
    sourcePath: 'app/src-tauri/src/credentials.rs',
    predicates: [
      ['keyring-entry', 'credential-store', /Entry::new\(/u],
      ['keyring-set', 'credential-store', /\.set_password\(/u],
      ['keyring-read', 'credential-store', /\.get_password\(/u],
      ['keyring-delete', 'credential-store', /\.delete_credential\(/u],
    ],
  },
  {
    sourcePath: 'app/src-tauri/src/pets.rs',
    predicates: [
      ['registry-read', 'os-registry', /\.open_subkey(?:_with_flags)?\(/u],
      ['registry-create', 'os-registry', /\.create_subkey(?:_with_flags)?\(/u],
      ['registry-set', 'os-registry', /\brun\.set_value\(/u],
      ['registry-delete', 'os-registry', /\brun\.delete_value\(/u],
    ],
  },
  {
    sourcePath: 'app/src-tauri/src/launcher.rs',
    predicates: [
      ['directory-create', 'filesystem', /fs::create_dir_all\(/u],
      ['file-write', 'filesystem', /fs::write\(/u],
      ['file-copy', 'filesystem', /fs::copy\(/u],
      ['registry-open', 'os-registry', /\.open_subkey(?:_with_flags)?\(/u],
      ['registry-create', 'os-registry', /\.create_subkey(?:_with_flags)?\(/u],
      ['registry-path-write', 'os-registry', /\benv\.set_value\("Path"/u],
      ['process-path-write', 'process-environment', /std::env::set_var\("PATH"/u],
      ['file-permissions-write', 'filesystem', /fs::set_permissions\(/u],
    ],
  },
  {
    sourcePath: 'app/src-tauri/src/terminal_cli.rs',
    predicates: [
      ['keyring-entry', 'credential-store', /Entry::new\(/u],
      ['keyring-set', 'credential-store', /\.set_password\(/u],
      ['keyring-read', 'credential-store', /\.get_password\(/u],
      ['file-remove', 'filesystem', /fs::remove_file\(/u],
      ['directory-create', 'filesystem', /fs::create_dir_all\(/u],
      ['file-create', 'filesystem', /OpenOptions::new\(\)/u],
      ['file-write', 'filesystem', /\bfile\.write_all\(/u],
      ['file-flush', 'filesystem', /\bfile\.sync_all\(\)/u],
      ['file-permissions-write', 'filesystem', /fs::set_permissions\(/u],
      ['file-rename', 'filesystem', /fs::rename\(/u],
      ['file-replace-windows', 'filesystem', /\bMoveFileExW\(/u],
    ],
  },
  {
    sourcePath: 'app/src/App.tsx',
    predicates: [
      [
        'frontend-terminal-launcher-install',
        'frontend-ipc',
        /invoke\('install_terminal_launcher'\)/u,
      ],
    ],
  },
  {
    sourcePath: 'app/src/lib/updates.ts',
    predicates: [
      ['update-check', 'updater', /\bconst update = await check\(\)/u],
      ['update-download-install', 'updater', /\bupdate\.downloadAndInstall\(/u],
      ['workspace-flush', 'persistence', /\bflushWorkspacePersistence\('pre-update-/u],
      ['process-relaunch', 'process-lifecycle', /\bawait relaunch\(\)/u],
    ],
  },
]);
const sourceCommitCache = new Map();

function sideEffect(
  id,
  sourcePath,
  sourceLine,
  operation,
  category,
  token,
  currentSeam,
  expectation = 'present',
) {
  return Object.freeze({
    id,
    sourcePath,
    sourceLine,
    operation,
    category,
    token,
    currentSeam,
    expectation,
    guardDisposition: 'inventory-only-no-guard-required',
  });
}

export const MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY = Object.freeze([
  sideEffect(
    'app-1009-frontend-terminal-launcher-install',
    'app/src/App.tsx',
    1009,
    'frontend-terminal-launcher-install',
    'frontend-ipc',
    ".then(({ invoke }) => invoke('install_terminal_launcher'))",
    'Direct frontend terminal launcher install boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'credentials-22-keyring-entry',
    'app/src-tauri/src/credentials.rs',
    22,
    'keyring-entry',
    'credential-store',
    'Entry::new(SERVICE, &account).map_err(|err| format!("credential store unavailable: {err}"))',
    'Direct keyring entry boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'credentials-33-keyring-set',
    'app/src-tauri/src/credentials.rs',
    33,
    'keyring-set',
    'credential-store',
    '.set_password(trimmed)',
    'Direct keyring set boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'credentials-40-keyring-read',
    'app/src-tauri/src/credentials.rs',
    40,
    'keyring-read',
    'credential-store',
    'match entry.get_password() {',
    'Direct keyring read boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'credentials-51-keyring-delete',
    'app/src-tauri/src/credentials.rs',
    51,
    'keyring-delete',
    'credential-store',
    'match entry.delete_credential() {',
    'Direct keyring delete boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'deep-link-registration-absent',
    'app/src-tauri/src/lib.rs',
    null,
    'plugin-registration',
    'declared-absence',
    'tauri_plugin_deep_link::init',
    'Documentation names deep links, but the source commit has no plugin registration',
    'absent',
  ),
  sideEffect(
    'launcher-14-directory-create',
    'app/src-tauri/src/launcher.rs',
    14,
    'directory-create',
    'filesystem',
    'fs::create_dir_all(&bin_dir).map_err(io_err)?;',
    'Direct directory create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-39-directory-create',
    'app/src-tauri/src/launcher.rs',
    39,
    'directory-create',
    'filesystem',
    'fs::create_dir_all(&bin_dir).map_err(io_err)?;',
    'Direct directory create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-409-file-write',
    'app/src-tauri/src/launcher.rs',
    409,
    'file-write',
    'filesystem',
    'fs::write(path, content).map_err(io_err)',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-426-file-copy',
    'app/src-tauri/src/launcher.rs',
    426,
    'file-copy',
    'filesystem',
    'fs::copy(path, backup).map_err(io_err)?;',
    'Direct file copy boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-43-file-write',
    'app/src-tauri/src/launcher.rs',
    43,
    'file-write',
    'filesystem',
    'fs::write(&primary, script).map_err(io_err)?;',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-437-registry-open',
    'app/src-tauri/src/launcher.rs',
    437,
    'registry-open',
    'os-registry',
    '.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)',
    'Direct registry environment handle open boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-447-registry-path-write',
    'app/src-tauri/src/launcher.rs',
    447,
    'registry-path-write',
    'os-registry',
    'env.set_value("Path", &updated)',
    'Direct registry path write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-458-process-path-write',
    'app/src-tauri/src/launcher.rs',
    458,
    'process-path-write',
    'process-environment',
    'std::env::set_var("PATH", joined);',
    'Direct process path write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-47-file-write',
    'app/src-tauri/src/launcher.rs',
    47,
    'file-write',
    'filesystem',
    'fs::write(&lower, unix_launcher_script()).map_err(io_err)?;',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-554-file-write',
    'app/src-tauri/src/launcher.rs',
    554,
    'file-write',
    'filesystem',
    'fs::write(&path, next).map_err(io_err)?;',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-565-process-path-write',
    'app/src-tauri/src/launcher.rs',
    565,
    'process-path-write',
    'process-environment',
    'std::env::set_var("PATH", joined);',
    'Direct process path write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'launcher-576-file-permissions-write',
    'app/src-tauri/src/launcher.rs',
    576,
    'file-permissions-write',
    'filesystem',
    'fs::set_permissions(path, perms).map_err(io_err)',
    'Direct file permissions write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-203-plugin-registration',
    'app/src-tauri/src/lib.rs',
    203,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-207-plugin-registration',
    'app/src-tauri/src/lib.rs',
    207,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_os::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-208-plugin-registration',
    'app/src-tauri/src/lib.rs',
    208,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_shell::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-209-plugin-registration',
    'app/src-tauri/src/lib.rs',
    209,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_dialog::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-210-plugin-registration',
    'app/src-tauri/src/lib.rs',
    210,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_notification::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-211-plugin-registration',
    'app/src-tauri/src/lib.rs',
    211,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_http::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-212-plugin-registration',
    'app/src-tauri/src/lib.rs',
    212,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_process::init())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-213-plugin-registration',
    'app/src-tauri/src/lib.rs',
    213,
    'plugin-registration',
    'plugin-registration',
    '.plugin(tauri_plugin_updater::Builder::new().build())',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-215-plugin-registration',
    'app/src-tauri/src/lib.rs',
    215,
    'plugin-registration',
    'plugin-registration',
    'tauri_plugin_global_shortcut::Builder::new()',
    'Direct plugin registration boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-232-startup-hook',
    'app/src-tauri/src/lib.rs',
    232,
    'startup-hook',
    'startup',
    '.setup(|app| {',
    'Direct startup hook boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-233-terminal-cli-start',
    'app/src-tauri/src/lib.rs',
    233,
    'terminal-cli-start',
    'startup',
    'if let Err(err) = terminal_cli::start_terminal_cli_server(',
    'Direct terminal cli start boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-267-tray-create',
    'app/src-tauri/src/lib.rs',
    267,
    'tray-create',
    'tray',
    'let _tray = tauri::tray::TrayIconBuilder::with_id(branding::TRAY_ICON_ID)',
    'Direct tray create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-309-global-shortcut-register',
    'app/src-tauri/src/lib.rs',
    309,
    'global-shortcut-register',
    'global-shortcut',
    'if let Err(err) = app.global_shortcut().register(dictation_shortcut) {',
    'Direct global shortcut register boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'lib-472-app-run-lifecycle',
    'app/src-tauri/src/lib.rs',
    472,
    'app-run-lifecycle',
    'process-lifecycle',
    '.run(|app_handle, event| {',
    'Direct app run lifecycle boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'pets-36-registry-read',
    'app/src-tauri/src/pets.rs',
    36,
    'registry-read',
    'os-registry',
    '.open_subkey_with_flags(r"Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ)',
    'Direct registry read boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'pets-60-registry-create',
    'app/src-tauri/src/pets.rs',
    60,
    'registry-create',
    'os-registry',
    '.create_subkey(r"Software\\Microsoft\\Windows\\CurrentVersion\\Run")',
    'Direct registry startup-key create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'pets-65-registry-set',
    'app/src-tauri/src/pets.rs',
    65,
    'registry-set',
    'os-registry',
    'run.set_value(',
    'Direct registry set boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'pets-72-registry-delete',
    'app/src-tauri/src/pets.rs',
    72,
    'registry-delete',
    'os-registry',
    'match run.delete_value(PET_AUTOSTART_VALUE_NAME) {',
    'Direct registry delete boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1093-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1093,
    'file-remove',
    'filesystem',
    'return match fs::remove_file(path) {',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1105-directory-create',
    'app/src-tauri/src/terminal_cli.rs',
    1105,
    'directory-create',
    'filesystem',
    'fs::create_dir_all(parent).map_err(|error| format!("Shell profile directory: {error}"))?;',
    'Direct directory create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1115-file-create',
    'app/src-tauri/src/terminal_cli.rs',
    1115,
    'file-create',
    'filesystem',
    'let mut file = OpenOptions::new()',
    'Direct file create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1120-file-write',
    'app/src-tauri/src/terminal_cli.rs',
    1120,
    'file-write',
    'filesystem',
    'if let Err(error) = file.write_all(content.as_bytes()) {',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1122-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1122,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1125-file-flush',
    'app/src-tauri/src/terminal_cli.rs',
    1125,
    'file-flush',
    'filesystem',
    'if let Err(error) = file.sync_all() {',
    'Direct file flush boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1127-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1127,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1132-file-permissions-write',
    'app/src-tauri/src/terminal_cli.rs',
    1132,
    'file-permissions-write',
    'filesystem',
    'if let Err(error) = fs::set_permissions(&temporary, metadata.permissions()) {',
    'Direct file permissions write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1133-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1133,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1138-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1138,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1165-keyring-entry',
    'app/src-tauri/src/terminal_cli.rs',
    1165,
    'keyring-entry',
    'credential-store',
    'Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)',
    'Direct keyring entry boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1186-directory-create',
    'app/src-tauri/src/terminal_cli.rs',
    1186,
    'directory-create',
    'filesystem',
    'fs::create_dir_all(parent).map_err(|error| format!("endpoint directory: {error}"))?;',
    'Direct directory create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1194-file-create',
    'app/src-tauri/src/terminal_cli.rs',
    1194,
    'file-create',
    'filesystem',
    'let mut file = OpenOptions::new()',
    'Direct file create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1199-file-write',
    'app/src-tauri/src/terminal_cli.rs',
    1199,
    'file-write',
    'filesystem',
    'file.write_all(&bytes)',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1201-file-flush',
    'app/src-tauri/src/terminal_cli.rs',
    1201,
    'file-flush',
    'filesystem',
    'file.sync_all()',
    'Direct file flush boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1206-file-permissions-write',
    'app/src-tauri/src/terminal_cli.rs',
    1206,
    'file-permissions-write',
    'filesystem',
    'fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))',
    'Direct file permissions write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1210-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1210,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1405-keyring-set',
    'app/src-tauri/src/terminal_cli.rs',
    1405,
    'keyring-set',
    'credential-store',
    '.set_password(&nonce)',
    'Direct keyring set boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1524-keyring-read',
    'app/src-tauri/src/terminal_cli.rs',
    1524,
    'keyring-read',
    'credential-store',
    '.get_password()',
    'Direct keyring read boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1845-file-replace-windows',
    'app/src-tauri/src/terminal_cli.rs',
    1845,
    'file-replace-windows',
    'filesystem',
    'MoveFileExW(',
    'Direct file replace windows boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1856-file-rename',
    'app/src-tauri/src/terminal_cli.rs',
    1856,
    'file-rename',
    'filesystem',
    'fs::rename(temporary, destination).map_err(|error| error.to_string())',
    'Direct file rename boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1875-file-create',
    'app/src-tauri/src/terminal_cli.rs',
    1875,
    'file-create',
    'filesystem',
    'let mut file = OpenOptions::new()',
    'Direct file create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1880-file-write',
    'app/src-tauri/src/terminal_cli.rs',
    1880,
    'file-write',
    'filesystem',
    'file.write_all(content.as_bytes())',
    'Direct file write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1882-file-flush',
    'app/src-tauri/src/terminal_cli.rs',
    1882,
    'file-flush',
    'filesystem',
    'file.sync_all()',
    'Direct file flush boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1887-file-permissions-write',
    'app/src-tauri/src/terminal_cli.rs',
    1887,
    'file-permissions-write',
    'filesystem',
    'fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))',
    'Direct file permissions write boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1891-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1891,
    'file-remove',
    'filesystem',
    'let _ = fs::remove_file(&temporary);',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1926-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1926,
    'file-remove',
    'filesystem',
    'None => match fs::remove_file(rollback_path) {',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1972-file-rename',
    'app/src-tauri/src/terminal_cli.rs',
    1972,
    'file-rename',
    'filesystem',
    'if let Err(remove_error) = fs::rename(path, &temporary) {',
    'Direct file rename boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1975-file-rename',
    'app/src-tauri/src/terminal_cli.rs',
    1975,
    'file-rename',
    'filesystem',
    'if let Err(error) = fs::rename(moved_path, original) {',
    'Direct file rename boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-1991-file-remove',
    'app/src-tauri/src/terminal_cli.rs',
    1991,
    'file-remove',
    'filesystem',
    'if let Err(error) = fs::remove_file(&temporary) {',
    'Direct file remove boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'terminal-cli-2043-directory-create',
    'app/src-tauri/src/terminal_cli.rs',
    2043,
    'directory-create',
    'filesystem',
    'fs::create_dir_all(&bin_dir).map_err(|error| format!("CLI bin directory: {error}"))?;',
    'Direct directory create boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'updates-48-update-check',
    'app/src/lib/updates.ts',
    48,
    'update-check',
    'updater',
    'const update = await check();',
    'Direct update check boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'updates-63-workspace-flush',
    'app/src/lib/updates.ts',
    63,
    'workspace-flush',
    'persistence',
    "await flushWorkspacePersistence('pre-update-install');",
    'Direct workspace flush boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'updates-69-update-download-install',
    'app/src/lib/updates.ts',
    69,
    'update-download-install',
    'updater',
    'await update.downloadAndInstall((event) => {',
    'Direct update download install boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'updates-87-workspace-flush',
    'app/src/lib/updates.ts',
    87,
    'workspace-flush',
    'persistence',
    "await flushWorkspacePersistence('pre-update-relaunch');",
    'Direct workspace flush boundary; no MonoChrome guard at MC0B',
  ),
  sideEffect(
    'updates-91-process-relaunch',
    'app/src/lib/updates.ts',
    91,
    'process-relaunch',
    'process-lifecycle',
    'await relaunch();',
    'Direct process relaunch boundary; no MonoChrome guard at MC0B',
  ),
]);

function sourceAtCommit(relativePath) {
  const cached = sourceCommitCache.get(relativePath);
  if (cached !== undefined) return cached;
  const source = execFileSync('git', ['show', `${SOURCE_COMMIT}:${relativePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  sourceCommitCache.set(relativePath, source);
  return source;
}

function discoverPrivilegedSideEffects() {
  const candidates = [];
  for (const rule of SIDE_EFFECT_DISCOVERY_RULES) {
    const lines = sourceAtCommit(rule.sourcePath).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const [operation, category, predicate] of rule.predicates) {
        if (!predicate.test(line)) continue;
        candidates.push({
          sourcePath: rule.sourcePath,
          sourceLine: index + 1,
          operation,
          category,
          token: line.trim(),
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.sourceLine - right.sourceLine ||
      left.operation.localeCompare(right.operation),
  );
}

function discoverRegistryOpenCreateBoundaries() {
  return ['app/src-tauri/src/launcher.rs', 'app/src-tauri/src/pets.rs']
    .flatMap((sourcePath) =>
      sourceAtCommit(sourcePath)
        .split(/\r?\n/u)
        .flatMap((line, index) => {
          const match = line.match(
            /\.(open_subkey(?:_with_flags)?|create_subkey(?:_with_flags)?)\(/u,
          );
          if (!match) return [];
          const operation = match[1].startsWith('create')
            ? 'registry-create'
            : sourcePath.endsWith('/launcher.rs')
              ? 'registry-open'
              : 'registry-read';
          return [
            {
              sourcePath,
              sourceLine: index + 1,
              operation,
              category: 'os-registry',
              token: line.trim(),
            },
          ];
        }),
    )
    .sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) || left.sourceLine - right.sourceLine,
    );
}

function callsiteTuple(entry) {
  return [entry.sourcePath, entry.sourceLine, entry.operation, entry.category, entry.token];
}

test('all Step-7 source-derived authorities exist before later MonoChrome tasks run', () => {
  for (const relativePath of requiredAuthorities) {
    const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));
    assert.equal(existsSync(absolutePath), true, `missing Step-7 authority: ${relativePath}`);
  }
});

test('all Step-7 manifests freeze exact common metadata and disjoint owned paths', () => {
  for (const authority of COMMON_MANIFEST_AUTHORITIES) {
    const { manifest } = authority;
    assert.equal(manifest.schemaVersion, 1, authority.name);
    assert.equal(manifest.sourceCommit, authority.expectedSourceCommit, authority.name);
    assert.equal(manifest.captureMode, 'retroactive-source-freeze', authority.name);
    assert.deepEqual(manifest.ownedPaths, authority.ownedPaths, authority.name);
    assert.deepEqual(manifest.fixtureIds, COMMON_FIXTURE_IDS, authority.name);
    assert.deepEqual(manifest.fixtureHashes, COMMON_FIXTURE_HASHES, authority.name);
    assert.deepEqual(manifest.consumerTasks, authority.consumerTasks, authority.name);
    assert.equal(manifest.validatorCommand, authority.validatorCommand, authority.name);
    for (const ownedPath of manifest.ownedPaths) {
      assert.equal(existsSync(fileURLToPath(new URL(`../../${ownedPath}`, import.meta.url))), true);
    }
  }

  const validateSet = fixtureAuthority.validateMonochromeManifestSet;
  assert.equal(typeof validateSet, 'function', 'missing common manifest set validator');
  if (typeof validateSet !== 'function') return;
  // The original set validator predates the later native-capability authority
  // and accepts one historical source commit. Exact provenance was asserted
  // above; normalize only that field in the validator views so its remaining
  // cross-authority fixture and owned-path invariants still run unchanged.
  const manifests = COMMON_MANIFEST_AUTHORITIES.map(({ name, manifest }) => ({
    name,
    manifest: { ...manifest, sourceCommit: SOURCE_COMMIT },
  }));
  assert.deepEqual(validateSet(manifests), []);
  assert.match(
    validateSet([
      ...manifests.slice(0, 2),
      {
        ...manifests[2],
        manifest: {
          ...manifests[2].manifest,
          ownedPaths: [...manifests[2].manifest.ownedPaths, manifests[0].manifest.ownedPaths[0]],
        },
      },
      ...manifests.slice(3),
    ]).join('\n'),
    /owned path.*overlap|overlap.*owned path/iu,
  );
  assert.match(
    validateSet([
      ...manifests.slice(0, 2),
      {
        ...manifests[2],
        manifest: { ...manifests[2].manifest, fixtureIds: ['chat'] },
      },
      ...manifests.slice(3),
    ]).join('\n'),
    /fixture.*metadata|metadata.*fixture/iu,
  );
});

test('manifest contract inventories every source-commit production capability tuple', () => {
  const capabilityFiles = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', MONOCHROME_NATIVE_SOURCE_COMMIT, 'app/src-tauri/capabilities'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .filter(
      (sourcePath) =>
        sourcePath.endsWith('.json') &&
        !TEST_ONLY_CAPABILITY_FILES.includes(sourcePath.replace('app/src-tauri/capabilities/', '')),
    )
    .sort();
  const discovered = capabilityFiles.map((sourcePath) => {
    const parsed = JSON.parse(
      execFileSync('git', ['show', `${MONOCHROME_NATIVE_SOURCE_COMMIT}:${sourcePath}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    );
    return [
      sourcePath.replace('app/src-tauri/capabilities/', ''),
      parsed.identifier,
      parsed.windows,
    ];
  });
  assert.equal(MONOCHROME_NATIVE_WINDOW_MANIFEST.sourceCommit, MONOCHROME_NATIVE_SOURCE_COMMIT);
  assert.deepEqual(
    MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities.map(({ file, identifier, windows }) => [
      file,
      identifier,
      windows,
    ]),
    discovered,
  );
});

const CAPABILITIES_DIRECTORY = 'app/src-tauri/capabilities';
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

function canonicalCapabilityHash(raw) {
  return createHash('sha256').update(raw.replace(/\r\n/gu, '\n')).digest('hex').toUpperCase();
}

function currentCapabilityEntries() {
  const directory = path.join(REPO_ROOT, CAPABILITIES_DIRECTORY);
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = readFileSync(path.join(directory, file), 'utf8');
      const parsed = JSON.parse(raw);
      return {
        file,
        identifier: parsed.identifier,
        windows: parsed.windows,
        sha256: canonicalCapabilityHash(raw),
        permissions: (parsed.permissions ?? []).map((permission) =>
          typeof permission === 'string' ? permission : (permission?.identifier ?? ''),
        ),
      };
    });
}

function productionCapabilityTuples(entries) {
  return entries.map(({ file, identifier, windows }) => [file, identifier, windows]);
}

test('current production capability closure stays byte/tuple closed while one test-only capability is permitted', () => {
  const entries = currentCapabilityEntries();
  const production = entries.filter((entry) => !TEST_ONLY_CAPABILITY_FILES.includes(entry.file));
  const testOnly = entries.filter((entry) => TEST_ONLY_CAPABILITY_FILES.includes(entry.file));

  assert.deepEqual(
    productionCapabilityTuples(production),
    MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities.map(({ file, identifier, windows }) => [
      file,
      identifier,
      windows,
    ]),
  );
  assert.deepEqual(
    production.map((entry) => entry.identifier).sort(),
    [...PRODUCTION_CAPABILITY_IDENTIFIERS].sort(),
  );

  assert.equal(testOnly.length, 1, 'expected exactly one classified test-only capability');
  assert.deepEqual(
    testOnly.map((entry) => entry.file),
    TEST_ONLY_CAPABILITY_FILES,
  );
  assert.equal(testOnly[0].identifier, TEST_ONLY_CAPABILITY_IDENTIFIER);

  assert.equal(
    production.some((entry) => entry.identifier === TEST_ONLY_CAPABILITY_IDENTIFIER),
    false,
    'production auto-discovery must never include monochrome-test',
  );
  assert.equal(
    production.some((entry) => entry.file === 'monochrome-test.json'),
    false,
  );
  const productionIdentifiers = new Set(production.map((entry) => entry.identifier));
  assert.equal(productionIdentifiers.has(TEST_ONLY_CAPABILITY_IDENTIFIER), false);
});

test('current test-only capability is least-privilege and base config pins the production allowlist', () => {
  const entries = currentCapabilityEntries();
  const testOnly = entries.find((entry) => entry.file === 'monochrome-test.json');
  assert.ok(testOnly, 'missing monochrome-test.json');
  assert.deepEqual(
    [...testOnly.permissions].sort(),
    [...MONOCHROME_TEST_ALLOWED_PERMISSIONS].sort(),
  );
  for (const token of MONOCHROME_TEST_FORBIDDEN_PERMISSION_TOKENS) {
    assert.equal(
      testOnly.permissions.some((permission) => permission.includes(token)),
      false,
      `forbidden permission present: ${token}`,
    );
  }
  const config = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'app/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const allowlist = config?.app?.security?.capabilities;
  assert.ok(Array.isArray(allowlist), 'missing app.security.capabilities allowlist');
  assert.deepEqual([...allowlist].sort(), [...PRODUCTION_CAPABILITY_IDENTIFIERS].sort());
  assert.equal(allowlist.includes(TEST_ONLY_CAPABILITY_IDENTIFIER), false);
});

test('production capability closure rejects removal, test-capability append, and permission broadening', () => {
  const entries = currentCapabilityEntries();
  const production = entries.filter((entry) => !TEST_ONLY_CAPABILITY_FILES.includes(entry.file));
  const frozenTuples = MONOCHROME_NATIVE_WINDOW_MANIFEST.capabilities.map(
    ({ file, identifier, windows }) => [file, identifier, windows],
  );

  assert.notDeepEqual(productionCapabilityTuples(production.slice(1)), frozenTuples);

  const testOnlyEntry = {
    file: 'monochrome-test.json',
    identifier: 'monochrome-test',
    windows: ['monochrome-test'],
    sha256: '0'.repeat(64),
  };
  const productionSnapshots = production.map(({ file, identifier, windows, sha256 }) => ({
    file,
    identifier,
    windows,
    sha256,
  }));
  const manifest = MONOCHROME_NATIVE_WINDOW_MANIFEST;
  const errors = validateMonochromeNativeWindowManifest(
    { ...manifest, capabilities: [...manifest.capabilities, testOnlyEntry] },
    productionSnapshots,
    [...productionSnapshots, testOnlyEntry],
    manifest.surfaces,
    manifest.surfaces,
  );
  assert.match(errors.join('\n'), /test window|monochrome test|closure|drift/iu);

  const testOnly = entries.find((entry) => entry.file === 'monochrome-test.json');
  const broadened = [...testOnly.permissions, 'updater:default'];
  assert.equal(
    broadened.some((permission) =>
      MONOCHROME_TEST_FORBIDDEN_PERMISSION_TOKENS.some((token) => permission.includes(token)),
    ),
    true,
    'broadened permission set must trip the forbidden-token guard',
  );
});

test('every MonoChrome visual snapshot is gated by computed style invariants before writing', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'tests/visual/monochrome/monochrome.visual.spec.ts'),
    'utf8',
  );
  const captureToken = 'await expect(page).toHaveScreenshot';
  const captureIndexes = [];
  for (let offset = source.indexOf(captureToken); offset !== -1; ) {
    captureIndexes.push(offset);
    offset = source.indexOf(captureToken, offset + captureToken.length);
  }

  assert.equal(
    captureIndexes.length,
    3,
    'the visual authority must retain its three capture loops',
  );
  for (const captureIndex of captureIndexes) {
    const testStart = source.lastIndexOf('    test(`', captureIndex);
    assert.notEqual(testStart, -1, 'each snapshot must remain inside an explicit test');
    const preparationIndex = source.indexOf('prepareDeterministicPage', testStart);
    const metricsIndex = source.indexOf('collectStyleMetrics', preparationIndex);
    const invariantIndex = source.indexOf('assertMonochromeInvariants', metricsIndex);

    assert.ok(
      preparationIndex < metricsIndex &&
        metricsIndex < invariantIndex &&
        invariantIndex < captureIndex,
      'a snapshot write must follow deterministic preparation, computed metrics, and invariant proof',
    );
  }
});

test('privileged side-effect inventory freezes every required callsite in stable order', () => {
  const ids = MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.length);
});

test('privileged inventory closes over every bounded source-derived side-effect candidate', () => {
  const discovered = discoverPrivilegedSideEffects().map(callsiteTuple);
  const frozen = MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.filter(
    (entry) => entry.expectation !== 'absent',
  )
    .map(callsiteTuple)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const sortedDiscovered = discovered.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  assert.deepEqual(frozen, sortedDiscovered);
});

test('privileged discovery includes the frozen launcher registry-open boundary', () => {
  const discovered = discoverPrivilegedSideEffects().map(callsiteTuple);
  assert.deepEqual(
    discovered.find(
      ([sourcePath, sourceLine]) =>
        sourcePath === 'app/src-tauri/src/launcher.rs' && sourceLine === 437,
    ),
    [
      'app/src-tauri/src/launcher.rs',
      437,
      'registry-open',
      'os-registry',
      '.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)',
    ],
  );
});

test('privileged discovery includes the frozen pets registry-create boundary', () => {
  const discovered = discoverPrivilegedSideEffects().map(callsiteTuple);
  assert.deepEqual(
    discovered.find(
      ([sourcePath, sourceLine]) => sourcePath === 'app/src-tauri/src/pets.rs' && sourceLine === 60,
    ),
    [
      'app/src-tauri/src/pets.rs',
      60,
      'registry-create',
      'os-registry',
      '.create_subkey(r"Software\\Microsoft\\Windows\\CurrentVersion\\Run")',
    ],
  );
});

test('privileged registry open/create inventory matches the independent bounded source scan', () => {
  const discovered = discoverRegistryOpenCreateBoundaries().map(callsiteTuple);
  const frozen = MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.filter(
    (entry) =>
      ['app/src-tauri/src/launcher.rs', 'app/src-tauri/src/pets.rs'].includes(entry.sourcePath) &&
      ['registry-read', 'registry-open', 'registry-create'].includes(entry.operation),
  ).map(callsiteTuple);
  assert.equal(discovered.length, 3);
  assert.deepEqual(frozen, discovered);
});

test('privileged inventory schema identifies each literal source callsite and current seam', () => {
  for (const entry of MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.match(entry.sourcePath, /^(?:app|tests|scripts)\//u);
    if (entry.expectation === 'absent') {
      assert.equal(entry.sourceLine, null, entry.id);
    } else {
      assert.ok(Number.isSafeInteger(entry.sourceLine) && entry.sourceLine > 0, entry.id);
    }
    assert.match(entry.operation, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.match(entry.category, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.equal(entry.guardDisposition, 'inventory-only-no-guard-required');
    assert.ok(entry.currentSeam.length > 0, entry.id);
  }
  const ids = MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('privileged callsite tokens reflect source-commit presence or declared absence', () => {
  for (const entry of MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY) {
    const source = sourceAtCommit(entry.sourcePath);
    if (entry.expectation === 'absent') {
      assert.equal(source.includes(entry.token), false, entry.id);
    } else {
      assert.equal(source.split(/\r?\n/u)[entry.sourceLine - 1]?.trim(), entry.token, entry.id);
    }
    assert.equal(entry.guardDisposition, 'inventory-only-no-guard-required');
    assert.ok(entry.currentSeam.length > 0, entry.id);
  }
});

test('privileged inventory covers the complete side-effect category vocabulary', () => {
  assert.deepEqual(
    [...new Set(MONOCHROME_PRIVILEGED_SIDE_EFFECT_INVENTORY.map((entry) => entry.category))].sort(),
    [
      'credential-store',
      'declared-absence',
      'filesystem',
      'frontend-ipc',
      'global-shortcut',
      'os-registry',
      'persistence',
      'plugin-registration',
      'process-environment',
      'process-lifecycle',
      'startup',
      'tray',
      'updater',
    ],
  );
});
