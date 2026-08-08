import {
  getNotificationPermission,
  notify,
  requestNotificationPermission,
  setTrayBadge,
  type NotificationPermissionState,
  type NotifyResult,
} from '@/lib/tauri';
import { assistantPersonaDisplayName } from '@/lib/assistantPersona';
import { useAuthStore } from '@/stores/auth';
import {
  createDefaultDoneNotifications,
  normalizeDoneNotifications,
  useUIStore,
  type DoneNotificationKey,
} from '@/stores/ui';

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

export function getDoneNotificationLabels(
  persona?: unknown,
): Record<DoneNotificationKey, string> {
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
  connectors:
    'When a provider CLI session or API connector loses authorization (sign-in expired).',
  reminders: 'When a scheduled task reminder is due.',
};

const DONE_NOTIFICATION_DEDUPE_MS = 4_000;
const recentDoneNotifications = new Map<string, number>();

export interface NotifyDoneOptions {
  /** Allow in-app toast when OS notifications are unavailable (explicit test only). */
  allowFallbackToast?: boolean;
  /** Bypass master + category gates (test notification only). */
  force?: boolean;
  /** Skip duplicate suppression (test notification only). */
  skipDedupe?: boolean;
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
  const resolved =
    persona !== undefined ? persona : useAuthStore.getState().personaPreset;
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
): boolean {
  const key = `${kind}\0${title}\0${body ?? ''}`;
  const now = Date.now();
  const last = recentDoneNotifications.get(key);
  if (last !== undefined && now - last < DONE_NOTIFICATION_DEDUPE_MS) {
    return true;
  }
  recentDoneNotifications.set(key, now);
  if (recentDoneNotifications.size > 64) {
    for (const [entryKey, ts] of recentDoneNotifications) {
      if (now - ts > DONE_NOTIFICATION_DEDUPE_MS) {
        recentDoneNotifications.delete(entryKey);
      }
    }
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
  if (!options.skipDedupe && shouldSkipDuplicateDoneNotification(kind, title, body)) {
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

  const result = await notify(resolvedTitle, body, {
    silent: notificationSilent(),
    fallbackToast: options.allowFallbackToast === true,
    onClick: () => {
      if (useUIStore.getState().notificationBadge) {
        void setTrayBadge(0);
      }
    },
  });

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
    permissionBefore === 'default'
      ? await requestNotificationPermission()
      : permissionBefore;

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

/**
 * Fire when a connector/auth session transitions authenticated → unauthenticated.
 * Call only with real inspection results (not first paint).
 */
export function notifyConnectorAuthExpired(
  connectionLabel: string,
  detail?: string,
): void {
  void notifyDone(
    'connectors',
    'Connector sign-in expired',
    detail ??
      `${connectionLabel} needs you to sign in again. Open Settings → AI Connectors to reconnect.`,
  );
}

/**
 * Compare previous vs next connection metadata and notify on auth loss.
 */
export function detectAndNotifyConnectorAuthLoss(
  previous: Readonly<
    Partial<Record<string, { auth?: string; disabled?: boolean } | undefined>>
  >,
  next: Readonly<
    Partial<Record<string, { auth?: string; disabled?: boolean } | undefined>>
  >,
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
