import { isTauri } from '@/lib/utils';
import { db, terminalSessionRepo } from '@/lib/db';
import {
  harnessRuntimeManager,
  type HarnessRuntimeManager,
  type OpenCodeServerConnection,
} from '@/lib/harness/runtimeManager';
import type { HarnessRuntimeState } from '@/lib/harness/types';
import { runStorageDoctor, type StorageDoctorResult } from '@/lib/doctor/storageDoctor';
import { getAllCatalogSkills } from '@/features/skills';
import { browserTokenOptimizationPreferences } from '@/features/token-optimizer';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { refreshExternalConnectionAutoDetection } from '@/lib/ai/adapters/autoDetectConnections';
import type { ConnectionMetadataRecord } from '@/lib/ai/connectionState';
import { installToolGatewayRlmContextPort } from '@/lib/harness/toolGatewayProduction';
import { productionRlmContextTool } from '@/features/context/contextRlmProduction';
import { getProductionSiyuanRlmPort } from '@/features/context/siyuanRlmProduction';
import { useDevConsoleStore, type DevLogEntry } from '@/features/dev-console/store';
import { runDefaultPlaywrightFeaturePackDoctorCheck } from './playwrightFeaturePackBridge';
import { codexRuntimeManager, type CodexRuntimeState } from '@/lib/harness/codexRuntimeManager';
import { runDefaultDoctorSystemChecks, withDoctorDeadline } from './doctorSystemChecks';

const OPENCODE_SETTLE_TIMEOUT_MS = 20_000;

export interface VibeSpaceDoctorReport {
  readonly ok: boolean;
  readonly text: string;
}

export interface VibeSpaceDoctorSubsystemCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface VibeSpaceDoctorDependencies {
  readonly nativeRuntime: boolean;
  readonly runStorage: () => Promise<StorageDoctorResult>;
  readonly refreshOpenCode: () => Promise<void>;
  readonly repairOpenCode: () => Promise<void>;
  readonly getOpenCodeState: () => HarnessRuntimeState;
  readonly getOpenCodeConnection: () => OpenCodeServerConnection | undefined;
  readonly waitForOpenCodeSettled: () => Promise<void>;
  readonly inspectCodexRuntime: () => Promise<CodexRuntimeState>;
  readonly repairCodexRuntime: () => Promise<CodexRuntimeState>;
  readonly refreshOpenCodeProvider: () => Promise<VibeSpaceDoctorSubsystemCheck>;
  readonly refreshContextBindings: () => Promise<readonly VibeSpaceDoctorSubsystemCheck[]>;
  readonly checkPlaywrightFeaturePack: () => Promise<VibeSpaceDoctorSubsystemCheck>;
  readonly readRecentHealthSignals: () => readonly VibeSpaceDoctorSubsystemCheck[];
  readonly captureProtectedRouteState: () => string;
  readonly runAdditionalChecks: () => Promise<readonly VibeSpaceDoctorSubsystemCheck[]>;
  readonly now: () => number;
}

export function summarizeCodexRuntime(state: CodexRuntimeState): VibeSpaceDoctorSubsystemCheck {
  if (state.kind === 'ready') {
    return {
      label: 'Codex tools',
      ok: true,
      detail: `Ready · Codex ${state.codexVersion} · OpenCodex ${state.openCodexVersion}`,
    };
  }
  if (state.kind === 'missing') {
    return {
      label: 'Codex tools',
      ok: false,
      detail: 'Needs repair · codex_runtime_missing',
    };
  }
  if (state.kind === 'incomplete') {
    return {
      label: 'Codex tools',
      ok: false,
      detail: 'Needs attention · codex_runtime_incomplete',
    };
  }
  if (state.kind === 'failed') {
    return {
      label: 'Codex tools',
      ok: false,
      detail: 'Check failed safely · codex_runtime_failed',
    };
  }
  return { label: 'Codex tools', ok: false, detail: `Not settled · codex_runtime_${state.kind}` };
}

const RECENT_HEALTH_WINDOW_MS = 15 * 60 * 1000;

