/**
 * Custom tools store.
 *
 * A "custom tool" is a user-authored action: a friendly name + a base
 * built-in action + preset params. For example, the user can save:
 *
 *   { name: 'My dev server',
 *     baseAction: 'terminal.run',
 *     params: { command: 'npm run jarvis', label: 'dev', cwd: 'C:\\proj' } }
 *
 * …and then invoke it via Mod+Shift+A or have Jarvis propose it from
 * chat (`custom.my-dev-server`). All the heavy lifting (running the
 * command, mounting the page, etc.) is delegated to the underlying
 * built-in action — the custom tool is just a saved param preset with
 * a name.
 *
 * Why this lives in `features/tools/` rather than `lib/actions/`:
 *   - It depends on `lib/actions/registry` (looks up the base action
 *     when synthesising an `ActionDef`).
 *   - The Custom Tools page (`ToolsPage.tsx`) is the only UI consumer
 *     and lives in this feature folder.
 *
 * Persistence: Zustand `persist` middleware keyed by `jarvis-tools`.
 * Mutations are also mirrored into the local sync queue so signed-in users
 * can carry custom tools through Jarvis Cloud's app sync records.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { Wrench } from 'lucide-react';
import { getBuiltinAction } from '@/lib/actions/registry';
import type { ActionDef, ActionParam, ActionResult, ActionRunContext } from '@/lib/actions/types';

/* --------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------*/

/**
 * Persisted shape of a user-authored tool. The `params` field holds the
 * preset arguments forwarded to the base action's runner.
 *
 * `slug` becomes the tool's id namespace (`custom.<slug>`); we keep it
 * separate from the action id so collision handling is trivial.
 */
export interface CustomTool {
  /** URL-safe slug. Stable for the life of the tool. */
  slug: string;
  /** Human label used in UI + as the ActionDef label. */
  name: string;
  /** One-line description used in palette + AI catalogue. */
  description: string;
  /** Built-in action id this tool wraps (e.g. 'terminal.run'). */
  baseAction: string;
  /** Preset params merged into the base action's invocation. */
  params: Record<string, unknown>;
  /** Optional ordered workflow. When present, each step runs a built-in action. */
  steps?: CustomToolStep[];
  /** Optional emoji or short string shown next to the name in UI. */
  emoji?: string;
  /** Creation + last-edit timestamps for sort order in the page. */
  createdAt: number;
  updatedAt: number;
  /**
   * Public cloud-publish state. Private account sync is handled by the
   * local sync queue and does not require a server-issued publish id.
   */
  published: { id: string; at: number } | null;
}

export interface CustomToolStep {
  /** Built-in action id to run, e.g. 'nav.terminal' or 'terminal.run'. */
  action: string;
  /** Params forwarded to that action. */
  params: Record<string, unknown>;
  /** Optional human label for cards and run summaries. */
  label?: string;
}

/* --------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

/** Generate a URL-safe slug from a free-form name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Force-uniquify a slug against an existing tool list. */
function uniqueSlug(base: string, existing: ReadonlyArray<CustomTool>): string {
  if (!existing.some((t) => t.slug === base)) return base;
  let n = 2;
  while (existing.some((t) => t.slug === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

type ParamCheck =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function describeParamValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  const text = String(value);
  return text.length > 40 ? `"${text.slice(0, 40)}…"` : `"${text}"`;
}

function coerceToolParam(param: ActionParam, raw: unknown): ParamCheck {
  const isEmpty = raw === undefined || raw === null || raw === '';
  if (isEmpty) {
    if (param.required) {
      return { ok: false, error: `Missing required parameter: ${param.label} (${param.key}).` };
    }
    if (param.default !== undefined) return { ok: true, value: param.default };
    return { ok: true, value: undefined };
  }

  switch (param.type) {
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
      if (typeof raw === 'string' && raw.trim()) {
        const value = Number(raw);
        if (Number.isFinite(value)) return { ok: true, value };
      }
      return { ok: false, error: `Parameter "${param.key}" must be a number; got ${describeParamValue(raw)}.` };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const value = raw.trim().toLowerCase();
        if (value === 'true' || value === 'on' || value === '1') return { ok: true, value: true };
        if (value === 'false' || value === 'off' || value === '0') return { ok: true, value: false };
      }
      return { ok: false, error: `Parameter "${param.key}" must be true/false; got ${describeParamValue(raw)}.` };
    }
    case 'select': {
      if (typeof raw !== 'string') {
        return { ok: false, error: `Parameter "${param.key}" must be a string; got ${describeParamValue(raw)}.` };
      }
      const allowed = (param.options ?? []).map((option) => option.value);
      if (allowed.length > 0 && !allowed.includes(raw)) {
        return { ok: false, error: `Parameter "${param.key}" must be one of: ${allowed.join(', ')}.` };
      }
      return { ok: true, value: raw };
    }
    case 'route':
    case 'string':
    default: {
      if (typeof raw === 'string') return { ok: true, value: raw };
      if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) };
      return { ok: false, error: `Parameter "${param.key}" must be a string; got ${describeParamValue(raw)}.` };
    }
  }
}

