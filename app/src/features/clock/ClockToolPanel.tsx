import * as React from 'react';
import { AlarmClock, BellRing, Clock, TimerReset, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { runAction } from '@/lib/actions';
import { cn } from '@/lib/utils';
import { formatClockRemaining, useClockStore } from './clockStore';

function dueTime(dueAt: number): string {
  return new Date(dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ClockToolPanel() {
  const scheduled = useClockStore((state) => state.scheduled());
  const completed = useClockStore((state) => state.completed());
  const cancel = useClockStore((state) => state.cancel);
  const clearCompleted = useClockStore((state) => state.clearCompleted);
  const [minutes, setMinutes] = React.useState('25');
  const [label, setLabel] = React.useState('Focus timer');
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const startTimer = async () => {
    const durationMinutes = Number(minutes);
    await runAction(
      'clock.timer',
      {
        durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 25,
        label,
        sound: 'chime',
      },
      { source: 'user' },
    );
  };

  return (
    <section className="mb-8 rounded-xl border border-border bg-elevated/80 p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-metadata uppercase tracking-wider text-accent-cyan">
            <Clock className="mr-1 inline h-3.5 w-3.5" />
            Preloaded tool
          </p>
          <h2 className="mt-1 font-display text-title text-foreground">Clock</h2>
          <p className="mt-1 max-w-2xl text-secondary text-muted-foreground">
            Local timers and alarms that Jarvis can control from chat, voice, the actions palette, or this Tools page.
          </p>
        </div>
        <div className="rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-3 py-1 text-metadata text-accent-cyan">
          {scheduled.length} active
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[320px_1fr]">
        <div className="rounded-lg border border-border bg-paper p-3">
          <div className="mb-2 flex items-center gap-2 text-secondary font-medium text-foreground">
            <TimerReset className="h-4 w-4 text-accent-copper" />
            Quick timer
          </div>
          <div className="grid grid-cols-[1fr_92px] gap-2">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Timer label" />
            <Input
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              inputMode="decimal"
              placeholder="min"
              aria-label="Timer minutes"
            />
          </div>
          <Button className="mt-2 w-full" variant="accent" onClick={startTimer}>
            <BellRing className="h-3.5 w-3.5" />
            Start timer
          </Button>
          <p className="mt-2 text-metadata text-muted-foreground">
            Try: “Hey Jarvis, make me a one-hour timer.”
          </p>
        </div>

        <div className="rounded-lg border border-border bg-paper p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-secondary font-medium text-foreground">
              <AlarmClock className="h-4 w-4 text-accent-violet" />
              Active timers and alarms
            </div>
            {completed.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => clearCompleted()}>
                Clear done
              </Button>
            )}
          </div>
          {scheduled.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-secondary text-muted-foreground">
              No active clock items.
            </div>
          ) : (
            <div className="grid gap-2">
              {scheduled.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-md border border-border bg-elevated px-3 py-2',
                    entry.dueAt - now < 60_000 && 'border-warning/40 bg-warning/5',
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate text-secondary font-medium text-foreground">{entry.label}</div>
                    <div className="text-metadata text-muted-foreground">
                      {entry.kind} · {dueTime(entry.dueAt)} · {formatClockRemaining(entry.dueAt, now)}
                    </div>
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => cancel(entry.id)} aria-label={`Cancel ${entry.label}`}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
