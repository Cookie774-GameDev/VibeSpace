import { AUDIT_METRICS, parseAuditGrades, auditReportText, type AuditMetric } from './auditGrades';
import { useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  CheckCheck,
  MessageSquare,
  Minus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import type { ChatId } from '@/types/common';
import { closeVibeCheck, patchAudit, useVibeCheckStore, type AuditOptions } from './vibeCheckStore';
import './vibe-check.css';

export function VibeCheckPanel() {
  const session = useVibeCheckStore((state) => state.session);
  const [confirmClose, setConfirmClose] = useState(false);
  if (!session) return null;
  const options = session.options;
  const setOptions = (options: AuditOptions) => patchAudit(session.id, { options });
  const busy = ['preparing', 'waiting', 'running'].includes(session.status);
  const launch = () => {
    void import('./vibeCheckService')
      .then((module) => module.startVibeCheck(options))
      .catch((error) => patchAudit(session.id, { status: 'error', error: String(error) }));
  };
  if (session.minimized)
    return (
      <button
        style={{ position: 'absolute', zIndex: 55 }}
        className={`vibe-check-orb ${busy ? 'is-active' : ''}`}
        aria-label="Restore VibeCheck"
        onClick={() => patchAudit(session.id, { minimized: false })}
      >
        <ShieldCheck size={23} />
        {busy && <span />}
      </button>
    );
  const evidence = session.evidence;
  const grades = parseAuditGrades(session.report);
  const report = auditReportText(session.report);
  const statusLabel = {
    ready: 'Ready to review',
    preparing: 'Preparing',
    waiting: 'Waiting',
    running: 'Review in progress',
    complete: 'Report returned',
    error: 'Needs attention',
  }[session.status];
  const snapshotDate =
    evidence && Number.isFinite(evidence.capturedAt) ? new Date(evidence.capturedAt) : null;
  const snapshotTime =
    snapshotDate && Number.isFinite(snapshotDate.getTime())
      ? snapshotDate.toISOString()
      : undefined;
  return (
    <section
      style={{ position: 'absolute', zIndex: 55 }}
      className="vibe-check-panel"
      role="dialog"
      aria-label="VibeCheck audit"
      aria-modal="false"
    >
      <header className="vibe-check-header">
        <div className="vibe-check-mark">
          <ShieldCheck size={22} />
        </div>
        <div>
          <strong>VibeCheck</strong>
          <small>A second look, with the evidence in view</small>
        </div>
        <button
          aria-label="Minimize VibeCheck"
          onClick={() => patchAudit(session.id, { minimized: true })}
        >
          <Minus size={17} />
        </button>
        <button aria-label="Close VibeCheck" onClick={() => setConfirmClose(true)}>
          <X size={17} />
        </button>
      </header>
      <div
        className="vibe-check-body"
        ref={(node) => {
          if (node) node.scrollTop = session.scrollTop ?? 0;
        }}
        onScroll={(event) => patchAudit(session.id, { scrollTop: event.currentTarget.scrollTop })}
      >
        <p className="vibe-check-source">
          <MessageSquare size={14} />
          <span>{session.title === 'VibeCheck' ? 'Current chat' : session.title}</span>
          <span className="vibe-check-badge">REVIEW REQUEST</span>
        </p>
        <div className={`vibe-check-state is-${session.status}`} role="status">
          <span className="vibe-check-state-dot" aria-hidden="true" />
          <strong>{statusLabel}</strong>
          <small>{options.auditor === 'new' ? 'Dedicated auditor' : 'Current agent'}</small>
        </div>
        <fieldset disabled={busy} className="vibe-check-choices">
          <legend>Who should take a look?</legend>
          <button
            aria-pressed={options.auditor === 'new'}
            onClick={() => setOptions({ ...options, auditor: 'new' })}
          >
            <Sparkles size={18} />
            <strong>Fresh eyes</strong>
            <small>
              {session.auditorChatId
                ? 'Same auditor, refreshed chat context'
                : 'New agent, full chat reference'}
            </small>
          </button>
          <button
            aria-pressed={options.auditor === 'main'}
            onClick={() => setOptions({ ...options, auditor: 'main' })}
          >
            <MessageSquare size={18} />
            <strong>Main agent</strong>
            <small>Ask this agent to audit its work</small>
          </button>
        </fieldset>
        <label className="vibe-check-interrupt">
          <input
            type="checkbox"
            checked={options.interrupt}
            disabled={busy}
            onChange={(event) => setOptions({ ...options, interrupt: event.target.checked })}
          />
          <span>
            Interrupt current work
            <small>
              {options.interrupt
                ? 'Stops the source turn before auditing. It will not resume automatically.'
                : options.auditor === 'new'
                  ? 'Your current agent keeps working alongside the auditor.'
                  : 'The audit waits until the current work finishes.'}
            </small>
          </span>
        </label>
        <p className="vibe-check-note">
          Read-only review is requested.{' '}
          {options.auditor === 'main'
            ? 'Your current agent keeps its saved permissions.'
            : 'The dedicated auditor is assigned read-only access.'}
        </p>
        <div className="vibe-check-progress" aria-live="polite">
          <span>
            <Activity size={14} />
            {session.stage}
          </span>
          <strong>{session.status === 'complete' ? 'Returned' : busy ? 'In progress' : '—'}</strong>
        </div>
        <div
          className={`vibe-check-track ${busy ? 'is-active' : ''}`}
          role="progressbar"
          aria-label="Audit workflow steps"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={session.status === 'complete' ? 100 : undefined}
          aria-valuetext={session.stage}
        >
          <span style={{ width: session.status === 'complete' ? '100%' : busy ? '36%' : '0%' }} />
        </div>
        <p className="vibe-check-note">
          Stage updates follow the audit workflow. Review time and percent complete are not
          measured.
        </p>
        <section className="vibe-check-scorecard" aria-label="Audit grades">
          <div className="vibe-check-section-heading">
            <strong>Auditor assessments</strong>
            <span>{Object.keys(grades).length}/6 reported</span>
          </div>
          <p className="vibe-check-note">
            Scores are the auditor’s judgments, not verified measurements. Open a dimension to
            inspect its stated reason and evidence.
          </p>
          <div className="vibe-check-grades">
            {(Object.keys(AUDIT_METRICS) as AuditMetric[]).map((metric) => {
              const grade = grades[metric];
              return (
                <details key={metric} className={`vibe-check-grade ${grade ? 'is-ready' : ''}`}>
                  <summary>
                    <span>{AUDIT_METRICS[metric]}</span>
                    <strong aria-label={`${AUDIT_METRICS[metric]} score`}>
                      {grade ? (grade.score ?? 'N/A') : '—'}
                      {grade?.score != null && <small>/100</small>}
                    </strong>
                    <span className="vibe-check-grade-meter" aria-hidden="true">
                      <i style={{ width: `${grade?.score ?? 0}%` }} />
                    </span>
                    <small>
                      {grade
                        ? `Auditor confidence: ${grade.confidence} · details`
                        : busy
                          ? 'Reviewing evidence'
                          : session.status === 'ready'
                            ? 'Awaiting audit'
                            : 'Not reported'}
                    </small>
                  </summary>
                  <p>{grade?.reason ?? 'No supported grade has been received yet.'}</p>
                  {grade && <p className="vibe-check-grade-evidence">{grade.evidence}</p>}
                </details>
              );
            })}
          </div>
        </section>
        {evidence && (
          <>
            <div className="vibe-check-section-heading vibe-check-evidence-heading">
              <strong>Recorded evidence</strong>
              <time dateTime={snapshotTime} title="Snapshot capture time in UTC">
                {snapshotTime
                  ? snapshotTime.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
                  : 'Capture time unavailable'}
              </time>
            </div>
            <div className="vibe-check-metrics">
              {[
                ['File paths recorded', evidence.files.length],
                ['Command calls', evidence.commands],
                [
                  'Reported lines added',
                  evidence.added === null ? 'Unknown' : `+${evidence.added}`,
                ],
                [
                  'Reported lines removed',
                  evidence.removed === null ? 'Unknown' : `−${evidence.removed}`,
                ],
                ['Reported agent IDs', evidence.subagents],
                ['Tool calls recorded', evidence.toolCalls],
              ].map(([label, value]) => (
                <div key={label}>
                  <strong>{value}</strong>
                  <small>{label}</small>
                </div>
              ))}
            </div>
            {evidence.unidentifiedSubagentEvents > 0 && (
              <p className="vibe-check-note">
                {evidence.unidentifiedSubagentEvents} subagent events have no agent identity; the
                agent total is unknown.
              </p>
            )}
            <p className="vibe-check-note">{evidence.coverage}</p>
            {evidence.files.length > 0 && (
              <details>
                <summary>Inspect recorded file paths</summary>
                <ul>
                  {evidence.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {session.error && (
          <p className="vibe-check-error" role="alert">
            {session.error}
          </p>
        )}
        {report ? (
          <article className="vibe-check-report" aria-label="Audit report">
            {report}
          </article>
        ) : (
          <div className="vibe-check-empty">
            <CheckCheck size={26} />
            <p>Evidence. Findings. A clear next step.</p>
            <small>Your detailed audit will appear here.</small>
          </div>
        )}
      </div>
      <footer>
        {session.targetId && (
          <button onClick={() => useUIStore.getState().setActiveChat(session.targetId as ChatId)}>
            Open audit chat <ArrowUpRight size={14} />
          </button>
        )}
        <button className="vibe-check-start" disabled={busy} onClick={launch}>
          {session.status === 'ready' ? <ShieldCheck size={16} /> : <RotateCw size={16} />}{' '}
          {busy
            ? 'Audit in progress'
            : session.status === 'ready'
              ? 'Start VibeCheck'
              : 'Refresh audit'}
        </button>
      </footer>
      {confirmClose && (
        <div className="vibe-check-confirm" role="alertdialog" aria-label="Close this audit?">
          <strong>Close this VibeCheck?</strong>
          <p>
            The panel will reset. A waiting audit will be cancelled; an audit already sent continues
            in its chat history.
          </p>
          <div>
            <button onClick={() => setConfirmClose(false)}>Keep audit</button>
            <button
              onClick={() => {
                setConfirmClose(false);
                closeVibeCheck();
              }}
            >
              Close audit
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