function validateToolParams(
  def: ActionDef,
  params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const errors: string[] = [];
  const next: Record<string, unknown> = { ...params };
  for (const param of def.params) {
    const checked = coerceToolParam(param, params[param.key]);
    if (!checked.ok) {
      errors.push(checked.error);
      continue;
    }
    if (checked.value === undefined) {
      delete next[param.key];
    } else {
      next[param.key] = checked.value;
    }
  }
  return errors.length > 0 ? { ok: false, error: errors.join(' ') } : { ok: true, params: next };
}

async function runValidatedBuiltinAction(
  action: ActionDef,
  params: Record<string, unknown>,
  ctx: ActionRunContext,
): Promise<ActionResult> {
  const validation = validateToolParams(action, params);
  if (!validation.ok) return { ok: false, error: validation.error };
  return action.run(validation.params, ctx);
}

function dispatchToolsUpdated(): void {
  if (typeof window === 'undefined') return;
  queueMicrotask(() => {
    window.dispatchEvent(new CustomEvent('jarvis:tools-updated'));
  });
}

const CUSTOM_TOOLS_SYNC_TABLE = 'custom_tools';

function enqueueToolSync(op: 'insert' | 'update' | 'delete', tool: CustomTool): void {
  void import('@/lib/sync')
    .then(({ enqueueMutation }) =>
      enqueueMutation(op, CUSTOM_TOOLS_SYNC_TABLE, tool.slug, op === 'delete' ? null : tool),
    )
    .catch((err) => {
      console.warn('[sync] failed to enqueue custom tool mutation', {
        slug: tool.slug,
        op,
        err,
      });
    });
}

export function normalizeToolSteps(value: unknown): CustomToolStep[] {
  if (!Array.isArray(value)) return [];
  const steps: CustomToolStep[] = [];
  for (const rawStep of value) {
    if (!isRecord(rawStep)) continue;
    const action = typeof rawStep.action === 'string' ? rawStep.action.trim() : '';
    if (!action || action.startsWith('custom.')) continue;
    steps.push({
      action,
      params: isRecord(rawStep.params) ? { ...rawStep.params } : {},
      label: typeof rawStep.label === 'string' && rawStep.label.trim() ? rawStep.label.trim() : undefined,
    });
  }
  return steps.slice(0, 12);
}

export function parseToolStepsJson(json: string): CustomToolStep[] {
  const parsed = JSON.parse(json);
  const steps = normalizeToolSteps(parsed);
  if (steps.length === 0) {
    throw new Error('Workflow must be a JSON array with at least one built-in action step.');
  }
  return steps;
}

/* --------------------------------------------------------------------------
 * Store
 * --------------------------------------------------------------------------*/

interface ToolStoreState {
  tools: CustomTool[];

  /** Sorted view (most-recently-updated first). */
  list: () => CustomTool[];

  /** Lookup by slug (no `custom.` prefix). */
  bySlug: (slug: string) => CustomTool | undefined;

  /**
   * Resolve `custom.<slug>` to an `ActionDef`. Returns `undefined` if
   * the id doesn't have the `custom.` prefix or the slug is unknown.
   * Used by the action runner.
   */
  resolve: (id: string) => ActionDef | undefined;

  /**
   * All tools as `ActionDef` entries (for the palette + prompt
   * addendum). Each entry's `run` delegates to the wrapped built-in.
   */
  toActionDefs: () => ActionDef[];

  /** Create a new tool. Slug is derived from name when omitted. */
  create: (
    input: Omit<CustomTool, 'slug' | 'createdAt' | 'updatedAt' | 'published'> & {
      slug?: string;
    },
  ) => CustomTool;

  /** Patch an existing tool by slug. No-op if slug is unknown. */
  update: (slug: string, patch: Partial<Omit<CustomTool, 'slug'>>) => void;

  /** Delete a tool by slug. */
  remove: (slug: string) => void;

  /** Queue the current tool state into private Jarvis Cloud account sync. */
  publish: (slug: string) => Promise<ActionResult>;

  /** Bulk import (used by the "Import JSON" UI). Returns count added. */
  importMany: (incoming: ReadonlyArray<CustomTool>) => number;
}

/**
 * Build the runtime ActionDef for a saved tool. Defined as a private
 * helper so any future call sites use the same shape.
 */
