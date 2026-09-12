import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/App.tsx', 'utf8');

describe('App VibeSpace Access composition', () => {
  it('wraps only the authenticated main workspace in the installed access host', () => {
    const bootstrap = source.indexOf('function KernelBridgeBootstrap');
    const authBoundary = source.indexOf('export function RuntimeProfileAuthBoundary', bootstrap);
    const desktopLifecycle = source.indexOf('function useDesktopReopenLifecycle', authBoundary);
    const bootstrapSource = source.slice(bootstrap, authBoundary);
    const authBoundarySource = source.slice(authBoundary, desktopLifecycle);
    const accessHost = bootstrapSource.indexOf(
      '<InstalledAccessAppHost authenticatedBoundary={WorkspaceRuntimeBoundary}>',
    );
    const workspace = bootstrapSource.indexOf('<WorkspaceRoot />', accessHost);
    const accessClose = bootstrapSource.indexOf('</InstalledAccessAppHost>', workspace);

    expect(bootstrap).toBeGreaterThan(-1);
    expect(authBoundary).toBeGreaterThan(bootstrap);
    expect(desktopLifecycle).toBeGreaterThan(authBoundary);
    expect(bootstrapSource).toContain('<RuntimeProfileAuthBoundary plan={plan}>');
    expect(authBoundarySource).toContain('<AuthGate>{children}</AuthGate>');
    expect(accessHost).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(accessHost);
    expect(accessClose).toBeGreaterThan(workspace);
  });

  it('keeps the account runtime owner outside the account-keyed workspace shell', () => {
    const runtimeBoundary = source.indexOf('function WorkspaceRuntimeBoundary');
    const workspaceRoot = source.indexOf('function WorkspaceRoot()', runtimeBoundary);
    const workspaceEnd = source.indexOf('const defaultRuntimeProfileQuery', workspaceRoot);
    const runtimeBoundarySource = source.slice(runtimeBoundary, workspaceRoot);
    const workspaceSource = source.slice(workspaceRoot, workspaceEnd);

    expect(runtimeBoundary).toBeGreaterThan(-1);
    expect(workspaceRoot).toBeGreaterThan(runtimeBoundary);
    expect(workspaceEnd).toBeGreaterThan(workspaceRoot);
    expect(runtimeBoundarySource).toContain(
      'const { commandCenterBinding, runtimeListenerReady } = useBoot();',
    );
    expect(runtimeBoundarySource).toContain('runtimeListenerReady ? children : null');
    expect(runtimeBoundarySource).toContain(
      '<JarvisCommandCenterProvider value={commandCenterBinding}>',
    );
    expect(runtimeBoundarySource).toContain(
      '<KernelSmokeReconstructedLiveEvidenceHost binding={commandCenterBinding} />',
    );
    expect(workspaceSource).not.toContain('useBoot()');
    expect(workspaceSource).not.toContain('<JarvisCommandCenterProvider');
    expect(workspaceSource).not.toContain('<KernelSmokeReconstructedLiveEvidenceHost');
  });

  it('keeps dictation and pet windows ahead of the main access-gated bootstrap', () => {
    const dictation = source.indexOf("if (view === 'dictation')");
    const petOverlay = source.indexOf("if (view === 'pet-overlay')");
    const petPanel = source.indexOf("if (view === 'pet-mini-panel')");
    const bridgeMount = source.lastIndexOf('<KernelBridgeBootstrap />');

    expect(dictation).toBeGreaterThan(-1);
    expect(petOverlay).toBeGreaterThan(dictation);
    expect(petPanel).toBeGreaterThan(petOverlay);
    expect(bridgeMount).toBeGreaterThan(petPanel);
  });
});
