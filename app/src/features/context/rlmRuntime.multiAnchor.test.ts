// @vitest-environment node
// Actual runtime/repository/query service; only owned disk/index/child IO is synthetic.
import { describe, expect, it, vi } from "vitest";
import { createContextMapRlmRepository } from "./contextRlmProduction";
import { createContextQueryService } from "./contextQueryService";
import {
  createRlmRuntime,
  type RlmBudget,
  type RlmChildRequest,
} from "./rlmRuntime";

const scope = { accountId: "anchor-account", projectId: "anchor-project" };
const identity = {
  transportConnectionId: "fixture",
  transportAdapterId: "fixture",
  upstreamProviderId: "fixture",
  upstreamModelId: "fixture",
  providerQualifiedModelId: "fixture/fixture",
  authBillingRoute: "fixture",
  effort: "low",
  fastVariant: "standard",
  catalogRevision: "fixture",
};
const budget: RlmBudget = {
  maxDepth: 1,
  maxSubcalls: 4,
  maxConcurrentSubcalls: 2,
  maxWallTimeMs: 5000,
  maxToolCalls: 12,
  maxOpenBytes: 64 * 1024,
};

async function fixture(
  indexed: boolean,
  separator = "-",
  duplicateFirst = false,
) {
  const anchors = [
    "ORBIT-INTAKE-71-P",
    "ORBIT-RELEASE-Q",
    "ORBIT-LABEL-R",
    "ORBIT-ROUTE-S",
    "ORBIT-PLATFORM-T",
  ].map((anchor) => anchor.replaceAll("-", separator));
  const bodies = anchors.map(
    (anchor, i) =>
      `Ledger anchor ${anchor}. Distinct recorded value ${i + 17}.`,
  );
  if (duplicateFirst) bodies.push(bodies[0]!);
  if (indexed)
    bodies.push(
      ...Array.from({ length: 124 }, (_, i) => `Unrelated filler ${i}.`),
    );
  const contents = new Map(
    bodies.map((body, i) => [`C:/anchor-fixture/source-${i}.txt`, body]),
  );
  const hashes = new Map(
    await Promise.all(
      [...contents].map(
        async ([path, content]) =>
          [
            path,
            `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))), (b) => b.toString(16).padStart(2, "0")).join("")}`,
          ] as const,
      ),
    ),
  );
  const nodes = [...contents].map(([path], i) => ({
    id: `source-${i}`,
    title: `source-${i}.txt`,
    path,
    kind: "file" as const,
    summary: "",
    modifiedAt: 1,
  }));
  // Match native full-text AND semantics: a combined list does not match five separate files.
  const lexicalSearch = vi.fn(
    async ({ query, limit }: { query: string; limit: number }) =>
      nodes
        .filter((node) =>
          query
            .toLowerCase()
            .replaceAll('"', "")
            .split(/\s+/u)
            .filter(Boolean)
            .every((term) =>
              contents.get(node.path)!.toLowerCase().includes(term),
            ),
        )
        .slice(0, limit)
        .map((node) => ({ documentId: node.id, score: 1, excerpt: "" })),
  );
  const repository = createContextMapRlmRepository({
    loadMaps: async () => [
      {
        id: "anchor-map",
        projectId: scope.projectId,
        rootDir: "C:/anchor-fixture",
        status: "active",
        sourceType: "local_folder",
        updatedAt: 1,
        tree: { nodes },
      },
    ],
    stat: async (path) => ({
      ok: true,
      path,
      kind: "file",
      size: new TextEncoder().encode(contents.get(path)!).length,
      createdMs: 1,
      modifiedMs: 1,
      sha256: hashes.get(path)!,
    }),
    read: async (path) => ({ ok: true, path, content: contents.get(path)! }),
    lexicalSearch,
    indexStatus: async () => ({
      documentCount: nodes.length,
      needsRebuild: false,
    }),
  });
  const query = createContextQueryService({ repository });
  const search = vi.fn(query.search);
  const child = vi.fn(async (request: RlmChildRequest) => ({
    answer: request.evidence.map((item) => item.text).join("\n"),
    citations: request.sourcePointers,
  }));
  const runtime = createRlmRuntime({
    contextTools: { ...query, search },
    childRunner: child,
    synthesize: async (request) => ({
      answer: request.evidence.map((item) => item.text).join("\n"),
      citations: request.evidence.map((item) => item.pointer),
    }),
  });
  const question = `Retrieve evidence for all distinct anchors: ${anchors.join(", ")}. Report each distinct recorded value only from mapped files.`;
  return {
    runtime,
    question,
    anchors,
    lexicalSearch,
    search,
    child,
    query,
    contents,
    hashes,
  };
}

