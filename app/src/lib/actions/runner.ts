/**
 * Action runner — central dispatch from id + params to a side effect.
 *
 * Two callers:
 *   - The chat message renderer when the user clicks Approve on an
 *     `action_proposal` part (`features/chat/ActionApprovalCard.tsx`).
 *   - The actions palette when the user picks an action directly
 *     (`features/actions/ActionPalette.tsx`).
 *
 * Lookup order: built-in registry (`registry.ts`) first, then custom
 * user-authored tools (`features/tools/toolStore.ts`). Built-ins win
 * on id collision so a custom tool can never hijack `nav.chat`,
 * `terminal.swarm`, etc.
 */

import { toast } from '@/components/ui/toast';
import { useToolStore } from '@/features/tools/toolStore';
import { devConsole } from '@/features/dev-console';
import { getBuiltinAction, getBuiltinActions } from './registry';
import type {
  ActionDef,
  ActionParam,
  ActionResult,
  ActionRunContext,
} from './types';

/**
 * Resolve an action id to its definition.
 *
 * Order:
 *   1. Built-in registry — protected names like `nav.*`, `terminal.*`.
 *   2. Custom user tools — registered at runtime, prefixed with
 *      `custom.` by the tool store so they never collide with built-ins
 *      even though we still check built-ins first.
 *
 * Returns `undefined` for unknown ids; callers surface a clear error.
 */
export function resolveAction(id: string): ActionDef | undefined {
  const builtin = getBuiltinAction(id);
  if (builtin) return builtin;
  // Late-binding the tool store keeps this module loadable even if
  // the tool feature was tree-shaken in some future build configuration.
  try {
    return useToolStore.getState().resolve(id);
  } catch {
    return undefined;
  }
}

/**
 * All currently-registered actions (built-in + custom). Used by the
 * actions palette to populate its list and by the prompt addendum to
 * advertise the catalogue to the AI.
 */
export function getAllActions(): ActionDef[] {
  const builtins = getBuiltinActions();
  let customs: ActionDef[] = [];
  try {
    customs = useToolStore.getState().toActionDefs();
  } catch {
    customs = [];
  }
  // Built-in ids take precedence — drop any custom that collides.
  const builtinIds = new Set(builtins.map((a) => a.id));
  return [...builtins, ...customs.filter((c) => !builtinIds.has(c.id))];
}

/**
 * Outcome of validating + coercing a single param value.
 *
 * - `ok: true`  → use `value`. May be a coerced version (e.g. the
 *   string "30" promoted to the number 30 for a `number` param).
 * - `ok: false` → surface `error` to the caller. The runner aggregates
 *   all errors before invoking the underlying runner so the user sees
 *   every problem at once instead of fixing them one whack-a-mole at a
 *   time.
 *
 * Coercion is deliberately narrow: we only convert between primitive
 * types when the source has an obvious mapping (numeric string ↔
 * number, "true"/"false" ↔ boolean). Anything more aggressive risks
 * masking real bugs in the AI's output.
 */
type ParamCheck =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function coerceAndValidate(p: ActionParam, raw: unknown): ParamCheck {
  // Empty values get the default (or fall through unchanged).
  const isEmpty = raw === undefined || raw === null || raw === '';
  if (isEmpty) {
    if (p.required) {
      return {
        ok: false,
        error: `Missing required parameter: ${p.label} (${p.key}).`,
      };
    }
    if (p.default !== undefined) return { ok: true, value: p.default };
    return { ok: true, value: undefined };
  }

  switch (p.type) {
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && raw.trim().length > 0) {
        const n = Number(raw);
        if (Number.isFinite(n)) return { ok: true, value: n };
      }
      return {
        ok: false,
        error: `Parameter "${p.key}" must be a number; got ${describe(raw)}.`,
      };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const lower = raw.trim().toLowerCase();
        if (lower === 'true' || lower === 'on' || lower === '1') {
          return { ok: true, value: true };
        }
        if (lower === 'false' || lower === 'off' || lower === '0') {
          return { ok: true, value: false };
        }
      }
      return {
        ok: false,
        error: `Parameter "${p.key}" must be true/false; got ${describe(raw)}.`,
      };
    }
    case 'select': {
      // Allowed values come from the spec. We accept the raw string
      // verbatim if it matches one of the options.
      if (typeof raw !== 'string') {
        return {
          ok: false,
          error: `Parameter "${p.key}" must be a string; got ${describe(raw)}.`,
        };
      }
      const allowed = (p.options ?? []).map((o) => o.value);
      if (allowed.length > 0 && !allowed.includes(raw)) {
        return {
          ok: false,
          error: `Parameter "${p.key}" must be one of: ${allowed.join(', ')}.`,
        };
      }
      return { ok: true, value: raw };
    }
    case 'route':
    case 'string':
    default: {
      if (typeof raw === 'string') return { ok: true, value: raw };
      // Numbers and booleans coerce cleanly to a string. Anything else
      // (object, array, null was already filtered) is suspicious enough
      // to flag rather than `String(...)`-coerce silently.
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { ok: true, value: String(raw) };
      }
      return {
        ok: false,
        error: `Parameter "${p.key}" must be a string; got ${describe(raw)}.`,
      };
    }
  }
}

