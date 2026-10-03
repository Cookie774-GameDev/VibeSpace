import {
  getNotificationPermission,
  notify,
  requestNotificationPermission,
  setTrayBadge,
  type NotificationPermissionState,
  type NotifyResult,
  type NotifyOptions,
} from '@/lib/tauri';
import { assistantPersonaDisplayName } from '@/lib/assistantPersona';
import { useAuthStore } from '@/stores/auth';
import {
  createDefaultDoneNotifications,
  normalizeDoneNotifications,
  useUIStore,
  type DoneNotificationKey,
} from '@/stores/ui';
import { playUiSound } from '@/lib/sfx';

/** Stable category order for Settings → Notifications. */
export const DONE_NOTIFICATION_KEYS: readonly DoneNotificationKey[] = [
  'jarvis',
  'terminal',
  'tasks',
  'contextMaps',
  'skills',
  'connectors',
  'reminders',
] as const;

export const DEFAULT_DONE_NOTIFICATIONS = createDefaultDoneNotifications();

export { normalizeDoneNotifications };

/** Static fallback labels (persona-agnostic keys use fixed copy). */
export const DONE_NOTIFICATION_LABELS: Record<DoneNotificationKey, string> = {
  jarvis: 'Assistant done',
  terminal: 'Terminal done',
  tasks: 'Task done',
  contextMaps: 'Context map done',
  skills: 'Skill done',
  connectors: 'Connector / auth expired',
  reminders: 'Task reminders',
};

export function getDoneNotificationLabels(persona?: unknown): Record<DoneNotificationKey, string> {
  const name = assistantPersonaDisplayName(persona);
  return {
    ...DONE_NOTIFICATION_LABELS,
    jarvis: `${name} done`,
  };
}

export const DONE_NOTIFICATION_DESCRIPTIONS: Record<DoneNotificationKey, string> = {
  jarvis: 'When an AI chat response finishes.',
  terminal: 'When a terminal command exits (success or failure).',
  tasks: 'When a task is marked done.',
  contextMaps: 'When a Context map finishes generating.',
  skills: 'When a skill is enabled or disabled.',
  connectors: 'When a provider CLI session or API connector loses authorization (sign-in expired).',
  reminders: 'When a scheduled task reminder is due.',
};

const DONE_NOTIFICATION_DEDUPE_MS = 4_000;
const COMPLETION_IDENTITY_DEDUPE_MS = 10 * 60_000;
const MAX_RECENT_DONE_NOTIFICATIONS = 64;
const MAX_COMPLETION_IDENTITY_LENGTH = 512;
const recentDoneNotifications = new Map<string, { observedAt: number; ttlMs: number }>();

export interface NotifyDoneOptions {
  /** Allow in-app toast when OS notifications are unavailable. */
  allowFallbackToast?: boolean;
  /** Bypass master + category gates (test notification only). */
  force?: boolean;
  /** Skip duplicate suppression (test notification only). */
  skipDedupe?: boolean;
  /** Stable non-secret identity shared by multiple presentations of one completion. */
  completionIdentity?: string;
  /** Situation-specific native notification artwork. */
  variant?: NotifyOptions['variant'];
}

export interface TestNotificationResult extends NotifyResult {
  /** True when something was shown (native, browser, or toast). */
  delivered: boolean;
}

/**
 * Plain-language system instruction: ask the model to signal completion
 * in the user-visible reply — not via hidden chain-of-thought.
 */
export function getAiCompletionInstruction(persona?: unknown): string {
  if (!useUIStore.getState().aiCompletionCue) return '';
  const resolved = persona !== undefined ? persona : useAuthStore.getState().personaPreset;
  const name = assistantPersonaDisplayName(resolved);
  return [
    `${name} completion signal (required when this cue is enabled):`,
    'When the user request is fully handled, end your reply with one short user-visible line:',
    'DONE: <one-sentence summary of what finished>',
    'If anything is incomplete, blocked, or needs the user, do not write DONE. End with:',
    'BLOCKED: <what remains or what you need>',
    'Put DONE/BLOCKED in the reply the user reads. Do not rely on hidden reasoning or tool logs alone.',
  ].join('\n');
}

