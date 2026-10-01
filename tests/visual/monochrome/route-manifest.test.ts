import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MONOCHROME_NATIVE_WINDOW_MANIFEST } from './native-window-manifest.ts';
import * as routeAuthority from './route-manifest.ts';
import { MONOCHROME_SHELL_OVERLAY_MANIFEST } from './shell-overlay-manifest.ts';

const B0_SOURCE_COMMIT = '7eb708e184ee4f054a49d3e70d73e80fd4eb97ae';
const MC6_DERIVATION_COMMIT = '041c914da680d4ee5d5c091573e5582b17f18484';
const B0_ROUTE_MANIFEST_SHA256 = 'cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APP_FULL_REGRESSION_COMMAND = 'npm --prefix app test -- --maxWorkers=1 --minWorkers=1';

const EXPECTED_ROUTES = [
  'chat',
  'canvas',
  'workbench',
  'preview',
  'browser',
  'terminal',
  'kanban',
  'schedule',
  'agents',
  'agent-detail',
  'project-detail',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'account',
] as const;

const EXPECTED_SETTINGS_TABS = [
  'plans',
  'providers',
  'connections',
  'hive',
  'allaboutme',
  'plugins',
  'localmodels',
  'appearance',
  'voice',
  'composerstt',
  'phone',
  'ambient',
  'notifications',
  'accessibility',
  'hotkeys',
  'jarvisactions',
  'admin',
  'about',
] as const;

const REQUIRED_GOAL_SURFACES = [
  'account',
  'agents',
  'billing-plans',
  'browser-chat',
  'browser-operator',
  'canvas',
  'chat',
  'command-center',
  'context',
  'files',
  'history-recall',
  'kanban',
  'locked-access',
  'messaging-channels',
  'prompt-forge',
  'providers',
  'schedule',
  'settings',
  'skills',
  'terminal',
  'tools-plugins',
  'usage',
  'workbench',
] as const;

function currentSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function currentRouteUnion(): string[] {
  const source = currentSource('app/src/stores/ui.ts');
  const start = source.indexOf('export type Route =');
  const block = source.slice(start, source.indexOf(';', start));
  return [...block.matchAll(/\|\s*'([^']+)'/gu)].map((match) => match[1]);
}

function currentRouterDispatch(): string[] {
  const source = currentSource('app/src/components/layout/PageRouter.tsx');
  const start = source.indexOf('const routeMap:');
  const block = source.slice(start, source.indexOf('};', start));
  return [...block.matchAll(/^\s*(?:'([^']+)'|([a-z-]+)):\s*[A-Z]/gmu)].map(
    (match) => match[1] ?? match[2],
  );
}

function currentSettingsTabs(): string[] {
  const source = currentSource('app/src/features/settings/settingsPrefetch.ts');
  const start = source.indexOf('export type SettingsTab =');
  const block = source.slice(start, source.indexOf(';', start));
  return [...block.matchAll(/\|\s*'([^']+)'/gu)].map((match) => match[1]);
}

function cloneManifest() {
  return structuredClone(routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST);
}

test('MC6 freezes current route and settings dispatch while retaining immutable B0 provenance', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.sourceCommit, B0_SOURCE_COMMIT);
  assert.equal(manifest.derivationCommit, MC6_DERIVATION_COMMIT);
  assert.equal(manifest.b0RouteManifestSha256, B0_ROUTE_MANIFEST_SHA256);
  assert.deepEqual(manifest.finalRouteIds, EXPECTED_ROUTES);
  assert.deepEqual(manifest.finalRouteIds, currentRouteUnion());
  assert.deepEqual(manifest.finalRouteIds, currentRouterDispatch());
  assert.deepEqual(manifest.settingsTabIds, EXPECTED_SETTINGS_TABS);
  assert.deepEqual(manifest.settingsTabIds, currentSettingsTabs());
});

