/**
 * V2 — Schedule modal.
 *
 * Two tabs: "Upcoming" (next 7 days feed) and "Add event" (quick-add form
 * that runs the regex parser, lets you tweak, then saves).
 *
 * Opens via:
 *   - Mod+Shift+E hotkey (registered in App.tsx GlobalHotkeysHost)
 *   - Command palette > Schedule
 *   - TodoPanel "Schedule" button (V2)
 *
 * State lives in `useUIStore.scheduleOpen` (added in this file via the
 * existing UI store extension; we read it through `subscribeWithSelector`).
 */
import * as React from 'react';
import { CalendarDays, Plus, Trash2, Sparkles, Repeat } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { eventRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import type { EventRow, EventReminder } from '@/types/event';
import type { WorkspaceId } from '@/types/common';
import { useUpcomingEvents } from './hooks';
import { parseEventInput } from './parseEventInput';

interface ScheduleModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const REMINDER_PRESETS: { label: string; offset_min: number }[] = [
  { label: 'At time', offset_min: 0 },
  { label: '5 min before', offset_min: 5 },
  { label: '15 min before', offset_min: 15 },
  { label: '1 hour before', offset_min: 60 },
];

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): number {
  const d = new Date(s);
  return d.getTime();
}

function formatRange(ev: EventRow): string {
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  const dayOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (ev.all_day) {
    return start.toLocaleDateString(undefined, dayOpts);
  }
  return `${start.toLocaleDateString(undefined, dayOpts)} · ${start.toLocaleTimeString(undefined, timeOpts)} – ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

/**
 * Same idea as formatRange but for a recurrence-expanded instance.
 * Uses the instance's own start/end (not the anchor row's) so a daily
 * standup that recurred 3 days from the anchor reads "Wed, Sep 12 · 9:00am".
 * "All day" rows render the day label only.
 */
function formatInstance(inst: { event: EventRow; instanceStartMs: number; instanceEndMs: number }): string {
  const start = new Date(inst.instanceStartMs);
  const end = new Date(inst.instanceEndMs);
  const dayOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (inst.event.all_day) {
    return `${start.toLocaleDateString(undefined, dayOpts)} · All day`;
  }
  return `${start.toLocaleDateString(undefined, dayOpts)} · ${start.toLocaleTimeString(undefined, timeOpts)} – ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

export function ScheduleModal({ open, onOpenChange }: ScheduleModalProps) {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const localUserId = useAuthStore((s) => s.localUserId);
  const events = useUpcomingEvents(workspaceId, 7 * 24 * 60 * 60 * 1000, 50);

  // Form state
  const [quick, setQuick] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [startInput, setStartInput] = React.useState(() => toLocalInput(Date.now() + 60 * 60 * 1000));
  const [endInput, setEndInput] = React.useState(() => toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
  const [allDay, setAllDay] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [reminderOffsets, setReminderOffsets] = React.useState<number[]>([15]);

  React.useEffect(() => {
    if (!open) {
      setQuick('');
    }
  }, [open]);

  const applyParse = (raw: string) => {
    if (!raw.trim()) return;
    const parsed = parseEventInput(raw);
    setTitle(parsed.title);
    setStartInput(toLocalInput(parsed.start_at));
    setEndInput(toLocalInput(parsed.end_at));
    setAllDay(parsed.all_day);
  };

  const onQuickChange = (v: string) => {
    setQuick(v);
    // Live-parse so the form previews what we'll save.
    if (v.trim().length > 2) applyParse(v);
  };

  const handleSave = async () => {
    if (!workspaceId) {
      toast.error('No workspace', 'Sign in or finish onboarding first.');
      return;
    }
    if (!title.trim()) {
      toast.warning('Add a title', 'Events need a name.');
      return;
    }
    const start = fromLocalInput(startInput);
    const end = allDay ? start + 24 * 60 * 60 * 1000 - 1 : Math.max(fromLocalInput(endInput), start + 5 * 60 * 1000);
    const reminders: EventReminder[] = reminderOffsets.map((m) => ({
      offset_min: m,
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
      // Reset form
      setQuick('');
      setTitle('');
      setDescription('');
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleDelete = async (ev: EventRow) => {
    try {
      await eventRepo.delete(ev.id);
      toast.success('Event removed', `“${ev.title}” is gone.`);
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : 'Try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" /> Schedule
          </DialogTitle>
          <DialogDescription>
            Add events with natural language. We parse times locally; nothing leaves your machine until you connect a calendar.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList>
            <TabsTrigger value="upcoming">Upcoming ({events.length})</TabsTrigger>
            <TabsTrigger value="add">Add event</TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="mt-4 max-h-[60vh] overflow-y-auto pr-1">
            {events.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-secondary text-muted-foreground">
                Nothing scheduled in the next 14 days.
                <br />
                <span className="text-metadata">Switch to "Add event" to schedule one.</span>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {events.map((inst) => {
                  const ev = inst.event;
                  return (
                    <li
                      key={`${ev.id}-${inst.instanceStartMs}`}
                      className="group flex items-start gap-3 rounded-md border border-border bg-panel p-3 hover:border-border-mid transition-colors"
                      style={
                        ev.color_hue !== undefined
                          ? { borderLeftColor: `hsl(${ev.color_hue} 70% 55%)`, borderLeftWidth: '3px' }
                          : undefined
                      }
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-secondary text-foreground truncate flex items-center gap-1.5">
                          <span className="truncate">{ev.title}</span>
                          {inst.isRecurrence && (
                            <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Recurring" />
                          )}
                        </div>
                        <div className="text-metadata text-muted-foreground mt-0.5">
                          {formatInstance(inst)}
                        </div>
                        {ev.location && (
                          <div className="text-metadata text-muted-foreground mt-0.5">
                            @ {ev.location}
                          </div>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => void handleDelete(ev)}
                        aria-label={`Delete ${ev.title}`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="add" className="mt-4 flex flex-col gap-3">
            <div>
              <Label htmlFor="event-quick" className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-accent-cyan" /> Natural language
              </Label>
              <Input
                id="event-quick"
                value={quick}
                onChange={(e) => onQuickChange(e.target.value)}
                placeholder="Lunch with Sam tomorrow at 1pm"
                autoFocus
              />
              <div className="text-metadata text-muted-foreground mt-1">
                Tries to parse date + time. Examples: "Friday 4pm", "tomorrow 9:30", "Aug 12".
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="event-title">Title</Label>
                <Input
                  id="event-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's the event?"
                />
              </div>
              <div>
                <Label htmlFor="event-start">Start</Label>
                <Input
                  id="event-start"
                  type="datetime-local"
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  disabled={allDay}
                />
              </div>
              <div>
                <Label htmlFor="event-end">End</Label>
                <Input
                  id="event-end"
                  type="datetime-local"
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  disabled={allDay}
                />
              </div>
              <div className="col-span-2 flex items-center gap-3">
                <Switch
                  id="event-allday"
                  checked={allDay}
                  onCheckedChange={(v) => setAllDay(Boolean(v))}
                />
                <Label htmlFor="event-allday" className="cursor-pointer">All day</Label>
              </div>
              <div className="col-span-2">
                <Label htmlFor="event-desc">Notes</Label>
                <Textarea
                  id="event-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional context..."
                  rows={3}
                />
              </div>
              <div className="col-span-2">
                <Label>Reminders</Label>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {REMINDER_PRESETS.map((p) => {
                    const active = reminderOffsets.includes(p.offset_min);
                    return (
                      <button
                        key={p.offset_min}
                        type="button"
                        onClick={() =>
                          setReminderOffsets((cur) =>
                            cur.includes(p.offset_min)
                              ? cur.filter((m) => m !== p.offset_min)
                              : [...cur, p.offset_min].sort((a, b) => a - b),
                          )
                        }
                        className={
                          'px-2.5 py-1 rounded-md text-metadata border transition-colors ' +
                          (active
                            ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
                            : 'border-border bg-panel text-muted-foreground hover:border-border-mid')
                        }
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="accent" onClick={() => void handleSave()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Save event
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
