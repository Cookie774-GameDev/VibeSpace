import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getCallService } from '@/features/call/CallService';

/**
 * Phone & Voice settings — everything related to the phone-jarvis cloud.
 *
 * Sections:
 *  1. Cloud connection — show the configured cloud URL + bridge status.
 *  2. PIN — set / change the 6-digit verbal PIN used to gate inbound PSTN calls.
 *  3. Allowed callers — phone numbers that skip the PIN. Caller-ID match.
 *  4. Provider keys (BYOK) — paste Groq, Anthropic, Deepgram, Cartesia keys.
 *     Stored encrypted in Supabase phone_settings.byok_provider_keys.
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
  persona: 'sage',
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

const PHONE_SETTINGS_DRAFT_KEY = 'jarvis-phone-settings-draft-v1';

function sanitizePhoneSettingsDraft(settings: PhoneSettings): PhoneSettings {
  const { byok_provider_keys: _keys, ...safe } = settings;
  return safe;
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
    // Local autosave is best-effort; Supabase remains the durable source.
  }
}

export function PhoneVoice() {
  const [settings, setSettings] = useState<PhoneSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...readPhoneSettingsDraft(),
  }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | 'disabled'>('disabled');

  const cloudUrl = getCallService().getCloudUrl();
  const configured = Boolean(cloudUrl);

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

        const { data, error } = await (supa as ReturnType<typeof getSupabaseClient> & {
          from: (t: string) => {
            select: (q: string) => {
              eq: (col: string, v: string) => {
                maybeSingle: () => Promise<{ data: PhoneSettings | null; error: { code?: string; message: string } | null }>;
              };
            };
          };
        })
          .from('phone_settings')
          .select('*')
          .eq('user_id', uid)
          .maybeSingle();

        if (cancelled) return;
        if (error && error.code !== 'PGRST116') {
          // PGRST116 = no rows; that's fine, we'll create on first save
          toast.error('Failed to load Phone settings', error.message);
        }
        if (data) {
          const next = { ...DEFAULT_SETTINGS, ...readPhoneSettingsDraft(), ...(data as PhoneSettings) };
          setSettings(next);
          writePhoneSettingsDraft(next);
        }
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
      try {
        const c = getBridgeClient();
        setBridgeStatus(c.getStatus());
      } catch {
        setBridgeStatus('disabled');
      }
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, [configured]);

  async function save(patch: Partial<PhoneSettings>, options: { silentLocal?: boolean } = {}) {
    const next = { ...settings, ...patch };
    setSettings(next);
    writePhoneSettingsDraft(next);

    if (!userId) {
      if (!options.silentLocal) {
        toast.info('Saved locally', 'Phone settings will sync when Supabase sign-in is available.');
      }
      return;
    }
    const supa = getSupabaseClient();
    if (!supa) {
      if (!options.silentLocal) {
        toast.info('Saved locally', 'Supabase is not configured in this build.');
      }
      return;
    }
    setSaving(true);
    try {
      // Loose-typed call so this compiles before we regen Supabase Database types
      const { error } = await (supa as unknown as {
        from: (t: string) => {
          upsert: (
            row: Record<string, unknown>,
            opts: { onConflict: string },
          ) => Promise<{ error: { message: string } | null }>;
        };
      })
        .from('phone_settings')
        .upsert(
          { user_id: userId, ...next },
          { onConflict: 'user_id' },
        );
      if (error) throw new Error(error.message);
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
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Phone & Voice</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Real phone calls, SMS messages, and in-app voice. Files never leave your machine.
        </p>
      </header>

      {/* 1. Cloud connection */}
      <CloudCard cloudUrl={cloudUrl} bridgeStatus={bridgeStatus} configured={configured} />

      <Separator />

      {/* Privacy disclosure */}
      <PrivacyCard />

      <Separator />

      {/* 2. PIN */}
      <PinCard userId={userId} pinLength={settings.pin_length ?? 6} onSaved={() => toast.success('PIN updated')} />

      <Separator />

      {/* 3. Allowed callers */}
      <AllowlistCard
        list={settings.caller_allowlist ?? []}
        onChange={(caller_allowlist) => save({ caller_allowlist })}
      />

      <Separator />

      {/* 4. BYOK */}
      <ByokCard
        keys={settings.byok_provider_keys ?? {}}
        onChange={(byok_provider_keys) => save({ byok_provider_keys })}
        saving={saving}
      />

      <Separator />

      {/* 5. Outbound triggers */}
      <OutboundCard
        triggers={settings.outbound_triggers ?? DEFAULT_SETTINGS.outbound_triggers!}
        onChange={(outbound_triggers) => save({ outbound_triggers })}
        userPhoneNumber={settings.user_phone_number ?? ''}
        onPhoneChange={(user_phone_number) => save({ user_phone_number }, { silentLocal: true })}
      />

      <Separator />

      {/* 6. Unlock phrase */}
      <UnlockCard
        phrase={settings.unlock_phrase ?? 'unlock shell'}
        onChange={(unlock_phrase) => save({ unlock_phrase }, { silentLocal: true })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud connection
// ---------------------------------------------------------------------------

function CloudCard({
  cloudUrl,
  bridgeStatus,
  configured,
}: {
  cloudUrl: string;
  bridgeStatus: BridgeStatus | 'disabled';
  configured: boolean;
}) {
  const status: 'good' | 'warn' | 'bad' = (() => {
    if (!configured) return 'bad';
    if (bridgeStatus === 'connected') return 'good';
    if (bridgeStatus === 'connecting' || bridgeStatus === 'reconnecting') return 'warn';
    return 'bad';
  })();

  const StatusIcon = status === 'good' ? Wifi : WifiOff;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>Cloud connection</Label>
        <div
          className={cn(
            'flex items-center gap-1.5 text-xs',
            status === 'good' && 'text-emerald-500',
            status === 'warn' && 'text-amber-500',
            status === 'bad' && 'text-rose-500',
          )}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {bridgeStatus === 'disabled' ? 'not configured' : bridgeStatus}
        </div>
      </div>

      {configured ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono break-all">
          {cloudUrl}
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500 leading-relaxed">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium mb-1">phone-jarvis cloud not configured</p>
              <p className="text-amber-500/80">
                Set <code className="font-mono">VITE_PHONE_JARVIS_CLOUD_URL</code> in your build env to your
                deployed cloud URL (e.g. <code className="font-mono">https://phone-jarvis-cloud.fly.dev</code>).
                See <code className="font-mono">phone-jarvis/cloud/README.md</code> for the deploy steps.
              </p>
            </div>
          </div>
        </div>
      )}
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
        <li>Your voice goes to the phone-jarvis cloud server you (or the operator) deployed.</li>
        <li>The transcript goes to the AI provider you configured (Anthropic / Groq / etc.).</li>
        <li>
          <strong>Your files NEVER leave this computer.</strong> The AI can read files only by asking the
          local Jarvis bridge. We use the same MCP registry the rest of Jarvis uses.
        </li>
        <li>Call metadata is kept 30 days for debugging. You can delete any time from this panel.</li>
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
      toast.error('Supabase not configured');
      return;
    }
    if (!valid) {
      toast.warning('PIN', 'Must be 4–8 digits and match confirmation.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await (supa as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ error: { message: string } | null }>;
      }).rpc('set_phone_pin', {
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

function AllowlistCard({
  list,
  onChange,
}: {
  list: string[];
  onChange: (next: string[]) => void;
}) {
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
        Numbers in E.164 format (e.g. <code className="font-mono">+15551234567</code>). Calls from these numbers
        skip the PIN and go straight to Sage.
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
// BYOK — bring your own provider keys (Groq is free; the rest are paid)
// ---------------------------------------------------------------------------

function ByokCard({
  keys,
  onChange,
  saving,
}: {
  keys: NonNullable<PhoneSettings['byok_provider_keys']>;
  onChange: (next: NonNullable<PhoneSettings['byok_provider_keys']>) => void;
  saving: boolean;
}) {
  const [local, setLocal] = useState(keys);

  useEffect(() => {
    setLocal(keys);
  }, [keys]);

  const dirty = useMemo(
    () => JSON.stringify(local) !== JSON.stringify(keys),
    [local, keys],
  );

  return (
    <section className="flex flex-col gap-3">
      <Label>Provider keys (BYOK)</Label>
      <p className="text-xs text-muted-foreground">
        Paste your own keys. When set, your keys override the operator defaults for your calls.
        Recommended starter: a free Groq key — covers STT and LLM at $0.
      </p>

      <div className="grid gap-2 max-w-xl">
        <KeyInput
          label="Groq"
          placeholder="gsk_…"
          help={
            <>
              Free, no card.{' '}
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                console.groq.com/keys
              </a>
            </>
          }
          value={local.groq ?? ''}
          onChange={(v) => setLocal({ ...local, groq: v })}
        />
        <KeyInput
          label="Anthropic"
          placeholder="sk-ant-…"
          help="Optional. Used for premium LLM on Path A (PSTN)."
          value={local.anthropic ?? ''}
          onChange={(v) => setLocal({ ...local, anthropic: v })}
        />
        <KeyInput
          label="Deepgram"
          placeholder="…"
          help="Optional. Used for premium STT on Path A."
          value={local.deepgram ?? ''}
          onChange={(v) => setLocal({ ...local, deepgram: v })}
        />
        <KeyInput
          label="Cartesia"
          placeholder="…"
          help="Optional. Used for high-quality TTS on both paths."
          value={local.cartesia ?? ''}
          onChange={(v) => setLocal({ ...local, cartesia: v })}
        />
      </div>

      <div>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => onChange(local)}
        >
          {saving ? 'Saving…' : dirty ? 'Save keys' : 'Saved'}
        </Button>
      </div>
    </section>
  );
}

function KeyInput({
  label,
  placeholder,
  help,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  help: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const masked = value && !revealed ? '•'.repeat(Math.min(value.length, 28)) : '';
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
      <Label className="pt-2 text-xs">{label}</Label>
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Input
            type={revealed ? 'text' : 'password'}
            placeholder={placeholder}
            value={revealed ? value : masked || ''}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? 'Hide' : 'Show'}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground leading-tight">{help}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outbound triggers
// ---------------------------------------------------------------------------

function OutboundCard({
  triggers,
  onChange,
  userPhoneNumber,
  onPhoneChange,
}: {
  triggers: NonNullable<PhoneSettings['outbound_triggers']>;
  onChange: (next: NonNullable<PhoneSettings['outbound_triggers']>) => void;
  userPhoneNumber: string;
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

  return (
    <section className="flex flex-col gap-3">
      <Label>Outbound phone — when Sage calls or messages you</Label>

      <div className="grid grid-cols-[120px_1fr] gap-2 items-center max-w-md">
        <Label className="text-xs">Your number</Label>
        <div className="flex gap-2">
          <Input
            placeholder="+15551234567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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
          help='You ask: "Sage, call me at 3pm."'
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
          help="Sage calls when a high-priority todo is due soon."
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
  onChange,
}: {
  phrase: string;
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

  return (
    <section className="flex flex-col gap-3">
      <Label>Shell unlock phrase</Label>
      <p className="text-xs text-muted-foreground">
        Sage will not run shell commands until you say this phrase mid-call. Resets at hangup.
        Pick something you would not say accidentally. Default: <code className="font-mono">unlock shell</code>.
      </p>

      <div className="flex gap-2 max-w-md">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