describe("bounded multi-anchor source coverage", () => {
  it.each([false, true])(
    "retrieves five distinct generic anchors with indexed=%s",
    async (indexed) => {
      const f = await fixture(indexed);
      const result = await f.runtime.investigate({
        question: f.question,
        scope,
        executionIdentity: identity,
        budget,
      });
      console.info(
        "multi-anchor boundary",
        JSON.stringify({
          indexed,
          searches: f.search.mock.calls.map(([input]) => ({
            query: input.query,
            limit: input.limit,
          })),
          citations: result.citations.length,
          usage: result.trace.usage,
          budgetExhausted: result.trace.budgetExhausted,
        }),
      );
      expect(result.citations).toHaveLength(5);
      for (const anchor of f.anchors) expect(result.answer).toContain(anchor);
      expect(result.trace.usage.toolCalls).toBeLessThanOrEqual(
        budget.maxToolCalls,
      );
      expect(result.trace.usage.openBytes).toBeLessThanOrEqual(
        budget.maxOpenBytes,
      );
      expect(result.trace.usage.subcalls).toBeLessThanOrEqual(
        budget.maxSubcalls,
      );
    },
  );
});

it("uses separate literal probes for underscore anchors as well as hyphenated anchors", async () => {
  const f = await fixture(true, "_");
  const result = await f.runtime.investigate({
    question: f.question,
    scope,
    executionIdentity: identity,
    budget,
  });
  expect(result.citations).toHaveLength(5);
  expect(f.search.mock.calls.map(([input]) => input.query)).toEqual(f.anchors);
  expect(result.trace.retrievalCoverage).toMatchObject({
    requestedQueries: 5,
    executedQueries: 5,
    matchedQueries: 5,
    omittedQueries: 0,
    openedSources: 5,
  });
});

it("deduplicates repeated anchors before spending tool calls", async () => {
  const f = await fixture(false);
  const result = await f.runtime.investigate({
    question: f.question + ` Recheck ${f.anchors[0]} and ${f.anchors[1]}.`,
    scope,
    executionIdentity: identity,
    budget,
  });
  expect(f.search).toHaveBeenCalledTimes(5);
  expect(result.citations).toHaveLength(5);
  expect(result.trace.usage.toolCalls).toBe(10);
});

it.each([8, 12])(
  "bounds extra anchors and reports omitted queries with %s tool calls",
  async (maxToolCalls) => {
    const f = await fixture(true);
    const result = await f.runtime.investigate({
      question:
        f.question + " Also inspect ORBIT-MISSING-U and ORBIT-MISSING-V.",
      scope,
      executionIdentity: identity,
      budget: { ...budget, maxToolCalls },
    });
    const expectedQueries = Math.min(6, Math.floor(maxToolCalls / 2));
    expect(f.search).toHaveBeenCalledTimes(expectedQueries);
    expect(result.trace.usage.toolCalls).toBeLessThanOrEqual(maxToolCalls);
    expect(result.trace.retrievalCoverage).toMatchObject({
      requestedQueries: 7,
      executedQueries: expectedQueries,
      omittedQueries: 7 - expectedQueries,
      matchedQueries: Math.min(expectedQueries, 5),
    });
    expect(result.trace.budgetExhausted).toBe(true);
    expect(result.answer).not.toContain("ORBIT-MISSING");
  },
);

it("reports a truncated matching-source page separately from query and source counts", async () => {
  const f = await fixture(false, "-", true);
  const result = await f.runtime.investigate({
    question: f.question,
    scope,
    executionIdentity: identity,
    budget,
  });
  expect(result.citations).toHaveLength(5);
  expect(result.trace.retrievalCoverage).toMatchObject({
    requestedQueries: 5,
    executedQueries: 5,
    matchedQueries: 5,
    omittedQueries: 0,
    searchTruncated: true,
    openedSources: 5,
  });
  expect(result.trace.budgetExhausted).toBe(true);
  expect(
    result.trace.events
      .filter((event) => event.type === "search_completed")
      .some((event) => event.detail?.includes("truncated=true")),
  ).toBe(true);
});