test('MC6 closes over routes, settings, access, overlays, detached views, native windows, and dev-only workbench', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  const ids = new Set(manifest.entries.map(({ id }) => id));

  for (const routeId of EXPECTED_ROUTES) assert.ok(ids.has(`route:${routeId}`));
  for (const tabId of EXPECTED_SETTINGS_TABS) assert.ok(ids.has(`settings:${tabId}`));
  for (const surface of MONOCHROME_SHELL_OVERLAY_MANIFEST.surfaces) {
    assert.ok(ids.has(`overlay:${surface.id}`), surface.id);
  }
  for (const view of MONOCHROME_SHELL_OVERLAY_MANIFEST.detachedViews) {
    assert.ok(ids.has(`detached:${view.id}`), view.id);
  }
  for (const surface of MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces) {
    assert.ok(ids.has(`native:${surface.label}`), surface.label);
  }
  assert.ok(ids.has('access:app-host'));
  assert.ok(ids.has('access:banner'));
  assert.ok(ids.has('access:locked'));
  assert.ok(ids.has('development:monochrome-workbench'));
  const accessEntries = manifest.entries.filter(({ id }) => id.startsWith('access:'));
  assert.deepEqual(
    accessEntries.map(({ availability }) => availability),
    ['feature-flagged', 'feature-flagged', 'feature-flagged'],
  );
  for (const routeId of ['project-detail', 'history']) {
    const entry = manifest.entries.find(({ id }) => id === `route:${routeId}`);
    assert.deepEqual(entry?.testPaths, ['tests/visual/monochrome/route-manifest.test.ts']);
    assert.deepEqual(entry?.behaviorCommands, [
      APP_FULL_REGRESSION_COMMAND,
      'node --test tests/visual/monochrome/route-manifest.test.ts',
    ]);
  }
});

test('every Goal 8 surface resolves to an audited entry and unavailable futures remain explicit', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  assert.deepEqual(Object.keys(manifest.goalSurfaceMap).sort(), [...REQUIRED_GOAL_SURFACES].sort());
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  for (const [goalId, entryIds] of Object.entries(manifest.goalSurfaceMap)) {
    assert.ok(entryIds.length > 0, goalId);
    for (const entryId of entryIds) assert.ok(entries.has(entryId), `${goalId}: ${entryId}`);
  }
  const messaging = entries.get('future:messaging-channels');
  assert.equal(messaging?.auditStatus, 'unavailable');
  assert.match(messaging?.unavailableReason ?? '', /not.*production.*surface/iu);
  assert.deepEqual(messaging?.sourcePaths, []);
  assert.deepEqual(messaging?.writerPaths, []);
});

test('every available entry carries real sources, tests, fixture hash, behavior, viewport, preservation, owner, and lock metadata', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  for (const entry of manifest.entries) {
    assert.match(entry.id, /^[a-z]+:[a-z0-9-]+$/u);
    assert.ok(entry.owner.length > 0, `${entry.id}: owner`);
    assert.ok(entry.logicalLock.length > 0, `${entry.id}: logical lock`);
    assert.ok(entry.behaviorCommands.length > 0, `${entry.id}: behavior command`);
    for (const command of entry.behaviorCommands) {
      if (command === APP_FULL_REGRESSION_COMMAND) continue;
      const nodeMatch = /^node --test (.+)$/u.exec(command);
      const appMatch = /^npm --prefix app test -- (src\/.+) --maxWorkers=1 --minWorkers=1$/u.exec(
        command,
      );
      const commandTestPath = nodeMatch?.[1] ?? (appMatch ? `app/${appMatch[1]}` : null);
      assert.ok(commandTestPath, `${entry.id}: behavior command uses a supported runner`);
      assert.ok(
        entry.testPaths.includes(commandTestPath),
        `${entry.id}: behavior command targets a declared test`,
      );
    }
    assert.deepEqual(entry.viewports, ['1672x941', '1024x768', 'narrow-desktop']);
    assert.deepEqual(
      entry.zoom,
      routeAuthority.MONOCHROME_ZOOM_ROWS.map(({ label }) => label),
    );
    assert.deepEqual(entry.motion, ['no-preference', 'reduce']);

    if (entry.auditStatus === 'unavailable') continue;
    assert.ok(
      entry.behaviorCommands.some((command) => command.startsWith('npm --prefix app test --')),
      `${entry.id}: functional app regression command`,
    );
    assert.ok(entry.sourcePaths.length > 0, `${entry.id}: source`);
    assert.ok(entry.testPaths.length > 0, `${entry.id}: tests`);
    assert.match(entry.fixture.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.preservedBaselineIds.length > 0, `${entry.id}: preserved baseline`);
    for (const relativePath of [...entry.sourcePaths, ...entry.testPaths]) {
      assert.equal(
        existsSync(path.join(REPO_ROOT, relativePath)),
        true,
        `${entry.id}: ${relativePath}`,
      );
    }
  }
});