function shouldSkipDuplicateDoneNotification(
  kind: DoneNotificationKey,
  title: string,
  body?: string,
  completionIdentity?: string,
  onReserved?: (key: string, entry: { observedAt: number; ttlMs: number }) => void,
): boolean {
  const stableCompletionIdentity =
    typeof completionIdentity === 'string' &&
    completionIdentity.length > 0 &&
    completionIdentity.length <= MAX_COMPLETION_IDENTITY_LENGTH &&
    completionIdentity === completionIdentity.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(completionIdentity)
      ? completionIdentity
      : undefined;
  const key = stableCompletionIdentity
    ? `completion\0${stableCompletionIdentity}`
    : `presentation\0${kind}\0${title}\0${body ?? ''}`;
  const ttlMs = stableCompletionIdentity
    ? COMPLETION_IDENTITY_DEDUPE_MS
    : DONE_NOTIFICATION_DEDUPE_MS;
  const now = Date.now();
  const last = recentDoneNotifications.get(key);
  if (last !== undefined && now - last.observedAt < last.ttlMs) {
    return true;
  }
  recentDoneNotifications.delete(key);
  const entry = { observedAt: now, ttlMs };
  recentDoneNotifications.set(key, entry);
  onReserved?.(key, entry);
  if (recentDoneNotifications.size > MAX_RECENT_DONE_NOTIFICATIONS) {
    for (const [entryKey, entry] of recentDoneNotifications) {
      if (now - entry.observedAt >= entry.ttlMs) {
        recentDoneNotifications.delete(entryKey);
      }
    }
  }
  while (recentDoneNotifications.size > MAX_RECENT_DONE_NOTIFICATIONS) {
    const oldest = recentDoneNotifications.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentDoneNotifications.delete(oldest);
  }
  return false;
}

/** @internal Test helper */
export function resetDoneNotificationDedupeForTests(): void {
  recentDoneNotifications.clear();
}

function notificationSilent(): boolean {
  return useUIStore.getState().notificationSound === false;
}

function maybeBumpBadge(): void {
  if (!useUIStore.getState().notificationBadge) return;
  void setTrayBadge(1);
}

/**
 * Category-gated done notification. Respects master switch + per-category toggles.
 * Presentation only — does not alter stored work state.
 */
export async function notifyDone(
  kind: DoneNotificationKey,
  title: string,
  body?: string,
  options: NotifyDoneOptions = {},
): Promise<NotifyResult | null> {
  const state = useUIStore.getState();
  if (!options.force) {
    if (!state.notificationMaster || !state.doneNotifications[kind]) return null;
  }
  const reservation: { current?: { key: string; entry: { observedAt: number; ttlMs: number } } } = {};
  if (
    !options.skipDedupe &&
    shouldSkipDuplicateDoneNotification(kind, title, body, options.completionIdentity, (key, entry) => {
      reservation.current = { key, entry };
    })
  ) {
    return null;
  }

  const labels = getDoneNotificationLabels();
  const resolvedTitle = title || labels[kind];

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('jarvis:done-notification', {
        detail: { kind, title: resolvedTitle, body },
      }),
    );
  }

  playUiSound('notification_complete');

  const result = await notify(resolvedTitle, body, {
    silent: notificationSilent(),
    variant:
      options.variant ??
      (kind === 'contextMaps'
        ? 'context_map_completed'
        : kind === 'tasks' || kind === 'terminal'
          ? 'task_completed'
          : undefined),
    fallbackToast:
      options.allowFallbackToast === true ||
      kind === 'contextMaps' ||
      kind === 'terminal' ||
      kind === 'tasks',
    onClick: () => {
      if (useUIStore.getState().notificationBadge) {
        void setTrayBadge(0);
      }
    },
  });

  // Non-granted permission never reaches a native/browser send. Release only
  // this attempt's reservation so a real recovery can retry immediately.
  // Granted-but-none and thrown calls may have been accepted: retain dedupe.
  if (result.channel === 'none' && result.permission !== 'granted' && reservation.current &&
      recentDoneNotifications.get(reservation.current.key) === reservation.current.entry) {
    recentDoneNotifications.delete(reservation.current.key);
  }
  if (result.channel === 'native' || result.channel === 'browser') {
    maybeBumpBadge();
  }

  return result;
}

/**
 * Always-runnable Settings → Send test path.
 * Requests permission, delivers a sample notification, returns clear feedback.
 * Does not require master/category toggles (uses force).
 */
