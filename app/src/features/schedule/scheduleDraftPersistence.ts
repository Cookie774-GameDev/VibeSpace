import type { CaoSupervisionScheduleMetadataV1, JarvisScheduleRecurrence } from './jarvisSchedules';

const SCHEDULE_DRAFT_PREFIX = 'vibespace-schedule-draft-v1:';
const DATE_TIME_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_QUICK_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_MODEL_OPTION_LENGTH = 1_000;
const CAO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ScheduleDraftEditingToken {
  readonly eventId: string;
  readonly updatedAt: number;
  readonly caoSupervision: CaoSupervisionScheduleMetadataV1;
}

export interface ScheduleDraft {
  readonly schemaVersion: 1;
  readonly quick: string;
  readonly title: string;
  readonly startInput: string;
  readonly endInput: string;
  readonly allDay: boolean;
  /** Existing short recurrence value or an RFC5545-compatible RRULE. */
  readonly eventRecurrenceRule?: string;
  readonly description: string;
  readonly reminderOffsets: readonly number[];
  readonly scheduleMode: 'event' | 'jarvis';
  readonly jarvisRecurrence: JarvisScheduleRecurrence;
  readonly intervalAmount: number;
  readonly intervalUnit: 'minutes' | 'hours' | 'days';
  readonly timingMode?: 'date' | 'delay';
  readonly delayMinutes?: number;
  readonly targetChatId?: string;
  readonly jarvisModelOptionId: string;
  readonly editing?: ScheduleDraftEditingToken;
}

const RECURRENCES: readonly JarvisScheduleRecurrence[] = [
  'once',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'custom_interval',
];

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isCaoSupervisionMetadata(value: unknown): value is CaoSupervisionScheduleMetadataV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CaoSupervisionScheduleMetadataV1>;
  return (
    Object.keys(value).every((key) =>
      ['schemaVersion', 'mode', 'scheduleId', 'policyId', 'targetId', 'projectId'].includes(key),
    ) &&
    candidate.schemaVersion === 1 &&
    candidate.mode === 'cao_supervision' &&
    CAO_ID_PATTERN.test(String(candidate.scheduleId ?? '')) &&
    CAO_ID_PATTERN.test(String(candidate.policyId ?? '')) &&
    CAO_ID_PATTERN.test(String(candidate.targetId ?? '')) &&
    CAO_ID_PATTERN.test(String(candidate.projectId ?? ''))
  );
}

function isEditingToken(value: unknown): value is ScheduleDraftEditingToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ScheduleDraftEditingToken>;
  return (
    Object.keys(value).every((key) => ['eventId', 'updatedAt', 'caoSupervision'].includes(key)) &&
    CAO_ID_PATTERN.test(String(candidate.eventId ?? '')) &&
    Number.isSafeInteger(candidate.updatedAt) &&
    Number(candidate.updatedAt) >= 0 &&
    isCaoSupervisionMetadata(candidate.caoSupervision)
  );
}

