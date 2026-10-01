import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, Eraser, Gift, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { telemetryConsentStore } from '@/features/telemetry/telemetryConsent';
import {
  getAccountTelemetryConsent,
  updateAccountTelemetryConsent,
  type AccountTelemetryConsent,
} from '@/features/telemetry/accountTelemetryConsent';
import { toast } from '@/components/ui/toast';

const DATA_CLASSES = [
  {
    key: 'productUsage' as const,
    label: 'Share product usage',
    detail:
      'Feature opens, settings changes, coarse performance timing, app version, and platform family.',
  },
  {
    key: 'diagnostics' as const,
    label: 'Share diagnostics',
    detail:
      'Sanitized error categories, failed operation type, retry count, and crash diagnostics—never stack values containing user content.',
  },
  {
    key: 'toolOutcomes' as const,
    label: 'Share tool outcomes',
    detail:
      'Tool name, approved/denied/cancelled/succeeded state, duration, and failure category. Commands, arguments, paths, outputs, and code are excluded.',
  },
] as const;

export function Telemetry() {
  const snapshot = useSyncExternalStore(
    telemetryConsentStore.subscribe,
    telemetryConsentStore.getSnapshot,
    telemetryConsentStore.getSnapshot,
  );
  const [accountConsent, setAccountConsent] = useState<AccountTelemetryConsent | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const allOptionalClassesEnabled =
    snapshot.consent.productUsage && snapshot.consent.diagnostics && snapshot.consent.toolOutcomes;

  useEffect(() => {
    let active = true;
    void getAccountTelemetryConsent().then((result) => {
      if (!active) return;
      if (result.ok) {
        setAccountConsent(result.state);
        setAccountError(null);
      } else {
        setAccountError(result.error);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const setRewardEnrollment = async (enabled: boolean) => {
    if (!accountConsent) return;
    setAccountBusy(true);
    const result = await updateAccountTelemetryConsent(enabled, accountConsent);
    setAccountBusy(false);
    if (!result.ok) {
      setAccountError(result.error);
      toast.error('Could not update reward consent', result.error);
      return;
    }
    setAccountConsent(result.state);
    setAccountError(null);
    toast.success(
      enabled ? '10% telemetry reward enabled' : 'Telemetry reward withdrawn',
      enabled
        ? 'Billing will verify this account state at checkout.'
        : 'Future subscriptions will no longer receive this reward.',
    );
  };

  const revokeAll = () => {
    telemetryConsentStore.revoke();
    if (accountConsent?.enabled) void setRewardEnrollment(false);
  };

  const downloadAudit = () => {
    const blob = new Blob([telemetryConsentStore.exportAudit()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vibespace-telemetry-consent.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Anonymous telemetry</h2>
        <p className="mt-1 text-secondary text-muted-foreground">
          Optional product-improvement sharing is off by default. Choose each class separately and
          revoke it whenever you want.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-panel p-4">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-accent-cyan" aria-hidden />
          <div>
            <h3 className="text-ui-strong text-foreground">Essential crash and security logging</h3>
            <p className="mt-1 text-secondary text-muted-foreground">
              Security events needed to protect accounts and local crash records needed to recover
              the app are separate from optional telemetry. They are not enabled by the switches
              below and follow the security and support retention policy.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="local-ai-diagnostics-title"
        className="rounded-xl border border-border bg-panel p-4"
      >
        <h3 id="local-ai-diagnostics-title" className="text-ui-strong text-foreground">
          Local AI diagnostics
        </h3>
        <p className="mt-1 text-secondary text-muted-foreground">
          Privacy-safe AI timing, token, retrieval, retry, and failure-category receipts stay in
          process memory for troubleshooting. They never contain prompts, responses, source code,
          file paths, credentials, or tool arguments.
        </p>
        <dl className="mt-3 grid gap-2 text-metadata sm:grid-cols-2">
          <DiagnosticDefault label="Local AI diagnostics" value="On" />
          <DiagnosticDefault label="External telemetry exporter" value="Off" />
          <DiagnosticDefault label="Store raw prompts" value="Off" />
          <DiagnosticDefault label="Store raw responses" value="Off" />
        </dl>
      </section>

      <section aria-labelledby="optional-telemetry-title" className="space-y-2">
        <div>
          <h3 id="optional-telemetry-title" className="text-ui-strong text-foreground">
            Optional data classes
          </h3>
          <p className="text-metadata text-muted-foreground">
            Consent is stored on this device with a timestamped audit record.
          </p>
        </div>
        {DATA_CLASSES.map(({ key, label, detail }) => (
          <label
            key={key}
            className="flex items-start justify-between gap-4 rounded-lg border border-border bg-elevated/55 p-4"
          >
            <span>
              <span className="block text-secondary font-medium text-foreground">{label}</span>
              <span className="mt-1 block text-metadata text-muted-foreground">{detail}</span>
            </span>
            <Switch
              aria-label={label}
              checked={snapshot.consent[key]}
              onCheckedChange={(enabled) => {
                telemetryConsentStore.updateConsent({ [key]: enabled });
                if (!enabled && accountConsent?.enabled) void setRewardEnrollment(false);
              }}
            />
          </label>
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <PolicyCard title="Never collected">
          Prompts, message contents, generated text, source code, rejected code, terminal commands,
          file contents, file paths, credentials, screenshots, audio, and raw tool input/output.
          Repeated mistakes are represented only as a content-free failure category when Diagnostics
          is enabled.
        </PolicyCard>
        <PolicyCard title="Identity and access">
          Optional events use a rotating pseudonymous installation identifier, not your name or
          email. Authorized VibeSpace operations staff may access aggregated records for product,
          reliability, abuse, and security work.
        </PolicyCard>
        <PolicyCard title="Storage and retention">
          Consent records stay locally on this device. Transmitted optional events use the
          configured VibeSpace telemetry region and are retained for at most 30 days unless a
          shorter authoritative policy applies.
        </PolicyCard>
        <PolicyCard title="Why it helps">
          Aggregated feature adoption, failures, and tool outcomes help prioritize fixes and measure
          whether releases improve reliability. Revoking consent stops future optional collection.
        </PolicyCard>
      </section>

      <section className="rounded-xl border border-border bg-panel p-4">
        <div className="flex items-start gap-3">
          <Gift className="mt-0.5 h-5 w-5 text-accent-copper" aria-hidden />
          <div>
            <h3 className="text-ui-strong text-foreground">Optional reward</h3>
            <p className="mt-1 text-secondary text-muted-foreground">
              Signed-in users who explicitly enable all three optional data classes can receive
              exactly 10% off subscriptions. Eligibility is verified by the billing service and does
              not stack with other promotions; an authoritative family benefit may use one
              pre-verified combined discount.
            </p>
            {accountConsent ? (
              <div className="mt-3 grid gap-2">
                <a
                  href={accountConsent.noticeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-metadata text-accent-copper underline underline-offset-4"
                >
                  Read the financial-incentive and telemetry notice
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant={accountConsent.enabled ? 'destructive' : 'secondary'}
                  disabled={accountBusy || (!accountConsent.enabled && !allOptionalClassesEnabled)}
                  onClick={() => void setRewardEnrollment(!accountConsent.enabled)}
                >
                  {accountConsent.enabled ? 'Withdraw 10% reward consent' : 'Enable 10% reward'}
                </Button>
                {!allOptionalClassesEnabled && !accountConsent.enabled ? (
                  <p className="text-metadata text-muted-foreground">
                    Enable all three clearly described optional classes before enrolling.
                  </p>
                ) : null}
                <p className="text-metadata text-muted-foreground" aria-live="polite">
                  Account status:{' '}
                  {accountConsent.eligible ? 'eligible for 10% at checkout' : 'not enrolled'}.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-metadata text-muted-foreground" aria-live="polite">
                {accountError
                  ? 'Sign in to a configured VibeSpace account to enroll. Local consent remains off unless you choose it.'
                  : 'Checking account eligibility…'}
              </p>
            )}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={downloadAudit}>
          <Download aria-hidden className="h-4 w-4" /> Export consent record
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => telemetryConsentStore.deleteAudit()}
        >
          <Eraser aria-hidden className="h-4 w-4" /> Delete local audit
        </Button>
        <Button type="button" variant="destructive" onClick={revokeAll}>
          Revoke optional telemetry
        </Button>
      </div>
      <p className="text-metadata text-muted-foreground" aria-live="polite">
        {snapshot.audit.length} local consent {snapshot.audit.length === 1 ? 'record' : 'records'}.
      </p>
    </div>
  );
}

function PolicyCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="rounded-lg border border-border bg-elevated/45 p-4">
      <h3 className="text-ui-strong text-foreground">{title}</h3>
      <p className="mt-1 text-secondary text-muted-foreground">{children}</p>
    </article>
  );
}

function DiagnosticDefault({ label, value }: { label: string; value: 'On' | 'Off' }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-elevated/55 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
