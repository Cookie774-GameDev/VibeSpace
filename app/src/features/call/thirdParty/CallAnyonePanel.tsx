import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, Check, ChevronLeft, PhoneCall, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getSupabaseClient } from '@/lib/supabase/client';
import { createThirdPartyCallClient, ThirdPartyCallError } from './client';
import {
  callCreditImpact,
  normalizeE164Phone,
  validateCallBrief,
  validateCallRecipient,
} from './callSetup';
import type {
  CallDestinationType,
  JarvisContact,
  ThirdPartyCallDraft,
  ThirdPartyCallJob,
} from './types';

type CallClient = ReturnType<typeof createThirdPartyCallClient>;
type SuppliedCallClient = Omit<CallClient, 'listContacts' | 'listHistory'> &
  Partial<Pick<CallClient, 'listContacts' | 'listHistory'>>;

const OPENING_DISCLOSURE = 'Hello, I am the VibeSpace AI assistant calling on behalf of my user.';

function friendlyError(error: unknown, job?: ThirdPartyCallJob | null): string {
  const code = error instanceof Error ? error.message : 'call_request_failed';
  if (code === 'budget_exceeded') {
    const available =
      error instanceof ThirdPartyCallError
        ? error.availableCredits
        : error &&
            typeof error === 'object' &&
            'availableCredits' in error &&
            typeof error.availableCredits === 'number'
          ? error.availableCredits
          : undefined;
    return [
      `This call needs an estimated reservation of ${job?.maximumCreditReservation ?? 'the displayed'} credits.`,
      typeof available === 'number'
        ? `Your available balance is ${available} credits.`
        : 'Your available balance is too low.',
      'Add credits, shorten the maximum call duration, use BYOK where supported, or cancel.',
    ].join(' ');
  }
  const known: Record<string, string> = {
    calling_unconfigured: 'Calling is not configured by the VibeSpace operator yet.',
    budget_exceeded: 'There are not enough credits available for this call.',
    approval_required: 'The call changed after review. Please review it again.',
    invalid_destination: 'Enter a valid non-emergency phone number including country code.',
    unauthorized: 'Sign in to VibeSpace Cloud before preparing a call.',
    provider_unavailable:
      'The phone provider could not start this call. No call was placed; try again shortly.',
    call_request_failed:
      'The call backend did not accept this request. No call was placed; try again shortly.',
  };
  return known[code] ?? 'The call request could not be completed. Please try again.';
}

