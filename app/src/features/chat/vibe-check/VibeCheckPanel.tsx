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
          <small>Clarity before the next move</small>
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
          <span className="vibe-check-badge">READ ONLY</span>
        </p>
        <fieldset disabled={busy} className="vibe-check-choices">
          <legend>Who should take a look?</legend>
          <button
            aria-pressed={options.auditor === 'new'}
            onClick={() => setOptions({ ...options, auditor: 'new' })}
          >
            <Sparkles size={18} />
            <strong>Fresh eyes</strong>
            <small>New agent, full chat reference</small>
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
        <div className="vibe-check-progress" aria-live="polite">
          <span>
            <Activity size={14} />
            {session.stage}
          </span>
          <strong>{session.progress}%</strong>
        </div>
        <div
          className={`vibe-check-track ${busy ? 'is-active' : ''}`}
          role="progressbar"
          aria-label="Audit workflow steps"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={session.progress}
          aria-valuetext={`${session.progress}% of workflow steps; ${session.stage}`}
        >
          <span style={{ width: `${session.progress}%` }} />
        </div>
        <p className="vibe-check-note">
          Progress tracks completed workflow steps, not estimated review time.
        </p>
        {evidence && (
          <>
            <div className="vibe-check-metrics">
              {[
                ['Changed files', evidence.files.length || 'Unknown'],
                ['Commands', evidence.commands],
                ['Lines added', evidence.added === null ? 'Unknown' : `+${evidence.added}`],
                ['Lines removed', evidence.removed === null ? 'Unknown' : `−${evidence.removed}`],
                ['Subagents', evidence.subagents],
                ['Tool calls', evidence.toolCalls],
              ].map(([label, value]) => (
                <div key={label}>
                  <strong>{value}</strong>
                  <small>{label}</small>
                </div>
              ))}
            </div>
            <p className="vibe-check-note">{evidence.coverage}</p>
            {evidence.files.length > 0 && (
              <details>
                <summary>Observed changed files</summary>
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
        {session.report ? (
          <article className="vibe-check-report" aria-label="Audit report">
            {session.report}
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
              : 'Run fresh audit'}
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
