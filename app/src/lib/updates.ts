import { isTauri } from '@/lib/utils';
import { flushWorkspacePersistence } from '@/lib/persistence/workspaceFlush';
import { resolveRuntimePlan } from '@/lib/runtimeProfile';

export const AUTO_UPDATE_KEY = 'jarvis-auto-update';
export const UPDATE_RELEASE_CHANNEL = 'stable';
export const UPDATE_RELEASES_URL = 'https://github.com/Cookie774-GameDev/VibeSpace/releases';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'none'
  | 'error';

export interface UpdateProgress {
  phase: UpdatePhase;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface UpdateResult {
  available: boolean;
  prepared?: boolean;
  installed: boolean;
  version?: string;
  notes?: string;
  notesUrl?: string;
  releaseChannel: typeof UPDATE_RELEASE_CHANNEL;
}

/** A pending update returned by the updater check seam. `handle` is opaque. */
interface PendingUpdate {
  readonly version: string;
  readonly notes?: string;
  readonly handle: unknown;
}

/** The updater download/install progress event shape used by the install seam. */
interface UpdateDownloadEvent {
  event: 'Started' | 'Progress' | 'Finished' | (string & {});
  data?: { contentLength?: number | null; chunkLength?: number };
}

/** Private adapters for the five frozen `updates.ts` side-effect rows. */
interface UpdateEffectSeams {
  /** Row 1: query the updater for an available update (network/update effect). */
  checkUpdate(): Promise<PendingUpdate | undefined>;
  /** Rows 2 & 4: flush workspace persistence before install/relaunch (persistence). */
  flushPersistence(reason: 'pre-update-install' | 'pre-update-relaunch'): Promise<unknown>;
  /** Download a pending update without installing it. */
  downloadUpdate(
    update: PendingUpdate,
    onEvent: (event: UpdateDownloadEvent) => void,
  ): Promise<void>;
  /** Install an update previously downloaded by `downloadUpdate`. */
  installPreparedUpdate(update: PendingUpdate): Promise<void>;
  /** Row 5: relaunch the application (process effect). */
  relaunch(): Promise<void>;
  /** Finish a natural close on platforms where install does not exit automatically. */
  exit(): Promise<void>;
}

const updateEffectAdapters: UpdateEffectSeams = {
  async checkUpdate() {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return undefined;
    return { version: update.version, notes: update.body, handle: update };
  },
  async flushPersistence(reason) {
    return flushWorkspacePersistence(reason);
  },
  async downloadUpdate(update, onEvent) {
    const handle = update.handle as {
      download(cb: (event: UpdateDownloadEvent) => void): Promise<void>;
    };
    await handle.download(onEvent);
  },
  async installPreparedUpdate(update) {
    const handle = update.handle as { install(): Promise<void> };
    await handle.install();
  },
  async relaunch() {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
  async exit() {
    const { exit } = await import('@tauri-apps/plugin-process');
    await exit(0);
  },
};

let preparedUpdate: PendingUpdate | undefined;

/**
 * Fail-closed guard for the frozen update side-effect rows. In the visual-test
 * runtime profile every persistence/process/network/update effect is denied
 * before its adapter runs; ordinary mode passes through unchanged.
 */
function assertUpdateEffectsAllowed(effect: string): void {
  const plan = resolveRuntimePlan();
  if (!plan.updateEffectsEnabled) {
    throw new Error(
      `Update effect "${effect}" denied by the visual-test runtime profile (updates disabled).`,
    );
  }
}

async function saveBeforeUpdate(
  reason: 'pre-update-install' | 'pre-update-relaunch',
): Promise<void> {
  assertUpdateEffectsAllowed(
    reason === 'pre-update-install' ? 'persistence-flush-install' : 'persistence-flush-relaunch',
  );
  const result = (await updateEffectAdapters.flushPersistence(reason)) as
    | {
        failed?: number;
        timedOut?: boolean;
        canvas?: { failed?: number; timedOut?: boolean };
      }
    | undefined;
  if (
    !result ||
    result.failed !== 0 ||
    result.timedOut !== false ||
    (result.canvas && (result.canvas.failed !== 0 || result.canvas.timedOut !== false))
  ) {
    throw new Error(
      reason === 'pre-update-install'
        ? 'The workspace could not be fully saved. The update was not installed; retry after saving your work.'
        : 'The update was installed, but the workspace could not be fully saved. Save your work before restarting.',
    );
  }
}

export function getAutoUpdateEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(AUTO_UPDATE_KEY) !== '0';
  } catch {
    return false;
  }
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AUTO_UPDATE_KEY, enabled ? '1' : '0');
}

const MAX_UPDATE_NOTES_LENGTH = 2_000;

