/**
 * @file MCP-lite tool registry.
 *
 * In-process map of named tools that skills, agents, and the assistant can
 * register and invoke. No network, no JWT, no real Model Context Protocol —
 * just a typed pub/sub registry with a `Map<string, ToolDef>` underneath.
 *
 * Exclusive owner: Wave 4 / Slice 18.
 *
 * Behaviour contract:
 *  - Storage is a module-scoped `Map<string, ToolDef>`.
 *  - `register` / unregister are synchronous; `invoke` is asynchronous.
 *  - `subscribe` callbacks are notified on every register/unregister with a
 *    fresh snapshot of the registry contents.
 *  - Re-registering the same `name` replaces the previous entry and emits a
 *    single `console.warn` per replacement.
 *  - `invoke` rejects with an error whose message includes the tool name.
 */

export interface ToolDef<I = unknown, O = unknown> {
  /** Stable, dot-namespaced id (e.g. `'fs.read'`, `'voice.speak'`). */
  name: string;
  /** One-sentence description shown in skill/agent UI. */
  description: string;
  /** Async entry point the registry calls on `invoke`. */
  invoke: (input: I) => Promise<O>;
  /** Visibility/persistence scope hint. Defaults to undefined ("global"). */
  scope?: 'workspace' | 'project' | 'chat';
  /** Optional JSON-schema-ish input shape for UI surfacing. Loose on purpose. */
  inputSchema?: Record<string, unknown>;
  /** Tags surfaced by the skills/agent UI for filtering. */
  tags?: string[];
}

type Subscriber = (tools: ToolDef[]) => void;
// Internal storage uses bivariant generics so heterogeneous ToolDefs share a
// Map without per-entry casts. Public reads/writes keep their narrow types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = ToolDef<any, any>;

const tools = new Map<string, AnyTool>();
const subscribers = new Set<Subscriber>();

function snapshot(): ToolDef[] {
  return Array.from(tools.values());
}

function notify(): void {
  // Snapshot subscribers so callbacks may (un)subscribe during iteration.
  const list = snapshot();
  for (const fn of Array.from(subscribers)) {
    try {
      fn(list);
    } catch (err) {
      // A subscriber throwing must not abort the rest of the fan-out.
      console.error('[mcp] subscriber threw', err);
    }
  }
}

function register<I, O>(tool: ToolDef<I, O>): () => void {
  if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new Error('toolRegistry.register: tool.name is required');
  }
  if (typeof tool.invoke !== 'function') {
    throw new Error(`toolRegistry.register: ${tool.name}.invoke must be a function`);
  }
  if (tools.has(tool.name)) {
    console.warn(`[mcp] replacing existing tool: ${tool.name}`);
  }
  tools.set(tool.name, tool);
  notify();
  return () => {
    // Only unregister if our slot still holds the same tool instance — a
    // replacement may have moved someone else into our name in the meantime,
    // and stale unregister callbacks must not delete the live entry.
    if (tools.get(tool.name) === tool) {
      tools.delete(tool.name);
      notify();
    }
  };
}

function get<I, O>(name: string): ToolDef<I, O> | undefined {
  return tools.get(name) as ToolDef<I, O> | undefined;
}

function list(filter?: { scope?: ToolDef['scope']; tag?: string }): ToolDef[] {
  let out: ToolDef[] = snapshot();
  const scope = filter?.scope;
  const tag = filter?.tag;
  if (scope) out = out.filter((t) => t.scope === scope);
  if (tag) out = out.filter((t) => Array.isArray(t.tags) && t.tags.includes(tag));
  return out;
}

async function invoke<I, O>(name: string, input: I): Promise<O> {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool '${name}' is not registered`);
  }
  try {
    return (await tool.invoke(input)) as O;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Tool '${name}' failed: ${msg}`);
  }
}

function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * Singleton registry. Methods are bound functions; safe to destructure.
 */
export const toolRegistry: {
  register<I, O>(tool: ToolDef<I, O>): () => void;
  get<I, O>(name: string): ToolDef<I, O> | undefined;
  list(filter?: { scope?: ToolDef['scope']; tag?: string }): ToolDef[];
  invoke<I, O>(name: string, input: I): Promise<O>;
  subscribe(fn: (tools: ToolDef[]) => void): () => void;
} = {
  register,
  get,
  list,
  invoke,
  subscribe,
};
