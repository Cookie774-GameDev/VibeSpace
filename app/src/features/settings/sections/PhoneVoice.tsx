import { useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneCall,
  Lock,
  Unlock,
  AlertTriangle,
  CheckCircle2,
  Wifi,
  WifiOff,
  Plus,
  Trash2,
  Copy,
  RefreshCw,
  KeyRound,
  Server,
  Coins,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { getSupabaseClient } from '@/lib/supabase/client';
import { getBridgeClient, type BridgeStatus } from '@/lib/bridge';
import {
  callCloudUrl,
  checkCallCloudReadiness,
  type CallCloudReadiness,
} from '@/features/call/config';
import { CallAnyonePanel } from '@/features/call/thirdParty/CallAnyonePanel';
import { normalizeAssistantPersonaId, useAssistantPersonaName } from '@/lib/assistantPersona';
import { DeepgramCredentialCard } from '@/features/settings/components/DeepgramCredentialCard';
import { migrateDeepgramPlaintextCredential } from '@/lib/deepgram';
import { useAuthStore } from '@/stores/auth';
import {
  getCombinedUsage,
  unifiedCreditsFromCombined,
  type CombinedUsage,
} from '@/features/billing/planLimits';
import { secureSetApiKey } from '@/lib/security/secureApiKeys';

/**
 * Phone & Voice settings — everything related to the phone-jarvis cloud.
 *
 * Sections:
 *  1. Cloud connection — show the configured cloud URL + bridge status.
 *  2. PIN — set / change the 6-digit verbal PIN used to gate inbound PSTN calls.
 *  3. Allowed callers — phone numbers that skip the PIN. Caller-ID match.
 *  4. Provider readiness — shared secure app credentials, with one-time
 *     migration from legacy phone settings.
 *  5. Outbound calling — toggle which event categories may dial the user.
 *  6. Unlock phrase — the spoken passphrase that unlocks shell.run for
 *     the current call only.
 *  7. Audit & status — last 5 calls (read from Supabase call_audit).
 *
 * All writes go to a single `phone_settings` row keyed by `user_id`.
 * The cloud reads this row at call start. Changes take effect on next call.
 */

interface PhoneSettings {
  user_phone_number?: string | null;
  twilio_phone_number?: string | null;
  persona?: string;
  pin_length?: number;
  caller_allowlist?: string[];
  byok_provider_keys?: {
    groq?: string;
    anthropic?: string;
    deepgram?: string;
    cartesia?: string;
  };
  outbound_triggers?: {
    manual?: boolean;
    error?: boolean;
    schedule?: boolean;
    todo_due?: boolean;
  };
  unlock_phrase?: string;
}

const DEFAULT_SETTINGS: PhoneSettings = {
  persona: 'jarvis',
  pin_length: 6,
  caller_allowlist: [],
  byok_provider_keys: {},
  outbound_triggers: {
    manual: true,
    error: true,
    schedule: false,
    todo_due: false,
  },
  unlock_phrase: 'unlock shell',
};

export const PHONE_SETTINGS_DRAFT_KEY = 'jarvis-phone-settings-draft-v1';

export function separateLegacyPhoneDeepgramCredential(settings: PhoneSettings | null | undefined): {
  settings: PhoneSettings | null | undefined;
  legacyKey?: string;
  legacyApiKeys?: Partial<Record<'groq' | 'anthropic', string>>;
} {
  const keys = settings?.byok_provider_keys;
  const legacyKey = keys?.deepgram?.trim() || undefined;
  const legacyApiKeys = {
    ...(keys?.groq?.trim() ? { groq: keys.groq.trim() } : {}),
    ...(keys?.anthropic?.trim() ? { anthropic: keys.anthropic.trim() } : {}),
  };
  if (
    !settings ||
    !keys ||
    (!('deepgram' in keys) && !('groq' in keys) && !('anthropic' in keys))
  ) {
    return { settings, legacyKey, legacyApiKeys };
  }
  const {
    deepgram: _legacyDeepgram,
    groq: _legacyGroq,
    anthropic: _legacyAnthropic,
    ...safeKeys
  } = keys;
  return {
    settings: { ...settings, byok_provider_keys: safeKeys },
    legacyKey,
    legacyApiKeys,
  };
}

function sanitizePhoneSettingsDraft(settings: PhoneSettings): PhoneSettings {
  const { byok_provider_keys: _keys, ...safe } = settings;
  return {
    ...safe,
    persona: normalizeAssistantPersonaId(safe.persona ?? 'jarvis'),
  };
}

function readPhoneSettingsDraft(): PhoneSettings {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PHONE_SETTINGS_DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PhoneSettings;
    return sanitizePhoneSettingsDraft(parsed);
  } catch {
    return {};
  }
}

