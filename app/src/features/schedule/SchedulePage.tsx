import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  Bell,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  Repeat,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { eventRepo } from '@/lib/db';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { flushUiStatePersistence, useUIStore } from '@/stores/ui';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import './sakura-schedule.css';
import { useAgentStore } from '@/stores/agents';
import { findProtectedJarvisAgent } from '@/lib/jarvis/identity';
import { selectionFromOption, selectionOptionId } from '@/lib/ai/modelSelection';
import { askAssistantLabel, useAssistantPersonaName } from '@/lib/assistantPersona';

const LEGACY_SCHEDULE_TIMELINE_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 240,
  damping: 28,
} as const);
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';
import { getProviderDisplayName } from '@/lib/ai/providerRegistry';
import { cn } from '@/lib/utils';
import { completeTask, useUpcomingTasks } from '@/features/tasks';
import type { EventReminder, EventRow } from '@/types/event';
import type { Task } from '@/types/task';
import type { WorkspaceId } from '@/types/common';
import { parseEventInput } from './parseEventInput';
import { useJarvisScheduleEvents, useUpcomingEvents } from './hooks';
import type { RecurrenceInstance } from './recurrence';
import {
  defaultEventEndMs,
  defaultEventStartMs,
  formatLocalDateTime,
  formatLocalDayHeading,
  formatLocalEventRange,
  fromLocalDateTimeInput,
  localDayKey,
  toLocalDateTimeInput,
} from './localDateTime';
import { visualForEventTitle, visualForTask } from './scheduleIcons';
import {
  buildJarvisScheduleEventInput,
  formatJarvisIntervalLabel,
  intervalMsFromParts,
  isJarvisScheduleEvent,
  parseJarvisScheduleMetadata,
  type JarvisScheduleRecurrence,
} from './jarvisSchedules';
import { ChatThread } from '@/features/chat/ChatThread';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL } from '@/lib/jarvis/smoke/evidenceIds';
import { KERNEL_SMOKE_SCENARIOS } from '@/lib/jarvis/smoke/scenarios';
import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import {
  isKernelSmokeBindingActive,
  KERNEL_SMOKE_PROVIDER_ID,
  subscribeKernelSmokeBinding,
} from '@/lib/ai/providers/kernelSmoke';
import { runDueJarvisSchedules } from './jarvisScheduleRunner';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

function formatScheduleSuccess(summary: string): string {
  return formatJarvisVerifiedNarration({ kind: 'success', summary }).text;
}

const REMINDER_PRESETS: { label: string; offset_min: number }[] = [
  { label: 'At time', offset_min: 0 },
  { label: '5 min before', offset_min: 5 },
  { label: '15 min before', offset_min: 15 },
  { label: '1 hour before', offset_min: 60 },
];

const JARVIS_RECURRENCE_PRESETS: { value: JarvisScheduleRecurrence; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom_interval', label: 'Every…' },
];

function jarvisRecurrenceLabel(recurrence: JarvisScheduleRecurrence, intervalMs?: number): string {
  if (recurrence === 'custom_interval') {
    return formatJarvisIntervalLabel(intervalMs);
  }
  return JARVIS_RECURRENCE_PRESETS.find((preset) => preset.value === recurrence)?.label ?? 'Once';
}

const SECTION_TITLE_CLASS = 'text-sm font-semibold tracking-tight text-foreground';
const FIELD_HINT_CLASS = 'mt-1 text-metadata text-muted-foreground';
const PLACEHOLDER_INPUT_CLASS =
  'placeholder:italic placeholder:text-muted-foreground/45 placeholder:font-normal';

type TimelineItem =
  | { kind: 'event'; id: string; at: number; end: number; instance: RecurrenceInstance }
  | { kind: 'task'; id: string; at: number; task: Task; timeKind: 'Scheduled' | 'Due' };

function buildTimeline(events: RecurrenceInstance[], tasks: Task[]): TimelineItem[] {
  const eventItems = events.map((instance) => ({
    kind: 'event' as const,
    id: `${instance.event.id}-${instance.instanceStartMs}`,
    at: instance.instanceStartMs,
    end: instance.instanceEndMs,
    instance,
  }));
  const taskItems = tasks
    .map((task) => {
      const at = task.scheduled_for ?? task.due_at;
      if (at === undefined) return null;
      return {
        kind: 'task' as const,
        id: task.id,
        at,
        task,
        timeKind: task.scheduled_for !== undefined ? ('Scheduled' as const) : ('Due' as const),
      };
    })
    .filter(Boolean) as TimelineItem[];
  return [...eventItems, ...taskItems].sort((a, b) => a.at - b.at);
}

