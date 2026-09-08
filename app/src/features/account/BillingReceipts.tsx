import { useCallback, useEffect, useRef, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchBillingReceipts,
  formatReceiptMoney,
  type BillingReceipt,
} from '@/lib/billing/receipts';
import { openExternal } from '@/lib/tauri';
import './receipt-printer.css';

type Props = { accountId: string | null; load?: typeof fetchBillingReceipts };
export function BillingReceipts({ accountId, load = fetchBillingReceipts }: Props) {
  if (!accountId)
    return (
      <p className="mt-5 text-secondary text-muted-foreground">
        Sign in to view your invoices and payment receipts.
      </p>
    );
  return <ReceiptPanel key={accountId} load={load} />;
}
function ReceiptPanel({ load }: { load: typeof fetchBillingReceipts }) {
  const [receipts, setReceipts] = useState<readonly BillingReceipt[]>([]);
  const [selected, setSelected] = useState<BillingReceipt | null>(null);
  const [printing, setPrinting] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const lastCheck = useRef(0);
  const latestId = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    lastCheck.current = Date.now();
    setBusy(true);
    setError(null);
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const next = await load(controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setReceipts(next);
      const latest = next[0] ?? null;
      const signature = latest
        ? `${latest.id}:${latest.status}:${latest.total}:${latest.paid}`
        : null;
      if (signature !== latestId.current) {
        latestId.current = signature;
        setSelected(latest);
        setPrinting((n) => n + 1);
      } else {
        setSelected((current) => next.find((item) => item.id === current?.id) ?? latest);
      }
    } catch {
      if (active.current && request.current === controller)
        setError('Invoices could not be loaded. Try again or use Manage subscription.');
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (active.current) setBusy(false);
      }
    }
  }, [load]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const focus = () => {
      if (Date.now() - lastCheck.current >= 30_000) void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  const final = receipts.find((r) => r.periodEnd * 1000 <= Date.now() && r.status !== 'void');
  const show = (receipt: BillingReceipt) => {
    setSelected(receipt);
    setPrinting((n) => n + 1);
  };
  return (
    <section className="vs-receipts" aria-label="Billing receipts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-ui-strong">Your receipts</h3>
          <p className="text-metadata text-muted-foreground">
            Finalized invoices, directly from your billing account.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={busy ? 'motion-safe:animate-spin h-3.5 w-3.5' : 'h-3.5 w-3.5'} />
          Refresh invoices
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="mt-3 text-muted-foreground">
          Checking your billing account…
        </p>
      )}
      {!busy && !error && receipts.length === 0 && (
        <p className="mt-4 text-muted-foreground">No finalized invoices are available yet.</p>
      )}
      {receipts.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-metadata">
            Invoice{' '}
            <select
              className="ml-2 rounded-md border border-border bg-panel px-2 py-1"
              value={selected?.id ?? ''}
              onChange={(e) => {
                const r = receipts.find((r) => r.id === e.target.value);
                if (r) show(r);
              }}
            >
              {receipts.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.created * 1000).toLocaleDateString()} · {r.status}
                </option>
              ))}
            </select>
          </label>
          {final && (
            <Button size="sm" variant="outline" onClick={() => show(final)}>
              View final bill
            </Button>
          )}
        </div>
      )}
      {selected && (
        <div className="vs-receipt-machine">
          <div className="vs-receipt-device" aria-hidden="true">
            <Printer size={18} />
            <span>VibeSpace</span>
            <i />
            <div className="vs-receipt-slot" />
          </div>
          <div className="vs-receipt-feed">
            <article
              key={`${selected.id}:${printing}`}
              className="vs-receipt-paper"
              aria-label={`Invoice ${selected.number ?? selected.id}`}
            >
              <p className="vs-receipt-brand">VIBESPACE</p>
              <p className="vs-receipt-caption">
                {selected.status === 'paid' ? 'PAYMENT RECEIPT' : 'INVOICE'}
              </p>
              <hr />
              <p>{selected.number ?? selected.id}</p>
              <p>{new Date(selected.created * 1000).toLocaleDateString()}</p>
              <p className="vs-receipt-period">
                {new Date(selected.periodStart * 1000).toLocaleDateString()} —{' '}
                {new Date(selected.periodEnd * 1000).toLocaleDateString()}
              </p>
              <hr />
              <dl>
                <div>
                  <dt>Invoice total</dt>
                  <dd>{formatReceiptMoney(selected.total, selected.currency)}</dd>
                </div>
                <div>
                  <dt>Amount paid</dt>
                  <dd>{formatReceiptMoney(selected.paid, selected.currency)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{selected.status}</dd>
                </div>
              </dl>
              <hr />
              <p className="vs-receipt-caption">Thank you for building with VibeSpace.</p>
              {selected.url && (
                <button
                  type="button"
                  className="vs-receipt-link"
                  onClick={() =>
                    void openExternal(selected.url!).catch(() =>
                      setError('The invoice link could not be opened.'),
                    )
                  }
                >
                  Open official invoice
                </button>
              )}
            </article>
          </div>
        </div>
      )}
    </section>
  );
}
