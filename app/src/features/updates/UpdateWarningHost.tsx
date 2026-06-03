import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, Download } from 'lucide-react';
import { checkForAppUpdate, getAutoUpdateEnabled } from '@/lib/updates';
import { toast } from '@/components/ui/toast';
import { isTauri } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const UPDATE_COUNTDOWN_SECONDS = 60 * 60;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_LATER_MS = 24 * 60 * 60 * 1000;
const SNOOZE_ONE_HOUR_MS = 60 * 60 * 1000;
const SNOOZE_UNTIL_KEY = 'jarvis-update-snoozed-until';

const WARNING_COPY: Record<number, { title: string; body: string }> = {
  3600: {
    title: 'Jarvis update ready',
    body: 'A signed update is ready. Jarvis will install it in 1 hour unless you update later.',
  },
  1800: {
    title: 'Jarvis update in 30 minutes',
    body: 'Jarvis will automatically update and restart in 30 minutes. Save active terminal work.',
  },
  300: {
    title: 'Jarvis update in 5 minutes',
    body: 'Jarvis will restart soon to apply the signed update. Choose Update Later if this is a bad time.',
  },
};

function getSnoozedUntil(): number {
  const raw = window.localStorage.getItem(SNOOZE_UNTIL_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function setSnoozedUntil(timestamp: number) {
  window.localStorage.setItem(SNOOZE_UNTIL_KEY, String(timestamp));
}

export function UpdateWarningHost() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const warnedRef = useRef<Set<number>>(new Set());

  const clearCountdown = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTimeLeft(null);
  };

  const warnAt = (seconds: number) => {
    if (warnedRef.current.has(seconds)) return;
    warnedRef.current.add(seconds);
    const warning = WARNING_COPY[seconds];
    if (!warning) return;
    toast.warning(warning.title, warning.body);
  };

  const triggerSilentUpdate = async () => {
    if (isUpdating) return;
    clearCountdown();
    setIsUpdating(true);
    toast.info('Installing update', 'Downloading and installing the signed update. Jarvis will relaunch shortly.');
    try {
      await checkForAppUpdate({ install: true });
    } catch (err) {
      setIsUpdating(false);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error('Update failed', `Silent update installation failed: ${msg}`);
      startCountdown(30 * 60);
    }
  };

  const startCountdown = (seconds = UPDATE_COUNTDOWN_SECONDS) => {
    warnedRef.current = new Set();
    setTimeLeft(seconds);
    warnAt(seconds >= 3600 ? 3600 : seconds >= 1800 ? 1800 : 300);

    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          void triggerSilentUpdate();
          return 0;
        }

        const next = prev - 1;
        if (next === 1800 || next === 300) warnAt(next);
        return next;
      });
    }, 1000);
  };

  const checkUpdates = async () => {
    if (!isTauri || import.meta.env.DEV) return;
    if (!getAutoUpdateEnabled()) return;
    if (Date.now() < getSnoozedUntil()) return;

    try {
      const res = await checkForAppUpdate({ install: false });
      if (res.available && res.version) {
        setTargetVersion(res.version);
        setUpdateAvailable(true);
        if (timeLeft === null) startCountdown();
      }
    } catch (err) {
      console.warn('[updates] Background update check failed:', err);
    }
  };

  const handleSnooze = () => {
    setSnoozedUntil(Date.now() + SNOOZE_ONE_HOUR_MS);
    startCountdown();
    toast.info('Update snoozed', 'Jarvis will remind you again in 1 hour.');
  };

  const handleUpdateLater = () => {
    setSnoozedUntil(Date.now() + UPDATE_LATER_MS);
    clearCountdown();
    setUpdateAvailable(false);
    toast.info('Update postponed', 'Jarvis will check again tomorrow.');
  };

  const handleUpdateNow = () => {
    void triggerSilentUpdate();
  };

  useEffect(() => {
    if (!isTauri || import.meta.env.DEV) return;

    const initialCheck = setTimeout(() => {
      void checkUpdates();
    }, 5000);

    checkTimerRef.current = setInterval(() => {
      void checkUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(initialCheck);
      if (checkTimerRef.current) clearInterval(checkTimerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // Update checks intentionally run from one global host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const showModal = updateAvailable && timeLeft !== null && timeLeft <= 300 && timeLeft > 0 && !isUpdating;
  const isOpen = showModal || isUpdating;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!isUpdating && !open) handleSnooze(); }}>
      {isUpdating ? (
        <DialogContent className="flex max-w-sm flex-col items-center justify-center rounded-xl border border-border bg-panel p-6 text-center shadow-lg">
          <DialogTitle className="sr-only">Updating Jarvis</DialogTitle>
          <DialogDescription className="sr-only">Installing update and relaunching.</DialogDescription>
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-accent-cyan/30 border-t-accent-cyan" />
          <h4 className="text-md text-ui-strong font-semibold text-foreground">Installing Update...</h4>
          <p className="mt-1.5 text-metadata text-muted-foreground">
            Applying version {targetVersion}. Jarvis will automatically relaunch in a few seconds.
          </p>
        </DialogContent>
      ) : (
        <DialogContent className="max-w-md rounded-xl border border-border bg-panel p-6 shadow-lg">
          <DialogTitle className="flex items-center gap-2 text-lg text-ui-strong text-foreground">
            <AlertTriangle className="h-5 w-5 animate-pulse text-accent-amber" />
            Automatic update alert
          </DialogTitle>
          <DialogDescription className="mt-2 text-secondary leading-relaxed text-muted-foreground">
            A signed update for Jarvis One v{targetVersion} is staged and ready. Jarvis will restart and apply it in:
          </DialogDescription>

          <div className="my-6 flex flex-col items-center justify-center rounded-lg border border-border/60 bg-background/50 p-4">
            <span className="mb-1 flex items-center gap-1 text-metadata font-semibold uppercase tracking-wider text-accent-cyan">
              <Clock className="h-4 w-4" /> Time remaining
            </span>
            <span className="font-mono text-3xl font-bold tracking-widest text-foreground">
              {timeLeft !== null ? formatTime(timeLeft) : '05:00'}
            </span>
          </div>

          <p className="mb-4 text-metadata text-muted-foreground">
            Save terminal layouts, active scripts, and unsaved files before applying the update.
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="ghost" onClick={handleUpdateLater}>
              Update Later
            </Button>
            <Button type="button" variant="outline" onClick={handleSnooze}>
              Snooze 1 Hour
            </Button>
            <Button type="button" variant="accent" onClick={handleUpdateNow} className="gap-1.5">
              <Download className="h-4 w-4" /> Update Now
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