export function CallAnyonePanel({
  client: suppliedClient,
  availability = { ready: true },
}: {
  client?: SuppliedCallClient;
  availability?: { ready: boolean; message?: string };
}) {
  const client = useMemo(() => {
    if (suppliedClient) return suppliedClient;
    const supabase = getSupabaseClient();
    return supabase ? createThirdPartyCallClient(supabase) : null;
  }, [suppliedClient]);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [profileImageUrl, setProfileImageUrl] = useState('');
  const [contactNotes, setContactNotes] = useState('');
  const [destinationType, setDestinationType] =
    useState<Exclude<CallDestinationType, 'owner'>>('business');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [maximumMinutes, setMaximumMinutes] = useState(5);
  const [setupStep, setSetupStep] = useState<1 | 2>(1);
  const [job, setJob] = useState<ThirdPartyCallJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<JarvisContact[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [history, setHistory] = useState<ThirdPartyCallJob[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );

  const refreshDirectory = useCallback(async () => {
    if (!availability.ready || !client?.listContacts || !client.listHistory) return;
    setDirectoryStatus('loading');
    try {
      const [nextContacts, nextHistory] = await Promise.all([
        client.listContacts(),
        client.listHistory(),
      ]);
      setContacts(nextContacts);
      setHistory(nextHistory);
      setDirectoryStatus('ready');
    } catch {
      setDirectoryStatus('error');
    }
  }, [availability.ready, client]);

  useEffect(() => {
    void refreshDirectory();
  }, [refreshDirectory]);

  useEffect(() => {
    if (!client || !job || ['completed', 'failed', 'cancelled', 'blocked'].includes(job.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void client
        .get(job.id)
        .then((next) => setJob(next))
        .catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [client, job?.id, job?.status]);

  async function prepare() {
    if (!client) {
      setError('VibeSpace Cloud is not configured in this build.');
      return;
    }
    setError(null);
    const recipientError = validateCallRecipient(name, phone);
    const briefError = validateCallBrief(purpose, maximumMinutes);
    if (recipientError || briefError) {
      setError(recipientError ?? briefError);
      return;
    }
    setBusy(true);
    try {
      const seconds = Math.max(60, Math.min(900, Math.round(maximumMinutes * 60)));
      const normalizedPhone = selectedContactId ? '' : normalizeE164Phone(phone);
      if (!selectedContactId && !normalizedPhone) throw new Error('invalid_destination');
      const destinationPhone = normalizedPhone ?? '';
      const contact = selectedContactId
        ? { id: selectedContactId }
        : destinationType === 'one_time_number'
          ? null
          : await client.saveContact({
              displayName: name.trim(),
              phone: destinationPhone,
              destinationType,
              relationship: relationship.trim() || undefined,
              notes: contactNotes.trim() || undefined,
              profileImageUrl: profileImageUrl.trim() || undefined,
              allowAiCalls: true,
              allowAiMessages: false,
              consentStatus: 'user_asserted',
            });
      const draft: ThirdPartyCallDraft = {
        contactId: contact?.id,
        destinationType,
        destinationPhone,
        destinationDisplayName: name.trim(),
        goal:
          destinationType === 'business'
            ? 'business_information'
            : destinationType === 'saved_contact'
              ? 'relay_message'
              : 'custom_information_request',
        purpose: purpose.trim(),
        userInstructions: instructions.trim(),
        approvedScript: instructions.trim() || purpose.trim(),
        openingDisclosure: OPENING_DISCLOSURE,
        allowedActions: ['ask_questions'],
        maximumDurationSeconds: seconds,
        maximumCreditReservation: Math.max(100, Math.ceil(seconds * 1.6)),
      };
      setJob(await client.prepare(draft));
      void refreshDirectory();
    } catch (cause) {
      setError(friendlyError(cause, job));
    } finally {
      setBusy(false);
    }
  }

  async function approveAndCall() {
    if (!client || !job) return;
    setBusy(true);
    setError(null);
    try {
      await client.approve(job.id);
      setJob(await client.start(job.id));
      void refreshDirectory();
    } catch (cause) {
      setError(friendlyError(cause, job));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (client && job) {
      setBusy(true);
      try {
        await client.cancel(job.id);
      } catch {
        // The local form still closes; the server operation is idempotent.
      } finally {
        setBusy(false);
      }
    }
    setJob(null);
  }

  async function decideProtectedAction(approved: boolean) {
    if (!client || !job) return;
    setBusy(true);
    setError(null);
    try {
      setJob(approved ? await client.approveLive(job.id) : await client.declineLive(job.id));
    } catch (cause) {
      setError(friendlyError(cause, job));
    } finally {
      setBusy(false);
    }
  }

  const isQueued = job?.status === 'queued' || job?.status === 'dialing';
  const impact = job ? callCreditImpact(job.maximumCreditReservation ?? 0) : null;

  function continueToBrief() {
    const validation = selectedContactId
      ? name.trim()
        ? null
        : 'Enter a recipient name.'
      : validateCallRecipient(name, phone);
    setError(validation);
    if (!validation) setSetupStep(2);
  }

  return (
    <section aria-labelledby="call-anyone-title" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="rounded-lg border border-border bg-muted/40 p-2">
          <PhoneCall className="size-4" aria-hidden="true" />
        </span>
        <div>
          <h3 id="call-anyone-title" className="text-sm font-semibold text-foreground">
            Call Anyone
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Prepare a bounded AI-assisted call. Nothing is dialed until you review and approve.
          </p>
        </div>
      </div>
      {!availability.ready ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-600"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {availability.message ??
            'Outbound calling is unavailable until the phone backend is ready.'}
        </p>
      ) : null}
      {contacts.length > 0 ? (
        <div className="rounded-xl border border-border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Saved contacts
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {contacts.map((contact) => (
              <Button
                key={contact.id}
                type="button"
                variant="outline"
                onClick={() => {
                  setDestinationType(contact.destinationType);
                  setSelectedContactId(contact.id);
                  setName(contact.displayName);
                  setRelationship(contact.relationship ?? '');
                  setProfileImageUrl(contact.profileImageUrl ?? '');
                  setContactNotes(contact.notes ?? '');
                }}
              >
                {contact.profileImageUrl ? (
                  <img
                    src={contact.profileImageUrl}
                    alt=""
                    className="size-5 rounded-full object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                {contact.displayName}
                {contact.relationship ? (
                  <span className="text-muted-foreground">{contact.relationship}</span>
                ) : null}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {!job ? (
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <ol aria-label="Outbound call setup progress" className="mb-5 grid grid-cols-3 gap-2">
            {['Recipient', 'Call brief', 'Review'].map((label, index) => {
              const number = index + 1;
              const active = number === setupStep;
              const complete = number < setupStep;
              return (
                <li
                  key={label}
                  aria-current={active ? 'step' : undefined}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full border ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : complete
                          ? 'border-emerald-500/50 text-emerald-500'
                          : 'border-border'
                    }`}
                  >
                    {complete ? <Check className="size-3" aria-hidden /> : number}
                  </span>
                  <span className={active ? 'font-medium text-foreground' : ''}>{label}</span>
                </li>
              );
            })}
          </ol>

          {setupStep === 1 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="call-anyone-destination-type">Recipient type</Label>
                <select
                  id="call-anyone-destination-type"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={destinationType}
                  onChange={(event) => {
                    setSelectedContactId(null);
                    setDestinationType(event.target.value as Exclude<CallDestinationType, 'owner'>);
                  }}
                >
                  <option value="business">Business</option>
                  <option value="saved_contact">Personal contact</option>
                  <option value="one_time_number">One-time number</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-anyone-number">Recipient phone number</Label>
                <Input
                  id="call-anyone-number"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  disabled={Boolean(selectedContactId)}
                  placeholder={
                    selectedContactId ? 'Stored securely for this contact' : '+1 312 555 0192'
                  }
                  onChange={(event) => {
                    setSelectedContactId(null);
                    setPhone(event.target.value);
                  }}
                  aria-describedby="call-anyone-number-help"
                />
                <p id="call-anyone-number-help" className="text-xs text-muted-foreground">
                  Include the country code. Emergency numbers are blocked.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-anyone-name">Recipient name</Label>
                <Input
                  id="call-anyone-name"
                  placeholder="Business or contact"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                />
                {selectedContactId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setSelectedContactId(null);
                      setPhone('');
                    }}
                  >
                    Use a different number
                  </Button>
                ) : null}
              </div>
              {destinationType !== 'one_time_number' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="call-anyone-relationship">Relationship (optional)</Label>
                    <Input
                      id="call-anyone-relationship"
                      value={relationship}
                      maxLength={120}
                      onChange={(event) => setRelationship(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="call-anyone-profile-image">Profile image URL (optional)</Label>
                    <Input
                      id="call-anyone-profile-image"
                      type="url"
                      inputMode="url"
                      placeholder="https://…"
                      value={profileImageUrl}
                      maxLength={2_048}
                      onChange={(event) => setProfileImageUrl(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="call-anyone-contact-notes">Contact notes (optional)</Label>
                    <Textarea
                      id="call-anyone-contact-notes"
                      value={contactNotes}
                      maxLength={2_000}
                      rows={2}
                      onChange={(event) => setContactNotes(event.target.value)}
                    />
                  </div>
                </>
              ) : null}
              <div className="sm:col-span-2 flex justify-end">
                <Button disabled={!availability.ready} onClick={continueToBrief}>
                  Continue to call brief
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="call-anyone-purpose">Purpose</Label>
                <Input
                  id="call-anyone-purpose"
                  placeholder="What should the call accomplish?"
                  value={purpose}
                  maxLength={500}
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="call-anyone-instructions">Instructions (optional)</Label>
                <Textarea
                  id="call-anyone-instructions"
                  placeholder="Questions to ask and boundaries to follow"
                  value={instructions}
                  maxLength={2_000}
                  rows={3}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-anyone-duration">Maximum duration (minutes)</Label>
                <Input
                  id="call-anyone-duration"
                  type="number"
                  min={1}
                  max={15}
                  value={maximumMinutes}
                  onChange={(event) => setMaximumMinutes(Number(event.target.value))}
                />
              </div>
              <div className="flex items-end justify-end gap-2">
                <Button variant="ghost" onClick={() => setSetupStep(1)}>
                  <ChevronLeft className="size-4" aria-hidden />
                  Back
                </Button>
                <Button disabled={busy} onClick={() => void prepare()}>
                  {busy ? 'Checking plan and credits…' : 'Review call'}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          {['completed', 'failed', 'cancelled', 'blocked'].includes(job.status) ? (
            <div role="status" className="space-y-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium capitalize text-foreground">Call {job.status}</p>
                  <p className="text-sm text-muted-foreground">
                    {job.destinationDisplayName} · {job.destinationMasked}
                  </p>
                </div>
              </div>
              {job.resultSummary ? (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
                  {job.resultSummary}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Reserved: {job.reservedCredits ?? 0} · Actual: {job.settledCredits ?? 0} · Returned:{' '}
                {Math.max(0, (job.reservedCredits ?? 0) - (job.settledCredits ?? 0))}
              </p>
              <Button variant="outline" onClick={() => setJob(null)}>
                New call
              </Button>
            </div>
          ) : isQueued ||
            job.status === 'in_progress' ||
            job.status === 'awaiting_live_approval' ? (
            <div className="space-y-4">
              <div role="status" className="flex items-center gap-3">
                <PhoneCall className="size-5 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium text-foreground">
                    {job.status === 'queued'
                      ? 'Call queued'
                      : job.status === 'awaiting_live_approval'
                        ? 'Approval needed'
                        : 'Call in progress'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {job.destinationDisplayName} · {job.destinationMasked}
                  </p>
                </div>
              </div>
              {job.status === 'awaiting_live_approval' ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-sm font-medium text-foreground">
                    {job.pendingActionSummary ?? 'The recipient requested a protected action.'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Payment credentials and authentication codes can never be shared.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button disabled={busy} onClick={() => void decideProtectedAction(true)}>
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decideProtectedAction(false)}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
                End call
              </Button>
              <Button variant="ghost" disabled title="Take over is unavailable on this transport.">
                Take over unavailable
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
                <h4 className="font-medium text-foreground">Confirm before calling</h4>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Recipient</dt>
                  <dd className="font-medium text-foreground">
                    {job.destinationDisplayName} · {job.destinationMasked}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Maximum</dt>
                  <dd className="font-medium text-foreground">
                    {Math.ceil((job.maximumDurationSeconds ?? 0) / 60)} min ·{' '}
                    {job.maximumCreditReservation ?? 0} credits reserved
                  </dd>
                </div>
                <div className="sm:col-span-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <dt className="font-medium text-foreground">Credit impact before dialing</dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{impact?.copy}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Purpose</dt>
                  <dd className="text-foreground">{job.purpose}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Opening disclosure</dt>
                  <dd className="flex gap-2 text-foreground">
                    <Bot className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {job.openingDisclosure}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Allowed actions</dt>
                  <dd className="text-foreground">
                    {(job.allowedActions ?? []).join(', ') || 'Conversation only'}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void approveAndCall()}>
                  {busy ? 'Starting…' : 'Approve and call'}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setJob(null)}>
                  Edit
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {error ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
      <div className="rounded-xl border border-border bg-card/30 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-foreground">Call history & diagnostics</h3>
          <Button
            type="button"
            variant="ghost"
            disabled={!client?.listHistory || directoryStatus === 'loading'}
            onClick={() => void refreshDirectory()}
          >
            Refresh
          </Button>
        </div>
        {directoryStatus === 'error' ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Call history could not be loaded. Calling remains available; retry when the backend is
            reachable.
          </p>
        ) : history.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No recent calls for this account.</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {entry.destinationDisplayName} · {entry.destinationMasked}
                  </span>
                  <span className="capitalize text-muted-foreground">{entry.status}</span>
                </div>
                {entry.resultSummary ? (
                  <p className="mt-1 text-sm text-muted-foreground">{entry.resultSummary}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry.createdAt
                    ? new Date(entry.createdAt).toLocaleString()
                    : 'Time unavailable'}
                  {' · '}
                  {entry.settledCredits ?? 0} credits
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
