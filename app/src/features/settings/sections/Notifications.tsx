import { Bell, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useUIStore, type DoneNotificationKey } from '@/stores/ui';
import { DONE_NOTIFICATION_LABELS, notifyDone } from '@/lib/notifications';

const DONE_ROWS: Array<{ key: DoneNotificationKey; description: string }> = [
  { key: 'jarvis', description: 'Notify when an AI chat response finishes.' },
  { key: 'terminal', description: 'Notify when a terminal process exits.' },
  { key: 'tasks', description: 'Notify when a task is marked done.' },
  { key: 'contextMaps', description: 'Notify when a Context map finishes generating.' },
  { key: 'skills', description: 'Notify when a skill enable/disable action completes.' },
];

export function Notifications() {
  const notificationMaster = useUIStore((s) => s.notificationMaster);
  const setNotificationMaster = useUIStore((s) => s.setNotificationMaster);
  const doneNotifications = useUIStore((s) => s.doneNotifications);
  const setDoneNotification = useUIStore((s) => s.setDoneNotification);
  const aiCompletionCue = useUIStore((s) => s.aiCompletionCue);
  const setAiCompletionCue = useUIStore((s) => s.setAiCompletionCue);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Notifications</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Choose which finished-work events should produce a desktop notification.
        </p>
      </header>

      <section className="flex items-start justify-between gap-3 max-w-xl">
        <div>
          <Label htmlFor="notifications-master">Enable done notifications</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Master switch for OS/browser notifications. In-app status still appears where the work happened.
          </p>
        </div>
        <Switch
          id="notifications-master"
          checked={notificationMaster}
          onCheckedChange={(v) => setNotificationMaster(Boolean(v))}
        />
      </section>

      <Separator />

      <section className="flex flex-col gap-3 max-w-2xl">
        <div>
          <Label>Done event types</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Leave noisy categories off and keep important completions on.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-panel overflow-hidden">
          {DONE_ROWS.map((row, index) => (
            <div
              key={row.key}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 last:border-b-0"
            >
              <div className={!notificationMaster ? 'opacity-50' : ''}>
                <div className="flex items-center gap-2 text-ui-strong text-foreground">
                  <CheckCircle2 className="h-4 w-4 text-accent-copper" />
                  {DONE_NOTIFICATION_LABELS[row.key]}
                </div>
                <p className="mt-1 text-metadata text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                id={`notification-${row.key}-${index}`}
                checked={doneNotifications[row.key]}
                disabled={!notificationMaster}
                onCheckedChange={(v) => setDoneNotification(row.key, Boolean(v))}
              />
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-xl">
        <div>
          <Label htmlFor="ai-completion-cue">AI completion cue</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Adds a short system-prompt instruction that asks AI agents to clearly say when the task is done, or what remains blocked.
          </p>
        </div>
        <Switch
          id="ai-completion-cue"
          checked={aiCompletionCue}
          onCheckedChange={(v) => setAiCompletionCue(Boolean(v))}
        />
      </section>

      <section className="flex items-center gap-3 rounded-xl border border-border bg-paper-soft p-3 max-w-xl">
        <Bell className="h-4 w-4 text-accent-copper" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-strong text-foreground">Test notification</div>
          <p className="text-metadata text-muted-foreground">Sends a sample Jarvis done notification using the current settings.</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void notifyDone('jarvis', 'Jarvis done', 'Notification settings are working.', { allowFallbackToast: true })}
          disabled={!notificationMaster || !doneNotifications.jarvis}
        >
          Send Test
        </Button>
      </section>
    </div>
  );
}

export default Notifications;