/**
 * Pretty-print a value for an error message. Truncates so a 50KB blob
 * the AI hallucinated doesn't wreck the toast layout.
 */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  const s = String(v);
  return s.length > 40 ? `"${s.slice(0, 40)}…"` : `"${s}"`;
}

/**
 * Validate every declared param and return either a clean coerced
 * params object or a list of errors. Unknown keys (params the AI
 * supplied but the action didn't declare) pass through verbatim — the
 * runner can use them, an action that forgot to declare them won't.
 */
function validateAndCoerceParams(
  def: ActionDef,
  params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...params };
  for (const p of def.params) {
    const check = coerceAndValidate(p, params[p.key]);
    if (!check.ok) {
      errors.push(check.error);
      continue;
    }
    if (check.value === undefined) {
      delete out[p.key];
    } else {
      out[p.key] = check.value;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params: out };
}

/**
 * Public runner. Looks up the action, validates required params,
 * invokes the runner, and emits a single toast (`success` / `error`).
 *
 * The toast is on by default because every direct user invocation
 * benefits from confirmation, but the chat approval card disables it
 * (`emitToast: false`) so the proposal card itself owns the visible
 * status; we don't want a parallel toast competing for attention.
 */
export async function runAction(
  id: string,
  params: Record<string, unknown> = {},
  ctx: ActionRunContext,
  options: { emitToast?: boolean } = {},
): Promise<ActionResult> {
  const emitToast = options.emitToast ?? true;
  const startedAt = Date.now();
  // DevConsole breadcrumb — every action attempt shows up in the
  // `action` channel so the user (or an LLM debugging the runtime)
  // can see exactly what got tried, with what params, and what
  // happened. The action source (chat-approved vs palette) is
  // surfaced via `ctx.source` when callers set it; we pass it
  // through verbatim.
  devConsole.log({
    channel: 'action',
    level: 'info',
    message: `Action → ${id}`,
    detail: { id, params, source: ctx.source ?? 'unknown' },
  });

  const def = resolveAction(id);
  if (!def) {
    const error = `Unknown action: ${id}`;
    if (emitToast) toast.error('Action failed', error);
    devConsole.log({
      channel: 'action',
      level: 'error',
      message: `Action ✗ ${id} (unknown)`,
      durationMs: Date.now() - startedAt,
      detail: { id, error },
    });
    return { ok: false, error };
  }

  const validation = validateAndCoerceParams(def, params);
  if (!validation.ok) {
    const error = validation.errors.join(' ');
    if (emitToast) toast.error('Action invalid', error);
    devConsole.log({
      channel: 'action',
      level: 'warn',
      message: `Action ✗ ${id} (invalid params)`,
      durationMs: Date.now() - startedAt,
      detail: { id, errors: validation.errors, params },
    });
    return { ok: false, error };
  }

  try {
    const result = await def.run(validation.params, ctx);
    if (emitToast) {
      if (result.ok) {
        toast.success(def.label, result.summary ?? 'Done.');
      } else {
        toast.error(def.label, result.error);
      }
    }
    devConsole.log({
      channel: 'action',
      level: result.ok ? 'info' : 'error',
      message: result.ok
        ? `Action ✓ ${id}`
        : `Action ✗ ${id}: ${result.error}`,
      durationMs: Date.now() - startedAt,
      detail: { id, result },
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (emitToast) toast.error(def.label, error);
    devConsole.log({
      channel: 'action',
      level: 'error',
      message: `Action ✗ ${id}: ${error}`,
      durationMs: Date.now() - startedAt,
      detail: {
        id,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err),
      },
    });
    return { ok: false, error };
  }
}