test('browser-owned zoom authority is one frozen exact ordered collection', () => {
  assert.deepEqual(routeAuthority.MONOCHROME_ZOOM_ROWS, [
    { label: '100%', factor: 1, surfaceId: 'zoom:100%' },
    { label: '125%', factor: 1.25, surfaceId: 'zoom:125%' },
    { label: '150%', factor: 1.5, surfaceId: 'zoom:150%' },
    { label: '200%', factor: 2, surfaceId: 'zoom:200%' },
  ]);
  assert.equal(Object.isFrozen(routeAuthority.MONOCHROME_ZOOM_ROWS), true);
  assert.equal(
    routeAuthority.MONOCHROME_ZOOM_ROWS.every((row) => Object.isFrozen(row)),
    true,
  );
});

test('validator fails closed for every MC6 Step 3 defect', () => {
  const validate = routeAuthority.validateMonochromeRouteCoverageManifest;
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  assert.deepEqual(validate(manifest), []);

  const missingRoute = cloneManifest();
  missingRoute.entries = missingRoute.entries.filter(({ id }) => id !== 'route:chat');
  assert.match(validate(missingRoute).join('\n'), /missing production route/iu);

  const missingSettings = cloneManifest();
  missingSettings.entries = missingSettings.entries.filter(
    ({ id }) => id !== 'settings:appearance',
  );
  assert.match(validate(missingSettings).join('\n'), /missing settings surface/iu);

  const missingAccess = cloneManifest();
  missingAccess.entries = missingAccess.entries.filter(({ id }) => id !== 'access:locked');
  assert.match(validate(missingAccess).join('\n'), /missing access surface/iu);

  const missingOverlay = cloneManifest();
  missingOverlay.entries = missingOverlay.entries.filter(
    ({ id }) => id !== 'overlay:activity-strip',
  );
  assert.match(validate(missingOverlay).join('\n'), /coverage entry closure/iu);

  const orphanOverlay = cloneManifest();
  const orphanOverlayEntry = structuredClone(
    orphanOverlay.entries.find(({ id }) => id === 'overlay:activity-strip')!,
  );
  orphanOverlayEntry.id = 'overlay:invented';
  orphanOverlayEntry.writerPaths = [];
  orphanOverlayEntry.fileLockPaths = [];
  orphanOverlay.entries.push(orphanOverlayEntry);
  orphanOverlay.entries.sort((left, right) => left.id.localeCompare(right.id));
  assert.match(validate(orphanOverlay).join('\n'), /coverage entry closure/iu);

  const zoomDrift = cloneManifest();
  zoomDrift.entries[0].zoom = ['100%'];
  assert.match(validate(zoomDrift).join('\n'), /zoom authority mismatch/iu);

  const unknownRoute = cloneManifest();
  unknownRoute.entries.find(({ id }) => id === 'route:chat')!.routeId = 'unknown-route';
  assert.match(validate(unknownRoute).join('\n'), /outside final route union/iu);

  const inventedRoute = cloneManifest();
  inventedRoute.finalRouteIds.push('invented-route');
  const inventedRouteEntry = structuredClone(
    inventedRoute.entries.find(({ id }) => id === 'route:chat')!,
  );
  inventedRouteEntry.id = 'route:invented-route';
  inventedRouteEntry.routeId = 'invented-route';
  inventedRouteEntry.writerPaths = [];
  inventedRouteEntry.fileLockPaths = [];
  inventedRoute.entries.push(inventedRouteEntry);
  inventedRoute.entries.sort((left, right) => left.id.localeCompare(right.id));
  assert.match(validate(inventedRoute).join('\n'), /source-derived route union drift/iu);

  const inventedSettings = cloneManifest();
  inventedSettings.settingsTabIds.push('invented-settings');
  const inventedSettingsEntry = structuredClone(
    inventedSettings.entries.find(({ id }) => id === 'settings:plans')!,
  );
  inventedSettingsEntry.id = 'settings:invented-settings';
  inventedSettingsEntry.writerPaths = [];
  inventedSettingsEntry.fileLockPaths = [];
  inventedSettings.entries.push(inventedSettingsEntry);
  inventedSettings.entries.sort((left, right) => left.id.localeCompare(right.id));
  assert.match(validate(inventedSettings).join('\n'), /source-derived settings union drift/iu);

  const inventedRouteAlias = cloneManifest();
  const inventedRouteAliasEntry = structuredClone(
    inventedRouteAlias.entries.find(({ id }) => id === 'route:account')!,
  );
  inventedRouteAliasEntry.id = 'route:invented-alias';
  inventedRouteAliasEntry.writerPaths = [];
  inventedRouteAliasEntry.fileLockPaths = [];
  inventedRouteAlias.entries.push(inventedRouteAliasEntry);
  inventedRouteAlias.entries.sort((left, right) => left.id.localeCompare(right.id));
  assert.match(validate(inventedRouteAlias).join('\n'), /route entry closure mismatch/iu);

  const inventedSettingsAlias = cloneManifest();
  const inventedSettingsAliasEntry = structuredClone(
    inventedSettingsAlias.entries.find(({ id }) => id === 'settings:plans')!,
  );
  inventedSettingsAliasEntry.id = 'settings:invented-alias';
  inventedSettingsAliasEntry.writerPaths = [];
  inventedSettingsAliasEntry.fileLockPaths = [];
  inventedSettingsAlias.entries.push(inventedSettingsAliasEntry);
  inventedSettingsAlias.entries.sort((left, right) => left.id.localeCompare(right.id));
  assert.match(validate(inventedSettingsAlias).join('\n'), /settings entry closure mismatch/iu);

  const nonexistentSource = cloneManifest();
  nonexistentSource.entries.find(({ id }) => id === 'route:chat')!.sourcePaths = [
    'app/src/features/chat/DoesNotExist.tsx',
  ];
  assert.match(validate(nonexistentSource).join('\n'), /nonexistent source/iu);

  const duplicateId = cloneManifest();
  duplicateId.entries.push(structuredClone(duplicateId.entries[0]));
  assert.match(validate(duplicateId).join('\n'), /duplicate entry id/iu);

  const missingBehavior = cloneManifest();
  missingBehavior.entries[0].behaviorCommands = [];
  assert.match(validate(missingBehavior).join('\n'), /missing behavior command/iu);

  const structuralOnlyBehavior = cloneManifest();
  structuralOnlyBehavior.entries.find(({ id }) => id === 'route:history')!.behaviorCommands = [
    'node --test tests/visual/monochrome/route-manifest.test.ts',
  ];
  assert.match(
    validate(structuralOnlyBehavior).join('\n'),
    /missing functional behavior command/iu,
  );

  const invalidBehavior = cloneManifest();
  invalidBehavior.entries.find(({ id }) => id === 'access:banner')!.behaviorCommands = [
    'npx --no-install vitest run app/src/features/access/AccessBanner.test.tsx',
  ];
  assert.match(validate(invalidBehavior).join('\n'), /invalid behavior command/iu);

  const mismatchedBehavior = cloneManifest();
  mismatchedBehavior.entries.find(({ id }) => id === 'access:banner')!.behaviorCommands = [
    'npm --prefix app test -- src/features/access/AccessPaywall.test.tsx --maxWorkers=1 --minWorkers=1',
  ];
  assert.match(validate(mismatchedBehavior).join('\n'), /behavior command\/test mismatch/iu);

  const writerOverlap = cloneManifest();
  const writerEntries = writerOverlap.entries.filter(({ writerPaths }) => writerPaths.length > 0);
  writerEntries[1].writerPaths = [writerEntries[0].writerPaths[0]];
  assert.match(validate(writerOverlap).join('\n'), /writer path overlap/iu);

  const falseUnavailable = cloneManifest();
  const future = falseUnavailable.entries.find(({ id }) => id === 'future:messaging-channels')!;
  future.auditStatus = 'covered';
  future.unavailableReason = null;
  assert.match(validate(falseUnavailable).join('\n'), /available entry missing source/iu);
});

