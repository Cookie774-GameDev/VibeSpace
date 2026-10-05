import { LocalWorkspaceRecovery } from './LocalWorkspaceRecovery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mail,
  User2,
  Copy,
  Check,
  LogIn,
  LogOut,
  UserPlus,
  Loader2,
  ImageIcon,
  CloudDownload,
  ShieldCheck,
  Download,
  Upload,
  CloudUpload,
  LockKeyhole,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { getPlan } from '@/lib/entitlements';
import { getSupabaseClient } from '@/lib/supabase';
import {
  previewCloudRecovery,
  restoreCloudRecovery,
  type CloudRecoveryPreview,
} from '@/lib/cloudRecovery';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { SignInDialog } from '@/features/auth/SignInDialog';
import { backupCurrentAccountWorkspace } from '@/features/access/workspaceBackup';
import {
  previewWorkspaceRestore,
  readPortableBackupHistory,
  recordPortableBackupHistory,
  restoreWorkspaceBackup,
  type PortableBackupHistory,
  type WorkspaceRestorePreview,
} from '@/features/access/workspaceRestore';
import {
  downloadEncryptedCloudBackup,
  uploadEncryptedCloudBackup,
} from '@/lib/encryptedCloudBackup';

const MAX_DISPLAY_NAME = 80;

export type ProfileSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

function normalizeDisplayName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME);
}

/**
 * Persist the signed-in user's display name through Supabase `profiles`
 * (and user metadata when available). Local-only sessions skip the network.
 */
export async function persistDisplayNameToCloud(input: {
  userId: string;
  displayName: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { ok: false, error: 'Cloud sync is not configured in this build.' };
  }

  const displayName = normalizeDisplayName(input.displayName);
  const { error: profileError } = await client
    .from('profiles')
    .update({ display_name: displayName || null })
    .eq('id', input.userId);

  if (profileError) {
    return {
      ok: false,
      error: profileError.message || 'Could not save your profile to the cloud.',
    };
  }

  // Best-effort metadata mirror — profile row is the source of truth.
  try {
    await client.auth.updateUser({
      data: { display_name: displayName || null },
    });
  } catch {
    /* non-fatal */
  }

  return { ok: true };
}

/**
 * Load `profiles.display_name` for the signed-in user when present.
 */
export async function loadDisplayNameFromCloud(
  userId: string,
): Promise<{ ok: true; displayName: string | null } | { ok: false; error: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { ok: false, error: 'Cloud sync is not configured in this build.' };
  }
  const { data, error } = await client
    .from('profiles')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    return { ok: false, error: error.message || 'Could not load cloud profile.' };
  }
  const raw = data?.display_name;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: true, displayName: null };
  }
  return { ok: true, displayName: normalizeDisplayName(raw) };
}

/**
 * Main Account Center profile editor.
 *
 * Settings no longer hosts a duplicate Account tab — this surface is opened
 * from the profile / J avatar (Account route). Usage, Billing, Pets, and
 * Support live as sibling tabs on AccountPage and are not recreated here.
 */
