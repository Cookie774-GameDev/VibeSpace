/**
 * Actions palette — Mod+Shift+A.
 *
 * One place to fire any registered action by hand. Sister to:
 *   - The chat composer's Approve/Cancel cards (AI-proposed).
 *   - The cmdk command palette Mod+K (general navigation + chat ops).
 *   - The launcher Mod+Shift+L (pinned tiles + URLs).
 *
 * The actions palette is action-flavored — it focuses on running things
 * Jarvis can do, not on opening files or finding chats. Built-in
 * actions (`lib/actions/registry.ts`) appear alongside any user-
 * authored custom tools (`features/tools/toolStore.ts`).
 *
 * UX shape:
 *   - Modal dialog at top-15vh (so the input is in thumb range above
 *     the visible content while still reading like a launcher).
 *   - Single search input at top — substring match across label +
 *     description + id.
 *   - Grouped list by category, with the user's most-recent invocations
 *     pinned to a "Recent" group at the top.
 *   - Click an action: if every required param has a default, run
 *     immediately; otherwise expand an inline form with one input per
 *     missing required param.
 *   - Esc / overlay click dismisses; close after a successful run.
 */

import * as React from 'react';
import {
  Sparkles,
  Play,
  Search,
  HelpCircle,
  ChevronRight,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import {
  getAllActions,
  runAction,
  CATEGORY_LABELS,
  CATEGORY_ICON,
  type ActionDef,
  type ActionParam,
} from '@/lib/actions';

/* --------------------------------------------------------------------------
 * Recent invocations — local-storage backed
 * --------------------------------------------------------------------------*/

const RECENT_KEY = 'jarvis-actions-recent';
const RECENT_CAP = 5;

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, RECENT_CAP) : [];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_CAP)));
  } catch {
    /* ignore quota errors */
  }
}

function pushRecent(prev: string[], id: string): string[] {
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_CAP);
  saveRecent(next);
  return next;
}

/* --------------------------------------------------------------------------
 * Search + grouping
 * --------------------------------------------------------------------------*/

function actionMatches(a: ActionDef, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    a.id.toLowerCase().includes(needle) ||
    a.label.toLowerCase().includes(needle) ||
    a.description.toLowerCase().includes(needle) ||
    a.category.toLowerCase().includes(needle)
  );
}

interface Group {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  actions: ActionDef[];
}

function groupActions(
  actions: ReadonlyArray<ActionDef>,
  recentIds: string[],
): Group[] {
  // "Recent" group surfaces actions the user has invoked before in
  // most-recent-first order, so the palette feels personalised.
  const idMap = new Map(actions.map((a) => [a.id, a]));
  const recent: ActionDef[] = recentIds
    .map((id) => idMap.get(id))
    .filter((a): a is ActionDef => Boolean(a));

  const recentSet = new Set(recent.map((a) => a.id));
  const remaining = actions.filter((a) => !recentSet.has(a.id));

  const byCategory = new Map<string, ActionDef[]>();
  for (const a of remaining) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const groups: Group[] = [];
  if (recent.length > 0) {
    groups.push({
      key: 'recent',
      label: 'Recent',
      icon: Sparkles,
      actions: recent,
    });
  }
  for (const [cat, items] of byCategory) {
    const label = CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat;
    const icon = (CATEGORY_ICON[cat] ?? HelpCircle) as React.ComponentType<{ className?: string }>;
    groups.push({ key: cat, label, icon, actions: items });
  }
  return groups;
}

/* --------------------------------------------------------------------------
 * Inline param form
 * --------------------------------------------------------------------------*/

interface ParamFormProps {
  action: ActionDef;
  onCancel: () => void;
  onRun: (params: Record<string, unknown>) => void;
}

