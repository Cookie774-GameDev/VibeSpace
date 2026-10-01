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
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { getSupabaseClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { SignInDialog } from '@/features/auth/SignInDialog';

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

  const [draftName, setDraftName] = useState(displayName);
  const [saveState, setSaveState] = useState<ProfileSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInMode, setSignInMode] = useState<'signin' | 'signup'>('signin');
  const [copied, setCopied] = useState(false);
  const [cloudHydrating, setCloudHydrating] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const signOutOperation = useRef<symbol | null>(null);
  const mounted = useRef(true);

  const cloudEmail = cloudSession?.email;
  const cloudUserId = cloudSession?.user_id?.trim() || null;

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
  }, [cloudUserId]);

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

      <section className="flex flex-col gap-3">
        <Label>Local user ID</Label>
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
        <p className="text-metadata text-muted-foreground">
          Generated locally. Used as the owner of your offline data.
        </p>
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