export function collectRecentDoctorHealthSignals(
  entries: readonly DevLogEntry[],
  now: number,
): readonly VibeSpaceDoctorSubsystemCheck[] {
  const signals = new Map<string, VibeSpaceDoctorSubsystemCheck>();
  const record = (label: string, code: string, detail: string) => {
    if (!signals.has(code)) signals.set(code, { label, ok: false, detail: `${detail} · ${code}` });
  };
  for (const entry of entries) {
    if (
      entry.channel !== 'ai' ||
      (entry.level !== 'warn' && entry.level !== 'error') ||
      entry.ts < now - RECENT_HEALTH_WINDOW_MS ||
      entry.ts > now + 60_000
    ) {
      continue;
    }
    const message = entry.message.toLowerCase();
    if (/rate.?limit|too many requests|\b429\b/u.test(message)) {
      record(
        'Recent OpenCode provider evidence',
        'opencode_upstream_rate_limited',
        'Recent upstream rate limit remains unverified',
      );
      continue;
    }
    if (/\b(?:context|rlm)\b/u.test(message) && /fail|error|unavailable|reject/u.test(message)) {
      record('Recent RLM evidence', 'rlm_recent_failure', 'Recent RLM failure remains unverified');
      continue;
    }
    if (/siyuan/u.test(message) && /fail|error|unavailable|reject/u.test(message)) {
      record(
        'Recent SiYuan evidence',
        'siyuan_recent_failure',
        'Recent SiYuan failure remains unverified',
      );
      continue;
    }
    if (/unauthori[sz]ed|authentication|token refresh|\b401\b/u.test(message)) {
      record(
        'Recent OpenCode provider evidence',
        'opencode_provider_auth_required',
        'Recent authentication failure remains unverified',
      );
    }
  }
  return [...signals.values()];
}

async function safeSubsystemCheck(
  label: string,
  diagnosticCode: string,
  check: () => string | Promise<string>,
): Promise<VibeSpaceDoctorSubsystemCheck> {
  try {
    return { label, ok: true, detail: await withDoctorDeadline(check) };
  } catch {
    return { label, ok: false, detail: `Check failed safely · ${diagnosticCode}` };
  }
}

async function runDefaultAdditionalChecks(): Promise<readonly VibeSpaceDoctorSubsystemCheck[]> {
  const [local, connected] = await Promise.all([
    Promise.all([
      safeSubsystemCheck('Agents', 'agents_roster_unavailable', () => {
        const count = Object.keys(useAgentStore.getState().agents).length;
        return `Ready · ${count} loaded`;
      }),
      safeSubsystemCheck('Skills', 'skills_catalog_unavailable', () => {
        const count = getAllCatalogSkills().length;
        return `Ready · ${count} available`;
      }),
      safeSubsystemCheck('Terminal storage', 'terminal_sessions_unavailable', async () => {
        const count = (await terminalSessionRepo.listRecentByLastActive(20)).length;
        return `Readable · ${count} recent ${count === 1 ? 'session' : 'sessions'}; PTY execution not tested`;
      }),
      safeSubsystemCheck('Optimization', 'optimization_settings_unavailable', () => {
        const preferences = browserTokenOptimizationPreferences.getSnapshot();
        if (!preferences.neverChangeSelectedModel) {
          throw new Error('model selection protection is disabled');
        }
        return `Ready · ${preferences.globalMode} · selected model protected`;
      }),
      safeSubsystemCheck('Settings', 'settings_store_unavailable', async () => {
        await db.settings.limit(1).toArray();
        return 'Readable';
      }),
    ]),
    runDefaultDoctorSystemChecks(),
  ]);
  return [...local, ...connected];
}

function isOpenCodeSettled(state: HarnessRuntimeState): boolean {
  return ['ready', 'missing', 'download_required', 'incompatible', 'failed'].includes(state.kind);
}

async function waitForOpenCodeSettled(manager: HarnessRuntimeManager): Promise<void> {
  if (isOpenCodeSettled(manager.getSnapshot())) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const timeout = setTimeout(finish, OPENCODE_SETTLE_TIMEOUT_MS);
    unsubscribe = manager.subscribe(() => {
      if (isOpenCodeSettled(manager.getSnapshot())) finish();
    });
    if (isOpenCodeSettled(manager.getSnapshot())) finish();
  });
}

function storageSummary(result: StorageDoctorResult): { ok: boolean; text: string } {
  if (result.code === 'healthy') return { ok: true, text: 'Healthy' };
  if (result.code === 'recovered_after_repair') {
    return { ok: true, text: 'Recovered from the confirmed backup-first repair' };
  }
  if (result.code === 'recovered_after_retry') {
    return { ok: true, text: `Recovered safely after ${result.attempts} attempts` };
  }
  if (result.code === 'needs_user_repair') {
    return {
      ok: false,
      text: `Needs confirmed backup-first repair · ${result.diagnosticCode}`,
    };
  }
  return { ok: false, text: `Unrecognized failure · ${result.diagnosticCode}` };
}