export async function sendTestNotification(): Promise<TestNotificationResult> {
  const labels = getDoneNotificationLabels();
  const permissionBefore = await getNotificationPermission();
  // Always attempt a permission prompt when still undecided.
  const permission =
    permissionBefore === 'default' ? await requestNotificationPermission() : permissionBefore;

  const result = await notifyDone(
    'jarvis',
    labels.jarvis,
    'This is a test notification from Settings. Your notification settings are working.',
    { allowFallbackToast: true, force: true, skipDedupe: true },
  );

  if (!result) {
    return {
      channel: 'none',
      permission,
      delivered: false,
      message: 'Test notification was blocked by an internal gate.',
    };
  }

  return {
    ...result,
    permission: result.permission !== 'unavailable' ? result.permission : permission,
    delivered: result.channel !== 'none',
  };
}

export async function readNotificationPermission(): Promise<NotificationPermissionState> {
  return getNotificationPermission();
}

export async function ensureOsNotificationPermission(): Promise<NotificationPermissionState> {
  return requestNotificationPermission();
}

function notificationProviderLabel(value: string): string {
  const displayValue = value === 'openai-codex' ? 'Codex' : value;
  return (
    displayValue
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim()
      .slice(0, 36) || 'Provider'
  );
}

function notificationDetectedTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Use only after a provider confirms that its API credential has expired. */
export function notifyApiKeyExpired(
  providerLabel: string,
  detectedAt = new Date(),
): Promise<NotifyResult | null> {
  const provider = notificationProviderLabel(providerLabel);
  const settings =
    provider === 'Deepgram' ? 'Settings → Speech to Text' : 'Settings → AI Connectors';
  return notifyDone(
    'connectors',
    `${provider} API key expired`,
    `Detected ${notificationDetectedTime(detectedAt)}. Open ${settings} to replace the key.`,
    {
      variant: 'credential_expired',
      allowFallbackToast: true,
      completionIdentity: `credential:${provider}:expired`,
    },
  );
}

/** A 401 only proves authorization failed; the provider may not reveal whether a key expired. */
export function notifyApiKeyRejected(
  providerLabel: string,
  detectedAt = new Date(),
): Promise<NotifyResult | null> {
  const provider = notificationProviderLabel(providerLabel);
  const settings =
    provider === 'Deepgram' ? 'Settings → Speech to Text' : 'Settings → AI Connectors';
  return notifyDone(
    'connectors',
    `${provider} authorization failed`,
    `Detected ${notificationDetectedTime(detectedAt)}. Check or replace the API key in ${settings}.`,
    {
      variant: 'credential_expired',
      allowFallbackToast: true,
      completionIdentity: `credential:${provider}:rejected`,
    },
  );
}

/**
 * Fire when a connector/auth session transitions authenticated → unauthenticated.
 * Call only with real inspection results (not first paint).
 */
export function notifyConnectorAuthExpired(connectionLabel: string, detail?: string): void {
  const label = notificationProviderLabel(connectionLabel);
  const detectedAt = notificationDetectedTime(new Date());
  const explanation =
    detail
      ?.replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim()
      .slice(0, 78) || 'Open Settings → AI Connectors to reconnect.';
  void notifyDone(
    'connectors',
    `${label} authorization expired`,
    `Detected ${detectedAt}. ${explanation}`,
    { variant: 'credential_expired', allowFallbackToast: true },
  );
}

/**
 * Compare previous vs next connection metadata and notify on auth loss.
 */
export function detectAndNotifyConnectorAuthLoss(
  previous: Readonly<Partial<Record<string, { auth?: string; disabled?: boolean } | undefined>>>,
  next: Readonly<Partial<Record<string, { auth?: string; disabled?: boolean } | undefined>>>,
  labels?: Readonly<Partial<Record<string, string>>>,
): string[] {
  const fired: string[] = [];
  for (const [id, nextRecord] of Object.entries(next)) {
    if (!nextRecord || nextRecord.disabled) continue;
    const prev = previous[id];
    if (!prev) continue;
    if (prev.auth === 'authenticated' && nextRecord.auth === 'unauthenticated') {
      const label = labels?.[id] ?? id;
      notifyConnectorAuthExpired(label);
      fired.push(id);
    }
  }
  return fired;
}
