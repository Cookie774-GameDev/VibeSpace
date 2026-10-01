import * as React from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { openExternal } from '@/lib/tauri';
import { browserFramePolicy, normalizeBrowserUrl } from './browserSecurity';
import type { WorkbenchPanel } from './types';

interface BrowserPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'blocked' | 'error';

async function requestNamedBrowser(url: string, browser: 'chrome' | 'edge'): Promise<void> {
  const normalized = normalizeBrowserUrl(url);
  const protocol =
    browser === 'edge'
      ? `microsoft-edge:${normalized}`
      : `googlechrome://navigate?url=${encodeURIComponent(normalized)}`;
  await openExternal(protocol);
}

export function BrowserPanel({ panel, onUpdate }: BrowserPanelProps) {
  const currentUrl = panel.settings.url ?? 'https://developer.mozilla.org';
  const [draft, setDraft] = React.useState(currentUrl);
  const [frameKey, setFrameKey] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('idle');
  const [history, setHistory] = React.useState<string[]>([currentUrl]);
  const [historyIndex, setHistoryIndex] = React.useState(0);
  const loadTimer = React.useRef<number | null>(null);

  const policy = React.useMemo(() => {
    try {
      return browserFramePolicy(currentUrl);
    } catch {
      return null;
    }
  }, [currentUrl]);

  React.useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  React.useEffect(() => {
    if (!policy) return;
    if (policy.frameBlocked) {
      setLoadState('blocked');
      return;
    }
    setLoadState('loading');
    if (loadTimer.current) window.clearTimeout(loadTimer.current);
    // Sites that fail silently still get a blocked fallback after a short wait.
    loadTimer.current = window.setTimeout(() => {
      setLoadState((prev) => (prev === 'loading' ? 'blocked' : prev));
    }, 3500);
    return () => {
      if (loadTimer.current) window.clearTimeout(loadTimer.current);
    };
  }, [policy?.src, policy?.frameBlocked, frameKey]);

  const commitUrl = (normalized: string, pushHistory: boolean) => {
    setError(null);
    setDraft(normalized);
    onUpdate({ settings: { ...panel.settings, url: normalized }, status: 'ready' });
    if (pushHistory) {
      setHistory((prev) => {
        const base = prev.slice(0, historyIndex + 1);
        if (base[base.length - 1] === normalized) return base;
        return [...base, normalized].slice(-40);
      });
      setHistoryIndex((idx) => Math.min(idx + 1, 39));
    }
    setLoadState('loading');
    setFrameKey((value) => value + 1);
  };

  const navigate = (event?: React.FormEvent) => {
    event?.preventDefault();
    try {
      const normalized = normalizeBrowserUrl(draft);
      commitUrl(normalized, true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That address cannot be opened.';
      setError(message);
      setLoadState('error');
      toast.warning('Browser address blocked', message);
    }
  };

  const goHistory = (delta: number) => {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    const url = history[next]!;
    try {
      const normalized = normalizeBrowserUrl(url);
      setDraft(normalized);
      onUpdate({ settings: { ...panel.settings, url: normalized }, status: 'ready' });
      setLoadState('loading');
      setFrameKey((value) => value + 1);
    } catch (cause) {
      toast.warning(
        'History address blocked',
        cause instanceof Error ? cause.message : 'Unsafe URL in history.',
      );
    }
  };

  const openExternalSafe = async (url = currentUrl) => {
    try {
      const normalized = normalizeBrowserUrl(url);
      await openExternal(normalized);
      toast.success('Opened in system browser', normalized);
    } catch (cause) {
      toast.warning(
        'Could not open externally',
        cause instanceof Error ? cause.message : 'Address rejected.',
      );
    }
  };

  const launchNamed = async (browser: 'chrome' | 'edge') => {
    try {
      await requestNamedBrowser(policy?.externalUrl ?? currentUrl, browser);
      toast.info(`${browser === 'chrome' ? 'Chrome' : 'Edge'} launch requested`, currentUrl);
    } catch (cause) {
      toast.warning(
        `${browser === 'chrome' ? 'Chrome' : 'Edge'} unavailable`,
        cause instanceof Error ? cause.message : 'Use Open externally instead.',
      );
    }
  };

  const showFrame =
    policy && !policy.frameBlocked && loadState !== 'blocked' && loadState !== 'idle';

  return (
    <div
      className="workbench-browser"
      data-testid="workbench-browser-panel"
      onWheel={(event) => event.stopPropagation()}
    >
      <form className="workbench-browser-bar" onSubmit={navigate}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          disabled={historyIndex <= 0}
          onClick={() => goHistory(-1)}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          disabled={historyIndex >= history.length - 1}
          onClick={() => goHistory(1)}
        >
          <ArrowRight />
        </Button>
        <Globe2 aria-hidden="true" />
        <input
          aria-label="Browser address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        <Button type="submit" size="icon-sm" variant="ghost" aria-label="Go">
          <ExternalLink />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reload browser"
          onClick={() => {
            setLoadState('loading');
            setFrameKey((value) => value + 1);
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Stop loading"
          onClick={() => setLoadState('idle')}
        >
          <Square />
        </Button>
      </form>
      <div className="workbench-browser-launchers" aria-label="External browser controls">
        <button type="button" onClick={() => void openExternalSafe()}>
          Open in system browser
        </button>
        <button type="button" onClick={() => void launchNamed('chrome')}>
          Open in Chrome
        </button>
        <button type="button" onClick={() => void launchNamed('edge')}>
          Open in Edge
        </button>
      </div>
      {error ? (
        <div className="workbench-panel-empty" role="alert">
          <strong>Address blocked</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {policy?.frameBlocked || loadState === 'blocked' ? (
        <div className="workbench-panel-empty" role="status" data-testid="workbench-browser-blocked">
          <strong>This site cannot run inside the Workbench frame</strong>
          <span>
            {policy?.frameBlocked
              ? 'The site blocks embedding (X-Frame-Options / CSP). Your URL is saved — open it in a real browser.'
              : 'The embedded preview did not load. Many sites refuse iframes. Open externally for a full session.'}
          </span>
          <Button type="button" size="sm" variant="accent" onClick={() => void openExternalSafe(policy?.externalUrl)}>
            <ExternalLink /> Open in system browser
          </Button>
          {!policy?.frameBlocked ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadState('loading');
                setFrameKey((k) => k + 1);
              }}
            >
              Retry embed
            </Button>
          ) : null}
        </div>
      ) : null}
      {showFrame && policy ? (
        <>
          {loadState === 'loading' ? (
            <p className="workbench-browser-status" aria-live="polite">
              Loading{policy.usedEmbed ? ' embed' : ''}…
            </p>
          ) : null}
          <iframe
            key={`${policy.src}-${frameKey}`}
            title={`${panel.title} web page`}
            src={policy.src}
            sandbox={policy.sandbox}
            referrerPolicy={policy.referrerPolicy}
            allow={policy.allow}
            onLoad={() => {
              if (loadTimer.current) window.clearTimeout(loadTimer.current);
              setLoadState('loaded');
            }}
          />
        </>
      ) : null}
      <p className="workbench-browser-engine">
        Embedded preview is sandboxed. Sites that refuse frames open via system browser — no VibeSpace
        credentials are shared.
      </p>
    </div>
  );
}

export { requestNamedBrowser };