function openCodeSummary(
  state: HarnessRuntimeState,
  connection: OpenCodeServerConnection | undefined,
): { ok: boolean; text: string } {
  if (state.kind === 'ready' && connection) {
    return { ok: true, text: `Ready · ${connection.source} ${connection.version}` };
  }
  if (state.kind === 'failed') {
    return { ok: false, text: 'Needs attention · opencode_runtime_failed' };
  }
  if (state.kind === 'incompatible') {
    return { ok: false, text: 'Needs attention · opencode_runtime_incompatible' };
  }
  if (state.kind === 'download_required' || state.kind === 'missing') {
    return {
      ok: false,
      text: 'Not available · opencode_runtime_missing',
    };
  }
  return { ok: false, text: `Did not become ready · ${state.kind}` };
}

export function summarizeOpenCodeProviderRecord(
  record: ConnectionMetadataRecord | undefined,
): VibeSpaceDoctorSubsystemCheck {
  if (!record) {
    return {
      label: 'OpenCode provider',
      ok: false,
      detail: 'Connection was not inspected · opencode_provider_unverified',
    };
  }
  if (record.disabled) {
    return {
      label: 'OpenCode provider',
      ok: false,
      detail: 'Disabled by user; no setting was changed · opencode_provider_disabled',
    };
  }
  if (record.installation !== 'installed') {
    return {
      label: 'OpenCode provider',
      ok: false,
      detail: 'Connection is not installed · opencode_provider_not_installed',
    };
  }
  if (record.auth === 'authenticated') {
    return { label: 'OpenCode provider', ok: true, detail: 'Authenticated' };
  }
  if (record.auth === 'unauthenticated') {
    return {
      label: 'OpenCode provider',
      ok: false,
      detail: 'Authentication required · opencode_provider_auth_required',
    };
  }
  return {
    label: 'OpenCode provider',
    ok: false,
    detail: 'Authentication was not verified · opencode_provider_auth_unverified',
  };
}

async function refreshDefaultOpenCodeProvider(): Promise<VibeSpaceDoctorSubsystemCheck> {
  const metadata = await refreshExternalConnectionAutoDetection();
  return summarizeOpenCodeProviderRecord(metadata['opencode-cli']);
}

interface DoctorSiyuanPort {
  stopActive(): Promise<void>;
  searchBlocks(projectId: string, query: string, limit: number): Promise<unknown>;
}

export interface DoctorContextBindingDependencies {
  installRlm(): void;
  getSiyuanPort(): DoctorSiyuanPort;
  projectId(): string | null;
  createProbeId(): string;
}

export async function refreshDoctorContextBindings(
  dependencies: DoctorContextBindingDependencies,
): Promise<readonly VibeSpaceDoctorSubsystemCheck[]> {
  const checks: VibeSpaceDoctorSubsystemCheck[] = [];
  try {
    dependencies.installRlm();
    checks.push({ label: 'RLM', ok: true, detail: 'Tool binding refreshed' });
  } catch {
    checks.push({ label: 'RLM', ok: false, detail: 'Rebind failed safely · rlm_rebind_failed' });
  }

  try {
    const port = dependencies.getSiyuanPort();
    await port.stopActive();
    const projectId = dependencies.projectId();
    if (!projectId) {
      checks.push({
        label: 'SiYuan',
        ok: true,
        detail: 'Binding refreshed; read-only probe deferred until a project is active',
      });
    } else {
      await port.searchBlocks(projectId, `vibespace-doctor-${dependencies.createProbeId()}`, 1);
      checks.push({ label: 'SiYuan', ok: true, detail: 'Read-only transport probe passed' });
    }
  } catch {
    checks.push({
      label: 'SiYuan',
      ok: false,
      detail: 'Read-only transport probe failed safely · siyuan_transport_unavailable',
    });
  }
  return checks;
}

async function refreshDefaultContextBindings(): Promise<readonly VibeSpaceDoctorSubsystemCheck[]> {
  return refreshDoctorContextBindings({
    // The production host uses this same typed binding. Reinstalling the exact
    // singleton repairs a missing process-local port without changing RLM settings.
    installRlm: () => {
      installToolGatewayRlmContextPort(productionRlmContextTool);
    },
    getSiyuanPort: getProductionSiyuanRlmPort,
    projectId: () => {
      const projectId = useAuthStore.getState().projectId;
      return projectId ? String(projectId) : null;
    },
    createProbeId: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
  });
}

const PROTECTED_ROUTE_STORAGE_KEYS = Object.freeze([
  'vibespace.chat-runtime-settings.v1',
  'vibespace.chat-reasoning.v1',
]);

