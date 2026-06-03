/**
 * ErrorBoundary — top-level safety net for the workspace tree.
 *
 * Why this matters: without an error boundary, a thrown error inside any
 * descendant during render unmounts the whole React tree and the user
 * sees a blank/dark window with no recovery path. That's the
 * "screen goes dark and crashes" failure mode reported on the
 * RequireModelAccess → WorkspaceRoot transition.
 *
 * Behaviour:
 *   - Catches errors during render, in lifecycle methods, and in
 *     constructors of any child component.
 *   - Renders a calm error card with the message, a copy-to-clipboard
 *     stack trace, a "Reload app" button, and a "Open dev console"
 *     button (which toggles the DevConsole overlay so the user can
 *     see the wider context that led to the crash).
 *   - Mirrors the error into the DevConsole store so it shows up in
 *     the same feed as console/fetch/invoke logs.
 *
 * Two things this does NOT catch:
 *   - Errors in event handlers (those bubble to window 'error' instead;
 *     DevConsole.installPatchers() listens for them).
 *   - Errors in `setTimeout` / promises (those bubble to
 *     'unhandledrejection'; same patcher catches them).
 *
 * The boundary is intentionally placed *inside* AuthGate so the
 * onboarding flow itself stays simple — onboarding doesn't have any
 * lazy chunks or boot effects that need error containment.
 */

import * as React from 'react';
import { AlertTriangle, RotateCw, Terminal as TerminalIcon, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { devConsole } from '@/features/dev-console/store';

interface ErrorBoundaryState {
  /** Last error caught, or null when the tree is healthy. */
  error: Error | null;
  /** React's componentStack (which component the error fired in). */
  componentStack: string | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // React's typing on info.componentStack is `string | null` — it can
    // be null in StrictMode dev re-renders. Default to empty so the UI
    // doesn't have to null-check.
    const stack = info.componentStack ?? '';
    this.setState({ componentStack: stack });

    // Mirror into the DevConsole feed. This is the single most useful
    // breadcrumb when the user reports a crash: the error sits next to
    // the console.warn / fetch / invoke entries that led up to it.
    devConsole.log({
      level: 'error',
      channel: 'react',
      message: error.message || 'Render error',
      detail: {
        name: error.name,
        stack: error.stack,
        componentStack: stack,
      },
    });

    // Also forward to the underlying console so devtools shows the
    // standard "uncaught error" entry. Bypasses the patched console
    // because devConsole has already captured it.
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', error, stack);
    }
  }

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleOpenConsole = () => {
    devConsole.setOpen(true);
  };

  handleCopy = async () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const text = [
      `${error.name}: ${error.message}`,
      '',
      'Stack:',
      error.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack ?? '(no component stack)',
    ].join('\n');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      /* clipboard might be denied — fail silently */
    }
  };

  /**
   * Reset path used by the "Try again" button. Clears the captured
   * error so the boundary remounts its children. If the underlying
   * fault is still present this just trips again — we keep the
   * button so transient failures (a one-off lazy-chunk fetch error)
   * don't require a full reload.
   */
  handleReset = () => {
    this.setState({ error: null, componentStack: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const err = this.state.error;
    return (
      <div
        role="alert"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6 overflow-y-auto"
      >
        <div className="w-full max-w-2xl rounded-lg border border-accent-copper/40 bg-panel shadow-soft">
          <header className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-copper/10 text-accent-copper">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-ui-strong text-foreground">
                Something hit a snag
              </h2>
              <p className="text-metadata text-muted-foreground truncate">
                Jarvis caught a render error before it could blank the
                screen.
              </p>
            </div>
          </header>

          <div className="px-5 py-4 space-y-3">
            <div className="rounded-md border border-border bg-paper-soft px-3 py-2 font-mono text-secondary text-foreground">
              <span className="text-muted-foreground">{err.name}:</span>{' '}
              {err.message}
            </div>

            {err.stack && (
              <details className="rounded-md border border-border bg-paper-soft">
                <summary className="cursor-pointer px-3 py-2 text-metadata text-muted-foreground hover:bg-muted/40">
                  Stack trace
                </summary>
                <pre className="border-t border-border px-3 py-2 text-metadata font-mono text-foreground overflow-auto max-h-[280px]">
                  {err.stack}
                </pre>
              </details>
            )}

            {this.state.componentStack && (
              <details className="rounded-md border border-border bg-paper-soft">
                <summary className="cursor-pointer px-3 py-2 text-metadata text-muted-foreground hover:bg-muted/40">
                  Component stack
                </summary>
                <pre className="border-t border-border px-3 py-2 text-metadata font-mono text-foreground overflow-auto max-h-[200px]">
                  {this.state.componentStack}
                </pre>
              </details>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={this.handleCopy}
              className="gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy details
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={this.handleOpenConsole}
              className="gap-1.5"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              Open dev console
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={this.handleReset}
            >
              Try again
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={this.handleReload}
              className="gap-1.5"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Reload app
            </Button>
          </footer>
        </div>
      </div>
    );
  }
}
