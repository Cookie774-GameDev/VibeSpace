import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCircle2, ShieldAlert, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useUIStore, type DoneNotificationKey } from '@/stores/ui';
import { useAssistantPersonaName } from '@/lib/assistantPersona';
import {
  DONE_NOTIFICATION_DESCRIPTIONS,
  DONE_NOTIFICATION_KEYS,
  ensureOsNotificationPermission,
  getDoneNotificationLabels,
  readNotificationPermission,
  sendTestNotification,
} from '@/lib/notifications';
import type { NotificationPermissionState } from '@/lib/tauri';

const MONOCHROME_SWITCH_CLASS =
  'motion-reduce:transition-none motion-reduce:[&_span]:transition-none [html[data-theme=monochrome]_&]:transition-none [html[data-theme=monochrome]_&_span]:transition-none [html[data-theme=monochrome]_&_span]:shadow-none';

function permissionLabel(state: NotificationPermissionState | 'loading'): string {
  switch (state) {
    case 'loading':
      return 'Checking…';
    case 'granted':
      return 'Allowed';
    case 'denied':
      return 'Blocked';
    case 'default':
      return 'Not decided yet';
    case 'unavailable':
      return 'Unavailable in this environment';
  }
}

function permissionHint(state: NotificationPermissionState | 'loading'): string {
  switch (state) {
    case 'loading':
      return 'Reading OS / browser notification permission…';
    case 'granted':
      return 'Desktop or browser notifications can be delivered.';
    case 'denied':
      return 'Notifications are blocked. Allow them in system or browser settings, then click Request permission.';
    case 'default':
      return 'Click Request permission (or Send test) to allow notifications.';
    case 'unavailable':
      return 'This build cannot use OS notifications. Test still shows an in-app toast.';
  }
}