function captureDefaultProtectedRouteState(): string {
  if (typeof localStorage === 'undefined') throw new Error('route_storage_unavailable');
  const stored = PROTECTED_ROUTE_STORAGE_KEYS.map((key) => {
    try {
      return [key, localStorage.getItem(key)] as const;
    } catch {
      throw new Error('route_storage_unavailable');
    }
  });
  return JSON.stringify({
    modelSelection: useAuthStore.getState().chatModelSelection,
    runtimeControls: stored,
  });
}

export async function runVibeSpaceDoctorWithDependencies(
  dependencies: VibeSpaceDoctorDependencies,
): Promise<VibeSpaceDoctorReport> {
  const startedAt = dependencies.now();
  let protectedRouteBefore: string | undefined;
  try {
    protectedRouteBefore = dependencies.captureProtectedRouteState();
  } catch {
    protectedRouteBefore = undefined;
  }
  let storage: { ok: boolean; text: string };
  try {
    storage = storageSummary(await withDoctorDeadline(dependencies.runStorage));
  } catch {
    storage = { ok: false, text: 'Check failed safely · storage_doctor_unavailable' };
  }

  let openCode: { ok: boolean; text: string };
  const runtimeChecks: VibeSpaceDoctorSubsystemCheck[] = [];
  if (!dependencies.nativeRuntime) {
    openCode = { ok: false, text: 'Native check unavailable in browser preview' };
    runtimeChecks.push({
      label: 'Codex tools',
      ok: false,
      detail: 'Native check unavailable in browser preview',
    });
    runtimeChecks.push({
      label: 'RLM / SiYuan',
      ok: false,
      detail: 'Native check unavailable in browser preview',
    });
    runtimeChecks.push({
      label: 'Playwright acceptance runtime',
      ok: false,
      detail: 'Native check unavailable in browser preview',
    });
  } else {
    let codexState: CodexRuntimeState | undefined;
    let codexRepairAttempted = false;
    try {
      codexState = await withDoctorDeadline(dependencies.inspectCodexRuntime);
    } catch {
      codexState = undefined;
    }
    if (
      codexState &&
      (codexState.kind === 'missing' ||
        codexState.kind === 'incomplete' ||
        (codexState.kind === 'failed' && codexState.recoverable))
    ) {
      codexRepairAttempted = true;
      try {
        codexState = await withDoctorDeadline(dependencies.repairCodexRuntime, 180_000);
      } catch {
        codexState = undefined;
      }
    }
    runtimeChecks.push(
      codexState
        ? summarizeCodexRuntime(codexState)
        : {
            label: 'Codex tools',
            ok: false,
            detail: codexRepairAttempted
              ? 'Repair failed safely · codex_runtime_repair_failed'
              : 'Inspection failed safely · codex_runtime_inspection_failed',
          },
    );
    try {
      await withDoctorDeadline(dependencies.refreshOpenCode);
      await withDoctorDeadline(
        dependencies.waitForOpenCodeSettled,
        OPENCODE_SETTLE_TIMEOUT_MS + 1_000,
      );
      let state = dependencies.getOpenCodeState();
      let connection = dependencies.getOpenCodeConnection();
      openCode = openCodeSummary(state, connection);
      if (
        !openCode.ok &&
        (['missing', 'download_required', 'incompatible'].includes(state.kind) ||
          (state.kind === 'failed' && state.recoverable))
      ) {
        await withDoctorDeadline(dependencies.repairOpenCode, 180_000);
        await withDoctorDeadline(
          dependencies.waitForOpenCodeSettled,
          OPENCODE_SETTLE_TIMEOUT_MS + 1_000,
        );
        state = dependencies.getOpenCodeState();
        connection = dependencies.getOpenCodeConnection();
        openCode = openCodeSummary(state, connection);
      }
      if (openCode.ok) {
        try {
          runtimeChecks.push(await withDoctorDeadline(dependencies.refreshOpenCodeProvider));
        } catch {
          runtimeChecks.push({
            label: 'OpenCode provider',
            ok: false,
            detail: 'Check failed safely · opencode_provider_unavailable',
          });
        }
      }
    } catch {
      openCode = { ok: false, text: 'Check failed safely · opencode_runtime_unavailable' };
    }
    try {
      runtimeChecks.push(...(await withDoctorDeadline(dependencies.refreshContextBindings)));
    } catch {
      runtimeChecks.push({
        label: 'RLM / SiYuan',
        ok: false,
        detail: 'Check failed safely · context_runtime_unavailable',
      });
    }
    try {
      runtimeChecks.push(await withDoctorDeadline(dependencies.checkPlaywrightFeaturePack));
    } catch {
      runtimeChecks.push({
        label: 'Playwright acceptance runtime',
        ok: false,
        detail: 'Check failed safely · playwright_feature_pack_unavailable',
      });
    }
  }

  let additionalChecks: readonly VibeSpaceDoctorSubsystemCheck[];
  try {
    additionalChecks = await withDoctorDeadline(dependencies.runAdditionalChecks);
  } catch {
    additionalChecks = [
      {
        label: 'App systems',
        ok: false,
        detail: 'Check failed safely · subsystem_checks_unavailable',
      },
    ];
  }

  let recentSignals: readonly VibeSpaceDoctorSubsystemCheck[];
  try {
    recentSignals = dependencies.readRecentHealthSignals();
  } catch {
    recentSignals = [
      {
        label: 'Recent runtime evidence',
        ok: false,
        detail: 'Check failed safely · doctor_log_evidence_unavailable',
      },
    ];
  }

  let routePreservation: VibeSpaceDoctorSubsystemCheck;
  try {
    const protectedRouteAfter = dependencies.captureProtectedRouteState();
    routePreservation =
      protectedRouteBefore === undefined
        ? {
            label: 'Route controls',
            ok: false,
            detail: 'Could not verify preservation · doctor_route_identity_unavailable',
          }
        : protectedRouteBefore === protectedRouteAfter
          ? { label: 'Route controls', ok: true, detail: 'Unchanged' }
          : {
              label: 'Route controls',
              ok: false,
              detail: 'Unexpected change detected · doctor_route_identity_changed',
            };
  } catch {
    routePreservation = {
      label: 'Route controls',
      ok: false,
      detail: 'Could not verify preservation · doctor_route_identity_unavailable',
    };
  }

  const allChecks = [...runtimeChecks, ...recentSignals, ...additionalChecks, routePreservation];
  const ok = storage.ok && openCode.ok && allChecks.every((check) => check.ok);
  const elapsedMs = Math.max(0, Math.round(dependencies.now() - startedAt));
  return {
    ok,
    text: [
      `VibeSpace Doctor — ${ok ? 'Checks completed' : 'Attention needed'}`,
      `${storage.ok ? '✓' : '•'} Local chat storage — ${storage.text}`,
      `${openCode.ok ? '✓' : '•'} OpenCode — ${openCode.text}`,
      ...allChecks.map((check) => `${check.ok ? '✓' : '•'} ${check.label} — ${check.detail}`),
      `Completed in ${elapsedMs} ms.`,
      'Checks describe verified capabilities only. Live execution, delivery, and backup restoration require separate tests.',
      ok
        ? 'No credentials, user content, or route controls were changed; only supported runtime refresh/rebind and non-destructive storage recovery ran.'
        : 'No destructive cleanup was attempted. Persistent storage repair still requires explicit confirmation; unknown errors are reported rather than guessed.',
    ].join('\n'),
  };
}

