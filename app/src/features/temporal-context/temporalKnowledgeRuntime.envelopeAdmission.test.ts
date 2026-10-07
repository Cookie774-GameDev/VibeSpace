import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db, openDb } from "@/lib/db";
import type { RepositoryRetrievalResult } from "@/features/context/repositoryRetrieval";
import {
  loadRepositoryTemporalKnowledge,
  recordRepositoryTemporalKnowledge,
} from "./temporalKnowledgeRuntime";

const scope = { accountId: "t03-account-a", projectId: "t03-project-a" };
const key = "temporal-knowledge-v1:t03-account-a:t03-project-a";
const snapshot = { schemaVersion: 1, ...scope, revision: 0, facts: [] };
const validEnvelope = () => ({
  schemaVersion: 1,
  snapshot,
  idempotencyKeys: [],
});
function result(content = "a"): RepositoryRetrievalResult {
  return {
    mapId: "t03-map",
    repositoryRevision: `revision-${content}`,
    structuralRevision: 1,
    items: [
      {
        path: "owned.ts",
        language: "typescript",
        representation: "full",
        content,
        tokens: 1,
        whySelected: [],
        symbols: [],
        evidence: {
          mapId: "t03-map",
          entityId: "t03-entity",
          sourceId: "t03-source",
          provenanceId: `evidence-${content}`,
          sourceRevision: `source-${content}`,
          repositoryRevision: `revision-${content}`,
          contentHash: `sha256:${content.repeat(64)}`,
          astHash: `sha256:${content.repeat(64)}`,
          parserId: "synthetic",
          parserVersion: "1",
        },
      },
    ],
    relationships: [],
    exclusions: [],
    totalTokens: 1,
    remainingTokens: 99,
    parsedChangedPaths: ["owned.ts"],
  };
}
const record = (content = "a", target = scope) =>
  recordRepositoryTemporalKnowledge({
    ...target,
    result: result(content),
    observedAt: content === "a" ? 1 : 2,
  });
beforeEach(async () => {
  await openDb();
  await db.settings
    .where("key")
    .startsWith("temporal-knowledge-v1:t03-")
    .delete();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await openDb();
  await db.settings
    .where("key")
    .startsWith("temporal-knowledge-v1:t03-")
    .delete();
  await closeDb();
});

const corruptEnvelopes: Array<[string, unknown]> = [
  ["null value", null],
  ["unsupported version", { ...validEnvelope(), schemaVersion: 2 }],
  ["missing snapshot", { schemaVersion: 1, idempotencyKeys: [] }],
  ["null snapshot", { ...validEnvelope(), snapshot: null }],
  [
    "invalid snapshot shape",
    { ...validEnvelope(), snapshot: "saved contents" },
  ],
  ["missing retry ledger", { schemaVersion: 1, snapshot }],
  [
    "non-array retry ledger",
    { ...validEnvelope(), idempotencyKeys: "saved retry key" },
  ],
  [
    "invalid retry ledger item",
    { ...validEnvelope(), idempotencyKeys: [null] },
  ],
];

describe("actual temporal Dexie envelope admission", () => {
  it("treats only a genuinely missing row as new storage", async () => {
    expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(snapshot);
    expect((await record()).revision).toBe(1);
    await closeDb();
    expect((await loadRepositoryTemporalKnowledge(scope)).facts).toHaveLength(
      1,
    );
  });

  it.each(corruptEnvelopes)(
    "refuses %s on load and recording without replacing the saved row",
    async (_name, value) => {
      const before = { key, value, updated_at: 7 };
      await db.settings.put(before);
      await expect
        .soft(loadRepositoryTemporalKnowledge(scope))
        .rejects.toThrow();
      await expect.soft(record()).rejects.toThrow();
      expect(await db.settings.get(key)).toEqual(before);
    },
  );

  it("allows explicit valid restoration and leaves another account row untouched", async () => {
    const otherScope = { ...scope, accountId: "t03-account-b" };
    const other = await record("a", otherScope);
    await db.settings.put({ key, value: null, updated_at: 7 });
    await expect(record()).rejects.toThrow();
    await db.settings.put({ key, value: validEnvelope(), updated_at: 8 });
    const saved = await record();
    expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(saved);
    expect(await loadRepositoryTemporalKnowledge(otherScope)).toEqual(other);
  });

  it.each([false, true])(
    "revalidates corrupt storage arriving while an observation was pending (existing=%s)",
    async (existing) => {
      if (existing) await record();
      const before = await db.settings.get(key);
      const corrupted = {
        key,
        updated_at: 9,
        value: {
          ...((before?.value as object) ?? validEnvelope()),
          schemaVersion: 2,
        },
      };
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation(async (algorithm, data) => {
          await hold;
          return realDigest(algorithm, data);
        });
      const pending = record("b");
      const settled = pending.then(
        () => "stored" as const,
        () => "rejected" as const,
      );
      try {
        await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
        await db.settings.put(corrupted);
      } finally {
        release();
      }
      expect(await settled).toBe("rejected");
      expect(await db.settings.get(key)).toEqual(corrupted);
    },
  );

  it("refuses another owner substituted at the same storage revision before commit", async () => {
    await record();
    const before = await db.settings.get(key);
    const envelope = before!.value as ReturnType<typeof validEnvelope>;
    const corrupt = {
      ...before!,
      value: {
        ...envelope,
        snapshot: { ...envelope.snapshot, accountId: "t03-foreign" },
      },
    };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        await hold;
        return realDigest(algorithm, data);
      });
    const settled = record("b").then(
      () => "stored" as const,
      () => "rejected" as const,
    );
    try {
      await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
      await db.settings.put(corrupt);
    } finally {
      release();
    }
    expect(await settled).toBe("rejected");
    expect(await db.settings.get(key)).toEqual(corrupt);
  });
});
