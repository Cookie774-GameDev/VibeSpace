import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuthStore, getLocalWorkspaceRecoveryRevision } from '@/stores/auth';
import { subscribeLocalAccountReadiness } from '@/lib/localAccountReadiness';
import {
  previewLocalWorkspaceRecovery,
  recoverLocalWorkspace,
  type LocalWorkspaceRecoveryPreview,
} from '@/features/access/localWorkspaceRecovery';

export function LocalWorkspaceRecovery() {
  const [preview, setPreview] = useState<LocalWorkspaceRecoveryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Nothing changes until you check and confirm.');
  const generation = useRef(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current += 1;
      setPreview(null);
      setConfirmed(false);
      setMessage('Local account readiness changed. Check recovery again.');
    };
    const stopAuth = useAuthStore.subscribe((next, previous) => {
      if (
        next.localUserId !== previous.localUserId ||
        next.workspaceId !== previous.workspaceId ||
        next.projectId !== previous.projectId ||
        next.cloudSession !== previous.cloudSession
      )
        invalidate();
    });
    const stopReady = subscribeLocalAccountReadiness(invalidate);
    return () => {
      mounted.current = false;
      generation.current += 1;
      stopAuth();
      stopReady();
    };
  }, []);
  async function run(apply: boolean) {
    if (running.current || (apply && (!preview || !confirmed))) return;
    running.current = true;
    const request = ++generation.current;
    setBusy(true);
    setConfirmed(false);
    try {
      if (apply && preview) {
        const result = await recoverLocalWorkspace(preview);
        const auth = useAuthStore.getState();
        if (
          !mounted.current ||
          getLocalWorkspaceRecoveryRevision() !== result.revision ||
          auth.cloudSession !== null ||
          auth.localUserId !== result.scope.localUserId ||
          auth.workspaceId !== result.scope.workspaceId ||
          auth.projectId !== result.scope.projectId
        )
          return;
        // Successful activation intentionally invalidates the old scope and preview.
        setPreview(null);
        setMessage('A new local workspace and Inbox are ready. Existing records were preserved.');
      } else {
        const result = await previewLocalWorkspaceRecovery();
        if (request !== generation.current) return;
        setPreview(result);
        setMessage(
          result.kind === 'resume'
            ? 'A saved recovery is ready to resume.'
            : 'No workspace rows exist on this device. You can create a new local workspace.',
        );
      }
    } catch (error) {
      if (request === generation.current) {
        setPreview(null);
        setMessage(
          error instanceof Error ? error.message : 'Recovery could not finish. Check again.',
        );
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-3" data-testid="account-local-workspace-recovery">
      <Label>Local workspace recovery</Label>
      <p className="max-w-xl text-metadata text-muted-foreground">
        If you are signed out and this device has no workspace rows, create a new Personal workspace
        and Inbox for your current local profile. Existing projects, chats, jobs and history stay
        unchanged. This does not reconnect orphaned records or recover cloud data.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(false)}
        >
          {busy ? 'Working…' : 'Check local workspace recovery'}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-metadata text-muted-foreground">
        {message}
      </p>
      {preview && (
        <div className="max-w-xl rounded-lg border border-border p-3">
          <label className="flex items-start gap-2 text-metadata text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand this activates a new local workspace and leaves my existing records
            unchanged.
          </label>
          <Button
            type="button"
            variant="accent"
            size="sm"
            className="mt-3"
            disabled={!confirmed || busy}
            onClick={() => void run(true)}
          >
            {preview.kind === 'resume'
              ? 'Resume local workspace recovery'
              : 'Create local workspace'}
          </Button>
        </div>
      )}
    </section>
  );
}
