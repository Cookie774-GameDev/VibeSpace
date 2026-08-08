import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/App.tsx', 'utf8');
const runtimeSource = readFileSync('src/lib/ai/runtime.ts', 'utf8');
const chatThreadSource = readFileSync('src/features/chat/ChatThread.tsx', 'utf8');
const commandCenterUiSources = [
  'src/features/jarvis-command-center/types.ts',
  'src/features/jarvis-command-center/selectors.ts',
  'src/features/jarvis-command-center/resultMappers.ts',
  'src/features/jarvis-command-center/commandCenterStore.ts',
  'src/features/jarvis-command-center/JarvisCommandCenter.tsx',
  'src/features/jarvis-command-center/JarvisOutputsTab.tsx',
  'src/features/jarvis-command-center/JarvisLiveSystemsTab.tsx',
].map((path) => readFileSync(path, 'utf8'));

describe('App trusted kernel host composition', () => {
  it('loads host/client boundaries dynamically and never imports runtime authority for pet views', () => {
    expect(source).not.toMatch(/^import .*kernel(?:Host|Client)/m);
    expect(source).toMatch(/import\(['"]@\/lib\/jarvis\/kernelHost['"]\)/);
    expect(source).toMatch(/import\(['"]@\/lib\/jarvis\/kernelClient['"]\)/);
    expect(source).toMatch(/<KernelBridgeBootstrap\s*\/>/);

    const petOverlay = source.indexOf("if (view === 'pet-overlay')");
    const petPanel = source.indexOf("if (view === 'pet-mini-panel')");
    const bridgeMount = source.lastIndexOf('<KernelBridgeBootstrap />');
    expect(petOverlay).toBeGreaterThan(-1);
    expect(petPanel).toBeGreaterThan(petOverlay);
    expect(bridgeMount).toBeGreaterThan(petPanel);
  });

  it('falls back to a typed client only after native/browser host attestation is unavailable', () => {
    expect(source).toMatch(/startJarvisKernelHost/);
    expect(source).toMatch(/session\.role\s*===\s*['"]host['"]/);
    expect(source).toMatch(/createJarvisKernelClient/);
    expect(source).not.toMatch(/kernelRole\s*=|[?&]kernel-host=|isHost\s*:/);
  });

  it('binds approval presentation, decision, and execution to the installed primary host', () => {
    expect(source).toMatch(/handleInstalledJarvisKernelClientRequest/);
    expect(source).toMatch(/handleRequest:\s*handleInstalledJarvisKernelClientRequest/);
    expect(runtimeSource).toMatch(/request\.kind === ['"]approval_present['"]/);
    expect(runtimeSource).toMatch(/request\.kind === ['"]approval_decide['"]/);
    expect(runtimeSource).toMatch(/request\.kind === ['"]approval_execute['"]/);
    expect(runtimeSource).toMatch(/presentJarvisApproval\(approval\)/);
  });

  it('keeps capability evidence boot-stable and caches local entitlement evidence until expiry', () => {
    expect(source).toMatch(/const securityBootObservedAt = now\(\);/);
    expect(source).toMatch(/let localDevelopmentEntitlementCache:/);
    expect(source).toMatch(/const localEntitlementObservedAt = now\(\);/);
    expect(source).toMatch(/const LOCAL_DEVELOPMENT_ENTITLEMENT_DECISION_FLOOR_MS = 2 \* 60_000;/);
    expect(source).toMatch(
      /localDevelopmentEntitlementCache\.snapshot\.expiresAt\s*-\s*localEntitlementObservedAt\s*>\s*LOCAL_DEVELOPMENT_ENTITLEMENT_DECISION_FLOOR_MS/,
    );
    expect(source).toMatch(
      /context:\s*\{\s*now:\s*localEntitlementObservedAt,\s*production:\s*import\.meta\.env\.PROD,?\s*\}/,
    );
    expect(source).toMatch(/const capturedAt = now\(\);/);
    expect(source).toMatch(/lastVerifiedAt:\s*securityBootObservedAt/);
    expect(source).not.toMatch(/lastVerifiedAt:\s*capturedAt/);
    expect(source).toMatch(
      /localDevelopmentEntitlementCache\?\.accountId === accountId[\s\S]*localDevelopmentEntitlementCache = undefined/,
    );
  });

  it('projects exact active-account plugin truth into every immutable capability snapshot', () => {
    expect(source).toMatch(/createJarvisPluginCapabilityProjection/);
    expect(source).toMatch(/selectPluginConnectionsForAccount/);
    expect(source).toMatch(/usePluginStore\.getState\(\)/);
    expect(source).toMatch(/accountId,\s*capturedAt,\s*manifests:\s*PLUGIN_CATALOG/);
    expect(source).toMatch(/plugins:\s*pluginCapabilities\.refs/);
    expect(source).not.toMatch(/plugins:\s*\[\]/);
  });

  it('projects the validated security catalog into model-visible action schemas', () => {
    expect(source).toMatch(/const catalog = createJarvisActionCatalog/);
    expect(source).toMatch(/actionSchemas:\s*catalog\.listExposed\(\)/);
  });

  it('projects observed external MCP manager state without starting or probing servers', () => {
    expect(source).toMatch(/createJarvisMcpCapabilityProjection/);
    expect(source).toMatch(/jarvisMcpServerManager\.discover\(\)/);
    expect(source).toMatch(/mcps:\s*mcpCapabilities\.refs/);
    expect(source).not.toMatch(/mcps:\s*\[\]/);
    expect(source).not.toMatch(
      /resolveInputForActiveAccount[\s\S]{0,2400}jarvisMcpServerManager\.(?:start|health|listTools|invoke)\(/,
    );
  });

  it('invalidates the old account synchronously before account listener teardown', () => {
    const teardownStart = source.indexOf('async function stopAccountScopedListeners');
    const teardownEnd = source.indexOf('async function transitionAccountScopedListeners');
    const teardown = source.slice(teardownStart, teardownEnd);
    const capture = teardown.indexOf('activeAccountIdentity?.accountId');
    const invalidate = teardown.indexOf('invalidateActiveKernelAccount');
    const clear = teardown.indexOf('activeAccountIdentity = null');
    const invokeStops = teardown.indexOf('stops.map');
    expect(capture).toBeGreaterThan(-1);
    expect(invalidate).toBeGreaterThan(capture);
    expect(clear).toBeGreaterThan(invalidate);
    expect(invokeStops).toBeGreaterThan(clear);
  });

  it('creates the Command Center host only after the exact account session opens', () => {
    const accountSession = source.indexOf('liveEvidenceAccountSession = voiceRecovery.session');
    const factory = source.indexOf('createJarvisCommandCenterHostPort({');
    const dependencies = source.indexOf(
      'getInstalledJarvisCommandCenterHostDependencies()',
      factory,
    );
    const publish = source.indexOf('setCommandCenterBinding(', factory);

    expect(accountSession).toBeGreaterThan(-1);
    expect(factory).toBeGreaterThan(accountSession);
    expect(dependencies).toBeGreaterThan(factory);
    expect(publish).toBeGreaterThan(dependencies);
    expect(runtimeSource).not.toMatch(/createJarvisCommandCenterHostPort\(\{/);
  });

  it('drops the account-bound UI port before disposing its account epoch', () => {
    const teardownStart = source.indexOf('async function stopAccountScopedListeners');
    const teardownEnd = source.indexOf('async function transitionAccountScopedListeners');
    const teardown = source.slice(teardownStart, teardownEnd);

    expect(teardown.indexOf('setCommandCenterBinding(undefined)')).toBeGreaterThan(-1);
    expect(teardown.indexOf('oldLiveEvidenceSession?.dispose()')).toBeGreaterThan(
      teardown.indexOf('setCommandCenterBinding(undefined)'),
    );
  });

  it('passes ChatThread only the minimal host port and read data port', () => {
    expect(chatThreadSource).toMatch(/hostPort\.requestCancellation/);
    expect(chatThreadSource).toMatch(/commandCenterBinding\?\.dataPort/);
    expect(chatThreadSource).not.toMatch(
      /JarvisKernelRuntime|AccountSession|scheduledTransportRetry|scheduledLogicalRetry|host lifecycle/i,
    );
  });

  it('keeps projection UI imports outside raw execution and live-evidence authority', () => {
    for (const uiSource of commandCenterUiSources) {
      expect(uiSource).not.toMatch(
        /jarvisRepositories|kernelRuntime|liveEvidenceAuthority|proofBrand|reconstructLive|ProducerVerifier|WriterPort/,
      );
    }
    expect(chatThreadSource).not.toMatch(
      /jarvisRepositories|kernelRuntime|liveEvidenceAuthority|JarvisLiveEvidencePrimaryHostAccountSession/,
    );
  });
});
