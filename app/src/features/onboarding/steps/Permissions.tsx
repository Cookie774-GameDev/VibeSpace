import { useEffect, useState, type ReactNode } from 'react';
import { Mic, Bell, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/lib/tauri';

type PermStatus = 'unknown' | 'requesting' | 'granted' | 'denied' | 'unavailable';

export function Permissions() {
  const [micStatus, setMicStatus] = useState<PermStatus>('unknown');
  const [notifStatus, setNotifStatus] = useState<PermStatus>('unknown');

  useEffect(() => {
    let active = true;
    void getNotificationPermission().then((permission) => {
      if (active) setNotifStatus(notificationPermissionToStatus(permission));
    });
    return () => {
      active = false;
    };
  }, []);

  async function requestMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus('unavailable');
      return;
    }
    setMicStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  }

  async function requestNotif() {
    setNotifStatus('requesting');
    const permission = await requestNotificationPermission();
    setNotifStatus(notificationPermissionToStatus(permission));
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 py-10 gap-8 overflow-y-auto">
      <header className="text-center max-w-xl">
        <h2 className="text-hero leading-tight">Grant permissions</h2>
        <p className="text-body text-muted-foreground mt-3">
          Voice and reminders need OS-level access. You can change these any time in your system
          settings.
        </p>
      </header>

      <div className="flex flex-col gap-3 w-full max-w-xl">
        <PermissionRow
          icon={<Mic className="h-4 w-4" />}
          title="Microphone"
          description="So Jarvis can hear you when you push-to-talk or say the wake word."
          status={micStatus}
          onRequest={requestMic}
        />
        <PermissionRow
          icon={<Bell className="h-4 w-4" />}
          title="Notifications"
          description="So Jarvis can remind you about todos and finished agent runs."
          status={notifStatus}
          onRequest={requestNotif}
        />
      </div>

      <p className="text-metadata text-muted-foreground text-center max-w-md">
        Denied either? No problem. You can keep going - we'll fall back to in-app prompts.
      </p>
    </div>
  );
}

interface PermissionRowProps {
  icon: ReactNode;
  title: string;
  description: string;
  status: PermStatus;
  onRequest: () => void;
}

function PermissionRow({ icon, title, description, status, onRequest }: PermissionRowProps) {
  const settled = status === 'granted' || status === 'denied' || status === 'unavailable';

  return (
    <div
      className={cn(
        'rounded-md border bg-panel px-4 py-3 flex items-start gap-3 transition-colors',
        status === 'granted'
          ? 'border-success/40'
          : status === 'denied'
            ? 'border-destructive/30'
            : 'border-border',
      )}
    >
      <span
        className={cn(
          'shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md border',
          status === 'granted'
            ? 'border-success/30 bg-success/10 text-success'
            : status === 'denied'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ui-strong text-foreground">{title}</span>
          <StatusPill status={status} />
        </div>
        <p className="text-secondary text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">
        <Button
          variant={settled && status === 'granted' ? 'ghost' : 'secondary'}
          size="sm"
          onClick={onRequest}
          disabled={status === 'requesting' || status === 'granted' || status === 'unavailable'}
        >
          {status === 'requesting' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {status === 'granted'
            ? 'Granted'
            : status === 'denied'
              ? 'Try again'
              : status === 'unavailable'
                ? 'Unavailable'
                : status === 'requesting'
                  ? 'Asking...'
                  : 'Allow'}
        </Button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PermStatus }) {
  if (status === 'unknown' || status === 'requesting') return null;
  const map: Record<
    Exclude<PermStatus, 'unknown' | 'requesting'>,
    { label: string; cls: string; icon: ReactNode }
  > = {
    granted: {
      label: 'Granted',
      cls: 'bg-success/10 text-success border-success/30',
      icon: <Check className="h-3 w-3" strokeWidth={3} />,
    },
    denied: {
      label: 'Denied',
      cls: 'bg-destructive/10 text-destructive border-destructive/30',
      icon: <X className="h-3 w-3" strokeWidth={3} />,
    },
    unavailable: {
      label: 'Unavailable',
      cls: 'bg-warning/10 text-warning border-warning/30',
      icon: <AlertTriangle className="h-3 w-3" />,
    },
  };
  const entry = map[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-metadata font-medium',
        entry.cls,
      )}
    >
      {entry.icon}
      {entry.label}
    </span>
  );
}

function notificationPermissionToStatus(permission: NotificationPermissionState): PermStatus {
  if (permission === 'unavailable') return 'unavailable';
  if (permission === 'granted') return 'granted';
  if (permission === 'denied') return 'denied';
  return 'unknown';
}
