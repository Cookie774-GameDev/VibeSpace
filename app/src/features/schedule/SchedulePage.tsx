import * as React from 'react';
import { CalendarDays, Check, Clock, Plus, Repeat, Sparkles, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { eventRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { completeTask, useUpcomingTasks } from '@/features/tasks';
import type { EventReminder, EventRow } from '@/types/event';
import type { Task } from '@/types/task';
import type { WorkspaceId } from '@/types/common';
import { parseEventInput } from './parseEventInput';
import { useUpcomingEvents } from './hooks';
import type { RecurrenceInstance } from './recurrence';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const REMINDER_PRESETS: { label: string; offset_min: number }[] = [
  { label: 'At time', offset_min: 0 },
  { label: '5 min before', offset_min: 5 },
  { label: '15 min before', offset_min: 15 },
  { label: '1 hour before', offset_min: 60 },
];

type TimelineItem =
  | { kind: 'event'; id: string; at: number; end: number; instance: RecurrenceInstance }
  | { kind: 'task'; id: string; at: number; task: Task; timeKind: 'Scheduled' | 'Due' };

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): number {
  return new Date(s).getTime();
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function formatEventRange(inst: RecurrenceInstance): string {
  const start = new Date(inst.instanceStartMs);
  const end = new Date(inst.instanceEndMs);
  if (inst.event.all_day) {
    return `${start.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })} · All day`;
  }
  return `${formatDateTime(inst.instanceStartMs)} – ${end.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

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
        timeKind: task.scheduled_for !== undefined ? 'Scheduled' as const : 'Due' as const,
      };
    })
    .filter(Boolean) as TimelineItem[];
  return [...eventItems, ...taskItems].sort((a, b) => a.at - b.at);
}

export function SchedulePage() {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const localUserId = useAuthStore((s) => s.localUserId);
  const events = useUpcomingEvents(workspaceId, 14 * DAY_MS, 100);
  const tasks = useUpcomingTasks();
  const timeline = React.useMemo(() => buildTimeline(events, tasks), [events, tasks]);

  const [quick, setQuick] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [startInput, setStartInput] = React.useState(() => toLocalInput(Date.now() + HOUR_MS));
  const [endInput, setEndInput] = React.useState(() => toLocalInput(Date.now() + 2 * HOUR_MS));
  const [allDay, setAllDay] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [reminderOffsets, setReminderOffsets] = React.useState<number[]>([15]);

  const applyParse = React.useCallback((raw: string) => {
    if (!raw.trim()) return;
    const parsed = parseEventInput(raw);
    setTitle(parsed.title);
    setStartInput(toLocalInput(parsed.start_at));
    setEndInput(toLocalInput(parsed.end_at));
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

    const start = fromLocalInput(startInput);
    if (!Number.isFinite(start)) {
      toast.warning('Check the start time', 'That date/time could not be read.');
      return;
    }
    const rawEnd = fromLocalInput(endInput);
    const end = allDay ? start + DAY_MS - 1 : Math.max(rawEnd, start + 5 * 60 * 1000);
    const reminders: EventReminder[] = reminderOffsets.map((offset_min) => ({
      offset_min,
      channels: ['desktop', 'in_app'],
    }));

    try {
      await eventRepo.create({
        workspace_id: workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        start_at: start,
        end_at: end,
        all_day: allDay,
        reminders,
        source: 'manual',
        created_by: localUserId ?? 'usr_local',
      });
      toast.success('Event saved', `“${title.trim()}” is on your schedule.`);
      setQuick('');
      setTitle('');
      setDescription('');
      setStartInput(toLocalInput(Date.now() + HOUR_MS));
      setEndInput(toLocalInput(Date.now() + 2 * HOUR_MS));
      setAllDay(false);
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleDeleteEvent = async (event: EventRow) => {
    try {
      await eventRepo.delete(event.id);
      toast.success('Event removed', `“${event.title}” is gone.`);
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleCompleteTask = async (task: Task) => {
    try {
      await completeTask(task.id);
      toast.success('Task completed', `“${task.title}” is done.`);
    } catch (err) {
      toast.error('Could not complete task', err instanceof Error ? err.message : 'Try again.');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper-warm">
      <header className="border-b border-border bg-panel px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-metadata uppercase tracking-wider text-accent-copper">
              <CalendarDays className="h-4 w-4" /> Schedule
            </div>
            <h1 className="font-display text-hero text-foreground">Events, timed tasks, and AI plans</h1>
            <p className="mt-1 text-secondary text-muted-foreground">
              Tell Jarvis what should happen and when. It can turn plain language into a scheduled work block.
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant="secondary">{events.length} events</Badge>
            <Badge variant="secondary">{tasks.length} timed tasks</Badge>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-h-[360px] rounded-xl border border-border bg-background/80 shadow-soft">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-page-title text-foreground">Timeline</h2>
              <p className="text-secondary text-muted-foreground">Next two weeks of events plus the next week of timed tasks.</p>
            </div>
          </div>

          {timeline.length === 0 ? (
            <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Clock className="h-8 w-8 text-accent-copper" />
              <p className="text-secondary">Nothing scheduled yet.</p>
              <p className="max-w-sm text-metadata">Add an event on the right or schedule a task with a due date to make it appear here.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {timeline.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="group flex gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-panel">
                    {item.kind === 'event' ? <CalendarDays className="h-4 w-4 text-accent-cyan" /> : <Check className="h-4 w-4 text-accent-copper" />}
                  </div>
                  {item.kind === 'event' ? (
                    <EventTimelineRow item={item} onDelete={handleDeleteEvent} />
                  ) : (
                    <TaskTimelineRow item={item} onComplete={handleCompleteTask} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="rounded-xl border border-border bg-panel p-4 shadow-soft">
          <div className="mb-4">
            <h2 className="text-page-title text-foreground">Ask Jarvis to schedule</h2>
            <p className="text-secondary text-muted-foreground">Natural-language planning stays local and editable before save.</p>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="event-quick" className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-accent-cyan" /> Jarvis schedule request
              </Label>
              <Input
                id="event-quick"
                value={quick}
                onChange={(e) => handleQuickChange(e.target.value)}
                placeholder="Work on this chat for our project at 2am"
              />
              <p className="mt-1 text-metadata text-muted-foreground">Try: Friday 4pm, tomorrow 9:30, call me at 2am, work on the project tonight.</p>
            </div>

            <div>
              <Label htmlFor="event-title">Title</Label>
              <Input id="event-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's the event?" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="event-start">Start</Label>
                <Input id="event-start" type="datetime-local" value={startInput} onChange={(e) => setStartInput(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="event-end">End</Label>
                <Input id="event-end" type="datetime-local" value={endInput} onChange={(e) => setEndInput(e.target.value)} disabled={allDay} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Switch id="event-allday" checked={allDay} onCheckedChange={(v) => setAllDay(Boolean(v))} />
              <Label htmlFor="event-allday" className="cursor-pointer">All day</Label>
            </div>

            <div>
              <Label htmlFor="event-desc">Notes</Label>
              <Textarea id="event-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional context..." rows={4} />
            </div>

            <div>
              <Label>Reminders</Label>
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

            <Button variant="accent" onClick={() => void handleSave()} className="mt-1 w-full">
              <Plus className="mr-1 h-3.5 w-3.5" /> Save event
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function EventTimelineRow({
  item,
  onDelete,
}: {
  item: Extract<TimelineItem, { kind: 'event' }>;
  onDelete: (event: EventRow) => void;
}) {
  const event = item.instance.event;
  return (
    <div
      className="min-w-0 flex-1"
      style={event.color_hue !== undefined ? { borderLeftColor: `hsl(${event.color_hue} 70% 55%)` } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-secondary text-foreground">
            <span className="truncate">{event.title}</span>
            {item.instance.isRecurrence && <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Recurring" />}
          </div>
          <p className="mt-0.5 text-metadata text-muted-foreground">{formatEventRange(item.instance)}</p>
          {event.location && <p className="mt-0.5 text-metadata text-muted-foreground">@ {event.location}</p>}
          {event.description && <p className="mt-1 line-clamp-2 text-secondary text-muted-foreground">{event.description}</p>}
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
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-secondary text-foreground">
            <span className="truncate">{task.title}</span>
            <Badge variant={task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'outline'}>
              {task.priority}
            </Badge>
          </div>
          <p className="mt-0.5 text-metadata text-muted-foreground">{item.timeKind} · {formatDateTime(item.at)}</p>
          {task.notes && <p className="mt-1 line-clamp-2 text-secondary text-muted-foreground">{task.notes}</p>}
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
  );
}

export default SchedulePage;