export function createVibeSpaceDoctorRunner(dependencies: VibeSpaceDoctorDependencies) {
  let active: Promise<VibeSpaceDoctorReport> | undefined;
  return (): Promise<VibeSpaceDoctorReport> => {
    active ??= runVibeSpaceDoctorWithDependencies(dependencies).finally(() => {
      active = undefined;
    });
    return active;
  };
}

export const runVibeSpaceDoctor = createVibeSpaceDoctorRunner({
  nativeRuntime: isTauri,
  runStorage: () => runStorageDoctor({ force: true }),
  refreshOpenCode: () => harnessRuntimeManager.refresh(),
  repairOpenCode: () => harnessRuntimeManager.repair(),
  getOpenCodeState: () => harnessRuntimeManager.getSnapshot(),
  getOpenCodeConnection: () => harnessRuntimeManager.getConnection(),
  waitForOpenCodeSettled: () => waitForOpenCodeSettled(harnessRuntimeManager),
  inspectCodexRuntime: async () => {
    await codexRuntimeManager.refresh();
    return codexRuntimeManager.getSnapshot();
  },
  repairCodexRuntime: async () => {
    await codexRuntimeManager.install();
    return codexRuntimeManager.getSnapshot();
  },
  refreshOpenCodeProvider: refreshDefaultOpenCodeProvider,
  refreshContextBindings: refreshDefaultContextBindings,
  checkPlaywrightFeaturePack: runDefaultPlaywrightFeaturePackDoctorCheck,
  readRecentHealthSignals: () =>
    collectRecentDoctorHealthSignals(useDevConsoleStore.getState().entries, Date.now()),
  captureProtectedRouteState: captureDefaultProtectedRouteState,
  runAdditionalChecks: runDefaultAdditionalChecks,
  now: () => performance.now(),
});