it("preserves byte and child-call budgets while exposing partial opened-source coverage", async () => {
  const f = await fixture(false);
  const result = await f.runtime.investigate({
    question: f.question,
    scope,
    executionIdentity: identity,
    budget: { ...budget, maxOpenBytes: 80, maxSubcalls: 1 },
  });
  expect(result.trace.usage.openBytes).toBeLessThanOrEqual(80);
  expect(result.trace.usage.subcalls).toBeLessThanOrEqual(1);
  expect(result.trace.retrievalCoverage?.openedSources).toBeLessThan(5);
  expect(result.trace.budgetExhausted).toBe(true);
});

it("stops later probes and child dispatch after cancellation during a search", async () => {
  const f = await fixture(true);
  const controller = new AbortController();
  let calls = 0;
  f.search.mockImplementation(async (input) => {
    if (++calls === 2) controller.abort();
    return f.query.search(input);
  });
  await expect(
    f.runtime.investigate({
      question: f.question,
      scope,
      executionIdentity: identity,
      budget,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(f.search).toHaveBeenCalledTimes(2);
  expect(f.child).not.toHaveBeenCalled();
});

it("rejects stale issued evidence when a source changes between probing and opening", async () => {
  const f = await fixture(true);
  let calls = 0;
  f.search.mockImplementation(async (input) => {
    const result = await f.query.search(input);
    if (++calls === 5)
      f.hashes.set(
        "C:/anchor-fixture/source-0.txt",
        `sha256:${"f".repeat(64)}`,
      );
    return result;
  });
  await expect(
    f.runtime.investigate({
      question: f.question,
      scope,
      executionIdentity: identity,
      budget,
    }),
  ).rejects.toThrow();
  expect(f.child).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains an explicitly named source alongside multiple anchors, indexed=%s",
  async (indexed) => {
    const f = await fixture(indexed);
    const question = `Compare ${f.anchors[0]} and ${f.anchors[1]}. Use source file anchor-fixture/source-4.txt as the source of record.`;
    const result = await f.runtime.investigate({
      question,
      scope,
      executionIdentity: identity,
      budget,
    });
    expect(result.answer).toContain("recorded value 21");
    expect(
      f.search.mock.calls.some(([input]) =>
        input.query.includes("anchor-fixture/source-4.txt"),
      ),
    ).toBe(true);
    expect(result.trace.usage.toolCalls).toBeLessThanOrEqual(
      budget.maxToolCalls,
    );
  },
);

it.each([false, true])(
  "retains a precise backticked symbol before broad anchors, indexed=%s",
  async (indexed) => {
    const f = await fixture(indexed);
    const path = "C:/anchor-fixture/source-4.txt";
    const body = `${f.contents.get(path)!} Function resolve_route_hint owns this reference.`;
    f.contents.set(path, body);
    f.hashes.set(
      path,
      `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
    const question = `Explain \`resolve_route_hint\` in relation to ${f.anchors[0]} and ${f.anchors[1]}.`;
    const result = await f.runtime.investigate({
      question,
      scope,
      executionIdentity: identity,
      budget,
    });
    expect(result.answer).toContain("recorded value 21");
    expect(f.search.mock.calls[0]?.[0].query).toBe("resolve_route_hint");
    expect(result.trace.usage.toolCalls).toBeLessThanOrEqual(
      budget.maxToolCalls,
    );
  },
);

it.each([false, true])(
  "retains a bracketed literal before broad anchors, indexed=%s",
  async (indexed) => {
    const f = await fixture(indexed);
    const path = "C:/anchor-fixture/source-4.txt";
    const body = `${f.contents.get(path)!} The manual approval stanza owns this reference.`;
    f.contents.set(path, body);
    f.hashes.set(
      path,
      `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
    const question = `Explain [manual approval stanza] in relation to ${f.anchors[0]} and ${f.anchors[1]}.`;
    const result = await f.runtime.investigate({
      question,
      scope,
      executionIdentity: identity,
      budget,
    });
    expect(result.answer).toContain("recorded value 21");
    expect(f.search.mock.calls[0]?.[0].query).toBe('"manual approval stanza"');
    expect(result.trace.usage.toolCalls).toBeLessThanOrEqual(
      budget.maxToolCalls,
    );
  },
);