export function Notifications() {
  const assistantName = useAssistantPersonaName();
  const notificationMaster = useUIStore((s) => s.notificationMaster);
  const setNotificationMaster = useUIStore((s) => s.setNotificationMaster);
  const doneNotifications = useUIStore((s) => s.doneNotifications);
  const setDoneNotification = useUIStore((s) => s.setDoneNotification);
  const aiCompletionCue = useUIStore((s) => s.aiCompletionCue);
  const setAiCompletionCue = useUIStore((s) => s.setAiCompletionCue);
  const notificationSound = useUIStore((s) => s.notificationSound);
  const setNotificationSound = useUIStore((s) => s.setNotificationSound);
  const notificationBadge = useUIStore((s) => s.notificationBadge);
  const setNotificationBadge = useUIStore((s) => s.setNotificationBadge);

  const [permission, setPermission] = useState<NotificationPermissionState | 'loading'>(
    'loading',
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const [permBusy, setPermBusy] = useState(false);

  const labels = getDoneNotificationLabels(assistantName);

  const refreshPermission = useCallback(async () => {
    const next = await readNotificationPermission();
    setPermission(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission]);

  const handleRequestPermission = async () => {
    setPermBusy(true);
    setTestFeedback(null);
    try {
      const next = await ensureOsNotificationPermission();
      setPermission(next);
      if (next === 'granted') {
        setTestFeedback('Permission granted. You can send a test notification.');
      } else if (next === 'denied') {
        setTestFeedback(
          'Permission denied. Allow notifications for VibeSpace in your system or browser settings.',
        );
      } else if (next === 'unavailable') {
        setTestFeedback('OS notifications are unavailable here. Send test still shows an in-app toast.');
      } else {
        setTestFeedback('Permission is still undecided. Try Send test to prompt again.');
      }
    } finally {
      setPermBusy(false);
    }
  };

  const handleSendTest = async () => {
    setTestBusy(true);
    setTestFeedback(null);
    try {
      const result = await sendTestNotification();
      setPermission(result.permission);
      const channelNote =
        result.channel === 'native'
          ? 'Desktop notification'
          : result.channel === 'browser'
            ? 'Browser notification'
            : result.channel === 'toast'
              ? 'In-app toast'
              : 'No delivery';
      setTestFeedback(
        result.delivered
          ? `${channelNote}: ${result.message}`
          : `Could not deliver: ${result.message}`,
      );
    } catch (err) {
      setTestFeedback(
        err instanceof Error ? err.message : 'Test notification failed unexpectedly.',
      );
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="mc7f-settings-notifications flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4">
      <header>
        <h2 className="text-page-title text-foreground">Notifications</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Choose which real app events produce a desktop notification. In-app status still appears
          where the work happened.
        </p>
      </header>

      <section className="flex items-start justify-between gap-3 max-w-xl">
        <div>
          <Label htmlFor="notifications-master">Enable notifications</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Master switch for OS/browser notifications from the categories below.
          </p>
        </div>
        <Switch
          id="notifications-master"
          className={MONOCHROME_SWITCH_CLASS}
          checked={notificationMaster}
          onCheckedChange={(v) => setNotificationMaster(Boolean(v))}
        />
      </section>

      <section className="flex flex-col gap-3 max-w-xl rounded-xl border border-border bg-panel p-3">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-accent-copper" />
          <div className="min-w-0 flex-1">
            <div className="text-ui-strong text-foreground">
              Permission status:{' '}
              <span className="text-accent-copper">{permissionLabel(permission)}</span>
            </div>
            <p className="mt-1 text-metadata text-muted-foreground">{permissionHint(permission)}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={permBusy || permission === 'loading'}
            onClick={() => void handleRequestPermission()}
          >
            {permBusy ? 'Requesting…' : 'Request permission'}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3 max-w-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label htmlFor="notification-sound">Notification sound</Label>
            <p className="text-metadata text-muted-foreground mt-1">
              Play the system sound when the platform supports it. Turn off for silent banners.
            </p>
          </div>
          <Switch
            id="notification-sound"
            className={MONOCHROME_SWITCH_CLASS}
            checked={notificationSound}
            disabled={!notificationMaster}
            onCheckedChange={(v) => setNotificationSound(Boolean(v))}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label htmlFor="notification-badge">Tray badge</Label>
            <p className="text-metadata text-muted-foreground mt-1">
              When supported, mark the app badge after a delivered notification. Click the
              notification to clear it.
            </p>
          </div>
          <Switch
            id="notification-badge"
            className={MONOCHROME_SWITCH_CLASS}
            checked={notificationBadge}
            disabled={!notificationMaster}
            onCheckedChange={(v) => setNotificationBadge(Boolean(v))}
          />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3 max-w-2xl">
        <div>
          <Label>Event categories</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Only events the app already produces. Leave noisy ones off.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-panel overflow-hidden">
          {DONE_NOTIFICATION_KEYS.map((key: DoneNotificationKey, index) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 last:border-b-0"
            >
              <div className={!notificationMaster ? 'opacity-50' : ''}>
                <div className="flex items-center gap-2 text-ui-strong text-foreground">
                  <CheckCircle2 className="h-4 w-4 text-accent-copper" />
                  {labels[key]}
                </div>
                <p className="mt-1 text-metadata text-muted-foreground">
                  {DONE_NOTIFICATION_DESCRIPTIONS[key]}
                </p>
              </div>
              <Switch
                id={`notification-${key}-${index}`}
                className={MONOCHROME_SWITCH_CLASS}
                checked={Boolean(doneNotifications[key])}
                disabled={!notificationMaster}
                onCheckedChange={(v) => setDoneNotification(key, Boolean(v))}
              />
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-xl">
        <div>
          <Label htmlFor="ai-completion-cue">Ask {assistantName} to say when work is done</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Adds a short instruction so {assistantName} ends finished replies with a clear{' '}
            <span className="font-mono text-foreground">DONE:</span> line (or{' '}
            <span className="font-mono text-foreground">BLOCKED:</span> if something remains). This
            is plain text in the reply — not hidden reasoning.
          </p>
        </div>
        <Switch
          id="ai-completion-cue"
          className={MONOCHROME_SWITCH_CLASS}
          checked={aiCompletionCue}
          onCheckedChange={(v) => setAiCompletionCue(Boolean(v))}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-paper-soft p-3 max-w-xl">
        <div className="flex items-center gap-3">
          <Bell className="h-4 w-4 shrink-0 text-accent-copper" />
          <div className="min-w-0 flex-1">
            <div className="text-ui-strong text-foreground">Test notification</div>
            <p className="text-metadata text-muted-foreground">
              Always available. Requests permission if needed, then sends a sample{' '}
              {assistantName} notification (uses toast if OS delivery is blocked).
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={testBusy}
            onClick={() => void handleSendTest()}
          >
            <Volume2 className="mr-1.5 h-3.5 w-3.5" />
            {testBusy ? 'Sending…' : 'Send test'}
          </Button>
        </div>
        {testFeedback ? (
          <p
            className="text-metadata text-muted-foreground border-t border-border/60 pt-2"
            role="status"
            data-testid="notification-test-feedback"
          >
            {testFeedback}
          </p>
        ) : null}
        {!notificationMaster ? (
          <p className="text-metadata text-muted-foreground">
            Tip: Turn on “Enable notifications” and the categories you want for everyday alerts.
            Send test still works so you can verify permission.
          </p>
        ) : null}
      </section>
    </div>
  );
}

export default Notifications;