export function normalizeUpdateNotes(notes: string | undefined, version: string): string {
  const normalized = (notes ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (!normalized) {
    return `Release notes for VibeSpace v${version} are available on the official release page.`;
  }
  if (normalized.length <= MAX_UPDATE_NOTES_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_UPDATE_NOTES_LENGTH).trimEnd()}…`;
}

function releaseUrl(version: string): string {
  return `${UPDATE_RELEASES_URL}/tag/v${version.replace(/^v/u, '')}`;
}

function reportDownloadProgress(
  onProgress: ((progress: UpdateProgress) => void) | undefined,
): (event: UpdateDownloadEvent) => void {
  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });
  return (event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0;
      totalBytes = event.data?.contentLength ?? undefined;
    } else if (event.event === 'Progress') {
      downloadedBytes += event.data?.chunkLength ?? 0;
    } else if (event.event === 'Finished') {
      onProgress?.({ phase: 'available', downloadedBytes, totalBytes });
      return;
    }
    onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });
  };
}

export async function prepareAppUpdate(options: {
  expectedVersion: string;
  onProgress?: (progress: UpdateProgress) => void;
}): Promise<UpdateResult> {
  if (!isTauri) throw new Error('Updates are only available in the installed desktop app.');
  assertUpdateEffectsAllowed('updater-check');

  if (preparedUpdate?.version === options.expectedVersion) {
    return {
      available: true,
      prepared: true,
      installed: false,
      version: preparedUpdate.version,
      notes: normalizeUpdateNotes(preparedUpdate.notes, preparedUpdate.version),
      notesUrl: releaseUrl(preparedUpdate.version),
      releaseChannel: UPDATE_RELEASE_CHANNEL,
    };
  }

  const update = await updateEffectAdapters.checkUpdate();
  if (!update) {
    options.onProgress?.({ phase: 'none' });
    return {
      available: false,
      prepared: false,
      installed: false,
      releaseChannel: UPDATE_RELEASE_CHANNEL,
    };
  }
  if (update.version !== options.expectedVersion) {
    throw new Error(
      'The available update changed while preparing it. Check again before installing.',
    );
  }

  assertUpdateEffectsAllowed('updater-download');
  await updateEffectAdapters.downloadUpdate(update, reportDownloadProgress(options.onProgress));
  preparedUpdate = update;
  return {
    available: true,
    prepared: true,
    installed: false,
    version: update.version,
    notes: normalizeUpdateNotes(update.notes, update.version),
    notesUrl: releaseUrl(update.version),
    releaseChannel: UPDATE_RELEASE_CHANNEL,
  };
}

export async function installPreparedAppUpdate(options: {
  relaunch: boolean;
  persistenceAlreadyRequested?: boolean;
}): Promise<UpdateResult> {
  const update = preparedUpdate;
  if (!update) throw new Error('No downloaded update is ready to install.');

  // A native flush request is not proof of completion. Await the shared barrier.
  await saveBeforeUpdate('pre-update-install');
  assertUpdateEffectsAllowed('install-prepared-update');
  await updateEffectAdapters.installPreparedUpdate(update);
  preparedUpdate = undefined;

  if (options.relaunch) {
    assertUpdateEffectsAllowed('relaunch');
    await updateEffectAdapters.relaunch();
  } else {
    assertUpdateEffectsAllowed('exit-after-update-install');
    await updateEffectAdapters.exit();
  }

  return {
    available: true,
    prepared: true,
    installed: true,
    version: update.version,
    notes: normalizeUpdateNotes(update.notes, update.version),
    notesUrl: releaseUrl(update.version),
    releaseChannel: UPDATE_RELEASE_CHANNEL,
  };
}

export async function checkForAppUpdate(
  options: {
    install?: boolean;
    onProgress?: (progress: UpdateProgress) => void;
  } = {},
): Promise<UpdateResult> {
  if (!isTauri) {
    throw new Error('Updates are only available in the installed desktop app.');
  }

  // Row 1: updater check (network/update effect).
  assertUpdateEffectsAllowed('updater-check');
  const update = await updateEffectAdapters.checkUpdate();

  if (!update) {
    options.onProgress?.({ phase: 'none' });
    return { available: false, installed: false, releaseChannel: UPDATE_RELEASE_CHANNEL };
  }

  const version = update.version;
  const notes = update.notes;

  if (!options.install) {
    options.onProgress?.({ phase: 'available' });
    return {
      available: true,
      installed: false,
      version,
      notes,
      notesUrl: releaseUrl(version),
      releaseChannel: UPDATE_RELEASE_CHANNEL,
    };
  }

  // Finish the download first: the user can make new edits while it runs.
  assertUpdateEffectsAllowed('updater-download');
  await updateEffectAdapters.downloadUpdate(update, reportDownloadProgress(options.onProgress));
  await saveBeforeUpdate('pre-update-install');
  assertUpdateEffectsAllowed('install-prepared-update');
  options.onProgress?.({ phase: 'installing' });
  await updateEffectAdapters.installPreparedUpdate(update);
  options.onProgress?.({ phase: 'installed' });

  // Row 4: persistence flush before relaunch.
  await saveBeforeUpdate('pre-update-relaunch');

  // Row 5: relaunch (process effect).
  assertUpdateEffectsAllowed('relaunch');
  try {
    await updateEffectAdapters.relaunch();
  } catch {
    console.warn('[updates] Relaunch failed after the signed update was installed.');
  }

  return {
    available: true,
    installed: true,
    version,
    notes,
    notesUrl: releaseUrl(version),
    releaseChannel: UPDATE_RELEASE_CHANNEL,
  };
}

function parseReleaseVersion(value: string): { core: number[]; prerelease: string[] } {
  const normalized = value.trim().replace(/^v/u, '');
  const [coreText = '', prereleaseText = ''] = normalized.split('-', 2);
  const core = coreText.split('.').map((part) => {
    if (!/^\d+$/u.test(part)) throw new Error(`Invalid release version: ${value}`);
    return Number(part);
  });
  if (core.length === 0 || core.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return { core, prerelease: prereleaseText ? prereleaseText.split('.') : [] };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}