export function Account({ profileOnly = true }: { profileOnly?: boolean }) {
  const displayName = useAuthStore((s) => s.displayName);
  const setDisplayName = useAuthStore((s) => s.setDisplayName);
  const localUserId = useAuthStore((s) => s.localUserId);
  const cloudSession = useAuthStore((s) => s.cloudSession);
  const plan = useAuthStore((s) => s.plan);

  const [draftName, setDraftName] = useState(displayName);
  const [saveState, setSaveState] = useState<ProfileSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInMode, setSignInMode] = useState<'signin' | 'signup'>('signin');
  const [copied, setCopied] = useState(false);
  const [cloudHydrating, setCloudHydrating] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [recoveryPreview, setRecoveryPreview] = useState<CloudRecoveryPreview | null>(null);
  const [recoveryState, setRecoveryState] = useState<
    'idle' | 'scanning' | 'ready' | 'restoring' | 'restored' | 'error'
  >('idle');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [portablePreview, setPortablePreview] = useState<WorkspaceRestorePreview | null>(null);
  const [portableState, setPortableState] = useState<
    'idle' | 'exporting' | 'previewing' | 'ready' | 'restoring' | 'restored' | 'error'
  >('idle');
  const [portableConfirmed, setPortableConfirmed] = useState(false);
  const [portableMessage, setPortableMessage] = useState('');
  const [portableHistory, setPortableHistory] = useState<PortableBackupHistory>({});
  const [encryptedPassphrase, setEncryptedPassphrase] = useState('');
  const [encryptedConsent, setEncryptedConsent] = useState(false);
  const [encryptedState, setEncryptedState] = useState<
    'idle' | 'uploading' | 'downloading' | 'complete' | 'error'
  >('idle');
  const [encryptedMessage, setEncryptedMessage] = useState('');
  const portableFileInput = useRef<HTMLInputElement | null>(null);
  const signOutOperation = useRef<symbol | null>(null);
  const mounted = useRef(true);

  const cloudEmail = cloudSession?.email;
  const cloudUserId = cloudSession?.user_id?.trim() || null;
  const portableAccountId = cloudUserId || localUserId || null;

  useEffect(
    () => () => {
      mounted.current = false;
      signOutOperation.current = null;
    },
    [],
  );

  // Keep draft aligned with the store. Do not clear a successful/failed save
  // status here — that is owned by the explicit save path.
  useEffect(() => {
    setDraftName(displayName);
  }, [displayName]);

  // Account switch resets save feedback (local ↔ cloud identity).
  useEffect(() => {
    setSaveState('idle');
    setSaveError(null);
    setRecoveryPreview(null);
    setRecoveryState('idle');
    setRecoveryConfirmed(false);
    setRecoveryMessage('');
    setPortablePreview(null);
    setPortableState('idle');
    setPortableConfirmed(false);
    setPortableMessage('');
    setPortableHistory(portableAccountId ? readPortableBackupHistory(portableAccountId) : {});
    setEncryptedPassphrase('');
    setEncryptedConsent(false);
    setEncryptedState('idle');
    setEncryptedMessage('');
  }, [cloudUserId, portableAccountId]);

  // Hydrate display name from Supabase when signed in.
  useEffect(() => {
    if (!cloudUserId) return;
    let cancelled = false;
    setCloudHydrating(true);
    void loadDisplayNameFromCloud(cloudUserId)
      .then((result) => {
        if (cancelled || !result.ok || result.displayName == null) return;
        const current = useAuthStore.getState().displayName;
        if (normalizeDisplayName(current) !== result.displayName) {
          setDisplayName(result.displayName);
        }
      })
      .finally(() => {
        if (!cancelled) setCloudHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudUserId, setDisplayName]);

  const normalizedDraft = useMemo(() => normalizeDisplayName(draftName), [draftName]);
  const normalizedStored = useMemo(() => normalizeDisplayName(displayName), [displayName]);
  const isDirty = normalizedDraft !== normalizedStored || draftName !== displayName;

  useEffect(() => {
    if (saveState === 'saving') return;
    if (isDirty) {
      setSaveState('dirty');
      setSaveError(null);
    } else if (saveState === 'dirty') {
      setSaveState('idle');
    }
  }, [isDirty, saveState]);

  const avatarSeed = normalizedDraft || cloudEmail || localUserId || 'jarvis';
  const avatarInitials = (normalizedDraft || cloudEmail || 'J').charAt(0);

  function openAuth(mode: 'signin' | 'signup') {
    setSignInMode(mode);
    setSignInOpen(true);
  }

  async function handleSignOut() {
    if (signOutOperation.current) return;
    const initiatingUserId = useAuthStore.getState().cloudSession?.user_id.trim() ?? '';
    if (!initiatingUserId) return;

    const operation = Symbol('account-sign-out');
    signOutOperation.current = operation;
    setSignOutPending(true);

    try {
      const client = getSupabaseClient();
      if (!client) throw new Error('Cloud sign out is unavailable.');
      const { error } = await client.auth.signOut();
      if (error) throw new Error('Cloud sign out failed.');

      if (!mounted.current || signOutOperation.current !== operation) return;
      const currentUserId = useAuthStore.getState().cloudSession?.user_id.trim() ?? '';
      if (currentUserId && currentUserId !== initiatingUserId) return;
      if (currentUserId === initiatingUserId) {
        useAuthStore.setState({ cloudSession: null, plan: 'free' });
      }
      toast.success('Signed out', 'You have been signed out of your account.');
    } catch {
      if (!mounted.current || signOutOperation.current !== operation) return;
      const currentUserId = useAuthStore.getState().cloudSession?.user_id.trim() ?? '';
      if (currentUserId === initiatingUserId) {
        toast.error(
          'Sign out failed',
          'Your session is still active. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted.current && signOutOperation.current === operation) {
        signOutOperation.current = null;
        setSignOutPending(false);
      }
    }
  }

  function copyId() {
    if (!localUserId) return;
    navigator.clipboard?.writeText(localUserId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => toast.error('Could not copy', 'Clipboard access was denied.'),
    );
  }

  const saveProfile = useCallback(async () => {
    const next = normalizeDisplayName(draftName);
    setSaveState('saving');
    setSaveError(null);

    if (!cloudUserId) {
      setDisplayName(next);
      setSaveState('saved');
      toast.success('Profile saved', 'Your display name is saved on this device.');
      return;
    }

    const result = await persistDisplayNameToCloud({
      userId: cloudUserId,
      displayName: next,
    });
    if (!result.ok) {
      setSaveState('error');
      setSaveError(result.error);
      toast.error('Cloud save failed', result.error);
      return;
    }

    // A signed-in profile becomes authoritative locally only after Supabase
    // accepts it, so an error never masquerades as a saved local profile.
    setDisplayName(next);
    setSaveState('saved');
    toast.success('Profile saved', 'Your display name is synced to your cloud account.');
  }, [cloudUserId, draftName, setDisplayName]);

  const saveStatusLabel = (() => {
    switch (saveState) {
      case 'dirty':
        return 'Unsaved changes';
      case 'saving':
        return 'Saving…';
      case 'saved':
        return cloudUserId ? 'Saved to cloud' : 'Saved on this device';
      case 'error':
        return saveError ?? 'Save failed';
      default:
        return cloudHydrating ? 'Loading cloud profile…' : 'Up to date';
    }
  })();

  const cloudRecoveryAvailable = Boolean(cloudUserId && getPlan(plan).cloudSync);

  async function scanCloudRecovery() {
    if (!cloudUserId || recoveryState === 'scanning' || recoveryState === 'restoring') return;
    setRecoveryState('scanning');
    setRecoveryPreview(null);
    setRecoveryConfirmed(false);
    setRecoveryMessage('');
    try {
      const preview = await previewCloudRecovery(cloudUserId);
      if (useAuthStore.getState().cloudSession?.user_id.trim() !== cloudUserId) return;
      setRecoveryPreview(preview);
      setRecoveryState('ready');
      setRecoveryMessage(
        preview.recoverable + preview.cloudNewer > 0
          ? `${preview.recoverable + preview.cloudNewer} cloud record${preview.recoverable + preview.cloudNewer === 1 ? '' : 's'} can be safely recovered.`
          : 'Your recoverable cloud data is already present on this device.',
      );
    } catch (error) {
      setRecoveryState('error');
      setRecoveryMessage(
        error instanceof Error ? error.message : 'Could not scan cloud recovery data.',
      );
    }
  }

  async function applyCloudRecovery() {
    if (!recoveryPreview || !recoveryConfirmed || recoveryState !== 'ready') return;
    setRecoveryState('restoring');
    setRecoveryMessage('Recovering your cloud data…');
    try {
      const result = await restoreCloudRecovery(recoveryPreview);
      setRecoveryState('restored');
      setRecoveryMessage(
        `${result.restored} record${result.restored === 1 ? '' : 's'} recovered. ${result.preservedLocal} newer or matching local record${result.preservedLocal === 1 ? '' : 's'} preserved.`,
      );
      toast.success('Cloud recovery complete', 'Your newer local data was preserved.');
    } catch (error) {
      setRecoveryState('error');
      const message = error instanceof Error ? error.message : 'Cloud recovery could not finish.';
      setRecoveryMessage(message);
      toast.error('Cloud recovery failed', message);
    }
  }

  function recordPortableFailure(error: unknown) {
    const message = error instanceof Error ? error.message : 'Portable backup operation failed.';
    setPortableState('error');
    setPortableMessage(message);
    if (portableAccountId) {
      try {
        setPortableHistory(recordPortableBackupHistory(portableAccountId, { error: message }));
      } catch {
        /* history is best-effort and never hides the primary error */
      }
    }
    toast.error('Portable backup failed', message);
  }

  function recordPortableSuccess(accountId: string, action: 'export' | 'restore') {
    try {
      setPortableHistory(recordPortableBackupHistory(accountId, action));
    } catch {
      // The artifact/restore already succeeded. History failure must not turn a
      // completed data operation into a false failure report.
    }
  }

  async function exportPortableBackup() {
    if (!portableAccountId || portableState === 'exporting' || portableState === 'restoring')
      return;
    setPortableState('exporting');
    setPortableMessage('Flushing pending changes and creating your backup…');
    try {
      const result = await backupCurrentAccountWorkspace();
      recordPortableSuccess(portableAccountId, 'export');
      setPortableState('idle');
      setPortableMessage(
        `Saved ${result.counts.workspaces} workspace${result.counts.workspaces === 1 ? '' : 's'}, ${result.counts.chats} chat${result.counts.chats === 1 ? '' : 's'}, and ${result.counts.canvasDocuments} canvas${result.counts.canvasDocuments === 1 ? '' : 'es'}.${result.counts.tasks ? ` ${result.counts.tasks} task${result.counts.tasks === 1 ? '' : 's'} included.` : ''}`,
      );
      toast.success('Portable backup created', result.filename);
    } catch (error) {
      recordPortableFailure(error);
    }
  }

  async function previewPortableRestore(file: File) {
    if (!portableAccountId || portableState === 'exporting' || portableState === 'restoring')
      return;
    setPortableState('previewing');
    setPortablePreview(null);
    setPortableConfirmed(false);
    setPortableMessage('Checking backup ownership and contents…');
    try {
      const preview = await previewWorkspaceRestore(await file.text());
      setPortablePreview(preview);
      setPortableState('ready');
      setPortableMessage(
        `${preview.restorable} missing local record${preview.restorable === 1 ? '' : 's'} can be restored. ${preview.preservedLocal} existing local record${preview.preservedLocal === 1 ? '' : 's'} will be preserved.`,
      );
    } catch (error) {
      recordPortableFailure(error);
    } finally {
      if (portableFileInput.current) portableFileInput.current.value = '';
    }
  }

  async function applyPortableRestore() {
    if (!portablePreview || !portableConfirmed || portableState !== 'ready') return;
    setPortableState('restoring');
    setPortableMessage('Restoring missing records…');
    try {
      const result = await restoreWorkspaceBackup(portablePreview);
      recordPortableSuccess(portablePreview.accountId, 'restore');
      setPortableState('restored');
      setPortableMessage(
        `${result.restored} record${result.restored === 1 ? '' : 's'} restored. ${result.preservedLocal} existing local record${result.preservedLocal === 1 ? '' : 's'} preserved.`,
      );
      toast.success('Portable restore complete', 'Existing local records were not replaced.');
    } catch (error) {
      recordPortableFailure(error);
    }
  }

  async function uploadEncryptedBackup() {
    if (
      !cloudRecoveryAvailable ||
      !encryptedConsent ||
      encryptedState === 'uploading' ||
      encryptedState === 'downloading'
    ) {
      return;
    }
    const passphrase = encryptedPassphrase;
    setEncryptedState('uploading');
    setEncryptedMessage('Creating and encrypting locally before upload…');
    try {
      const result = await uploadEncryptedCloudBackup(passphrase);
      setEncryptedState('complete');
      setEncryptedMessage(
        `Encrypted cloud backup saved ${new Date(result.createdAt).toLocaleString()}. Keep your passphrase safe; VibeSpace cannot recover it.`,
      );
      setEncryptedConsent(false);
      toast.success('Encrypted cloud backup saved', 'Only ciphertext was uploaded.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Encrypted cloud backup failed.';
      setEncryptedState('error');
      setEncryptedMessage(message);
      toast.error('Encrypted cloud backup failed', message);
    } finally {
      setEncryptedPassphrase('');
    }
  }

  async function previewEncryptedCloudRestore() {
    if (
      !cloudRecoveryAvailable ||
      encryptedState === 'uploading' ||
      encryptedState === 'downloading'
    ) {
      return;
    }
    const passphrase = encryptedPassphrase;
    setEncryptedState('downloading');
    setEncryptedMessage('Downloading ciphertext and decrypting locally…');
    setPortablePreview(null);
    setPortableConfirmed(false);
    try {
      const plaintext = await downloadEncryptedCloudBackup(passphrase);
      const preview = await previewWorkspaceRestore(plaintext);
      setPortablePreview(preview);
      setPortableState('ready');
      setEncryptedState('complete');
      setEncryptedMessage(
        `Decrypted locally. ${preview.restorable} missing record${preview.restorable === 1 ? '' : 's'} can be restored below.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Encrypted cloud recovery failed.';
      setEncryptedState('error');
      setEncryptedMessage(message);
      toast.error('Encrypted cloud recovery failed', message);
    } finally {
      setEncryptedPassphrase('');
    }
  }

  const profileBody = (
    <>
      <section className="flex flex-col gap-3" data-testid="account-profile-editor">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar
            seed={avatarSeed}
            initials={avatarInitials}
            size={64}
            className="ring-2 ring-border/70"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-ui-strong text-foreground">Profile image</p>
            <p className="mt-1 text-metadata text-muted-foreground">
              VibeSpace generates your avatar from your display name. Custom photo upload is not
              available in the current account model.
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-metadata text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              Preview updates as you edit your name.
            </p>
          </div>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <Label htmlFor="acct-name">Display name</Label>
        <div className="flex items-center gap-2 max-w-md">
          <User2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            id="acct-name"
            name="displayName"
            placeholder="What should Jarvis call you?"
            value={draftName}
            maxLength={MAX_DISPLAY_NAME}
            autoComplete="nickname"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isDirty && saveState !== 'saving') {
                e.preventDefault();
                void saveProfile();
              }
            }}
            data-testid="account-display-name-input"
          />
        </div>
        <p className="text-metadata text-muted-foreground">
          Used in greetings, the top-bar avatar initial, and the persona prompt.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={!isDirty || saveState === 'saving'}
            onClick={() => void saveProfile()}
            data-testid="account-profile-save"
          >
            {saveState === 'saving' ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : null}
            Save profile
          </Button>
          <span
            className="text-metadata text-muted-foreground"
            data-testid="account-profile-save-status"
            role="status"
            aria-live="polite"
          >
            {saveStatusLabel}
          </span>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3" aria-labelledby="local-data-ownership-heading">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 id="local-data-ownership-heading" className="text-ui-strong text-foreground">
              Local data ownership
            </h3>
            <p className="mt-1 text-ui-small leading-relaxed text-muted-foreground">
              Your local user ID is an offline data-ownership namespace for records saved on this
              device. It is not a password or recovery secret.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 max-w-md">
          <code className="flex-1 px-2.5 h-8 inline-flex items-center rounded-md border border-border bg-muted font-mono text-secondary text-muted-foreground select-all">
            {localUserId ?? 'not assigned'}
          </code>
          <Button
            variant="ghost"
            size="icon"
            onClick={copyId}
            disabled={!localUserId}
            aria-label="Copy local user id"
          >
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between max-w-md gap-3">
          <div className="flex flex-col gap-1">
            <Label>Cloud account</Label>
            <p className="text-metadata text-muted-foreground">
              {cloudSession
                ? 'You are signed in. Profile saves sync to Supabase.'
                : 'Sign in or create an account to save your workspace and plan.'}
            </p>
          </div>
          {cloudSession ? (
            <Badge variant="success">Signed in</Badge>
          ) : (
            <Badge variant="outline">Signed out</Badge>
          )}
        </div>

        {cloudEmail && (
          <div className="flex items-center gap-2 text-secondary text-muted-foreground max-w-md">
            <Mail className="h-3.5 w-3.5" />
            <span>{cloudEmail}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {cloudSession ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              disabled={signOutPending}
              aria-busy={signOutPending}
            >
              {signOutPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5 mr-1.5" />
              )}
              {signOutPending ? 'Signing out…' : 'Sign out'}
            </Button>
          ) : (
            <>
              <Button variant="accent" size="sm" onClick={() => openAuth('signin')}>
                <LogIn className="h-3.5 w-3.5 mr-1.5" />
                Sign in
              </Button>
              <Button variant="outline" size="sm" onClick={() => openAuth('signup')}>
                <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                Create account
              </Button>
            </>
          )}
        </div>
      </section>

      <Separator />

      <LocalWorkspaceRecovery />

      <Separator />

      <section className="flex flex-col gap-3" data-testid="account-cloud-recovery">
        <div className="flex items-start justify-between max-w-xl gap-3">
          <div>
            <Label className="inline-flex items-center gap-2">
              <CloudDownload className="h-4 w-4 text-accent-copper" />
              Cloud recovery
            </Label>
            <p className="mt-1 text-metadata text-muted-foreground">
              Preview and safely merge core data already synced to this account after a reset or on
              a new device.
            </p>
          </div>
          <Badge variant={cloudRecoveryAvailable ? 'success' : 'outline'}>
            {cloudRecoveryAvailable ? 'Available' : cloudUserId ? 'Plan required' : 'Sign in'}
          </Badge>
        </div>

        <div className="max-w-xl rounded-lg border border-border/70 bg-muted/30 p-3">
          <p className="inline-flex items-start gap-2 text-metadata text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            Recovery never deletes local records and preserves newer local copies. API keys,
            credentials, settings blobs, terminal transcripts, project files, provider state, and
            local-only Context data are excluded.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !cloudRecoveryAvailable ||
              recoveryState === 'scanning' ||
              recoveryState === 'restoring'
            }
            onClick={() => void scanCloudRecovery()}
            aria-busy={recoveryState === 'scanning'}
            data-testid="cloud-recovery-scan"
          >
            {recoveryState === 'scanning' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
            )}
            {recoveryState === 'scanning' ? 'Scanning…' : 'Preview cloud recovery'}
          </Button>
          <span
            className="text-metadata text-muted-foreground"
            role="status"
            aria-live="polite"
            data-testid="cloud-recovery-status"
          >
            {recoveryMessage ||
              (cloudRecoveryAvailable
                ? 'Nothing changes until you preview and confirm.'
                : cloudUserId
                  ? 'Cloud recovery is included with a cloud-sync plan.'
                  : 'Sign in to check for recoverable cloud data.')}
          </span>
        </div>

        {recoveryPreview && recoveryState !== 'restored' ? (
          <div
            className="max-w-xl rounded-lg border border-border bg-panel/50 p-3"
            data-testid="cloud-recovery-preview"
          >
            <div className="grid grid-cols-2 gap-2 text-metadata sm:grid-cols-4">
              <span>
                <strong className="block text-foreground">{recoveryPreview.recoverable}</strong>
                Missing locally
              </span>
              <span>
                <strong className="block text-foreground">{recoveryPreview.cloudNewer}</strong>Newer
                in cloud
              </span>
              <span>
                <strong className="block text-foreground">{recoveryPreview.preservedLocal}</strong>
                Local preserved
              </span>
              <span>
                <strong className="block text-foreground">{recoveryPreview.skippedDeleted}</strong>
                Deletes skipped
              </span>
            </div>
            {recoveryPreview.recoverable + recoveryPreview.cloudNewer > 0 ? (
              <>
                <label className="mt-3 flex items-start gap-2 text-metadata text-muted-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={recoveryConfirmed}
                    onChange={(event) => setRecoveryConfirmed(event.target.checked)}
                    data-testid="cloud-recovery-confirm"
                  />
                  Merge these records into this device. Existing newer or matching local data will
                  not be replaced.
                </label>
                <Button
                  type="button"
                  variant="accent"
                  size="sm"
                  className="mt-3"
                  disabled={!recoveryConfirmed || recoveryState !== 'ready'}
                  onClick={() => void applyCloudRecovery()}
                  data-testid="cloud-recovery-apply"
                >
                  Recover to this device
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-3" data-testid="account-portable-backup">
        <div className="flex items-start justify-between max-w-xl gap-3">
          <div>
            <Label className="inline-flex items-center gap-2">
              <Download className="h-4 w-4 text-accent-copper" />
              Portable local backup
            </Label>
            <p className="mt-1 text-metadata text-muted-foreground">
              Export your workspaces, chats, messages, and Canvas data, or preview a backup before
              restoring its missing records.
            </p>
          </div>
          <Badge
            variant={portableAccountId ? 'success' : 'outline'}
            className="shrink-0 whitespace-nowrap"
          >
            {portableAccountId ? 'Local & private' : 'Account required'}
          </Badge>
        </div>

        <div className="max-w-xl rounded-lg border border-border/70 bg-muted/30 p-3">
          <p className="inline-flex items-start gap-2 text-metadata text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            Restore is additive only: it never deletes or overwrites local records. Credentials,
            provider state, terminal transcripts, local file bytes, and private file paths are not
            included.
          </p>
        </div>

        <input
          ref={portableFileInput}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Choose VibeSpace backup file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void previewPortableRestore(file);
          }}
          data-testid="portable-backup-file"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !portableAccountId || portableState === 'exporting' || portableState === 'restoring'
            }
            onClick={() => void exportPortableBackup()}
            aria-busy={portableState === 'exporting'}
            data-testid="portable-backup-export"
          >
            {portableState === 'exporting' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {portableState === 'exporting' ? 'Creating…' : 'Export backup'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !portableAccountId || portableState === 'exporting' || portableState === 'restoring'
            }
            onClick={() => portableFileInput.current?.click()}
            data-testid="portable-backup-choose"
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Preview restore
          </Button>
          <span
            className="text-metadata text-muted-foreground"
            role="status"
            aria-live="polite"
            data-testid="portable-backup-status"
          >
            {portableMessage || 'Nothing changes until you preview and confirm.'}
          </span>
        </div>

        {portablePreview && portableState !== 'restored' ? (
          <div
            className="max-w-xl rounded-lg border border-border bg-panel/50 p-3"
            data-testid="portable-backup-preview"
          >
            <div className="grid grid-cols-2 gap-2 text-metadata sm:grid-cols-4">
              <span>
                <strong className="block text-foreground">{portablePreview.restorable}</strong>
                Missing locally
              </span>
              <span>
                <strong className="block text-foreground">{portablePreview.preservedLocal}</strong>
                Local preserved
              </span>
              <span>
                <strong className="block text-foreground">{portablePreview.counts.chats}</strong>
                Chats in file
              </span>
              <span>
                <strong className="block text-foreground">
                  {portablePreview.counts.canvasDocuments}
                </strong>
                Canvases in file
              </span>
            </div>
            <p className="mt-2 text-metadata text-muted-foreground">
              Tasks in file: <strong className="text-foreground">{portablePreview.counts.tasks ?? 0}</strong>
            </p>
            {(portablePreview.counts.tasks ?? 0) > 0 ? (
              <p className="mt-2 text-metadata text-muted-foreground">
                Imported pending reminders stay dismissed until you reschedule them.
              </p>
            ) : null}
            {portablePreview.restorable > 0 ? (
              <>
                <label className="mt-3 flex items-start gap-2 text-metadata text-muted-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={portableConfirmed}
                    onChange={(event) => setPortableConfirmed(event.target.checked)}
                    data-testid="portable-backup-confirm"
                  />
                  Restore only records that are missing on this device. Keep every existing local
                  record unchanged.
                </label>
                <Button
                  type="button"
                  variant="accent"
                  size="sm"
                  className="mt-3"
                  disabled={!portableConfirmed || portableState !== 'ready'}
                  onClick={() => void applyPortableRestore()}
                  data-testid="portable-backup-apply"
                >
                  Restore missing records
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        <p className="text-metadata text-muted-foreground" data-testid="portable-backup-history">
          Last export:{' '}
          {portableHistory.lastExportAt
            ? new Date(portableHistory.lastExportAt).toLocaleString()
            : 'Never'}
          {' · '}Last restore:{' '}
          {portableHistory.lastRestoreAt
            ? new Date(portableHistory.lastRestoreAt).toLocaleString()
            : 'Never'}
          {portableHistory.lastErrorAt && portableHistory.lastError
            ? ` · Last error: ${portableHistory.lastError}`
            : ''}
        </p>

        <div
          className="max-w-xl rounded-lg border border-border/70 bg-panel/40 p-3"
          data-testid="encrypted-cloud-backup"
        >
          <Label htmlFor="encrypted-backup-passphrase" className="inline-flex items-center gap-2">
            <LockKeyhole className="h-3.5 w-3.5 text-accent-copper" />
            Optional encrypted cloud copy
          </Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Available with cloud sync. Encryption and decryption happen on this device. Your
            passphrase is never saved or sent, and there is no passphrase recovery.
          </p>
          <Input
            id="encrypted-backup-passphrase"
            type="password"
            value={encryptedPassphrase}
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            placeholder="12–256 character passphrase"
            disabled={
              !cloudRecoveryAvailable ||
              encryptedState === 'uploading' ||
              encryptedState === 'downloading'
            }
            onChange={(event) => setEncryptedPassphrase(event.target.value)}
            className="mt-3 max-w-md"
            data-testid="encrypted-backup-passphrase"
          />
          <label className="mt-2 flex items-start gap-2 text-metadata text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={encryptedConsent}
              disabled={!cloudRecoveryAvailable}
              onChange={(event) => setEncryptedConsent(event.target.checked)}
              data-testid="encrypted-backup-consent"
            />
            I understand this uploads only an encrypted portable backup and losing the passphrase
            makes it unrecoverable.
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                !cloudRecoveryAvailable ||
                !encryptedConsent ||
                encryptedPassphrase.length < 12 ||
                encryptedState === 'uploading' ||
                encryptedState === 'downloading'
              }
              onClick={() => void uploadEncryptedBackup()}
              data-testid="encrypted-backup-upload"
            >
              {encryptedState === 'uploading' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
              )}
              {encryptedState === 'uploading' ? 'Encrypting…' : 'Encrypt & upload'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                !cloudRecoveryAvailable ||
                encryptedPassphrase.length < 12 ||
                encryptedState === 'uploading' ||
                encryptedState === 'downloading'
              }
              onClick={() => void previewEncryptedCloudRestore()}
              data-testid="encrypted-backup-download"
            >
              {encryptedState === 'downloading' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
              )}
              {encryptedState === 'downloading' ? 'Decrypting…' : 'Decrypt & preview'}
            </Button>
          </div>
          <p
            className="mt-2 text-metadata text-muted-foreground"
            role="status"
            aria-live="polite"
            data-testid="encrypted-backup-status"
          >
            {encryptedMessage ||
              (cloudRecoveryAvailable
                ? 'Enter your passphrase to upload or preview your latest encrypted copy.'
                : cloudUserId
                  ? 'Encrypted cloud backup is included with a cloud-sync plan.'
                  : 'Sign in to use encrypted cloud backup.')}
          </p>
        </div>
      </section>
    </>
  );

  // profileOnly is the only production surface (Account Center). The flag remains
  // for call-site clarity; Settings no longer mounts this component.
  void profileOnly;

  return (
    <div
      className="mc7f-account-profile flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none"
      data-testid="account-profile-panel"
    >
      {profileBody}
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} initialMode={signInMode} />
    </div>
  );
}
