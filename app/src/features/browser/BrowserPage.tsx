import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  Plus,
  RefreshCw,
  Shield,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { openExternal } from '@/lib/tauri';
import { normalizePreviewUrl } from '@/features/preview/previewUrl';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import {
  browserStart,
  browserStatus,
  browserStop,
  CdpSession,
  isTauriRuntime,
  resolvePageWsUrl,
} from './browserClient';
import {
  approveBrowserCanonicalReviewedAction,
  denyBrowserCanonicalReviewedAction,
} from './browserCanonicalApprovalRuntime';
import {
  BROWSER_GOAL_HOST_LEASE_MS,
  registerBrowserGoalHostSession,
  type BrowserGoalHostLease,
} from './browserGoalIntegration';
import { useBrowserStore } from './browserStore';
import './browser.css';
import './browser.sakura.css';

/**
 * Vibe Browser — Canvas / VS Code Simple Browser style:
 * primary surface is an in-app iframe (works for localhost + embeddable sites).
 * Optional CDP agent runtime for advanced control when Edge/Chrome is available.
 */
export function BrowserPage() {
  const cdpRef = React.useRef<CdpSession | null>(null);
  const hostLeaseRef = React.useRef<BrowserGoalHostLease | null>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const [cdpConnected, setCdpConnected] = React.useState(false);
  const [iframeBlocked, setIframeBlocked] = React.useState(false);
  const [engine, setEngine] = React.useState<'iframe' | 'agent'>('iframe');

  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const runtime = useBrowserStore((s) => s.runtime);
  const frameDataUrl = useBrowserStore((s) => s.frameDataUrl);
  const consoleEntries = useBrowserStore((s) => s.consoleEntries);
  const agentActions = useBrowserStore((s) => s.agentActions);
  const agentArmed = useBrowserStore((s) => s.agentArmed);
  const sidebarOpen = useBrowserStore((s) => s.sidebarOpen);
  const consoleOpen = useBrowserStore((s) => s.consoleOpen);
  const draftUrl = useBrowserStore((s) => s.draftUrl);

  const setDraftUrl = useBrowserStore((s) => s.setDraftUrl);
  const setRuntime = useBrowserStore((s) => s.setRuntime);
  const setFrame = useBrowserStore((s) => s.setFrame);
  const setActiveTab = useBrowserStore((s) => s.setActiveTab);
  const newTab = useBrowserStore((s) => s.newTab);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const updateTab = useBrowserStore((s) => s.updateTab);
  const pushConsole = useBrowserStore((s) => s.pushConsole);
  const abortAgentActions = useBrowserStore((s) => s.abortAgentActions);
  const setControlMode = useBrowserStore((s) => s.setControlMode);
  const setSidebarOpen = useBrowserStore((s) => s.setSidebarOpen);
  const setConsoleOpen = useBrowserStore((s) => s.setConsoleOpen);
  const restoreClosed = useBrowserStore((s) => s.restoreClosed);

  const active = tabs.find((t) => t.id === activeTabId);
  const pending = agentActions.filter((a) => a.status === 'pending');
  const reviewedOutcomes = agentActions.filter((a) => a.status !== 'pending').slice(0, 5);

  const refreshStatus = React.useCallback(async () => {
    const status = await browserStatus();
    setRuntime(status);
    return status;
  }, [setRuntime]);

  const connectCdp = React.useCallback(
    async (wsUrl: string): Promise<CdpSession> => {
      const pageWs = (await resolvePageWsUrl(wsUrl)) ?? wsUrl;
      const session = new CdpSession();
      await session.connect(pageWs);
      session.onScreencast((b64) => setFrame(`data:image/jpeg;base64,${b64}`));
      session.onCdpEvent((method, params) => {
        if (method === 'Runtime.consoleAPICalled' && params && typeof params === 'object') {
          const p = params as {
            type?: string;
            args?: Array<{ value?: unknown; description?: string }>;
          };
          const text = (p.args ?? [])
            .map((a) => String(a.value ?? a.description ?? ''))
            .join(' ')
            .slice(0, 500);
          const level = p.type === 'error' ? 'error' : p.type === 'warning' ? 'warn' : 'log';
          pushConsole(level, text || method);
        }
        if (method === 'Page.frameNavigated' && params && typeof params === 'object') {
          const frame = (params as { frame?: { url?: string } }).frame;
          if (frame?.url && activeTabId) {
            updateTab(activeTabId, { url: frame.url, title: frame.url, loading: false });
            setDraftUrl(frame.url);
          }
        }
      });
      await session.startScreencast();
      cdpRef.current = session;
      setCdpConnected(true);
      pushConsole('info', 'Agent CDP connected');
      return session;
    },
    [activeTabId, pushConsole, setDraftUrl, setFrame, updateTab],
  );

  React.useEffect(() => {
    void refreshStatus();
    const initial = sessionStorage.getItem('vibespace-browser-initial-url');
    if (initial) {
      sessionStorage.removeItem('vibespace-browser-initial-url');
      setDraftUrl(initial);
      if (activeTabId) updateTab(activeTabId, { url: initial, title: initial });
    }
    return () => {
      hostLeaseRef.current?.revoke();
      hostLeaseRef.current = null;
      void cdpRef.current?.close();
      cdpRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    hostLeaseRef.current?.revoke();
    hostLeaseRef.current = null;
    const identity = getActiveAccountIdentity();
    const session = cdpRef.current;
    const sessionId = runtime?.session_id;
    if (
      engine !== 'agent' ||
      !cdpConnected ||
      !identity ||
      !session ||
      !sessionId ||
      !active
    ) {
      return;
    }
    let origin = 'null';
    try {
      origin = new URL(active.url).origin;
    } catch {
      // Invalid/about URLs stay explicitly null-scoped.
    }
    const issuedAt = Date.now();
    const lease = registerBrowserGoalHostSession({
      scope: {
        accountId: identity.accountId,
        sessionId,
        tabId: active.id,
        origin,
        purpose: 'browser_goal',
        issuedAt,
        expiresAt: issuedAt + BROWSER_GOAL_HOST_LEASE_MS,
      },
      cdp: session,
    });
    hostLeaseRef.current = lease;
    const expiry = window.setTimeout(() => lease.revoke(), BROWSER_GOAL_HOST_LEASE_MS);
    return () => {
      window.clearTimeout(expiry);
      lease.revoke();
      if (hostLeaseRef.current?.id === lease.id) hostLeaseRef.current = null;
    };
  }, [active, cdpConnected, engine, runtime?.session_id]);

  const navigateIframe = (url: string) => {
    setIframeBlocked(false);
    if (active) updateTab(active.id, { url, title: url, loading: true });
    setDraftUrl(url);
    // iframe src is bound to active.url — loading ends on load event
    window.setTimeout(() => {
      if (active) updateTab(active.id, { loading: false });
    }, 800);
  };

  const go = async (raw?: string) => {
    const target = (raw ?? draftUrl).trim();
    if (!target || target === 'about:blank') {
      if (active) updateTab(active.id, { url: 'about:blank', title: 'New Tab', loading: false });
      setDraftUrl('about:blank');
      return;
    }

    const norm = normalizePreviewUrl(target);
    if (!norm.ok) {
      toast.warning('Invalid URL', norm.message);
      return;
    }
    const url = norm.url;

    if (engine === 'agent') {
      if (active) updateTab(active.id, { url, title: url, loading: true });
      setDraftUrl(url);
      try {
        if (!cdpRef.current) {
          const status = runtime?.running
            ? runtime
            : (await browserStart()).ok
              ? await browserStatus()
              : null;
          if (status?.cdp_ws_url) {
            setRuntime(status);
            await connectCdp(status.cdp_ws_url);
          } else {
            toast.warning(
              'Agent runtime',
              'Could not start Edge/Chrome CDP — switching to Simple Browser.',
            );
            setEngine('iframe');
            navigateIframe(url);
            return;
          }
        }
        await cdpRef.current?.navigate(url);
      } catch (e) {
        pushConsole('error', e instanceof Error ? e.message : 'Navigate failed');
        toast.warning('Agent navigate failed', 'Falling back to Simple Browser (iframe).');
        setEngine('iframe');
        navigateIframe(url);
      }
      if (active) updateTab(active.id, { loading: false, title: url });
      return;
    }

    navigateIframe(url);
    pushConsole('info', `Simple Browser → ${url}`);
  };

  const reload = () => {
    if (engine === 'agent') {
      void cdpRef.current?.reload(false);
      return;
    }
    const el = iframeRef.current;
    if (el && active?.url && active.url !== 'about:blank') {
      // Force reload
      const u = active.url;
      el.src = 'about:blank';
      window.setTimeout(() => {
        el.src = u;
      }, 30);
    }
  };

  const startAgentRuntime = async () => {
    setEngine('agent');
    const result = await browserStart();
    if (!result.ok) {
      toast.warning('Browser runtime', result.error.message);
      pushConsole('error', result.error.message);
      setEngine('iframe');
      await refreshStatus();
      return;
    }
    setRuntime(result.status);
    toast.success('Agent runtime', 'Isolated Edge/Chrome profile ready');
    if (result.status.cdp_ws_url) {
      try {
        await connectCdp(result.status.cdp_ws_url);
        if (active?.url && active.url !== 'about:blank') {
          await cdpRef.current?.navigate(active.url);
        }
      } catch (e) {
        pushConsole('error', e instanceof Error ? e.message : 'CDP connect failed');
        setEngine('iframe');
      }
    }
  };

  const stopAgentRuntime = async () => {
    abortAgentActions();
    hostLeaseRef.current?.revoke();
    hostLeaseRef.current = null;
    await cdpRef.current?.close();
    cdpRef.current = null;
    setCdpConnected(false);
    setFrame(null);
    await browserStop();
    await refreshStatus();
    setEngine('iframe');
    toast.info('Back to Simple Browser');
  };

  const showUrl = active?.url && active.url !== 'about:blank' ? active.url : '';

  return (
    <div
      className="browser-shell [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:text-foreground"
      data-testid="vibe-browser"
      data-vibespace-owned-chrome="browser"
    >
      <div className="browser-tabs [html[data-theme=monochrome]_&]:gap-1 [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none">
        <div role="tablist" aria-label="Browser tabs" className="flex min-w-0 items-stretch gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`browser-tab [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-wide ${
                tab.id === activeTabId
                  ? 'is-active [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none'
                  : ''
              }`}
              role="tab"
              aria-selected={tab.id === activeTabId}
              aria-keyshortcuts="Delete"
              data-loading={tab.loading ? 'true' : 'false'}
              onClick={(e) => {
                if (
                  e.target instanceof Element &&
                  e.target.closest('[data-browser-tab-close="true"]')
                ) {
                  closeTab(tab.id);
                  return;
                }
                setActiveTab(tab.id);
                setDraftUrl(tab.url);
                setIframeBlocked(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Delete') {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
            >
              <span title={tab.url}>{tab.title || tab.url}</span>
              <span
                aria-hidden="true"
                data-browser-tab-close="true"
                title={`Close ${tab.title}`}
                className="inline-flex shrink-0 rounded-sm opacity-70 hover:text-accent-copper hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="New tab"
          onClick={() => newTab('about:blank')}
        >
          <Plus />
        </Button>
      </div>

      <header className="browser-toolbar [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:shadow-none">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          onClick={() => {
            try {
              iframeRef.current?.contentWindow?.history.back();
            } catch {
              /* cross-origin */
            }
          }}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          onClick={() => {
            try {
              iframeRef.current?.contentWindow?.history.forward();
            } catch {
              /* cross-origin */
            }
          }}
        >
          <ArrowRight />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload" onClick={reload}>
          <RefreshCw />
        </Button>

        <form
          className="browser-url [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:pl-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <Globe2
            className="h-3.5 w-3.5 [html[data-theme=monochrome]_&]:!text-muted-foreground"
            style={{ color: 'hsl(var(--accent-copper))', flex: '0 0 auto' }}
          />
          <input
            className="[html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-0 [html[data-theme=monochrome]_&]:border-l [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-transparent [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:focus-visible:outline [html[data-theme=monochrome]_&]:focus-visible:outline-2 [html[data-theme=monochrome]_&]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&]:focus-visible:outline-ring"
            aria-label="Address bar"
            value={draftUrl === 'about:blank' ? '' : draftUrl}
            placeholder="localhost:5173 or https://…"
            onChange={(e) => setDraftUrl(e.target.value)}
          />
          <Button type="submit" size="sm" variant="accent">
            Go
          </Button>
        </form>

        <span
          className={`browser-agent-pill [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-muted [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:text-foreground ${
            engine === 'agent'
              ? 'is-hot [html[data-theme=monochrome]_&]:border-destructive [html[data-theme=monochrome]_&]:bg-destructive/10 [html[data-theme=monochrome]_&]:text-destructive'
              : ''
          }`}
        >
          <Shield className="h-3 w-3" />
          {engine === 'agent' ? 'Agent engine' : 'Simple Browser'}
        </span>

        {(agentArmed || pending.length > 0) && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => {
              abortAgentActions();
              toast.info('Agent stopped');
            }}
          >
            <Square className="h-3 w-3" /> Stop Agent
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          Profile
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setConsoleOpen(!consoleOpen)}
        >
          Console
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!showUrl}
          onClick={() => showUrl && void openExternal(showUrl)}
        >
          <ExternalLink /> External
        </Button>

        {engine === 'agent' ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void stopAgentRuntime()}>
            Use Simple Browser
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!isTauriRuntime()}
            title={
              isTauriRuntime()
                ? 'Optional isolated Edge/Chrome for agent control'
                : 'Desktop app only'
            }
            onClick={() => void startAgentRuntime()}
          >
            Agent runtime
          </Button>
        )}
      </header>

      <div className="browser-body">
        {sidebarOpen ? (
          <aside
            className="browser-sidebar [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
            aria-label="Browser sidebar"
          >
            <h3 className="[html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-[0.14em] [html[data-theme=monochrome]_&]:text-foreground">
              Engine
            </h3>
            <p>
              <strong style={{ color: 'hsl(var(--foreground))' }}>Simple Browser</strong> embeds
              pages in-app (same idea as VS Code / Canvas simple browser). Best for localhost and
              sites that allow framing.
            </p>
            <p style={{ marginTop: 8 }}>
              <strong style={{ color: 'hsl(var(--foreground))' }}>Agent runtime</strong> launches an
              isolated Edge/Chrome profile with CDP for automation. Optional.
            </p>
            <h3
              className="[html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-[0.14em] [html[data-theme=monochrome]_&]:text-foreground"
              style={{ marginTop: 14 }}
            >
              Profile
            </h3>
            <p>Isolated app-data profile — never your everyday browser.</p>
            <p style={{ marginTop: 8 }}>
              Status: {runtime?.running ? 'Agent running' : 'Simple mode'}
            </p>
            {runtime?.cdp_port ? <p>CDP: 127.0.0.1:{runtime.cdp_port}</p> : null}
            {runtime?.last_error ? <p className="err">{runtime.last_error}</p> : null}
            <h3
              className="[html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:tracking-[0.14em] [html[data-theme=monochrome]_&]:text-foreground"
              style={{ marginTop: 14 }}
            >
              Control mode
            </h3>
            <select
              className="[html[data-theme=monochrome]_&]:min-h-8 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:text-foreground [html[data-theme=monochrome]_&]:focus-visible:outline [html[data-theme=monochrome]_&]:focus-visible:outline-2 [html[data-theme=monochrome]_&]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&]:focus-visible:outline-ring"
              aria-label="Agent control mode"
              value={active?.controlMode ?? 'ask_every_action'}
              onChange={(e) =>
                active && setControlMode(active.id, e.target.value as typeof active.controlMode)
              }
              style={{ width: '100%', marginBottom: 8 }}
            >
              <option value="user_only">User only</option>
              <option value="ask_every_action">Ask before every action</option>
              <option value="allow_safe_session">Allow safe actions (session)</option>
              <option value="agent_controlled">Agent controlled</option>
            </select>
            <Button type="button" size="sm" variant="ghost" onClick={() => restoreClosed()}>
              Restore closed tab
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              style={{ marginTop: 6 }}
              onClick={() => void refreshStatus()}
            >
              Refresh diagnostics
            </Button>
          </aside>
        ) : null}

        <div
          className="browser-viewport [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:bg-none"
          data-testid="browser-viewport"
        >
          {engine === 'agent' && frameDataUrl ? (
            <img
              src={frameDataUrl}
              alt="Live agent browser view"
              className="browser-viewport-cast"
              data-remote-content-boundary="provider-screencast"
            />
          ) : showUrl ? (
            <div className="browser-iframe-wrap">
              <iframe
                ref={iframeRef}
                key={`${activeTabId}:${showUrl}`}
                title={active?.title || 'Vibe Browser'}
                className="browser-iframe"
                data-remote-content-boundary="provider-page"
                src={showUrl}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer-when-downgrade"
                onLoad={() => {
                  if (active)
                    updateTab(active.id, { loading: false, title: active.title || showUrl });
                  setIframeBlocked(false);
                }}
                onError={() => setIframeBlocked(true)}
              />
              {iframeBlocked ? (
                <div className="browser-iframe-block [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none">
                  <h3 className="[html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:font-semibold [html[data-theme=monochrome]_&]:tracking-tight">
                    Page blocked embedding
                  </h3>
                  <p>
                    This site refuses to load in an in-app browser (X-Frame-Options / CSP), same
                    limitation as VS Code Simple Browser.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button
                      type="button"
                      size="sm"
                      variant="accent"
                      onClick={() => void openExternal(showUrl)}
                    >
                      Open externally
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void startAgentRuntime()}
                    >
                      Try agent runtime
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="browser-viewport-empty [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none">
              <p className="browser-kicker [html[data-theme=monochrome]_&]:!font-mono [html[data-theme=monochrome]_&]:!tracking-[0.14em] [html[data-theme=monochrome]_&]:!text-foreground">
                Vibe Browser
              </p>
              <h2 className="[html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:font-semibold [html[data-theme=monochrome]_&]:tracking-tight">
                Browse inside the workspace
              </h2>
              <p>
                Type a URL above (try <code>http://localhost:5173</code>) and press Go. Simple
                Browser mode works immediately — no extra runtime required.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  onClick={() => {
                    setDraftUrl('http://localhost:5173');
                    void go('http://localhost:5173');
                  }}
                >
                  localhost:5173
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraftUrl('https://example.com');
                    void go('https://example.com');
                  }}
                >
                  example.com
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {(consoleOpen || pending.length > 0 || reviewedOutcomes.length > 0) && (
        <div
          className="browser-console [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          aria-label="Browser console and approvals"
        >
          {pending.map((action) => (
            <div
              key={action.id}
              className={`browser-approval [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:bg-muted/50 [html[data-theme=monochrome]_&]:shadow-none ${
                action.risk === 'dangerous'
                  ? '[html[data-theme=monochrome]_&]:border-l-destructive'
                  : action.risk === 'safe'
                    ? '[html[data-theme=monochrome]_&]:border-l-muted-foreground'
                    : '[html[data-theme=monochrome]_&]:border-l-accent-cyan'
              }`}
              data-risk={action.risk}
              data-status={action.status}
            >
              <strong>
                {action.risk.toUpperCase()} · {action.kind}
              </strong>
              <div>{action.safeSummary}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  onClick={() => {
                    void approveBrowserCanonicalReviewedAction(action.id);
                  }}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => denyBrowserCanonicalReviewedAction(action.id)}
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
          {reviewedOutcomes.map((action) => (
            <div
              key={action.id}
              className={`browser-approval [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:bg-muted/50 [html[data-theme=monochrome]_&]:shadow-none ${
                action.risk === 'dangerous'
                  ? '[html[data-theme=monochrome]_&]:border-l-destructive'
                  : action.risk === 'safe'
                    ? '[html[data-theme=monochrome]_&]:border-l-muted-foreground'
                    : '[html[data-theme=monochrome]_&]:border-l-accent-cyan'
              } ${
                action.status === 'denied' ||
                action.status === 'cancelled' ||
                action.status === 'failed' ||
                action.status === 'expired' ||
                action.status === 'unavailable'
                  ? '[html[data-theme=monochrome]_&]:border-l-dashed [html[data-theme=monochrome]_&]:text-muted-foreground'
                  : ''
              }`}
              data-risk={action.risk}
              data-status={action.status}
            >
              <strong>
                {action.status.toUpperCase()} · {action.kind}
              </strong>
              {action.result ? <div>{action.result}</div> : null}
            </div>
          ))}
          {consoleOpen
            ? consoleEntries.slice(0, 40).map((e) => (
                <div
                  key={e.id}
                  className={
                    e.level === 'error'
                      ? 'err [html[data-theme=monochrome]_&]:text-destructive'
                      : e.level === 'warn'
                        ? 'warn [html[data-theme=monochrome]_&]:text-warning'
                        : undefined
                  }
                >
                  [{e.level}] {e.text}
                </div>
              ))
            : null}
        </div>
      )}
    </div>
  );
}

export default BrowserPage;