function isScheduleDraft(value: unknown): value is ScheduleDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ScheduleDraft>;
  return (
    candidate.schemaVersion === 1 &&
    boundedString(candidate.quick, MAX_QUICK_LENGTH) &&
    boundedString(candidate.title, MAX_TITLE_LENGTH) &&
    boundedString(candidate.description, MAX_DESCRIPTION_LENGTH) &&
    boundedString(candidate.jarvisModelOptionId, MAX_MODEL_OPTION_LENGTH) &&
    typeof candidate.startInput === 'string' &&
    DATE_TIME_INPUT_PATTERN.test(candidate.startInput) &&
    typeof candidate.endInput === 'string' &&
    DATE_TIME_INPUT_PATTERN.test(candidate.endInput) &&
    typeof candidate.allDay === 'boolean' &&
    (candidate.eventRecurrenceRule === undefined ||
      boundedString(candidate.eventRecurrenceRule, 1_000)) &&
    Array.isArray(candidate.reminderOffsets) &&
    candidate.reminderOffsets.length <= 16 &&
    candidate.reminderOffsets.every(
      (offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= 10_080,
    ) &&
    (candidate.scheduleMode === 'event' || candidate.scheduleMode === 'jarvis') &&
    (candidate.timingMode === undefined ||
      candidate.timingMode === 'date' ||
      candidate.timingMode === 'delay') &&
    (candidate.delayMinutes === undefined ||
      (Number.isSafeInteger(candidate.delayMinutes) &&
        candidate.delayMinutes >= 1 &&
        candidate.delayMinutes <= 43_200)) &&
    (candidate.targetChatId === undefined ||
      (boundedString(candidate.targetChatId, 128) && candidate.targetChatId.trim().length > 0)) &&
    RECURRENCES.includes(candidate.jarvisRecurrence as JarvisScheduleRecurrence) &&
    Number.isSafeInteger(candidate.intervalAmount) &&
    Number(candidate.intervalAmount) >= 1 &&
    Number(candidate.intervalAmount) <= 999 &&
    (candidate.intervalUnit === 'minutes' ||
      candidate.intervalUnit === 'hours' ||
      candidate.intervalUnit === 'days') &&
    (candidate.editing === undefined || isEditingToken(candidate.editing))
  );
}

function editingTokensEqual(
  left: ScheduleDraftEditingToken | undefined,
  right: ScheduleDraftEditingToken | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.eventId === right.eventId &&
    left.updatedAt === right.updatedAt &&
    left.caoSupervision.schemaVersion === right.caoSupervision.schemaVersion &&
    left.caoSupervision.mode === right.caoSupervision.mode &&
    left.caoSupervision.scheduleId === right.caoSupervision.scheduleId &&
    left.caoSupervision.policyId === right.caoSupervision.policyId &&
    left.caoSupervision.targetId === right.caoSupervision.targetId &&
    left.caoSupervision.projectId === right.caoSupervision.projectId
  );
}

export function scheduleDraftStorageKey(workspaceId: string): string {
  return `${SCHEDULE_DRAFT_PREFIX}${encodeURIComponent(workspaceId.trim())}`;
}

export function readScheduleDraft(workspaceId: string): ScheduleDraft | null {
  if (typeof window === 'undefined' || !workspaceId.trim()) return null;
  try {
    const raw = window.localStorage.getItem(scheduleDraftStorageKey(workspaceId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isScheduleDraft(parsed) ? Object.freeze({ ...parsed }) : null;
  } catch {
    return null;
  }
}

export function writeScheduleDraft(workspaceId: string, draft: ScheduleDraft): boolean {
  if (typeof window === 'undefined' || !workspaceId.trim() || !isScheduleDraft(draft)) return false;
  try {
    window.localStorage.setItem(scheduleDraftStorageKey(workspaceId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearScheduleDraft(workspaceId: string): void {
  if (typeof window === 'undefined' || !workspaceId.trim()) return;
  try {
    window.localStorage.removeItem(scheduleDraftStorageKey(workspaceId));
  } catch {
    // Schedule remains usable when persistence is unavailable or at quota.
  }
}

export function scheduleDraftsEqual(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return (
    left.quick === right.quick &&
    left.title === right.title &&
    left.startInput === right.startInput &&
    left.endInput === right.endInput &&
    left.allDay === right.allDay &&
    left.eventRecurrenceRule === right.eventRecurrenceRule &&
    left.description === right.description &&
    left.scheduleMode === right.scheduleMode &&
    left.jarvisRecurrence === right.jarvisRecurrence &&
    left.intervalAmount === right.intervalAmount &&
    left.intervalUnit === right.intervalUnit &&
    (left.timingMode ?? 'date') === (right.timingMode ?? 'date') &&
    (left.delayMinutes ?? 5) === (right.delayMinutes ?? 5) &&
    left.targetChatId === right.targetChatId &&
    left.jarvisModelOptionId === right.jarvisModelOptionId &&
    editingTokensEqual(left.editing, right.editing) &&
    left.reminderOffsets.length === right.reminderOffsets.length &&
    left.reminderOffsets.every((offset, index) => offset === right.reminderOffsets[index])
  );
}