function writePhoneSettingsDraft(settings: PhoneSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PHONE_SETTINGS_DRAFT_KEY,
      JSON.stringify(sanitizePhoneSettingsDraft(settings)),
    );
  } catch {
    // Local autosave is best-effort; Jarvis Cloud remains the durable source.
  }
}

export function mergePhoneSettingsForDisplay(
  remote: PhoneSettings | null | undefined,
): PhoneSettings {
  const draft = readPhoneSettingsDraft();
  return {
    ...DEFAULT_SETTINGS,
    ...(remote ?? {}),
    ...draft,
  };
}

function patchPhoneSettingsDraft(base: PhoneSettings, patch: Partial<PhoneSettings>): void {
  writePhoneSettingsDraft({
    ...base,
    ...readPhoneSettingsDraft(),
    ...patch,
  });
}

export function PhoneVoice() {
  const [settings, setSettings] = useState<PhoneSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...readPhoneSettingsDraft(),
  }));
  const [loading, setLoading] = useState(true);
  const [, setSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | 'disabled'>('disabled');
  const [cloudReadiness, setCloudReadiness] = useState<CallCloudReadiness>(() => {
    const url = callCloudUrl();
    return url
      ? { state: 'checking', url }
      : { state: 'missing', message: 'This build does not include a phone backend URL.' };
  });
  const [usage, setUsage] = useState<CombinedUsage | null>(null);
  const apiKeys = useAuthStore((state) => state.apiKeys);
  const hydrateApiKeysFromVault = useAuthStore((state) => state.hydrateApiKeysFromVault);

  const cloudUrl = callCloudUrl();
  const configured = cloudReadiness.state === 'ready' || cloudReadiness.state === 'partial';
  const outboundReady =
    (cloudReadiness.state === 'ready' || cloudReadiness.state === 'partial') &&
    cloudReadiness.transports.telnyx &&
    cloudReadiness.transports.callAnyone &&
    cloudReadiness.transports.supabase;

  const refreshCloudReadiness = async () => {
    if (cloudUrl) setCloudReadiness({ state: 'checking', url: cloudUrl });
    setCloudReadiness(await checkCallCloudReadiness(cloudUrl));
  };

  useEffect(() => {
    void refreshCloudReadiness();
    void hydrateApiKeysFromVault();
    void getCombinedUsage().then(setUsage);
  }, []);

  // --- Load on mount ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supa = getSupabaseClient();
      if (!supa) {
        setLoading(false);
        return;
      }
      try {
        const { data: sessionData } = await supa.auth.getSession();
        const uid = sessionData.session?.user?.id ?? null;
        if (cancelled) return;
        setUserId(uid);

        if (!uid) {
          setLoading(false);
          return;
        }

        const { data, error } = await (
          supa as ReturnType<typeof getSupabaseClient> & {
            from: (t: string) => {
              select: (q: string) => {
                eq: (
                  col: string,
                  v: string,
                ) => {
                  maybeSingle: () => Promise<{
                    data: PhoneSettings | null;
                    error: { code?: string; message: string } | null;
                  }>;
                };
              };
            };
          }
        )
          .from('phone_settings')
          .select('*')
          .eq('user_id', uid)
          .maybeSingle();

        if (cancelled) return;
        if (error && error.code !== 'PGRST116') {
          // PGRST116 = no rows; that's fine, we'll create on first save
          toast.error('Failed to load Phone settings', error.message);
        }
        const separated = separateLegacyPhoneDeepgramCredential(data as PhoneSettings | null);
        const legacyApiEntries = Object.entries(separated.legacyApiKeys ?? {}) as Array<
          ['groq' | 'anthropic', string]
        >;
        let credentialsMigrated = true;
        if (separated.legacyKey) {
          const migrated = await migrateDeepgramPlaintextCredential(separated.legacyKey);
          credentialsMigrated = migrated.configured;
        }
        if (credentialsMigrated && legacyApiEntries.length > 0) {
          try {
            const currentApiKeys = useAuthStore.getState().apiKeys;
            const migratedApiKeys: Partial<Record<'groq' | 'anthropic', string>> = {};
            for (const [provider, key] of legacyApiEntries) {
              if (currentApiKeys[provider]?.trim()) continue;
              await secureSetApiKey(provider, key);
              migratedApiKeys[provider] = key;
            }
            useAuthStore.setState((state) => ({
              apiKeys: { ...state.apiKeys, ...migratedApiKeys },
            }));
          } catch {
            credentialsMigrated = false;
          }
        }
        if (credentialsMigrated && (separated.legacyKey || legacyApiEntries.length > 0)) {
          const safeKeys = separated.settings?.byok_provider_keys ?? {};
          const cleanup = await (
            supa as unknown as {
              from: (t: string) => {
                upsert: (
                  row: Record<string, unknown>,
                  opts: { onConflict: string },
                ) => Promise<{ error: { message: string } | null }>;
              };
            }
          )
            .from('phone_settings')
            .upsert({ user_id: uid, byok_provider_keys: safeKeys }, { onConflict: 'user_id' });
          if (cleanup.error) {
            toast.warning(
              'Provider migration cleanup pending',
              'The keys are secure in this app, but their legacy phone settings could not yet be removed.',
            );
          }
        }
        if (cancelled) return;
        const next = mergePhoneSettingsForDisplay(separated.settings);
        setSettings(next);
        writePhoneSettingsDraft(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Bridge status polling (cheap; status flips are rare) ---
  useEffect(() => {
    if (!configured) return;
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const c = getBridgeClient();
        setBridgeStatus(c.getStatus());
      } catch {
        setBridgeStatus('disabled');
      }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [configured]);

  async function save(
    patch: Partial<PhoneSettings>,
    options: { silentLocal?: boolean; notify?: boolean } = {},
  ) {
    const next =
      separateLegacyPhoneDeepgramCredential({ ...settings, ...patch }).settings ?? DEFAULT_SETTINGS;
    setSettings(next);
    writePhoneSettingsDraft(next);

    if (!userId) {
      if (options.notify) {
        toast.success('Auto saved', 'Phone settings saved on this device.');
      } else if (!options.silentLocal) {
        toast.info(
          'Saved locally',
          'Phone settings will sync when VibeSpace Cloud sign-in is available.',
        );
      }
      return;
    }
    const supa = getSupabaseClient();
    if (!supa) {
      if (!options.silentLocal) {
        toast.info('Saved locally', 'VibeSpace Cloud is not configured in this build.');
      }
      return;
    }
    setSaving(true);
    try {
      // Loose-typed call so this compiles before we regen Supabase Database types
      const { error } = await (
        supa as unknown as {
          from: (t: string) => {
            upsert: (
              row: Record<string, unknown>,
              opts: { onConflict: string },
            ) => Promise<{ error: { message: string } | null }>;
          };
        }
      )
        .from('phone_settings')
        .upsert({ user_id: userId, ...next }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
      if (options.notify) {
        toast.success('Auto saved', 'Phone settings updated.');
      }
    } catch (e) {
      toast.error('Save failed', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-secondary text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="mc7f-settings-phone-voice flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none [html[data-theme=monochrome]_&_*]:!animate-none [html[data-theme=monochrome]_&_*]:!blur-none [html[data-theme=monochrome]_&_*]:backdrop-blur-none [html[data-theme=monochrome]_&_*]:transition-none [html[data-theme=monochrome]_&_*]:focus-visible:outline [html[data-theme=monochrome]_&_*]:focus-visible:outline-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-ring motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:transition-none">
      <header className="rounded-xl border border-border bg-card/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-copper">
          Communications
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
          Phone & Voice
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Connect the services that hear, speak, and place calls—then review permissions and
          shared-credit impact before anything paid starts.
        </p>
      </header>

      <SectionHeading
        eyebrow="1 · Identity"
        title="My number"
        description="Choose the number Jarvis uses only when calling or messaging you, and keep the existing automation controls."
      />
      <OutboundCard
        triggers={settings.outbound_triggers ?? DEFAULT_SETTINGS.outbound_triggers!}
        onChange={(outbound_triggers) => save({ outbound_triggers })}
        userPhoneNumber={settings.user_phone_number ?? ''}
        onPhoneDraftChange={(user_phone_number) =>
          patchPhoneSettingsDraft(settings, { user_phone_number })
        }
        onPhoneChange={(user_phone_number) => save({ user_phone_number }, { silentLocal: true })}
      />

      <Separator />

      <SectionHeading
        eyebrow="2 · People"
        title="Contacts"
        description="Saved call contacts can include a name, relationship, optional HTTPS profile image, phone number, and private notes. Choose one in the Test call workflow below."
      />

      <Separator />

      <SectionHeading
        eyebrow="3 · Carrier"
        title="Calling provider"
        description="The hosted phone backend and carrier must pass a real health check before VibeSpace can place a call."
      />
      <CloudCard
        readiness={cloudReadiness}
        bridgeStatus={bridgeStatus}
        onRetry={() => void refreshCloudReadiness()}
      />

      <Separator />

      <SectionHeading
        eyebrow="4 · Speech and intelligence"
        title="Voice provider"
        description="Provider credentials live in the secure app-wide store. Phone & Voice reads their connection state and never asks you to enter the same key twice."
      />
      <ProviderReadiness apiKeys={apiKeys} />
      <PrivacyCard />

      <Separator />

      <SectionHeading
        eyebrow="5 · Safe dry run"
        title="Test call"
        description="Choose a recipient, define the brief, then review the server-calculated reservation before explicitly approving the call."
      />
      {usage ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          <Coins className="size-4 text-accent-copper" aria-hidden />
          <span className="text-foreground">
            {unifiedCreditsFromCombined(usage)?.remaining.toLocaleString() ?? 0} shared credits
            available
          </span>
          <span className="text-muted-foreground">· 1 credit = $0.001 provider usage</span>
        </div>
      ) : null}
      <CallAnyonePanel
        availability={{
          ready: outboundReady,
          message:
            cloudReadiness.state === 'partial'
              ? 'The backend is reachable, but Telnyx, Call Anyone, or account credits are not fully configured.'
              : cloudReadiness.state === 'ready'
                ? undefined
                : 'Outbound calling stays off until the configured backend passes its health check.',
        }}
      />

      <Separator />

      <SectionHeading
        eyebrow="Inbound security"
        title="Who can reach you"
        description="PIN and allowlist controls protect incoming calls. They do not weaken app approvals or shell permissions."
      />

      {/* 2. PIN */}
      <PinCard
        userId={userId}
        pinLength={settings.pin_length ?? 6}
        onSaved={() => toast.success('PIN updated')}
      />

      <Separator />

      {/* 3. Allowed callers */}
      <AllowlistCard
        list={settings.caller_allowlist ?? []}
        onChange={(caller_allowlist) => save({ caller_allowlist })}
      />

      <Separator />

      {/* 6. Unlock phrase */}
      <UnlockCard
        phrase={settings.unlock_phrase ?? 'unlock shell'}
        onDraftChange={(unlock_phrase) => patchPhoneSettingsDraft(settings, { unlock_phrase })}
        onChange={(unlock_phrase) => save({ unlock_phrase }, { silentLocal: true })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud connection
// ---------------------------------------------------------------------------

function CloudCard({
  readiness,
  bridgeStatus,
  onRetry,
}: {
  readiness: CallCloudReadiness;
  bridgeStatus: BridgeStatus | 'disabled';
  onRetry: () => void;
}) {
  const status: 'good' | 'warn' | 'bad' =
    readiness.state === 'ready'
      ? 'good'
      : readiness.state === 'checking' || readiness.state === 'partial'
        ? 'warn'
        : 'bad';

  const StatusIcon = status === 'good' ? Wifi : WifiOff;
  const title =
    readiness.state === 'ready'
      ? 'Phone backend ready'
      : readiness.state === 'checking'
        ? 'Checking phone backend'
        : readiness.state === 'partial'
          ? 'Phone backend needs provider setup'
          : readiness.state === 'unreachable'
            ? 'Phone backend is unreachable'
            : 'Phone backend needs configuration';

  return (
    <section aria-labelledby="phone-backend-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            System readiness
          </p>
          <h3 id="phone-backend-title" className="mt-1 text-lg font-semibold text-foreground">
            {title}
          </h3>
        </div>
        <div
          className={cn(
            'flex items-center gap-1.5 text-xs',
            status === 'good' && 'text-emerald-500',
            status === 'warn' && 'text-amber-500',
            status === 'bad' && 'text-rose-500',
          )}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {readiness.state}
        </div>
      </div>

      {'url' in readiness ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs break-all">
          <span className="font-mono">{readiness.url}</span>
          {readiness.state === 'ready' || readiness.state === 'partial' ? (
            <p className="mt-2 font-sans text-muted-foreground">
              In-app voice: {readiness.transports.livekit ? 'ready' : 'not configured'} · Outbound
              phone:{' '}
              {readiness.transports.callAnyone && readiness.transports.telnyx
                ? 'ready'
                : 'not configured'}{' '}
              · Account/credits: {readiness.transports.supabase ? 'ready' : 'not configured'} ·
              Desktop bridge: {bridgeStatus}
            </p>
          ) : null}
          {readiness.state === 'unreachable' ? (
            <p className="mt-2 font-sans text-destructive">{readiness.message}</p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500 leading-relaxed">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium mb-1">{title}</p>
              <p className="text-amber-500/80">{readiness.message}</p>
            </div>
          </div>
        </div>
      )}
      {readiness.state !== 'ready' ? (
        <Button className="self-start" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden />
          Check again
        </Button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Privacy disclosure
// ---------------------------------------------------------------------------

function PrivacyCard() {
  return (
    <section className="rounded-md border border-border bg-elevated/40 px-4 py-3 text-secondary text-muted-foreground leading-relaxed">
      <p className="text-foreground mb-1.5 font-medium flex items-center gap-1.5">
        <Lock className="h-3.5 w-3.5 text-accent-cyan" />
        What happens when you call (or are called)
      </p>
      <ul className="text-xs space-y-1 list-disc list-inside">
        <li>
          During a hosted call, audio goes to the VibeSpace call service. Telnyx carries the call;
          Deepgram provides supported live transcription and speech.
        </li>
        <li>
          The conversation uses the explicitly selected AI route. BYOK calls use your provider
          account; hosted routes use the shared credit pool.
        </li>
        <li>
          <strong>Your files stay on this computer.</strong> A call can access a file only through
          the local bridge and the app’s normal permission and approval controls.
        </li>
        <li>
          Call metadata is kept 30 days for debugging. You can delete any time from this panel.
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PIN — set / change
// ---------------------------------------------------------------------------

function PinCard({
  userId,
  pinLength,
  onSaved,
}: {
  userId: string | null;
  pinLength: number;
  onSaved: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = pin.length >= 4 && pin.length <= 8 && /^\d+$/.test(pin) && pin === confirm;

  async function set() {
    if (!userId) return;
    const supa = getSupabaseClient();
    if (!supa) {
      toast.error('VibeSpace Cloud is not configured in this build.');
      return;
    }
    if (!valid) {
      toast.warning('PIN', 'Must be 4–8 digits and match confirmation.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await (
        supa as unknown as {
          rpc: (
            name: string,
            args: Record<string, unknown>,
          ) => Promise<{ error: { message: string } | null }>;
        }
      ).rpc('set_phone_pin', {
        p_user_id: userId,
        p_pin: pin,
      });
      if (error) throw new Error(error.message);
      setPin('');
      setConfirm('');
      onSaved();
    } catch (e) {
      toast.error('PIN save failed', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <Label>Verbal PIN (inbound calls)</Label>
      <p className="text-xs text-muted-foreground">
        Recommended 6 digits. Spoken at the start of inbound calls. Stored hashed; never plaintext.
        Three wrong PINs locks the caller out for an hour.
      </p>
      <div className="grid grid-cols-2 gap-2 max-w-md">
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="New PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
        />
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 8))}
        />
      </div>
      <div>
        <Button onClick={set} disabled={!valid || saving} size="sm">
          {saving ? 'Saving…' : `Set ${pin.length || pinLength}-digit PIN`}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Allowed callers (caller-ID skip-PIN)
// ---------------------------------------------------------------------------

function AllowlistCard({ list, onChange }: { list: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (list.includes(v)) {
      toast.info('Already on list');
      return;
    }
    onChange([...list, v]);
    setDraft('');
  };

  return (
    <section className="flex flex-col gap-3">
      <Label>Allowed callers (skip PIN)</Label>
      <p className="text-xs text-muted-foreground">
        Numbers in E.164 format (e.g. <code className="font-mono">+15551234567</code>). Calls from
        these numbers skip the PIN and go straight to the assistant.
      </p>

      <div className="flex gap-2 max-w-md">
        <Input
          placeholder="+15551234567"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {list.length > 0 && (
        <ul className="flex flex-col gap-1 max-w-md">
          {list.map((n) => (
            <li
              key={n}
              className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs font-mono"
            >
              <span>{n}</span>
              <button
                onClick={() => onChange(list.filter((x) => x !== n))}
                aria-label={`Remove ${n}`}
                className="text-muted-foreground hover:text-rose-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared provider readiness
// ---------------------------------------------------------------------------

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-copper">
        {eyebrow}
      </p>
      <h3 className="mt-1 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function ProviderReadiness({
  apiKeys,
}: {
  apiKeys: Partial<Record<'groq' | 'anthropic', string>>;
}) {
  const openProviders = () => {
    window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: 'providers' } }));
  };
  const providers = [
    {
      id: 'groq' as const,
      label: 'Groq',
      description:
        'Fast language and speech-to-text requests when you choose Groq. Your own usage is billed by Groq, not VibeSpace credits.',
    },
    {
      id: 'anthropic' as const,
      label: 'Anthropic',
      description:
        'Reasoning and conversation requests when you explicitly route a supported voice workflow to Anthropic.',
    },
  ];

  return (
    <section className="grid gap-3 lg:grid-cols-2" aria-label="Phone and voice providers">
      {providers.map((provider) => {
        const connected = Boolean(apiKeys[provider.id]?.trim());
        return (
          <article key={provider.id} className="rounded-xl border border-border bg-card/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-accent-copper" aria-hidden />
                <h4 className="font-semibold text-foreground">{provider.label}</h4>
              </div>
              <span
                className={cn(
                  'text-xs font-medium',
                  connected ? 'text-emerald-500' : 'text-muted-foreground',
                )}
              >
                {provider.label} {connected ? 'connected' : 'not connected'}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {provider.description}
            </p>
          </article>
        );
      })}
      <div className="lg:col-span-2">
        <DeepgramCredentialCard compact />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Deepgram powers supported speech recognition (Flux) and speech output (Aura). The same
          secure key is shared with Providers, Speech to Text, and Voice. Hosted calls use only the
          operator’s server-side credential; your desktop key is never sent to the call backend.
        </p>
      </div>
      <article className="lg:col-span-2 rounded-xl border border-border bg-muted/25 p-4">
        <div className="flex items-start gap-3">
          <Server className="mt-0.5 size-4 shrink-0 text-accent-cyan" aria-hidden />
          <div className="flex-1">
            <h4 className="font-semibold text-foreground">Hosted phone providers</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              VibeSpace routes outbound carrier service through Telnyx and hosted voice through
              server-side Deepgram credentials. Those operator secrets never belong in this app.
              BYOK and local voice do not consume the shared company-credit pool.
            </p>
          </div>
        </div>
      </article>
      <Button className="justify-self-start" variant="outline" onClick={openProviders}>
        <KeyRound className="size-4" aria-hidden />
        Manage provider keys
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Outbound triggers
// ---------------------------------------------------------------------------

function OutboundCard({
  triggers,
  onChange,
  userPhoneNumber,
  onPhoneDraftChange,
  onPhoneChange,
}: {
  triggers: NonNullable<PhoneSettings['outbound_triggers']>;
  onChange: (next: NonNullable<PhoneSettings['outbound_triggers']>) => void;
  userPhoneNumber: string;
  onPhoneDraftChange: (next: string) => void;
  onPhoneChange: (next: string) => void;
}) {
  const [phone, setPhone] = useState(userPhoneNumber);
  const onPhoneChangeRef = useRef(onPhoneChange);
  useEffect(() => setPhone(userPhoneNumber), [userPhoneNumber]);
  useEffect(() => {
    onPhoneChangeRef.current = onPhoneChange;
  }, [onPhoneChange]);
  useEffect(() => {
    if (phone === userPhoneNumber) return;
    const id = window.setTimeout(() => onPhoneChangeRef.current(phone), 650);
    return () => window.clearTimeout(id);
  }, [phone, userPhoneNumber]);

  const assistantName = useAssistantPersonaName();

  return (
    <section className="flex flex-col gap-3">
      <Label>Outbound phone — when {assistantName} calls or messages you</Label>

      <div className="grid grid-cols-[120px_1fr] gap-2 items-center max-w-md">
        <Label htmlFor="phone-voice-my-number" className="text-xs">
          Your number
        </Label>
        <div className="flex gap-2">
          <Input
            id="phone-voice-my-number"
            placeholder="+15551234567"
            value={phone}
            onChange={(e) => {
              const next = e.target.value;
              setPhone(next);
              onPhoneDraftChange(next);
            }}
            onBlur={() => phone !== userPhoneNumber && onPhoneChange(phone)}
            className="font-mono text-xs"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Toggle which categories may dial or text your phone. Default: manual + error only.
      </p>

      <div className="flex flex-col gap-2 max-w-md">
        <TriggerRow
          label="Manual"
          help={`You ask: "${assistantName}, call me at 3pm."`}
          value={!!triggers.manual}
          onChange={(v) => onChange({ ...triggers, manual: v })}
        />
        <TriggerRow
          label="Errors"
          help="Build failed, terminal exit code ≠ 0, runtime crash."
          value={!!triggers.error}
          onChange={(v) => onChange({ ...triggers, error: v })}
        />
        <TriggerRow
          label="Schedule"
          help="Daily check-in at a fixed time (configure in Schedule)."
          value={!!triggers.schedule}
          onChange={(v) => onChange({ ...triggers, schedule: v })}
        />
        <TriggerRow
          label="Todo deadlines"
          help={`${assistantName} calls when a high-priority todo is due soon.`}
          value={!!triggers.todo_due}
          onChange={(v) => onChange({ ...triggers, todo_due: v })}
        />
      </div>
    </section>
  );
}

function TriggerRow({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between rounded-md border border-border px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-muted-foreground">{help}</div>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unlock phrase
// ---------------------------------------------------------------------------

function UnlockCard({
  phrase,
  onDraftChange,
  onChange,
}: {
  phrase: string;
  onDraftChange: (next: string) => void;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(phrase);
  const onChangeRef = useRef(onChange);
  useEffect(() => setDraft(phrase), [phrase]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const dirty = draft.trim() !== phrase.trim();
  useEffect(() => {
    if (!dirty || draft.trim().length < 3) return;
    const id = window.setTimeout(() => onChangeRef.current(draft.trim()), 800);
    return () => window.clearTimeout(id);
  }, [dirty, draft]);

  const assistantName = useAssistantPersonaName();

  return (
    <section className="flex flex-col gap-3">
      <Label>Shell unlock phrase</Label>
      <p className="text-xs text-muted-foreground">
        {assistantName} will not run shell commands until you say this phrase mid-call. Resets at
        hangup. Pick something you would not say accidentally. Default:{' '}
        <code className="font-mono">unlock shell</code>.
      </p>

      <div className="flex gap-2 max-w-md">
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onDraftChange(e.target.value);
          }}
          placeholder="unlock shell"
        />
        <Button
          size="sm"
          variant={dirty ? 'default' : 'outline'}
          disabled={!dirty || draft.trim().length < 3}
          onClick={() => onChange(draft.trim())}
        >
          Save
        </Button>
      </div>
    </section>
  );
}
