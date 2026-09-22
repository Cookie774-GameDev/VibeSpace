import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Monitor,
  Cloud,
  MessageSquare,
  ArrowRight,
  Unplug,
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import tunnelVideo from '@/assets/webmcp/tunnel-setup.mp4?url';
import apiVideo from '@/assets/webmcp/api-key-setup.mp4?url';
import tunnelPoster from '@/assets/webmcp/tunnel-setup.jpg';
import apiPoster from '@/assets/webmcp/api-key-setup.jpg';
import {
  describeSetupError,
  pluginName,
  setupErrorMessages,
  draftFromStatus,
  readWebMcpStatus,
  saveWebMcpDraft,
  setupAction,
  setupLinks,
  validateSetupDraft,
  type GuideTab,
  type SetupDraft,
  type SetupLink,
  type WebMcpStatus,
} from './webMcpSetupClient';
import './webMcpSetupPanel.css';

function GuideVideo({ tab }: { tab: GuideTab }) {
  const storageKey = 'vibespace.webmcp.tutorial-position.v1.' + tab;
  const lastSaved = useRef(-1);
  return (
    <video
      key={tab}
      className="webmcp-video"
      controls
      playsInline
      preload="metadata"
      aria-label={tab === 'tunnel' ? 'Tunnel setup tutorial' : 'Runtime API key tutorial'}
      src={tab === 'tunnel' ? tunnelVideo : apiVideo}
      poster={tab === 'tunnel' ? tunnelPoster : apiPoster}
      onLoadedMetadata={(event) => {
        try {
          const saved = Number(localStorage.getItem(storageKey));
          if (Number.isFinite(saved) && saved > 0 && saved < event.currentTarget.duration - 0.5)
            event.currentTarget.currentTime = saved;
        } catch {
          /* Playback still works when local storage is unavailable. */
        }
      }}
      onTimeUpdate={(event) => {
        const seconds = Math.floor(event.currentTarget.currentTime);
        if (seconds === lastSaved.current) return;
        lastSaved.current = seconds;
        try {
          localStorage.setItem(storageKey, String(seconds));
        } catch {
          /* Optional playback memory. */
        }
      }}
    />
  );
}