function ParamForm({ action, onCancel, onRun }: ParamFormProps) {
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of action.params) {
      if (p.default !== undefined) init[p.key] = String(p.default);
    }
    return init;
  });

  const handleSubmit = () => {
    const params: Record<string, unknown> = {};
    for (const p of action.params) {
      const raw = values[p.key] ?? '';
      if (raw === '') {
        if (!p.required) continue;
        params[p.key] = '';
        continue;
      }
      if (p.type === 'number') {
        const n = Number(raw);
        params[p.key] = Number.isFinite(n) ? n : raw;
      } else if (p.type === 'boolean') {
        params[p.key] = raw === 'true' || raw === 'on';
      } else {
        params[p.key] = raw;
      }
    }
    onRun(params);
  };

  return (
    <div className="rounded-md border border-border bg-elevated px-3 py-2.5 mt-1 flex flex-col gap-2">
      <div className="text-metadata uppercase tracking-wide text-muted-foreground">
        Run with parameters
      </div>
      {action.params.map((p) => (
        <ParamField
          key={p.key}
          param={p}
          value={values[p.key] ?? ''}
          onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))}
        />
      ))}
      <div className="flex items-center gap-2 mt-1">
        <Button size="sm" variant="default" onClick={handleSubmit}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ParamField({
  param: p,
  value,
  onChange,
}: {
  param: ActionParam;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-metadata">
        <span className="font-mono text-foreground/90">{p.key}</span>
        <span className="ml-1 text-muted-foreground">— {p.label}</span>
        {p.required && <span className="ml-1 text-destructive">*</span>}
      </label>
      <Input
        type={p.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={p.placeholder}
        autoFocus={p.required}
      />
      {p.help && (
        <p className="mt-0.5 text-metadata text-muted-foreground">{p.help}</p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Action row
 * --------------------------------------------------------------------------*/

interface ActionRowProps {
  action: ActionDef;
  expanded: boolean;
  onClick: () => void;
  onCancel: () => void;
  onRun: (params: Record<string, unknown>) => void;
}

function ActionRow({ action, expanded, onClick, onCancel, onRun }: ActionRowProps) {
  const Icon = action.icon ?? Sparkles;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-md text-left',
          'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
          'focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <Icon className="h-3.5 w-3.5 text-accent-copper shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-secondary text-foreground truncate">
            {action.label}
          </div>
          <div className="text-metadata text-muted-foreground truncate">
            {action.description}
          </div>
        </div>
        <span className="text-metadata text-muted-foreground/60 font-mono shrink-0">
          {action.id}
        </span>
        <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
      </button>
      {expanded && (
        <ParamForm action={action} onCancel={onCancel} onRun={onRun} />
      )}
    </li>
  );
}

/* --------------------------------------------------------------------------
 * Palette
 * --------------------------------------------------------------------------*/

export function ActionsPalette() {
  const open = useUIStore((s) => s.actionsPaletteOpen);
  const setOpen = useUIStore((s) => s.setActionsPaletteOpen);

  const [query, setQuery] = React.useState('');
  const [recent, setRecent] = React.useState<string[]>(() => loadRecent());
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Reset transient form state every time the palette opens.
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setExpandedId(null);
    }
  }, [open]);

  const allActions = React.useMemo(() => getAllActions(), [open]);
  const filtered = React.useMemo(
    () => allActions.filter((a) => actionMatches(a, query)),
    [allActions, query],
  );
  const groups = React.useMemo(
    () => groupActions(filtered, recent),
    [filtered, recent],
  );

  const close = () => setOpen(false);

  const runById = async (
    id: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    setRecent((prev) => pushRecent(prev, id));
    const result = await runAction(id, params, { source: 'user' });
    if (result.ok) close();
    // On error, the runner already toasted; leave the palette open so
    // the user can adjust and retry.
  };

  const handleRowClick = (a: ActionDef) => {
    const requiredParamsMissingDefaults = a.params.filter(
      (p) => p.required && p.default === undefined,
    );
    if (requiredParamsMissingDefaults.length === 0) {
      // Either no params or every required has a default — fire away.
      void runById(a.id, {});
      return;
    }
    // Toggle the inline form open for this row.
    setExpandedId((cur) => (cur === a.id ? null : a.id));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl top-[15vh] translate-y-0">
        <DialogTitle className="flex items-center gap-2 text-secondary">
          <Sparkles className="h-4 w-4 text-accent-copper" />
          Actions
          <span className="ml-auto text-metadata text-muted-foreground/70 font-mono">
            Mod+Shift+A
          </span>
        </DialogTitle>

        {/* Search bar */}
        <div className="relative mt-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search actions… try 'terminal claude' or 'eye break'"
            className="pl-7"
            autoFocus
          />
        </div>

        {/* Results */}
        <div className="mt-2 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
          {groups.length === 0 ? (
            <div className="text-secondary text-muted-foreground px-2 py-4 text-center">
              No actions match{' '}
              <span className="font-mono text-foreground">{query}</span>.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-1.5 mb-1 px-2 text-metadata uppercase tracking-wide text-muted-foreground">
                  <g.icon className="h-3 w-3" />
                  {g.label}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {g.actions.map((a) => (
                    <ActionRow
                      key={`${g.key}-${a.id}`}
                      action={a}
                      expanded={expandedId === a.id}
                      onClick={() => handleRowClick(a)}
                      onCancel={() => setExpandedId(null)}
                      onRun={(params) => void runById(a.id, params)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="mt-2 text-metadata text-muted-foreground/70 px-2">
          Click an action to run it. Custom tools you save in{' '}
          <span className="text-foreground">Tools</span> appear here too.
        </div>
      </DialogContent>
    </Dialog>
  );
}