function groupTimelineByDay(items: TimelineItem[]) {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = localDayKey(item.at);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([dayKey, dayItems]) => ({
    dayKey,
    heading: formatLocalDayHeading(dayItems[0]!.at),
    subheading: new Date(dayItems[0]!.at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    items: dayItems,
  }));
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function MiniCalendar({
  todayKey,
  selectedDayKey,
  eventCountByDay,
  onSelectDay,
}: {
  todayKey: string;
  selectedDayKey: string | null;
  eventCountByDay: Map<string, number>;
  onSelectDay: (dayMs: number) => void;
}) {
  const now = React.useMemo(() => new Date(), []);
  const [view, setView] = React.useState(() => ({
    year: now.getFullYear(),
    month: now.getMonth(),
  }));

  const cells = React.useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const leading = first.getDay();
    const out: { ms: number; day: number; inMonth: boolean }[] = [];
    // 6 rows × 7 = stable height; start from the Sunday before the 1st.
    const start = new Date(view.year, view.month, 1 - leading);
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({ ms: d.getTime(), day: d.getDate(), inMonth: d.getMonth() === view.month });
    }
    return out;
  }, [view]);

  const shiftMonth = (delta: number) =>
    setView((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div
      data-monochrome-surface="schedule-calendar"
      data-sakura-surface="schedule-calendar"
      className="w-72 p-3 [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&_*]:shadow-none"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <span className="font-display text-ui-strong text-foreground">
            {MONTH_LABELS[view.month]} {view.year}
          </span>
          <button
            type="button"
            onClick={() => setView({ year: now.getFullYear(), month: now.getMonth() })}
            className="rounded-md border border-border px-1.5 py-0.5 text-metadata text-muted-foreground transition-colors hover:border-accent-copper/40 hover:text-accent-copper"
          >
            Today
          </button>
        </div>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={`${w}-${i}`} className="text-center text-metadata text-muted-foreground">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const key = localDayKey(cell.ms);
          const count = eventCountByDay.get(key) ?? 0;
          const isToday = key === todayKey;
          const isSelected = key === selectedDayKey;
          return (
            <button
              key={cell.ms}
              type="button"
              onClick={() => onSelectDay(cell.ms)}
              title={count > 0 ? `${count} item${count === 1 ? '' : 's'}` : 'No events'}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center rounded-md text-secondary transition-colors',
                cell.inMonth ? 'text-foreground' : 'text-muted-foreground/40',
                isSelected
                  ? 'bg-accent-copper text-white'
                  : isToday
                    ? 'border border-accent-copper/50 bg-accent-copper/10 text-accent-copper'
                    : 'hover:bg-panel',
              )}
            >
              <span className="tabular-nums">{cell.day}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'absolute bottom-1 h-1 w-1 rounded-full',
                    isSelected ? 'bg-white' : 'bg-accent-copper',
                  )}
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SchedulePage() {
  const reducedMotion = useReducedMotion();
  const personaName = useAssistantPersonaName();
  const askLabel = askAssistantLabel(personaName);
  const timelineTransition = useThemeMotionTransition(LEGACY_SCHEDULE_TIMELINE_TRANSITION);
  const kernelSmokeBindingActive = React.useSyncExternalStore(
    subscribeKernelSmokeBinding,
    isKernelSmokeBindingActive,
    () => false,
  );
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const localUserId = useAuthStore((s) => s.localUserId);
  const chatModelSelection = useAuthStore((s) => s.chatModelSelection);
  const protectedJarvisAgent = useAgentStore((state) =>
    findProtectedJarvisAgent(Object.values(state.agents)),
  );
  const { groups: jarvisModelGroups, flatOptions: jarvisModelOptionsAll } =
    useAccessibleChatModels();
  /** Only models the user can actually run — never show unauthorized tiers. */
  const jarvisModelOptions = React.useMemo(
    () => jarvisModelOptionsAll.filter((option) => option.available !== false),
    [jarvisModelOptionsAll],
  );
  const jarvisModelGroupsAvailable = React.useMemo(
    () =>
      jarvisModelGroups
        .map((group) => ({
          ...group,
          options: group.options.filter((option) => option.available !== false),
        }))
        .filter((group) => group.options.length > 0),
    [jarvisModelGroups],
  );
  const events = useUpcomingEvents(workspaceId, 14 * DAY_MS, 100);
  const tasks = useUpcomingTasks();
  const timeline = React.useMemo(() => buildTimeline(events, tasks), [events, tasks]);
  const dayGroups = React.useMemo(() => groupTimelineByDay(timeline), [timeline]);
  const todayKey = React.useMemo(() => localDayKey(Date.now()), []);
  const eventCountByDay = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const item of timeline) {
      const key = localDayKey(item.at);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [timeline]);

  const [quick, setQuick] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [startInput, setStartInput] = React.useState(() =>
    toLocalDateTimeInput(defaultEventStartMs()),
  );
  const [endInput, setEndInput] = React.useState(() =>
    toLocalDateTimeInput(defaultEventEndMs(defaultEventStartMs())),
  );
  const [allDay, setAllDay] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [reminderOffsets, setReminderOffsets] = React.useState<number[]>([15]);
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [selectedDayKey, setSelectedDayKey] = React.useState<string | null>(null);
  const [scheduleMode, setScheduleMode] = React.useState<'event' | 'jarvis'>('event');
  const [jarvisRecurrence, setJarvisRecurrence] = React.useState<JarvisScheduleRecurrence>('once');
  const [intervalAmount, setIntervalAmount] = React.useState(2);
  const [intervalUnit, setIntervalUnit] = React.useState<'minutes' | 'hours' | 'days'>('hours');
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [timelineView, setTimelineView] = React.useState<'timeline' | 'jarvis'>('timeline');
  const [openJarvisEventId, setOpenJarvisEventId] = React.useState<string | null>(null);
  const [kernelSmokeDispatching, setKernelSmokeDispatching] = React.useState(false);
  const [kernelSmokeScheduleState, setKernelSmokeScheduleState] = React.useState<
    | 'idle'
    | 'creating'
    | 'dispatching'
    | 'dispatch-claim'
    | 'dispatch-output'
    | 'dispatch-kernel'
    | 'dispatch-settle'
    | 'dispatch-failed'
    | 'opening'
    | 'completed'
    | 'error-create'
    | 'error-dispatch'
    | 'error-open'
    | 'unavailable-binding'
    | 'unavailable-identity'
    | 'unavailable-workspace'
    | 'unavailable-agent'
    | 'unavailable-model'
  >('idle');
  const kernelSmokeUnavailableState = !kernelSmokeBindingActive
    ? 'unavailable-binding'
    : !getActiveAccountIdentity()
      ? 'unavailable-identity'
      : !workspaceId
        ? 'unavailable-workspace'
        : !protectedJarvisAgent
          ? 'unavailable-agent'
          : chatModelSelection.mode !== 'single' ||
              chatModelSelection.providerId !== KERNEL_SMOKE_PROVIDER_ID ||
              chatModelSelection.modelId !== 'kernel-smoke-v1' ||
              chatModelSelection.connectionId !== 'vibespace-kernel-smoke-native'
            ? 'unavailable-model'
            : null;
  const kernelSmokeVisibleScheduleState =
    kernelSmokeScheduleState === 'idle' && kernelSmokeUnavailableState
      ? kernelSmokeUnavailableState
      : kernelSmokeScheduleState;
  const jarvisEvents = useJarvisScheduleEvents(workspaceId);
  const openJarvisEvent = React.useMemo(
    () => jarvisEvents.find((event) => String(event.id) === openJarvisEventId) ?? null,
    [jarvisEvents, openJarvisEventId],
  );
  const [jarvisModelOptionId, setJarvisModelOptionId] = React.useState(
    () => selectionOptionId(chatModelSelection) ?? '',
  );
  const selectedJarvisModel = React.useMemo(() => {
    const exact = jarvisModelOptions.find((option) => option.id === jarvisModelOptionId);
    if (exact) return exact;

    // Accept provider-qualified values persisted by older builds, then resolve
    // them to the concrete connection so scheduled actions retain exact routing.
    const separator = jarvisModelOptionId.indexOf(':');
    if (separator < 1) return null;
    const provider = jarvisModelOptionId.slice(0, separator);
    const modelId = jarvisModelOptionId.slice(separator + 1);
    return (
      jarvisModelOptions.find(
        (option) =>
          option.provider === provider && option.modelId === modelId && option.available !== false,
      ) ?? null
    );
  }, [jarvisModelOptions, jarvisModelOptionId]);

  React.useEffect(() => {
    if (scheduleMode === 'jarvis') setAllDay(false);
  }, [scheduleMode]);

  React.useEffect(() => {
    const activeId = selectionOptionId(chatModelSelection);
    setJarvisModelOptionId((current) => {
      if (current && jarvisModelOptions.some((option) => option.id === current)) return current;
      if (activeId && jarvisModelOptions.some((option) => option.id === activeId)) return activeId;
      if (chatModelSelection.mode === 'single') {
        const compatible = jarvisModelOptions.find(
          (option) =>
            option.provider === chatModelSelection.providerId &&
            option.modelId === chatModelSelection.modelId &&
            option.available !== false,
        );
        if (compatible) return compatible.id;
      }
      return (
        jarvisModelOptions.find((option) => option.available !== false)?.id ??
        jarvisModelOptions[0]?.id ??
        ''
      );
    });
  }, [chatModelSelection, jarvisModelOptions]);

  // Pick a day from the mini-calendar: pre-fill the new-event form for 9–10am
  // that day and jump the timeline to it if anything is already scheduled.
  const handleSelectDay = React.useCallback(
    (dayMs: number) => {
      const start = new Date(dayMs);
      start.setHours(9, 0, 0, 0);
      const startMs = start.getTime();
      setStartInput(toLocalDateTimeInput(startMs));
      setEndInput(toLocalDateTimeInput(defaultEventEndMs(startMs)));
      const key = localDayKey(startMs);
      setSelectedDayKey(key);
      setCalendarOpen(false);
      requestAnimationFrame(() => {
        document
          .getElementById(`schedule-day-${key}`)
          ?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      });
    },
    [reducedMotion],
  );

  const applyParse = React.useCallback((raw: string) => {
    if (!raw.trim()) return;
    const parsed = parseEventInput(raw);
    setTitle(parsed.title);
    setStartInput(toLocalDateTimeInput(parsed.start_at));
    setEndInput(toLocalDateTimeInput(parsed.end_at));
    setAllDay(parsed.all_day);
  }, []);

  const handleQuickChange = (v: string) => {
    setQuick(v);
    if (v.trim().length > 2) applyParse(v);
  };

  const handleSave = async () => {
    if (!workspaceId) {
      toast.error('No workspace', 'Finish onboarding first.');
      return;
    }
    if (!title.trim()) {
      toast.warning('Add a title', 'Events need a name.');
      return;
    }
    if (scheduleMode === 'jarvis' && !selectedJarvisModel) {
      toast.warning(
        'Connect a model',
        `Connect a provider or download a local model before saving a ${personaName} Action.`,
      );
      return;
    }
    const customIntervalMs =
      scheduleMode === 'jarvis' && jarvisRecurrence === 'custom_interval'
        ? intervalMsFromParts(intervalAmount, intervalUnit)
        : undefined;
    if (scheduleMode === 'jarvis' && jarvisRecurrence === 'custom_interval' && !customIntervalMs) {
      toast.warning(
        'Check the interval',
        'Use at least 5 minutes and at most 30 days for “Every…”.',
      );
      return;
    }

    const start = fromLocalDateTimeInput(startInput);
    if (!Number.isFinite(start)) {
      toast.warning('Check the start time', 'That date/time could not be read.');
      return;
    }
    const rawEnd = fromLocalDateTimeInput(endInput);
    const jarvisAction = scheduleMode === 'jarvis';
    const end =
      !jarvisAction && allDay ? start + DAY_MS - 1 : Math.max(rawEnd, start + 5 * 60 * 1000);
    const reminders: EventReminder[] = jarvisAction
      ? []
      : reminderOffsets.map((offset_min) => ({
          offset_min,
          channels: ['desktop', 'in_app'],
        }));

    if (jarvisAction) {
      // Duplicate guard: repeated saves (or repeated natural-language parses)
      // of the same action at the same time must not stack duplicate runs.
      const normalizedTitle = title.trim().toLowerCase();
      const duplicate = jarvisEvents.some(
        (event) =>
          event.status === 'scheduled' &&
          event.start_at === start &&
          event.title
            .replace(/^Jarvis Scheduled\s+—\s+/, '')
            .trim()
            .toLowerCase() === normalizedTitle,
      );
      if (duplicate) {
        toast.warning(
          'Already scheduled',
          'A Jarvis Action with this title and start time already exists.',
        );
        return;
      }
    }

    try {
      const protectedJarvis = findProtectedJarvisAgent(
        Object.values(useAgentStore.getState().agents),
      );
      const protectedJarvisId = protectedJarvis?.id ?? 'agent_jarvis';
      await eventRepo.create(
        jarvisAction
          ? buildJarvisScheduleEventInput({
              workspaceId,
              createdBy: protectedJarvisId,
              title: title.trim(),
              prompt: description.trim() || title.trim(),
              startAt: start,
              durationMs: end - start,
              recurrence: jarvisRecurrence,
              ...(customIntervalMs !== undefined ? { intervalMs: customIntervalMs } : {}),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              modelSelection: selectedJarvisModel
                ? selectionFromOption(
                    selectedJarvisModel.provider,
                    selectedJarvisModel.modelId,
                    selectedJarvisModel.connection,
                  )
                : chatModelSelection,
              agentId: protectedJarvisId,
            })
          : {
              workspace_id: workspaceId,
              title: title.trim(),
              description: description.trim() || undefined,
              start_at: start,
              end_at: end,
              all_day: allDay,
              reminders,
              source: 'manual',
              created_by: localUserId ?? 'usr_local',
            },
      );
      toast.success(
        jarvisAction ? `${personaName} Action saved` : 'Event saved',
        formatScheduleSuccess(
          jarvisAction
            ? `“${title.trim()}” will run ${
                jarvisRecurrence === 'once'
                  ? 'once'
                  : jarvisRecurrenceLabel(jarvisRecurrence, customIntervalMs).toLowerCase()
              } while VibeSpace is open.`
            : `“${title.trim()}” is on your schedule.`,
        ),
      );
      setQuick('');
      setTitle('');
      setDescription('');
      const nextStart = defaultEventStartMs();
      setStartInput(toLocalDateTimeInput(nextStart));
      setEndInput(toLocalDateTimeInput(defaultEventEndMs(nextStart)));
      setAllDay(false);
      setJarvisRecurrence('once');
      setIntervalAmount(2);
      setIntervalUnit('hours');
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const dispatchKernelSmokeSchedule = async (kind: 'success' | 'retry') => {
    if (!KERNEL_SMOKE_ENABLED || kernelSmokeDispatching) return;
    const auth = useAuthStore.getState();
    const identity = getActiveAccountIdentity();
    const selection = auth.chatModelSelection;
    const protectedJarvis = protectedJarvisAgent;
    const rejectUnavailable = (
      state:
        | 'unavailable-binding'
        | 'unavailable-identity'
        | 'unavailable-workspace'
        | 'unavailable-agent'
        | 'unavailable-model',
    ) => {
      setKernelSmokeScheduleState(state);
      toast.error('Smoke fixture unavailable', 'The native smoke binding is not ready.');
    };
    if (!kernelSmokeBindingActive) {
      rejectUnavailable('unavailable-binding');
      return;
    }
    if (!identity) {
      rejectUnavailable('unavailable-identity');
      return;
    }
    if (!workspaceId) {
      rejectUnavailable('unavailable-workspace');
      return;
    }
    if (!protectedJarvis) {
      rejectUnavailable('unavailable-agent');
      return;
    }
    if (
      selection.mode !== 'single' ||
      selection.providerId !== KERNEL_SMOKE_PROVIDER_ID ||
      selection.modelId !== 'kernel-smoke-v1' ||
      selection.connectionId !== 'vibespace-kernel-smoke-native'
    ) {
      rejectUnavailable('unavailable-model');
      return;
    }

    setKernelSmokeDispatching(true);
    let stage: 'create' | 'dispatch' | 'open' = 'create';
    try {
      const scenario =
        kind === 'retry'
          ? KERNEL_SMOKE_SCENARIOS.schedule_transport_retry
          : KERNEL_SMOKE_SCENARIOS.schedule_dispatch;
      const startAt = Date.now();
      setKernelSmokeScheduleState('creating');
      const created = await eventRepo.create(
        buildJarvisScheduleEventInput({
          workspaceId,
          createdBy: auth.localUserId ?? 'usr_local',
          title: kind === 'retry' ? 'Kernel smoke schedule retry' : 'Kernel smoke schedule',
          prompt: scenario.safeTextFixture,
          startAt,
          durationMs: 5 * 60 * 1000,
          recurrence: 'once',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          modelSelection: selection,
          agentId: protectedJarvis.id,
        }),
      );
      stage = 'dispatch';
      setKernelSmokeScheduleState('dispatching');
      const result = await runDueJarvisSchedules(identity.accountId, workspaceId, undefined, {
        onStage: (runnerStage) => {
          const states = {
            claimed: 'dispatch-claim',
            output_chat: 'dispatch-output',
            kernel_dispatch: 'dispatch-kernel',
            settling: 'dispatch-settle',
            completed: 'dispatching',
            failed: 'dispatch-failed',
          } as const;
          setKernelSmokeScheduleState(states[runnerStage]);
        },
      });
      if (!result.ran.includes(String(created.id))) {
        throw new Error('kernel_smoke_schedule_not_dispatched');
      }
      stage = 'open';
      setKernelSmokeScheduleState('opening');
      const updated = await eventRepo.getById(created.id);
      const metadata = updated ? parseJarvisScheduleMetadata(updated) : null;
      if (!metadata?.outputChatId) throw new Error('kernel_smoke_schedule_output_missing');
      useUIStore.getState().setActiveChat(metadata.outputChatId);
      useUIStore.getState().setChatMode('chat');
      flushUiStatePersistence();
      setTimelineView('jarvis');
      setOpenJarvisEventId(String(created.id));
      setKernelSmokeScheduleState('completed');
    } catch {
      setKernelSmokeScheduleState(`error-${stage}`);
      toast.error('Smoke dispatch failed', 'The fixed schedule did not reach the kernel.');
    } finally {
      setKernelSmokeDispatching(false);
    }
  };

  const handleDeleteEvent = async (event: EventRow) => {
    try {
      await eventRepo.delete(event.id);
      toast.success('Event removed', formatScheduleSuccess(`“${event.title}” is gone.`));
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleCompleteTask = async (task: Task) => {
    try {
      await completeTask(task.id);
      toast.success('Task completed', formatScheduleSuccess(`“${task.title}” is done.`));
    } catch (err) {
      toast.error('Could not complete task', err instanceof Error ? err.message : 'Try again.');
    }
  };

  return (
    <div
      data-monochrome-route="schedule"
      data-sakura-route="schedule"
      className="flex h-full min-h-0 flex-col bg-paper-warm [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&_*]:shadow-none"
    >
      <header
        data-monochrome-surface="schedule-header"
        data-sakura-surface="schedule-header"
        data-warm-surface="schedule-shell-header"
        className="relative overflow-hidden border-b border-border bg-gradient-to-r from-panel via-panel to-accent-copper/5 px-5 py-4 [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:bg-none"
      >
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-accent-copper/10 blur-3xl [html[data-theme=monochrome]_&]:hidden"
          animate={reducedMotion ? undefined : { scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }}
          transition={
            reducedMotion ? undefined : { duration: 8, repeat: Infinity, ease: 'easeInOut' }
          }
        />
        <div aria-hidden data-warm-element="schedule-conversation-chip">
          So right now it looks really useful…
        </div>
        <div className="relative flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-metadata uppercase tracking-wider text-accent-copper">
              <CalendarDays className="h-4 w-4" /> Schedule
            </div>
            <h1 className="font-display text-hero text-foreground">
              Events, timed tasks, and AI plans
            </h1>
            <p className="mt-1 text-secondary text-muted-foreground">
              Tell Jarvis what should happen and when. Times use your device clock.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <CalendarRange className="h-3.5 w-3.5 text-accent-copper" />
                  Calendar
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-0">
                <MiniCalendar
                  todayKey={todayKey}
                  selectedDayKey={selectedDayKey}
                  eventCountByDay={eventCountByDay}
                  onSelectDay={handleSelectDay}
                />
              </PopoverContent>
            </Popover>
            <Badge variant="secondary">{events.length} events</Badge>
            <Badge variant="secondary">{tasks.length} timed tasks</Badge>
          </div>
        </div>
      </header>

      <div
        data-warm-surface="schedule-grid"
        className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 xl:grid-cols-[minmax(0,1fr)_420px]"
      >
        <section
          data-monochrome-surface="schedule-timeline"
          data-sakura-surface="schedule-timeline"
          data-warm-state={
            timelineView === 'jarvis'
              ? jarvisEvents.length === 0
                ? 'empty'
                : 'populated'
              : timeline.length === 0
                ? 'empty'
                : 'populated'
          }
          className="min-h-[360px] overflow-hidden rounded-xl border border-border bg-background/80 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none"
        >
          <div
            data-warm-surface="schedule-timeline-header"
            className="flex items-center justify-between gap-3 border-b border-border bg-panel/60 px-4 py-3"
          >
            <div>
              <h2 className="font-display text-page-title text-foreground">
                {timelineView === 'jarvis' ? 'Jarvis Actions' : 'Timeline'}
              </h2>
              <p className="text-secondary text-muted-foreground">
                {timelineView === 'jarvis'
                  ? 'Scheduled prompts and their saved outputs'
                  : 'Next two weeks · local dates and times'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1 rounded-lg border border-border/80 bg-background/40 p-1 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel">
                <Button
                  type="button"
                  size="sm"
                  variant={timelineView === 'timeline' ? 'secondary' : 'ghost'}
                  onClick={() => {
                    setTimelineView('timeline');
                    setOpenJarvisEventId(null);
                  }}
                >
                  Timeline
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={timelineView === 'jarvis' ? 'secondary' : 'ghost'}
                  onClick={() => setTimelineView('jarvis')}
                >
                  <Sparkles className="mr-1 h-3.5 w-3.5 text-accent-violet" />
                  Jarvis Actions
                  {jarvisEvents.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-accent-violet/15 px-1.5 text-metadata text-accent-violet">
                      {jarvisEvents.length}
                    </span>
                  )}
                </Button>
              </div>
              <Clock className="h-5 w-5 text-accent-copper/70" aria-hidden />
            </div>
          </div>

          {timelineView === 'jarvis' ? (
            openJarvisEvent ? (
              <JarvisActionOutputView
                event={openJarvisEvent}
                onBack={() => setOpenJarvisEventId(null)}
                onDelete={(event) => {
                  setOpenJarvisEventId(null);
                  void handleDeleteEvent(event);
                }}
              />
            ) : (
              <JarvisActionsList
                events={jarvisEvents}
                onOpen={(event) => setOpenJarvisEventId(String(event.id))}
              />
            )
          ) : timeline.length === 0 ? (
            <div
              data-warm-surface="schedule-empty-content"
              className="flex h-72 flex-col items-center justify-center gap-3 text-center text-muted-foreground"
            >
              <motion.div
                data-warm-element="schedule-empty-icon"
                className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-panel shadow-soft motion-reduce:!transform-none [html[data-theme=monochrome]_&]:!transform-none"
                animate={reducedMotion ? undefined : { y: [0, -6, 0] }}
                transition={
                  reducedMotion ? undefined : { duration: 4, repeat: Infinity, ease: 'easeInOut' }
                }
              >
                <CalendarDays className="h-7 w-7 text-accent-copper" />
              </motion.div>
              <p className="font-display text-ui-strong text-foreground">Nothing scheduled yet</p>
              <p className="max-w-sm text-metadata">
                Add an event on the right or schedule a task with a due date to make it appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {dayGroups.map((group) => (
                <section key={group.dayKey} id={`schedule-day-${group.dayKey}`}>
                  <div
                    className={cn(
                      'sticky top-0 z-10 flex items-center gap-2 border-b border-border/80 px-4 py-2.5 backdrop-blur-sm [html[data-theme=monochrome]_&]:backdrop-blur-none',
                      group.dayKey === todayKey
                        ? 'bg-accent-copper/10'
                        : group.dayKey === selectedDayKey
                          ? 'bg-accent-copper/[0.06]'
                          : 'bg-background/95',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg border',
                        group.dayKey === todayKey
                          ? 'border-accent-copper/40 bg-accent-copper/15 text-accent-copper'
                          : 'border-border bg-panel text-accent-cyan',
                      )}
                    >
                      <CalendarDays className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-display text-ui-strong text-foreground">{group.heading}</p>
                      <p className="text-metadata text-muted-foreground">{group.subheading}</p>
                    </div>
                    {group.dayKey === todayKey && (
                      <Badge
                        variant="outline"
                        className="ml-auto border-accent-copper/40 text-accent-copper"
                      >
                        Now
                      </Badge>
                    )}
                  </div>

                  <ul className="space-y-0">
                    {group.items.map((item, idx) => (
                      <motion.li
                        key={`${item.kind}-${item.id}`}
                        data-sakura-surface="schedule-row"
                        data-sakura-state={
                          item.kind === 'task' && item.task.status === 'done'
                            ? 'complete'
                            : item.kind === 'task'
                              ? 'attention'
                              : 'scheduled'
                        }
                        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                        animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
                        transition={
                          reducedMotion
                            ? timelineTransition
                            : {
                                ...timelineTransition,
                                delay: Math.min(idx * 0.03, 0.3),
                              }
                        }
                        className="group border-b border-border/60 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/40 motion-reduce:!transform-none motion-reduce:!opacity-100 [html[data-theme=monochrome]_&]:!transform-none [html[data-theme=monochrome]_&]:!opacity-100"
                      >
                        {item.kind === 'event' ? (
                          <EventTimelineRow
                            item={item}
                            onDelete={handleDeleteEvent}
                            onOpenJarvis={(event) => {
                              setTimelineView('jarvis');
                              setOpenJarvisEventId(String(event.id));
                            }}
                          />
                        ) : (
                          <TaskTimelineRow item={item} onComplete={handleCompleteTask} />
                        )}
                      </motion.li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>

        <aside
          data-monochrome-surface="schedule-editor"
          data-sakura-surface="schedule-editor"
          className="rounded-xl border border-border bg-panel p-4 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:shadow-none"
        >
          <div
            data-warm-surface="schedule-editor-intro"
            className="mb-4 rounded-lg border border-border/80 bg-background/60 p-3 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background"
          >
            <div className="flex items-start gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10">
                <Sparkles className="h-4 w-4 text-accent-cyan" />
              </div>
              <div>
                <h2 className="font-display text-page-title text-foreground">
                  {askLabel} to schedule
                </h2>
                <p className="text-secondary text-muted-foreground">
                  Natural-language planning stays local and editable before save.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div
              data-warm-surface="schedule-mode-switch"
              className="grid grid-cols-2 gap-2 rounded-lg border border-border/80 bg-background/40 p-1 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background"
            >
              <Button
                type="button"
                size="sm"
                variant={scheduleMode === 'event' ? 'secondary' : 'ghost'}
                onClick={() => setScheduleMode('event')}
              >
                Event
              </Button>
              <Button
                type="button"
                size="sm"
                variant={scheduleMode === 'jarvis' ? 'secondary' : 'ghost'}
                onClick={() => setScheduleMode('jarvis')}
              >
                {personaName} Action
              </Button>
            </div>
            {scheduleMode === 'jarvis' && (
              <div className="rounded-lg border border-accent-violet/30 bg-accent-violet/10 p-3 text-secondary [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background">
                <div className={cn(SECTION_TITLE_CLASS, 'font-display text-base')}>
                  {personaName} action
                </div>
                <p className={FIELD_HINT_CLASS}>
                  One clear title, the instruction {personaName} should follow, a model you can
                  access, and when to run.
                </p>
                <div className="mt-3 space-y-1.5">
                  <Label htmlFor="jarvis-action-model" className={SECTION_TITLE_CLASS}>
                    Model
                  </Label>
                  {jarvisModelOptions.length > 0 ? (
                    <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                      <PopoverTrigger asChild>
                        <button
                          id="jarvis-action-model"
                          type="button"
                          aria-label={`${personaName} action model`}
                          className={cn(
                            'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-body text-foreground',
                            'hover:border-border-mid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                          )}
                        >
                          <span className="min-w-0 truncate">
                            {selectedJarvisModel
                              ? `${getProviderDisplayName(selectedJarvisModel.provider)} · ${selectedJarvisModel.label}`
                              : 'Choose a connected model'}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90 text-muted-foreground" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-[min(22rem,calc(100vw-2rem))] max-h-72 overflow-y-auto p-2"
                      >
                        <div className="space-y-3" role="listbox" aria-label="Connected models">
                          {jarvisModelGroupsAvailable.map((group) => (
                            <div key={group.provider}>
                              <div className="mb-1 px-1.5 text-metadata font-semibold uppercase tracking-wide text-muted-foreground">
                                {group.label}
                              </div>
                              <div className="space-y-0.5">
                                {group.options.map((option) => {
                                  const selected = option.id === jarvisModelOptionId;
                                  return (
                                    <button
                                      key={option.id}
                                      type="button"
                                      role="option"
                                      aria-selected={selected}
                                      onClick={() => {
                                        setJarvisModelOptionId(option.id);
                                        setModelPickerOpen(false);
                                      }}
                                      className={cn(
                                        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-secondary transition-colors',
                                        selected
                                          ? 'bg-accent-violet/15 text-foreground ring-1 ring-accent-violet/40'
                                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border text-[10px] font-bold',
                                          selected
                                            ? 'border-accent-violet/50 bg-accent-violet/20 text-foreground'
                                            : 'border-border bg-background text-muted-foreground',
                                        )}
                                        aria-hidden
                                      >
                                        {getProviderDisplayName(option.provider).slice(0, 2)}
                                      </span>
                                      <span className="min-w-0">
                                        <span className="block truncate font-medium text-foreground">
                                          {option.label}
                                        </span>
                                        <span className="block truncate text-metadata text-muted-foreground">
                                          {option.modeLabel ??
                                            getProviderDisplayName(option.provider)}
                                          {option.authLabel ? ` · ${option.authLabel}` : ''}
                                        </span>
                                      </span>
                                      {selected ? (
                                        <Check className="ml-auto mt-1 h-3.5 w-3.5 shrink-0 text-accent-violet" />
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <div className="rounded-md border border-dashed border-border bg-background/50 px-2.5 py-2 text-metadata text-muted-foreground">
                      Connect a provider in Settings → Providers or download a local model before
                      saving a {personaName} Action. Inaccessible models are never listed.
                    </div>
                  )}
                </div>
                <div className="mt-3 space-y-1.5">
                  <Label className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-1.5')}>
                    <Repeat className="h-3.5 w-3.5" /> Repeats
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {JARVIS_RECURRENCE_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => setJarvisRecurrence(preset.value)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-metadata transition-colors',
                          jarvisRecurrence === preset.value
                            ? 'border-accent-violet/60 bg-accent-violet/10 text-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-border-mid',
                        )}
                        aria-pressed={jarvisRecurrence === preset.value}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  {jarvisRecurrence === 'custom_interval' ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-metadata text-muted-foreground">Every</span>
                      <Input
                        type="number"
                        min={1}
                        max={999}
                        value={intervalAmount}
                        onChange={(e) =>
                          setIntervalAmount(Math.max(1, Number(e.target.value) || 1))
                        }
                        className="h-8 w-20"
                        aria-label="Interval amount"
                      />
                      <select
                        value={intervalUnit}
                        onChange={(e) =>
                          setIntervalUnit(e.target.value as 'minutes' | 'hours' | 'days')
                        }
                        className="h-8 rounded-md border border-input bg-background px-2 text-metadata text-foreground"
                        aria-label="Interval unit"
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                      <span className="text-metadata text-muted-foreground">
                        (min 5 min · max 30 days)
                      </span>
                    </div>
                  ) : null}
                </div>
                <p className={cn(FIELD_HINT_CLASS, 'text-accent-violet')}>
                  Selected:{' '}
                  {selectedJarvisModel
                    ? `${getProviderDisplayName(selectedJarvisModel.provider)} · ${selectedJarvisModel.label}`
                    : 'none'}
                </p>
                <p className={FIELD_HINT_CLASS}>
                  Runs while VibeSpace is open. Runs missed by more than 6 hours are logged, not
                  replayed. Timezone: your system local clock.
                </p>
              </div>
            )}
            {scheduleMode === 'event' ? (
              <div>
                <Label
                  htmlFor="event-quick"
                  className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-1.5')}
                >
                  <Sparkles className="h-3.5 w-3.5 text-accent-cyan" /> Quick natural language
                </Label>
                <Input
                  id="event-quick"
                  value={quick}
                  onChange={(e) => handleQuickChange(e.target.value)}
                  placeholder="e.g. Work on this chat for your project at 2 a.m."
                  className={PLACEHOLDER_INPUT_CLASS}
                />
                <p className={FIELD_HINT_CLASS}>
                  Suggestion only — not saved content. Try: Friday 4pm, tomorrow 9:30, call me at
                  2am.
                </p>
              </div>
            ) : null}

            <div>
              <Label htmlFor="event-title" className={SECTION_TITLE_CLASS}>
                {scheduleMode === 'jarvis' ? `${personaName} action title` : 'Title'}
              </Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  scheduleMode === 'jarvis'
                    ? `e.g. Morning briefing for ${personaName}`
                    : "e.g. What's the event?"
                }
                className={PLACEHOLDER_INPUT_CLASS}
              />
            </div>

            <div className="rounded-lg border border-border/80 bg-background/40 p-3 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background">
              <div className="mb-2 flex items-center justify-between gap-2">
                <Label className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-1.5')}>
                  <Clock className="h-3.5 w-3.5 text-accent-copper" /> When
                </Label>
              </div>
              <div
                className={cn(
                  'grid gap-3',
                  scheduleMode === 'jarvis' ? 'grid-cols-1' : 'grid-cols-2',
                )}
              >
                <div>
                  <Label htmlFor="event-start" className="text-metadata text-muted-foreground">
                    {scheduleMode === 'jarvis' ? 'Run at' : 'Start'}
                  </Label>
                  <Input
                    id="event-start"
                    type="datetime-local"
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                  />
                </div>
                {scheduleMode === 'event' && (
                  <div>
                    <Label htmlFor="event-end" className="text-metadata text-muted-foreground">
                      End
                    </Label>
                    <Input
                      id="event-end"
                      type="datetime-local"
                      value={endInput}
                      onChange={(e) => setEndInput(e.target.value)}
                      disabled={allDay}
                    />
                  </div>
                )}
              </div>
            </div>

            {scheduleMode === 'event' ? (
              <div className="flex items-center gap-3">
                <Switch
                  id="event-allday"
                  aria-labelledby="event-allday-label"
                  checked={allDay}
                  onCheckedChange={(v) => setAllDay(Boolean(v))}
                />
                <Label id="event-allday-label" htmlFor="event-allday" className="cursor-pointer">
                  All day
                </Label>
              </div>
            ) : null}

            <div>
              <Label id="event-desc-label" htmlFor="event-desc" className={SECTION_TITLE_CLASS}>
                {scheduleMode === 'jarvis' ? `${personaName} instruction` : 'Notes'}
              </Label>
              <Textarea
                id="event-desc"
                aria-labelledby="event-desc-label"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  scheduleMode === 'jarvis'
                    ? `e.g. What should ${personaName} do when this runs?`
                    : 'e.g. Optional context…'
                }
                className={PLACEHOLDER_INPUT_CLASS}
                rows={4}
              />
            </div>

            {scheduleMode === 'event' ? (
              <div>
                <Label className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-1.5')}>
                  <Bell className="h-3.5 w-3.5 text-accent-copper" /> Reminders
                </Label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {REMINDER_PRESETS.map((preset) => {
                    const active = reminderOffsets.includes(preset.offset_min);
                    return (
                      <button
                        key={preset.offset_min}
                        type="button"
                        onClick={() =>
                          setReminderOffsets((current) =>
                            current.includes(preset.offset_min)
                              ? current.filter((m) => m !== preset.offset_min)
                              : [...current, preset.offset_min].sort((a, b) => a - b),
                          )
                        }
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-metadata transition-colors',
                          active
                            ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-border-mid',
                        )}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <Button
              data-warm-action="schedule-save"
              variant="accent"
              onClick={() => void handleSave()}
              className="mt-1 w-full"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />{' '}
              {scheduleMode === 'jarvis' ? `Save ${personaName} Action` : 'Save event'}
            </Button>
            {KERNEL_SMOKE_ENABLED && kernelSmokeBindingActive ? (
              <div className="grid grid-cols-2 gap-2" aria-label="Kernel schedule smoke fixtures">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={kernelSmokeDispatching || !!kernelSmokeUnavailableState}
                  onClick={() => void dispatchKernelSmokeSchedule('success')}
                  data-sik-evidence={SIK_CONTROL.scheduleDispatch}
                  data-sik-schedule-state={kernelSmokeVisibleScheduleState}
                >
                  Dispatch smoke
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={kernelSmokeDispatching || !!kernelSmokeUnavailableState}
                  onClick={() => void dispatchKernelSmokeSchedule('retry')}
                  data-sik-evidence={SIK_CONTROL.scheduleRetryFixture}
                  data-sik-schedule-state={kernelSmokeVisibleScheduleState}
                >
                  Dispatch retry smoke
                </Button>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function EventTimelineRow({
  item,
  onDelete,
  onOpenJarvis,
}: {
  item: Extract<TimelineItem, { kind: 'event' }>;
  onDelete: (event: EventRow) => void;
  onOpenJarvis?: (event: EventRow) => void;
}) {
  const event = item.instance.event;
  const visual = visualForEventTitle(event.title);
  const jarvisSchedule = isJarvisScheduleEvent(event);
  const jarvisMetadata = parseJarvisScheduleMetadata(event);
  const Icon = visual.icon;
  const reminderCount = event.reminders?.length ?? 0;
  const accentColor = event.color_hue !== undefined ? `hsl(${event.color_hue} 70% 55%)` : undefined;

  return (
    <div
      className={cn(
        'flex gap-3 rounded-xl [html[data-theme=monochrome]_&]:rounded-sm',
        jarvisSchedule && 'bg-accent-violet/5 py-2 pr-2 [html[data-theme=monochrome]_&]:bg-muted',
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-panel shadow-soft',
          jarvisSchedule
            ? 'border-accent-violet/40 bg-accent-violet/10 text-accent-violet'
            : visual.accentClass,
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div
        className="min-w-0 flex-1 rounded-lg border-l-2 pl-3"
        style={
          jarvisSchedule
            ? { borderLeftColor: 'hsl(var(--accent-violet) / 0.75)' }
            : accentColor
              ? { borderLeftColor: accentColor }
              : { borderLeftColor: 'hsl(var(--accent-cyan) / 0.5)' }
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-display text-ui-strong text-foreground">
                {event.title}
              </span>
              <Badge variant="outline" className="shrink-0 text-metadata">
                {jarvisSchedule ? 'Jarvis Scheduled' : visual.label}
              </Badge>
              {jarvisSchedule && (
                <Badge variant="secondary" className="shrink-0 gap-1 text-metadata">
                  <Sparkles className="h-3 w-3 text-accent-violet" />
                  AI task
                </Badge>
              )}
              {item.instance.isRecurrence && (
                <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Recurring" />
              )}
              {reminderCount > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-metadata text-muted-foreground"
                  title="Reminders"
                >
                  <Bell className="h-3 w-3" />
                  {reminderCount}
                </span>
              )}
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-metadata text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0 text-accent-copper/80" />
              {formatLocalEventRange(
                item.instance.instanceStartMs,
                item.instance.instanceEndMs,
                item.instance.event.all_day,
              )}
            </p>
            {event.location && (
              <p className="mt-1 flex items-center gap-1.5 text-metadata text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0 text-accent-cyan/80" />
                {event.location}
              </p>
            )}
            {jarvisSchedule && jarvisMetadata ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-metadata text-muted-foreground">
                <span>
                  Model:{' '}
                  {jarvisMetadata.modelSelection.mode === 'single'
                    ? jarvisMetadata.modelSelection.modelId
                    : jarvisMetadata.modelSelection.mode}
                </span>
                <span>
                  Repeats:{' '}
                  {jarvisRecurrenceLabel(jarvisMetadata.recurrence, jarvisMetadata.intervalMs)}
                </span>
                <span>
                  Next:{' '}
                  {formatLocalDateTime(jarvisMetadata.nextRunAt ?? item.instance.instanceStartMs)}
                </span>
              </p>
            ) : null}
            {event.description && (
              <p className="mt-1.5 line-clamp-2 text-secondary text-muted-foreground">
                {event.description}
              </p>
            )}
            {jarvisSchedule && onOpenJarvis && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 h-7 gap-1 border-accent-violet/40 text-metadata text-accent-violet hover:bg-accent-violet/10"
                onClick={() => onOpenJarvis(event)}
              >
                <Sparkles className="h-3 w-3" />
                View runs & output
              </Button>
            )}
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => onDelete(event)}
            aria-label={`Delete ${event.title}`}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function jarvisEventDisplayTitle(event: EventRow): string {
  return event.title.replace(/^Jarvis Scheduled\s+—\s+/, '').trim() || 'Jarvis task';
}

function JarvisActionsList({
  events,
  onOpen,
}: {
  events: EventRow[];
  onOpen: (event: EventRow) => void;
}) {
  const reducedMotion = useReducedMotion();

  if (events.length === 0) {
    return (
      <div className="flex h-72 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <motion.div
          className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-violet/30 bg-accent-violet/10 shadow-soft motion-reduce:!transform-none [html[data-theme=monochrome]_&]:!transform-none"
          animate={reducedMotion ? undefined : { y: [0, -6, 0] }}
          transition={
            reducedMotion ? undefined : { duration: 4, repeat: Infinity, ease: 'easeInOut' }
          }
        >
          <Sparkles className="h-7 w-7 text-accent-violet" />
        </motion.div>
        <p className="font-display text-ui-strong text-foreground">No Jarvis Actions yet</p>
        <p className="max-w-sm text-metadata">
          Switch the form on the right to “Jarvis Action” to schedule a prompt — like football news
          every morning at 8 AM. Outputs collect here.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/70">
      {events.map((event) => {
        const metadata = parseJarvisScheduleMetadata(event);
        const runCount = metadata?.runHistory.length ?? 0;
        const errorCount = metadata?.errorHistory.length ?? 0;
        return (
          <li
            key={event.id}
            data-sakura-surface="schedule-row"
            data-sakura-state={
              errorCount > 0
                ? 'error'
                : event.status === 'done'
                  ? 'complete'
                  : event.status === 'scheduled'
                    ? 'attention'
                    : 'scheduled'
            }
          >
            <button
              type="button"
              onClick={() => onOpen(event)}
              className="group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent-violet/5"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent-violet/40 bg-accent-violet/10 text-accent-violet">
                <Sparkles className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate font-display text-ui-strong text-foreground">
                    {jarvisEventDisplayTitle(event)}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-metadata">
                    {jarvisRecurrenceLabel(metadata?.recurrence ?? 'once', metadata?.intervalMs)}
                  </Badge>
                  {event.status === 'done' && (
                    <Badge variant="secondary" className="shrink-0 text-metadata">
                      Completed
                    </Badge>
                  )}
                  {event.status === 'cancelled' && (
                    <Badge variant="secondary" className="shrink-0 text-metadata">
                      Paused
                    </Badge>
                  )}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-metadata text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3 text-accent-copper/80" />
                    {metadata?.nextRunAt && event.status === 'scheduled'
                      ? `Next ${formatLocalDateTime(metadata.nextRunAt)}`
                      : metadata?.lastRunAt
                        ? `Last ran ${formatLocalDateTime(metadata.lastRunAt)}`
                        : `Starts ${formatLocalDateTime(event.start_at)}`}
                  </span>
                  <span>
                    {runCount} run{runCount === 1 ? '' : 's'}
                  </span>
                  {errorCount > 0 && (
                    <span className="text-destructive">
                      {errorCount} issue{errorCount === 1 ? '' : 's'}
                    </span>
                  )}
                </p>
                {metadata?.prompt && (
                  <p className="mt-1 line-clamp-1 text-secondary text-muted-foreground">
                    {metadata.prompt}
                  </p>
                )}
              </div>
              <ChevronRight
                className="mt-2 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function JarvisActionOutputView({
  event,
  onBack,
  onDelete,
}: {
  event: EventRow;
  onBack: () => void;
  onDelete: (event: EventRow) => void;
}) {
  const metadata = parseJarvisScheduleMetadata(event);

  return (
    <div className="flex h-[560px] min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-accent-violet/5 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onBack}
            aria-label="Back to Jarvis Actions"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="truncate font-display text-ui-strong text-foreground">
              {jarvisEventDisplayTitle(event)}
            </div>
            <p className="text-metadata text-muted-foreground">
              {jarvisRecurrenceLabel(metadata?.recurrence ?? 'once', metadata?.intervalMs)}
              {metadata?.modelSelection.mode === 'single'
                ? ` · ${metadata.modelSelection.modelId}`
                : ''}
              {metadata?.nextRunAt && event.status === 'scheduled'
                ? ` · next ${formatLocalDateTime(metadata.nextRunAt)}`
                : ''}
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => onDelete(event)}
          aria-label={`Delete ${event.title}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {metadata?.errorHistory.length ? (
        <div className="border-b border-border/70 bg-destructive/5 px-4 py-2">
          <p className="text-metadata text-destructive">
            {metadata.errorHistory[metadata.errorHistory.length - 1]!.error}
          </p>
        </div>
      ) : null}

      {metadata?.outputChatId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatThread chatId={metadata.outputChatId} compact />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <Sparkles className="h-6 w-6 text-accent-violet" />
          <p className="font-display text-ui-strong text-foreground">No runs yet</p>
          <p className="max-w-sm text-metadata">
            {event.status === 'scheduled'
              ? `The first output will appear here after ${formatLocalDateTime(metadata?.nextRunAt ?? event.start_at)}.`
              : 'This action has not produced any output.'}
          </p>
        </div>
      )}
    </div>
  );
}

function TaskTimelineRow({
  item,
  onComplete,
}: {
  item: Extract<TimelineItem, { kind: 'task' }>;
  onComplete: (task: Task) => void;
}) {
  const task = item.task;
  const visual = visualForTask();
  const Icon = visual.icon;

  return (
    <div className="flex gap-3">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-panel shadow-soft',
          visual.accentClass,
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 rounded-lg border-l-2 border-accent-copper/40 pl-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate font-display text-ui-strong text-foreground">
                {task.title}
              </span>
              <Badge variant="outline" className="shrink-0 text-metadata">
                Task
              </Badge>
              <Badge
                variant={
                  task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'outline'
                }
              >
                {task.priority}
              </Badge>
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-metadata text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0 text-accent-copper/80" />
              {item.timeKind} · {formatLocalDateTime(item.at)}
            </p>
            {task.notes && (
              <p className="mt-1.5 line-clamp-2 text-secondary text-muted-foreground">
                {task.notes}
              </p>
            )}
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => onComplete(task)}
            aria-label={`Complete ${task.title}`}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SchedulePage;