export function WebMcpSetupPanel({
  initialStatus,
  onStatus,
  onClose,
}: {
  initialStatus?: WebMcpStatus;
  onStatus: (status: WebMcpStatus) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [draft, setDraft] = useState(() => draftFromStatus(initialStatus));
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'pending' | 'error'>('saved');
  const [error, setError] = useState('');
  const [replacingKey, setReplacingKey] = useState(false);
  const latestDraft = useRef(draft);
  const latestKey = useRef('');
  const mounted = useRef(true);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saveTail = useRef<Promise<unknown>>(Promise.resolve());
  const savingCount = useRef(0);
  const pendingSave = useRef<{ revision: number; promise: Promise<WebMcpStatus> }>();
  const keyRevision = useRef(0);
  const acknowledgedKeyRevision = useRef(-1);
  const changeStatus = useRef(onStatus);
  changeStatus.current = onStatus;
  const applyStatus = useCallback((value: WebMcpStatus) => {
    if (!mounted.current) return;
    setStatus(value);
    changeStatus.current(value);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        await setupAction('prepare');
        const value = await readWebMcpStatus();
        if (!mounted.current) return;
        applyStatus(value);
        latestDraft.current = draftFromStatus(value);
        setDraft(latestDraft.current);
      } catch {
        if (mounted.current) setError('Could not prepare WebMCP. Close this panel and try again.');
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      latestKey.current = '';
      acknowledgedKeyRevision.current = -1;
    };
  }, [applyStatus]);
  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const current = { ...latestDraft.current };
    const key = latestKey.current.trim();
    const version = revision.current;
    const keyVersion = keyRevision.current;
    if (pendingSave.current?.revision === version) return pendingSave.current.promise;
    const problem = validateSetupDraft(current, key);
    if (problem) {
      setError(problem);
      setSaveState('error');
      throw new Error(problem);
    }
    savingCount.current++;
    setSaveState('saving');
    const operation = saveTail.current.then(() =>
      saveWebMcpDraft(current, keyVersion === acknowledgedKeyRevision.current ? '' : key),
    );
    saveTail.current = operation.catch(() => {});
    const completion = operation
      .then((confirmed) => {
        if (key) acknowledgedKeyRevision.current = keyVersion;
        if (mounted.current) {
          if (version === revision.current) {
            applyStatus(confirmed);
            setSaveState('saved');
            setError('');
          }
          if (key && latestKey.current.trim() === key) {
            latestKey.current = '';
            setApiKey('');
            setReplacingKey(false);
          }
        }
        return confirmed;
      })
      .catch((cause) => {
        const message = describeSetupError(
          cause,
          'Setup progress could not be saved and verified. Please retry.',
        );
        if (mounted.current) {
          setSaveState('error');
          setError(message);
        }
        throw new Error(message);
      })
      .finally(() => {
        savingCount.current--;
        if (pendingSave.current?.promise === completion) pendingSave.current = undefined;
      });
    pendingSave.current = { revision: version, promise: completion };
    return completion;
  }, [applyStatus]);
  const scheduleSave = () => {
    clearTimeout(timer.current);
    setSaveState('pending');
    timer.current = setTimeout(() => {
      if (!validateSetupDraft(latestDraft.current, latestKey.current.trim()))
        void save().catch(() => {});
    }, 450);
  };
  const updateDraft = (patch: Partial<SetupDraft>) => {
    revision.current++;
    setError('');
    latestDraft.current = { ...latestDraft.current, ...patch };
    setDraft(latestDraft.current);
    scheduleSave();
  };
  useEffect(() => {
    if (loading) return;
    let pending = false;
    const poll = setInterval(() => {
      if (pending || savingCount.current || busy) return;
      pending = true;
      const requestedRevision = revision.current;
      void readWebMcpStatus()
        .then((value) => {
          if (requestedRevision === revision.current && !savingCount.current) applyStatus(value);
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    }, 2000);
    return () => clearInterval(poll);
  }, [loading, busy, applyStatus]);
  const close = async () => {
    if (busy) return;
    if (loading || !status?.connectionDetected) {
      latestKey.current = '';
      onClose();
      return;
    }
    setBusy(true);
    try {
      await save();
      latestKey.current = '';
      onClose();
    } catch {
      /* Keep unsaved fields visible instead of silently losing the draft. */
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const connect = async () => {
    if (busy || loading) return;
    if (!latestDraft.current.tunnelId.trim() || (!latestKey.current.trim() && !status?.hasKey)) {
      setError('Add your tunnel ID and a restricted runtime API key first.');
      return;
    }
    setBusy(true);
    try {
      await save();
      await setupAction('connect');
      applyStatus(await readWebMcpStatus());
    } catch (cause) {
      setError(
        describeSetupError(
          cause,
          'The local connection could not be confirmed. Check the saved setup and retry.',
        ),
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await setupAction('disconnect');
      applyStatus(await readWebMcpStatus());
    } catch {
      setError('Disconnect could not be confirmed. Please retry.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const link = (action: SetupLink, label: string) => (
    <a
      href={setupLinks[action]}
      className="webmcp-link"
      onClick={(event) => {
        event.preventDefault();
        void setupAction(action).catch(() => setError('The browser link could not be opened.'));
      }}
    >
      {label}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
  const ready = status?.status === 'ready' && (status.toolCount ?? 0) > 0;
  const active = status?.status === 'ready' || status?.status === 'connecting';
  const tunnelSaved = Boolean(status?.tunnelId && status.tunnelId === draft.tunnelId.trim());
  const credentialStep = draft.step !== 3;
  const displayedError =
    error ||
    (status?.errorCode && Object.hasOwn(setupErrorMessages, status.errorCode)
      ? setupErrorMessages[status.errorCode]
      : '');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className="webmcp-dialog"
        hideClose
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <header className="webmcp-header">
          <div className="webmcp-mark">
            <Link2 size={21} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <DialogTitle>WebMCP setup</DialogTitle>
            <DialogDescription>Bring your VibeSpace tools into ChatGPT.</DialogDescription>
          </div>
          <button
            className="webmcp-close"
            aria-label="Close WebMCP setup"
            disabled={busy}
            onClick={() => void close()}
          >
            <X size={18} />
          </button>
        </header>
        <nav className="webmcp-steps" aria-label="WebMCP setup progress">
          <button
            type="button"
            aria-current={credentialStep ? 'step' : undefined}
            disabled={loading || busy}
            onClick={() => updateDraft({ step: 1 })}
          >
            <span className={ready ? 'complete' : ''}>{ready ? <Check size={14} /> : '1'}</span>
            Create tunnel &amp; API key
          </button>
          <button
            type="button"
            aria-current={!credentialStep ? 'step' : undefined}
            disabled={loading || busy}
            onClick={() => updateDraft({ step: 3 })}
          >
            <span>
              <MessageSquare size={13} aria-hidden="true" />
            </span>
            Add to ChatGPT
          </button>
        </nav>
        <div className="webmcp-body" aria-busy={loading}>
          {loading ? (
            <p role="status" className="webmcp-preparing">
              <Loader2 className="animate-spin" size={18} /> Preparing your packaged tools…
            </p>
          ) : (
            <>
              <div className="webmcp-checks" aria-label="Connection checks">
                <div data-verified={status?.connectionDetected && (status?.toolCount ?? 0) > 0}>
                  <Monitor size={16} aria-hidden="true" />
                  <span>
                    Local tools
                    <small>
                      {status?.toolCount ? status.toolCount + ' available' : 'Not ready'}
                    </small>
                  </span>
                </div>
                <ArrowRight size={13} aria-hidden="true" />
                <div data-verified={status?.hasKey === true}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>
                    Secure key<small>{status?.hasKey ? 'Saved on this PC' : 'Not saved yet'}</small>
                  </span>
                </div>
                <ArrowRight size={13} aria-hidden="true" />
                <div data-verified={ready}>
                  <Cloud size={16} aria-hidden="true" />
                  <span>
                    OpenAI tunnel
                    <small>{ready ? 'Connected' : active ? 'Connecting…' : 'Not connected'}</small>
                  </span>
                </div>
              </div>
              <div className="webmcp-guide-tabs" role="tablist" aria-label="Setup tutorial">
                {(['tunnel', 'api'] as const).map((tab) => (
                  <button
                    key={tab}
                    id={'webmcp-tab-' + tab}
                    role="tab"
                    type="button"
                    aria-selected={draft.guideTab === tab}
                    aria-controls="webmcp-guide"
                    tabIndex={draft.guideTab === tab ? 0 : -1}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        const next = tab === 'api' ? 'tunnel' : 'api';
                        updateDraft({ guideTab: next });
                        document.getElementById('webmcp-tab-' + next)?.focus();
                      }
                    }}
                    onClick={() => updateDraft({ guideTab: tab })}
                  >
                    {tab === 'tunnel' ? <Link2 size={14} /> : <KeyRound size={14} />}
                    {tab === 'tunnel' ? 'Tunnel video' : 'API key video'}
                  </button>
                ))}
              </div>
              <section
                id="webmcp-guide"
                role="tabpanel"
                aria-labelledby={'webmcp-tab-' + draft.guideTab}
                className="webmcp-guide"
              >
                <GuideVideo key={draft.guideTab} tab={draft.guideTab} />
                <div className="webmcp-guide-caption">
                  <span>
                    {draft.guideTab === 'tunnel'
                      ? 'Create a tunnel, then copy its ID.'
                      : 'Choose Restricted → Tunnels Read + Use. The recorded secret is hidden.'}
                  </span>
                  {draft.guideTab === 'tunnel'
                    ? link('open-tunnels', 'Open OpenAI Tunnels')
                    : link('open-api-keys', 'Create runtime API key')}
                </div>
              </section>
              {credentialStep ? (
                <form
                  className="webmcp-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect();
                  }}
                >
                  <div className="webmcp-fields">
                    <label>
                      Tunnel ID
                      <Input
                        aria-label="Tunnel ID"
                        placeholder="tunnel_…"
                        spellCheck={false}
                        autoComplete="off"
                        value={draft.tunnelId}
                        disabled={busy || active}
                        onChange={(event) => updateDraft({ tunnelId: event.target.value })}
                      />
                      {tunnelSaved && (
                        <span
                          className="webmcp-saved-chip"
                          title={status?.tunnelId}
                          data-testid="saved-tunnel"
                        >
                          <CheckCircle2 size={13} />
                          Tunnel saved<span>{status?.tunnelId?.slice(-8)}</span>
                        </span>
                      )}
                    </label>
                    <div>
                      <label htmlFor="webmcp-runtime-key">Runtime API key</label>
                      {status?.hasKey && !replacingKey ? (
                        <div className="webmcp-key-saved">
                          <ShieldCheck size={16} />
                          <span>Saved securely</span>
                          <button
                            type="button"
                            disabled={busy || active}
                            onClick={() => setReplacingKey(true)}
                          >
                            Replace
                          </button>
                        </div>
                      ) : (
                        <Input
                          id="webmcp-runtime-key"
                          aria-label="Runtime API key"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={4096}
                          placeholder="Paste restricted runtime key"
                          value={apiKey}
                          disabled={busy || active}
                          onChange={(event) => {
                            revision.current++;
                            keyRevision.current++;
                            setError('');
                            latestKey.current = event.target.value;
                            setApiKey(event.target.value);
                            scheduleSave();
                          }}
                        />
                      )}
                      <p className="webmcp-hint">
                        Protected by Windows. Never saved in browser storage.
                      </p>
                    </div>
                  </div>
                  <label className="webmcp-name webmcp-optional-name">
                    <span>
                      <MessageSquare size={13} aria-hidden="true" /> ChatGPT plugin name{' '}
                      <small>optional</small>
                    </span>
                    <Input
                      aria-label="WebMCP app name"
                      placeholder="VibeSpace Desktop"
                      value={draft.displayName}
                      maxLength={64}
                      onChange={(event) => updateDraft({ displayName: event.target.value })}
                      disabled={busy}
                    />
                    <span className="webmcp-hint">
                      Only the label you use in ChatGPT. Leave blank to use VibeSpace Desktop.
                    </span>
                  </label>
                  <p className="webmcp-hint">
                    The tunnel ID identifies the connection. The runtime key authenticates it.
                  </p>
                  <button type="submit" hidden aria-hidden="true" tabIndex={-1}>
                    Connect
                  </button>
                </form>
              ) : (
                <section className="webmcp-chatgpt">
                  <h3>One last step in ChatGPT</h3>
                  <p>
                    Create an app named <strong>{pluginName(draft.displayName)}</strong>, choose{' '}
                    <strong>Connection: Tunnel</strong>, select your tunnel, and review its tools.
                  </p>
                  <div className="webmcp-connection-receipt">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>{ready ? 'Ready for ChatGPT' : 'Connect your tunnel first'}</strong>
                      <p>
                        {ready
                          ? String(status?.toolCount) +
                            ' tools available. Keep WebMCP enabled while you use them.'
                          : 'Return to step 1 to save your credentials and connect.'}
                      </p>
                    </div>
                  </div>
                  {link('open-chatgpt', 'Open ChatGPT Apps')}
                  <p className="webmcp-hint">
                    Adding the app happens in your browser. Tunnel readiness does not mean the
                    ChatGPT app has been added.
                  </p>
                </section>
              )}
              {displayedError && (
                <p role="alert" className="webmcp-error">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {displayedError}
                </p>
              )}
            </>
          )}
        </div>
        <footer className="webmcp-footer">
          <div className="webmcp-footer-status" role="status">
            <span className={ready ? 'webmcp-dot ready' : 'webmcp-dot'} />
            <span>
              {ready ? 'Tunnel ready' : active ? 'Connecting…' : 'Not connected'}
              <small>
                {saveState === 'saving'
                  ? 'Saving securely…'
                  : saveState === 'error'
                    ? 'Changes not saved'
                    : saveState === 'pending'
                      ? 'Unsaved changes'
                      : 'Progress saved on this computer'}
              </small>
            </span>
          </div>
          <div className="webmcp-footer-actions">
            <Button disabled={busy} onClick={() => void close()}>
              Save &amp; close
            </Button>
            {ready ? (
              <>
                <Button disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </Button>
                {credentialStep && (
                  <Button onClick={() => updateDraft({ step: 3 })}>
                    Add to ChatGPT <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                )}
              </>
            ) : active ? (
              <Button disabled={busy} onClick={() => void disconnect()}>
                <Unplug size={14} aria-hidden="true" />
                Stop connection
              </Button>
            ) : (
              <Button disabled={loading || busy} onClick={() => void connect()}>
                {busy ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Link2 size={14} aria-hidden="true" />
                )}
                {busy ? 'Connecting…' : 'Connect tunnel'}
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
