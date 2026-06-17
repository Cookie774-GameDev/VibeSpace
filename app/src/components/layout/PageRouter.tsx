import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import type { Route } from '@/stores/ui';

/**
 * V3 PageRouter.
 *
 * Reads `route` from `useUIStore` and renders the matching page lazily,
 * inside a single `<Suspense>` boundary. Each non-core feature page is
 * imported with a `.catch` fallback so a missing slice falls back to a
 * cozy `PlaceholderPage` card instead of taking the whole app down.
 *
 * The chat route uses the existing `ChatView`. Council-mode dispatch
 * historically lived in `ActiveCanvas` (App.tsx); this slice routes the
 * surface only — re-wiring council to the route layer is a follow-up.
 *
 * `route` is transient (see `partialize` in `ui.ts`), so reloads always
 * land back on `'chat'`.
 */

interface PlaceholderPageProps {
  title: string;
  hint: string;
}

/**
 * Cozy fallback card. Centered on the canvas; uses the warm paper
 * surface + a copper eyebrow so the user knows the app is intact, the
 * feature just hasn't loaded.
 */
function PlaceholderPage({ title, hint }: PlaceholderPageProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-paper-warm p-8">
      <div className="bg-paper rounded-lg shadow-soft p-12 text-center max-w-md">
        <p className="text-metadata uppercase tracking-wider text-accent-copper mb-3">
          {hint}
        </p>
        <h2 className="font-display text-hero text-foreground">{title}</h2>
        <p className="mt-3 text-secondary text-muted-foreground">
          This page will appear once its module is installed.
        </p>
      </div>
    </div>
  );
}

/**
 * Suspense fallback shown while a lazy page chunk is in flight.
 * Small breathing copper dot — keeps the canvas from flickering blank.
 */
function PageLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div
        role="status"
        aria-label="Loading page"
        className="bg-paper rounded-lg shadow-soft px-5 py-3 flex items-center gap-3"
      >
        <span
          aria-hidden
          className="h-2.5 w-2.5 rounded-full bg-accent-copper animate-breathe"
        />
        <span className="text-secondary text-muted-foreground">Loading…</span>
      </div>
    </div>
  );
}

// ---------- Lazy page components ----------
//
// Core (chat / agents) are guaranteed to exist so they don't carry a
// catch-fallback. Every other slice is wrapped: a missing module
// resolves to a placeholder instead of throwing.

const ChatRoute = React.lazy(() =>
  import('@/features/chat').then((m) => ({ default: m.ChatView })),
);

const AgentsRoute = React.lazy(() =>
  import('@/features/agents').then((m) => ({ default: m.AgentManager })),
);

const AgentDetailRoute = React.lazy(() =>
  import('@/features/agents')
    .then((m) => ({ default: m.AgentDetail }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="Agent details" hint="Module not loaded" />
      ),
    })),
);

const ProjectDetailRoute = React.lazy(() =>
  import('@/features/projects')
    .then((m) => ({ default: m.ProjectDetail }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="Project details" hint="Module not loaded" />
      ),
    })),
);

const TerminalsPage = React.lazy(() =>
  import('@/features/terminals/TerminalsPage')
    .then((m) => ({ default: m.TerminalsPage }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="Terminals" hint="Module not loaded" />
      ),
    })),
);

const KanbanPage = React.lazy(() =>
  import('@/features/kanban')
    .then((m) => ({ default: m.KanbanPage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Kanban" hint="Module not loaded" />,
    })),
);

const SchedulePage = React.lazy(() =>
  import('@/features/schedule')
    .then((m) => ({ default: m.SchedulePage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Schedule" hint="Module not loaded" />,
    })),
);

const ContextPage = React.lazy(() =>
  import('@/features/context')
    .then((m) => ({ default: m.ContextPage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Context" hint="Module not loaded" />,
    })),
);

const SkillsPage = React.lazy(() =>
  import('@/features/skills')
    .then((m) => ({ default: m.SkillsPage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Skills" hint="Module not loaded" />,
    })),
);

const BenchmarksPage = React.lazy(() =>
  import('@/features/benchmarks')
    .then((m) => ({ default: m.BenchmarksPage }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="Benchmarks" hint="Module not loaded" />
      ),
    })),
);

const HistoryPage = React.lazy(() =>
  import('@/features/history')
    .then((m) => ({ default: m.HistoryPage }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="History" hint="Module not loaded" />
      ),
    })),
);

const ToolsPage = React.lazy(() =>
  import('@/features/tools')
    .then((m) => ({ default: m.ToolsPage }))
    .catch(() => ({
      default: () => (
        <PlaceholderPage title="Custom tools" hint="Module not loaded" />
      ),
    })),
);

const FilesPage = React.lazy(() =>
  import('@/features/files')
    .then((m) => ({ default: m.FilesPage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Files" hint="Module not loaded" />,
    })),
);

const AccountPage = React.lazy(() =>
  import('@/features/account')
    .then((m) => ({ default: m.AccountPage }))
    .catch(() => ({
      default: () => <PlaceholderPage title="Account" hint="Module not loaded" />,
    })),
);

// Single dispatch table keyed by `Route`. If a new route is added to the
// `Route` union in `ui.ts`, TypeScript will flag this map as incomplete.
const routeMap: Record<Route, React.LazyExoticComponent<React.ComponentType>> = {
  chat: ChatRoute,
  terminal: TerminalsPage,
  kanban: KanbanPage,
  schedule: SchedulePage,
  agents: AgentsRoute,
  'agent-detail': AgentDetailRoute,
  'project-detail': ProjectDetailRoute,
  context: ContextPage,
  skills: SkillsPage,
  benchmarks: BenchmarksPage,
  history: HistoryPage,
  tools: ToolsPage,
  files: FilesPage,
  account: AccountPage,
};

export function PageRouter() {
  const route = useUIStore((s) => s.route);
  const visibleRoute = React.useDeferredValue(route);
  const Page = routeMap[visibleRoute] ?? ChatRoute;
  const [terminalMounted, setTerminalMounted] = React.useState(visibleRoute === 'terminal');

  React.useEffect(() => {
    if (visibleRoute !== 'terminal') return;
    setTerminalMounted(true);
    const raf = window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('jarvis:terminals:visible'));
    });
    return () => window.cancelAnimationFrame(raf);
  }, [visibleRoute]);

  const shouldRenderTerminal = terminalMounted || visibleRoute === 'terminal';

  return (
    <React.Suspense fallback={<PageLoading />}>
      {shouldRenderTerminal ? (
        <div
          data-terminal-route-cache
          aria-hidden={visibleRoute !== 'terminal'}
          className={visibleRoute === 'terminal' ? 'h-full w-full' : 'hidden'}
        >
          <TerminalsPage />
        </div>
      ) : null}
      {visibleRoute !== 'terminal' ? (
        <Page key={visibleRoute} />
      ) : null}
    </React.Suspense>
  );
}

export default PageRouter;
