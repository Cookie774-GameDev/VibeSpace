/**
 * Production OpenCode send contract.
 * Warm Chat uses the persistent `opencode serve` harness + official SDK/SSE.
 * `opencode run` is diagnostic-only and cannot be the production send path.
 */

import { resolveOpenCodeSelection } from '@/lib/harness/providerReconciliation';
import type { HarnessModelSelection, HarnessProvider } from '@/lib/harness/types';

export const OPENCODE_DIAGNOSTIC_RUN_ARG = 'run' as const;

export type CatalogExecutionSource = 'live-opencode' | 'static-display';

export function isDiagnosticOpenCodeRun(args: readonly string[]): boolean {
  return args[0] === OPENCODE_DIAGNOSTIC_RUN_ARG;
}

export function assertProductionSendDoesNotUseOpenCodeRun(args: readonly string[]): void {
  if (isDiagnosticOpenCodeRun(args)) {
    throw new Error(
      'OpenCode production send uses the persistent serve harness, not opencode run.',
    );
  }
}

export function assertCatalogExecutionAllowed(source: CatalogExecutionSource): void {
  if (source !== 'live-opencode') {
    throw new Error('Static model lists cannot execute. Refresh the live OpenCode catalog.');
  }
}

export function assertSupportedOpenCodeEffort(
  requested: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (requested === undefined) return undefined;
  const allowed = supported && supported.length > 0 ? supported : undefined;
  if (!allowed) {
    throw new Error(`OpenCode model variant "${requested}" is unsupported.`);
  }
  if (!allowed.includes(requested)) {
    throw new Error(`OpenCode model variant "${requested}" is unsupported.`);
  }
  return requested;
}

let liveOpenCodeProviders: readonly HarnessProvider[] = [];

export function rememberLiveOpenCodeProviders(providers: readonly HarnessProvider[]): void {
  liveOpenCodeProviders = providers;
}

export function getLiveOpenCodeProviders(): readonly HarnessProvider[] {
  return liveOpenCodeProviders;
}

export function catalogSourceFromLiveProviders(
  providers: readonly HarnessProvider[],
): CatalogExecutionSource {
  return providers.some((provider) => provider.models.length > 0) ? 'live-opencode' : 'static-display';
}

export function liveVariantsForSelection(
  providers: readonly HarnessProvider[],
  selection: Pick<HarnessModelSelection, 'providerId' | 'modelId' | 'runtimeProviderId'>,
): readonly string[] | undefined {
  const providerId = selection.runtimeProviderId ?? selection.providerId;
  return providers
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.id === selection.modelId)?.variants;
}

/** Fail closed unless the live connection-qualified OpenCode catalog can execute this send. */
export function assertProductionOpenCodeSend(input: {
  providers: readonly HarnessProvider[];
  selection: Pick<HarnessModelSelection, 'providerId' | 'modelId' | 'runtimeProviderId' | 'connectionId'>;
  variant?: string;
}): string | undefined {
  rememberLiveOpenCodeProviders(input.providers);
  assertCatalogExecutionAllowed(catalogSourceFromLiveProviders(input.providers));
  resolveOpenCodeSelection(
    {
      providerId: input.selection.providerId,
      modelId: input.selection.modelId,
      ...(input.selection.connectionId ? { connectionId: input.selection.connectionId } : {}),
      ...(input.selection.runtimeProviderId
        ? { runtimeProviderId: input.selection.runtimeProviderId }
        : {}),
    },
    input.providers,
  );
  return assertSupportedOpenCodeEffort(
    input.variant,
    liveVariantsForSelection(input.providers, input.selection),
  );
}

export function shouldDispatchOpenCodeThroughHarness(connection?: {
  id?: string;
  adapterId?: string;
}): boolean {
  return connection?.adapterId === 'opencode-cli' || connection?.id === 'opencode-cli';
}

export function isSafeAbsoluteWorkingDirectory(directory: string): boolean {
  const absoluteWindows = /^[A-Za-z]:[\\/]/.test(directory);
  const absoluteUnc = /^\\\\[^\\]+\\[^\\]+/.test(directory);
  const absolutePosix = directory.startsWith('/');
  return (
    directory.length > 0 &&
    directory.length <= 4_096 &&
    !directory.includes('\u0000') &&
    !/[\r\n]/.test(directory) &&
    (absoluteWindows || absoluteUnc || absolutePosix)
  );
}

function defaultWorkingDirectory(): string {
  try {
    const cwd =
      typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '';
    if (isSafeAbsoluteWorkingDirectory(cwd)) return cwd;
  } catch {
    /* ignore non-Node hosts */
  }
  if (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)) {
    return 'C:\\';
  }
  return '/';
}

/** Production send always supplies a safe absolute cwd; relative or dirty values fail closed. */
export function resolveProductionWorkingDirectory(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed) {
    if (!isSafeAbsoluteWorkingDirectory(trimmed)) {
      throw new Error('OpenCode requires a safe absolute working directory.');
    }
    return trimmed;
  }
  const fallback = defaultWorkingDirectory();
  if (!isSafeAbsoluteWorkingDirectory(fallback)) {
    throw new Error('OpenCode requires a safe absolute working directory.');
  }
  return fallback;
}
