import { useState } from 'react';
import { KeyRound, ExternalLink, Eye, EyeOff, WifiOff, Sparkles, FastForward } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { devConsole } from '@/features/dev-console';

const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';

/**
 * RequireModelAccess — the model-access gate between onboarding and the
 * workspace.
 *
 * Three exit paths, in order of preference:
 *
 *   1. Connect a free Google Gemini key (the default new-user path).
 *   2. Flip into offline mode (Ollama-backed local model).
 *   3. Skip the gate entirely and use mock responses until the user
 *      decides to add a real model later.
 *
 * Why "Skip" exists: a brand-new user can hit this screen, change
 * their mind about onboarding, and have nothing to do — Esc didn't
 * close the gate, the providers list was buried behind another tab,
 * and dismissing the screen meant force-quitting the app. The Skip
 * button writes a sentinel `mock` API key so the gate's
 * `hasModelAccess` predicate flips true; chat still works (against
 * the mock provider, which is local-only and free) and the user can
 * upgrade from Settings → Providers whenever they're ready.
 *
 * The gate falls through automatically: the moment a key is saved,
 * offline mode is enabled, or the skip sentinel is set, `AuthGate`
 * re-renders (Zustand is reactive) and mounts the real app. No
 * manual "continue" needed.
 */
export function RequireModelAccess() {
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);
  const setOfflineMode = useAuthStore((s) => s.setOfflineMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);

  function saveKey() {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.warning('Enter your key', 'Paste your Gemini API key first.');
      return;
    }
    devConsole.log({
      channel: 'app',
      level: 'info',
      message: 'RequireModelAccess: connecting Gemini',
      detail: { provider: 'google', keyLength: trimmed.length },
    });
    setApiKey('google', trimmed);
    setDefaultProvider('google');
    toast.success('Gemini connected', 'Jarvis now has a real brain. Welcome aboard.');
    // AuthGate re-renders and falls through to the app on the next tick.
  }

  function goLocal() {
    devConsole.log({
      channel: 'app',
      level: 'info',
      message: 'RequireModelAccess: enabling offline mode',
    });
    setOfflineMode(true);
    toast.info('Offline mode on', 'Pick or download a local model in Settings \u2192 Local Models.');
    setSettingsOpen(true);
    // Jump to the Local Models tab once the settings modal mounts in the shell.
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('jarvis:settings:tab', { detail: { tab: 'localmodels' } }),
      );
    }, 90);
  }

  /**
   * Skip the gate by registering a mock-provider sentinel. The mock
   * provider satisfies `hasModelAccess` without sending any real
   * traffic, and the chat composer's free-tier nudge keeps reminding
   * the user there's a real provider one click away in settings.
   */
  function skipGate() {
    devConsole.log({
      channel: 'app',
      level: 'warn',
      message: 'RequireModelAccess: user skipped (using mock provider)',
    });
    setApiKey('mock', 'mock-skip-sentinel');
    setDefaultProvider('mock');
    toast.info(
      'Skipped for now',
      "Replies will use a local mock until you connect a real model in Settings \u2192 Providers.",
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center px-6 py-10 overflow-y-auto"
      role="dialog"
      aria-label="Connect a model"
    >
      <div className="w-full max-w-lg flex flex-col gap-6">
        <header className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-gradient">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-hero leading-tight">One quick step</h1>
          <p className="text-body text-muted-foreground mt-3">
            Jarvis needs a model to think. The free path is a Google Gemini key — no credit card,
            about 30 seconds.
          </p>
        </header>

        {/* Primary: Google Gemini key */}
        <section className="rounded-lg border border-accent-copper/40 bg-elevated p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-ui-strong text-foreground">
              <KeyRound className="h-4 w-4 text-accent-copper" />
              Google Gemini API key
            </span>
            <a
              href={GEMINI_KEY_URL}
              target="_blank"
              rel="noreferrer"
              className="text-metadata text-accent-copper underline-offset-4 hover:underline inline-flex items-center gap-0.5"
            >
              Get a free key <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1" data-jarvis-rainbow="true">
              <Input
                type={revealed ? 'text' : 'password'}
                placeholder="AIza..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveKey();
                  }
                }}
                className="pr-9 font-mono"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-label="Gemini API key"
              />
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={revealed ? 'Hide key' : 'Show key'}
                tabIndex={-1}
              >
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button variant="accent" size="sm" onClick={saveKey} disabled={!draft.trim()}>
              Connect
            </Button>
          </div>
          <p className="text-metadata text-muted-foreground">
            Stored locally on this device. It never leaves until you send a message to Google.
          </p>
        </section>

        {/* Divider */}
        <div className="flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          <span className="text-metadata text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Secondary: local / offline */}
        <button
          type="button"
          onClick={goLocal}
          className={cn(
            'group flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3 text-left transition-colors',
            'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <WifiOff className="h-5 w-5 text-muted-foreground group-hover:text-accent-cyan shrink-0 transition-colors" />
          <span className="min-w-0">
            <span className="block text-ui-strong text-foreground">Run fully offline instead</span>
            <span className="block text-metadata text-muted-foreground">
              No key, no internet. Use a local model via Ollama — we'll help you set it up.
            </span>
          </span>
        </button>

        {/* Tertiary: skip the gate. Tucked below the fold so it doesn't
            compete with the recommended paths above, but always visible
            so the user is never trapped on this screen. */}
        <div className="flex items-center justify-center pt-2">
          <button
            type="button"
            onClick={skipGate}
            className={cn(
              'inline-flex items-center gap-1.5 text-metadata text-muted-foreground',
              'hover:text-foreground transition-colors underline-offset-4 hover:underline',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded',
              'px-2 py-1',
            )}
            aria-label="Skip and connect a model later"
          >
            <FastForward className="h-3.5 w-3.5" />
            Skip for now (use mock replies until I connect a model)
          </button>
        </div>
      </div>
    </div>
  );
}