test('MC7 lane locks are non-overlapping and exclude shared layout, CSS, registries, primitives, and harnesses', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  const writerOwner = new Map<string, string>();
  const forbidden =
    /(?:app\/src\/components\/layout\/|app\/src\/components\/ui\/|app\/src\/styles\/|registry|tests\/visual\/monochrome\/)/u;

  for (const entry of manifest.entries) {
    if (!entry.owner.startsWith('MC7')) continue;
    for (const writerPath of entry.writerPaths) {
      assert.doesNotMatch(writerPath, forbidden, `${entry.id}: shared path`);
      assert.equal(writerOwner.has(writerPath), false, `${writerPath}: overlapping MC7 owner`);
      writerOwner.set(writerPath, entry.owner);
    }
    assert.deepEqual(entry.fileLockPaths, entry.writerPaths);
  }
});

test('route coverage document is mechanically aligned with the manifest contract', () => {
  const document = currentSource('docs/appearance/monochrome/route-coverage.md');
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  assert.match(document, new RegExp(`Schema: ${manifest.schemaVersion}`, 'u'));
  assert.match(document, new RegExp(`Derivation commit: ${manifest.derivationCommit}`, 'u'));
  assert.match(document, new RegExp(`Production routes: ${manifest.finalRouteIds.length}`, 'u'));
  assert.match(document, new RegExp(`Settings tabs: ${manifest.settingsTabIds.length}`, 'u'));
  assert.match(document, new RegExp(`Coverage entries: ${manifest.entries.length}`, 'u'));
  const availableEntries = manifest.entries.filter(
    ({ auditStatus }) => auditStatus !== 'unavailable',
  );
  const focusedEntries = availableEntries.filter(({ behaviorCommands }) =>
    behaviorCommands.some((command) => command.startsWith('npm --prefix app test -- src/')),
  );
  const aggregateEntries = availableEntries.filter(({ behaviorCommands }) =>
    behaviorCommands.includes(APP_FULL_REGRESSION_COMMAND),
  );
  assert.match(document, new RegExp(`${focusedEntries.length} available entries`, 'u'));
  assert.match(document, new RegExp(`remaining ${aggregateEntries.length} available entries`, 'u'));
  for (const lane of routeAuthority.MONOCHROME_MC7_LANES) {
    assert.match(document, new RegExp(`\\| ${lane.id} \\|`, 'u'), lane.id);
  }
});

test('owned-path scope remains exact and validator command is resumable', () => {
  const manifest = routeAuthority.MONOCHROME_ROUTE_COVERAGE_MANIFEST;
  assert.deepEqual(manifest.ownedPaths, [
    'docs/appearance/monochrome/route-coverage.md',
    'tests/visual/monochrome/route-manifest.test.ts',
    'tests/visual/monochrome/route-manifest.ts',
  ]);
  assert.equal(
    manifest.validatorCommand,
    'node --test tests/visual/monochrome/route-manifest.test.ts',
  );
  assert.doesNotThrow(() =>
    execFileSync('git', ['cat-file', '-e', `${manifest.derivationCommit}^{commit}`], {
      cwd: REPO_ROOT,
    }),
  );
});
