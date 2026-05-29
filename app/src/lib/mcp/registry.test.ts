/**
 * @file Unit tests for the MCP-lite registry.
 *
 * Vitest is not yet wired into the app. Until it is, this file serves as
 * executable documentation: it imports cleanly under `tsc --noEmit`, and
 * the assertions express the intended contract. When Vitest lands, swap
 * the ambient declarations below for `import { describe, it, expect,
 * beforeEach } from 'vitest'`.
 *
 * The tests deliberately import only from `./registry` so the built-ins
 * registered by `./builtins` don't leak into the test fixtures.
 */

import { toolRegistry, type ToolDef } from './registry';

/* -------------------------------------------------------------------------- */
/*  Vitest globals (ambient)                                                  */
/* -------------------------------------------------------------------------- */

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toContain(needle: unknown): void;
  toMatch(re: RegExp | string): void;
  toThrow(msg?: string | RegExp): void;
  rejects: { toThrow(msg?: string | RegExp): Promise<void> };
}
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: <T>(actual: T) => Matchers;
declare const beforeEach: (fn: () => void) => void;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function makeTool<I, O>(
  name: string,
  result: O,
  overrides: Partial<ToolDef<I, O>> = {},
): ToolDef<I, O> {
  return {
    name,
    description: 'fixture',
    invoke: async () => result,
    ...overrides,
  };
}

let warnings: unknown[][] = [];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
});

function restoreWarn(): void {
  console.warn = originalWarn;
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('toolRegistry.register / get / list', () => {
  it('stores a tool by name and returns an unregister function', () => {
    const tool = makeTool('test.basic', 42);
    const unregister = toolRegistry.register(tool);

    expect(toolRegistry.get('test.basic')).toBe(tool);
    expect(toolRegistry.list().some((t) => t.name === 'test.basic')).toBe(true);

    unregister();
    expect(toolRegistry.get('test.basic')).toBeUndefined();
    expect(toolRegistry.list().some((t) => t.name === 'test.basic')).toBe(false);
    restoreWarn();
  });

  it('warns once when re-registering the same name', () => {
    const a = makeTool('test.replace', 'A');
    const b = makeTool('test.replace', 'B');

    const u1 = toolRegistry.register(a);
    expect(warnings.length).toBe(0);

    const u2 = toolRegistry.register(b);
    expect(warnings.length).toBe(1);

    expect(toolRegistry.get('test.replace')).toBe(b);

    // u1 must not delete the live entry it no longer owns.
    u1();
    expect(toolRegistry.get('test.replace')).toBe(b);

    u2();
    expect(toolRegistry.get('test.replace')).toBeUndefined();
    restoreWarn();
  });

  it('filters by scope and tag', () => {
    const u1 = toolRegistry.register(
      makeTool('test.scoped', 1, { scope: 'project', tags: ['alpha'] }),
    );
    const u2 = toolRegistry.register(
      makeTool('test.unscoped', 2, { tags: ['beta'] }),
    );

    expect(toolRegistry.list({ scope: 'project' }).map((t) => t.name)).toEqual([
      'test.scoped',
    ]);
    expect(toolRegistry.list({ tag: 'beta' }).map((t) => t.name)).toEqual([
      'test.unscoped',
    ]);

    u1();
    u2();
    restoreWarn();
  });
});

describe('toolRegistry.invoke', () => {
  it('resolves with the tool result on success', async () => {
    const u = toolRegistry.register(makeTool<{ n: number }, number>('test.add1', 0, {
      invoke: async ({ n }) => n + 1,
    }));

    const out = await toolRegistry.invoke<{ n: number }, number>('test.add1', { n: 41 });
    expect(out).toBe(42);

    u();
    restoreWarn();
  });

  it('rejects with a tool-name-tagged error for unknown tools', async () => {
    let caught: Error | null = null;
    try {
      await toolRegistry.invoke('test.does.not.exist', {});
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('test.does.not.exist');
    restoreWarn();
  });

  it('wraps inner errors with the tool name', async () => {
    const u = toolRegistry.register(
      makeTool('test.boom', null, {
        invoke: async () => {
          throw new Error('inner kaboom');
        },
      }),
    );

    let caught: Error | null = null;
    try {
      await toolRegistry.invoke('test.boom', {});
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('test.boom');
    expect((caught as Error).message).toContain('inner kaboom');

    u();
    restoreWarn();
  });
});

describe('toolRegistry.subscribe', () => {
  it('fires once per register and once per unregister', () => {
    const calls: ToolDef[][] = [];
    const unsub = toolRegistry.subscribe((tools) => calls.push(tools));

    const u1 = toolRegistry.register(makeTool('test.sub1', 0));
    expect(calls.length).toBe(1);

    const u2 = toolRegistry.register(makeTool('test.sub2', 0));
    expect(calls.length).toBe(2);

    u1();
    expect(calls.length).toBe(3);

    u2();
    expect(calls.length).toBe(4);

    unsub();
    toolRegistry.register(makeTool('test.sub3', 0));
    expect(calls.length).toBe(4); // no longer subscribed

    // cleanup
    const stale = toolRegistry.get('test.sub3');
    if (stale) toolRegistry.list(); // touch list for type smoke
    restoreWarn();
  });
});