function toolToActionDef(t: CustomTool): ActionDef {
  const steps = normalizeToolSteps(t.steps);
  return {
    id: `custom.${t.slug}`,
    category: 'custom',
    label: t.name,
    description: t.description,
    icon: Wrench,
    params: [], // preset params live on the tool, not the form
    exposeToAI: true,
    run: async (
      _params: Record<string, unknown>,
      ctx: ActionRunContext,
    ): Promise<ActionResult> => {
      if (steps.length > 0) {
        const summaries: string[] = [];
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
          const step = steps[stepIndex];
          const action = getBuiltinAction(step.action);
          if (!action) {
            return {
              ok: false,
              error: `Step ${stepIndex + 1} references an unknown built-in action: ${step.action}.`,
            };
          }
          const result = await runValidatedBuiltinAction(action, step.params, ctx);
          if (!result.ok) {
            return {
              ok: false,
              error: `Step ${stepIndex + 1} (${step.label ?? step.action}) failed: ${result.error}`,
            };
          }
          summaries.push(result.summary ?? step.label ?? step.action);
        }
        return {
          ok: true,
          summary: `Ran ${steps.length} workflow step${steps.length === 1 ? '' : 's'}.`,
          data: { steps: summaries },
        };
      }
      const base = getBuiltinAction(t.baseAction);
      if (!base) {
        return {
          ok: false,
          error: `Tool "${t.name}" is wired to an unknown base action: ${t.baseAction}.`,
        };
      }
      return runValidatedBuiltinAction(base, t.params, ctx);
    },
  };
}

export const useToolStore = create<ToolStoreState>()(
  persist(
    (set, get) => ({
      tools: [],

      list: () =>
        [...get().tools].sort((a, b) => b.updatedAt - a.updatedAt),

      bySlug: (slug) => get().tools.find((t) => t.slug === slug),

      resolve: (id) => {
        if (!id.startsWith('custom.')) return undefined;
        const slug = id.slice('custom.'.length);
        const t = get().tools.find((x) => x.slug === slug);
        return t ? toolToActionDef(t) : undefined;
      },

      toActionDefs: () => get().tools.map(toolToActionDef),

      create: (input) => {
        const now = Date.now();
        const baseSlug = (input.slug ?? slugify(input.name)) || 'tool';
        const slug = uniqueSlug(baseSlug, get().tools);
        const tool: CustomTool = {
          slug,
          name: input.name,
          description: input.description,
          baseAction: input.baseAction,
          params: { ...input.params },
          steps: input.steps ? normalizeToolSteps(input.steps) : undefined,
          emoji: input.emoji,
          createdAt: now,
          updatedAt: now,
          published: null,
        };
        set((s) => ({ tools: [tool, ...s.tools] }));
        enqueueToolSync('insert', tool);
        dispatchToolsUpdated();
        return tool;
      },

      update: (slug, patch) => {
        let updatedTool: CustomTool | undefined;
        set((s) => ({
          tools: s.tools.map((t) => {
            if (t.slug !== slug) return t;
            updatedTool = { ...t, ...patch, slug, updatedAt: Date.now() };
            return updatedTool;
          }),
        }));
        if (updatedTool) enqueueToolSync('update', updatedTool);
        dispatchToolsUpdated();
      },

      remove: (slug) => {
        const removedTool = get().tools.find((t) => t.slug === slug);
        set((s) => ({ tools: s.tools.filter((t) => t.slug !== slug) }));
        if (removedTool) enqueueToolSync('delete', removedTool);
        dispatchToolsUpdated();
      },

      publish: async (slug) => {
        const tool = get().tools.find((t) => t.slug === slug);
        if (!tool) return { ok: false, error: `Unknown custom tool: ${slug}` };
        enqueueToolSync('update', tool);
        return {
          ok: true,
          summary: 'Queued for Jarvis Cloud account sync.',
          data: { slug },
        };
      },

      importMany: (incoming) => {
        if (!Array.isArray(incoming) || incoming.length === 0) return 0;
        const existing = get().tools;
        const added: CustomTool[] = [];
        for (const raw of incoming) {
          if (!raw || typeof raw !== 'object') continue;
          const name = typeof raw.name === 'string' ? raw.name.trim() : '';
          const baseAction =
            typeof raw.baseAction === 'string' ? raw.baseAction.trim() : '';
          const steps = normalizeToolSteps((raw as { steps?: unknown }).steps);
          if (!name || (!baseAction && steps.length === 0)) continue;
          const description =
            typeof raw.description === 'string' ? raw.description : '';
          const params =
            raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
              ? (raw.params as Record<string, unknown>)
              : {};
          const slugBase = slugify(typeof raw.slug === 'string' ? raw.slug : name);
          const slug = uniqueSlug(slugBase || 'tool', [...existing, ...added]);
          const now = Date.now();
          added.push({
            slug,
            name,
            description,
            baseAction: steps.length > 0 ? 'workflow.run' : baseAction,
            params: steps.length > 0 ? {} : params,
            steps: steps.length > 0 ? steps : undefined,
            emoji: typeof raw.emoji === 'string' ? raw.emoji : undefined,
            createdAt: now,
            updatedAt: now,
            published: null,
          });
        }
        if (added.length === 0) return 0;
        set((s) => ({ tools: [...added, ...s.tools] }));
        added.forEach((tool) => enqueueToolSync('insert', tool));
        dispatchToolsUpdated();
        return added.length;
      },
    }),
    {
      name: 'jarvis-tools',
      storage: createJSONStorage(() => safeLocalStorage),
      // Persist only the tools array; everything else is derived state.
      partialize: (s) => ({ tools: s.tools }),
      version: 1,
    },
  ),
);
