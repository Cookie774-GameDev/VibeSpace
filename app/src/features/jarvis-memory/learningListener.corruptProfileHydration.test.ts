import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLearningFile,
  saveLearningFile,
  type LearningFileIo,
} from "./learningFile";
import { startJarvisLearningListener } from "./learningListener";
import {
  parseJarvisLearningMarkdown,
  renderMarkdown,
  useJarvisLearningStore,
} from "./learningStore";

const account = "m03-owned-account";
const memory = "Keep the last-good owned memory";
let stop: (() => Promise<void>) | undefined;
beforeEach(() => useJarvisLearningStore.getState().clearForTests());
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

it.each(["remember", "enable"] as const)(
  "captures a first newer %s intent during held retry hydration",
  async (action) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await ownedHarness("malformed", undefined, hold);
    try {
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
      h.files.set(h.target.path, h.original);
      sendMessage();
      await vi.waitFor(() => expect(h.retryReadDone()).toBe(true));
      if (action === "remember")
        useJarvisLearningStore
          .getState()
          .remember({
            value: "First intent during retry",
            category: "workflow",
            source: { kind: "explicit" },
          });
      else useJarvisLearningStore.getState().setEnabled(true);
      expect(h.save).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
      await stop?.();
      stop = undefined;
      const saved = parseJarvisLearningMarkdown(
        (await loadLearningFile(account, h.io)).markdown,
        account,
      )!;
      expect(saved.enabled).toBe(action === "enable");
      expect(saved.items.map((item) => item.value)).toContain(memory);
      if (action === "remember")
        expect(saved.items.map((item) => item.value)).toContain(
          "First intent during retry",
        );
    } finally {
      release();
    }
  },
);

it("retains Clear through another rejected retry without using that intent as write authority", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await ownedHarness("foreign", undefined, hold);
  try {
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    sendMessage();
    await vi.waitFor(() => expect(h.retryReadDone()).toBe(true));
    useJarvisLearningStore.getState().clear();
    release();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.save).not.toHaveBeenCalled();
    expect(h.files).toEqual(h.originalFiles);
    h.files.set(h.target.path, h.original);
    sendMessage();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
    await stop?.();
    stop = undefined;
    expect(
      parseJarvisLearningMarkdown(
        (await loadLearningFile(account, h.io)).markdown,
        account,
      ),
    ).toMatchObject({ enabled: false, items: [] });
  } finally {
    release();
  }
});

it("keeps held retry intent scoped to A while B hydrates and persists independently", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await ownedHarness("malformed", undefined, hold);
  try {
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    h.files.set(h.target.path, h.original);
    sendMessage();
    await vi.waitFor(() => expect(h.retryReadDone()).toBe(true));
    useJarvisLearningStore
      .getState()
      .remember({
        value: "Only account A retry intent",
        category: "workflow",
        source: { kind: "explicit" },
      });
    h.switchAccount("m03-other-account");
    sendMessage();
    release();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.save.mock.calls[0]?.[0]).toBe("m03-other-account");
    expect(h.files.get(h.target.path)).toBe(h.original);
    expect(useJarvisLearningStore.getState().currentProfile().items).toEqual(
      [],
    );
    h.switchAccount(account);
    sendMessage();
    await vi.waitFor(() =>
      expect(h.save.mock.calls.some(([owner]) => owner === account)).toBe(true),
    );
    await stop?.();
    stop = undefined;
    expect(
      parseJarvisLearningMarkdown(
        (await loadLearningFile(account, h.io)).markdown,
        account,
      )!.items.map((item) => item.value),
    ).toEqual(expect.arrayContaining([memory, "Only account A retry intent"]));
  } finally {
    release();
  }
});

async function run(primaryKind: "valid" | "malformed" | "foreign") {
  const files = new Map<string, string>();
  const io: LearningFileIo = {
    resolveRoot: async () => "C:\\synthetic-m03",
    createDirectory: async () => undefined,
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, value) => {
      files.set(path, value);
    },
  };
  const store = useJarvisLearningStore.getState();
  store.setAccount(account);
  store.setEnabled(false);
  store.remember({
    value: memory,
    category: "workflow",
    source: { kind: "explicit" },
  });
  const original = store.exportMarkdown();
  const saved = await saveLearningFile(account, original, io);
  await saveLearningFile(account, original, io);
  if (primaryKind === "malformed")
    files.set(
      saved.path,
      "# Jarvis Learning\n\nEnabled: no\n<!-- jarvis-learning-v1:%7Bbroken -->\n",
    );
  if (primaryKind === "foreign")
    files.set(
      saved.path,
      renderMarkdown({
        ...store.currentProfile(),
        accountId: "m03-foreign-account",
      }),
    );
  const beforePrimary = files.get(saved.path)!;
  store.clearForTests();
  const onError = vi.fn();
  const save = vi.fn((owner: string, markdown: string) =>
    saveLearningFile(owner, markdown, io),
  );
  let loaded = false;
  stop = startJarvisLearningListener({
    getAccountId: () => account,
    debounceMs: 0,
    onError,
    save,
    load: async (owner) => {
      const result = await loadLearningFile(owner, io);
      loaded = true;
      return result;
    },
  });
  await vi.waitFor(() => expect(loaded).toBe(true));
  window.dispatchEvent(
    new CustomEvent("jarvis:send", {
      detail: {
        chatId: "m03-owned-chat",
        text: "An ordinary meaningful message with no new memory instruction.",
      },
    }),
  );
  await vi.waitFor(() =>
    expect(onError.mock.calls.length + save.mock.calls.length).toBeGreaterThan(
      0,
    ),
  );
  await stop();
  stop = undefined;
  return { files, saved, original, beforePrimary, save, onError };
}

describe("structured learning-profile admission before automatic persistence", () => {
  it("keeps a valid disabled profile and its memory during ordinary progress persistence", async () => {
    const h = await run("valid");
    expect(h.onError).not.toHaveBeenCalled();
    expect(
      parseJarvisLearningMarkdown(h.files.get(h.saved.path)!, account),
    ).toMatchObject({
      enabled: false,
      items: [expect.objectContaining({ value: memory })],
    });
  });

  it.each(["malformed", "foreign"] as const)(
    "does not silently replace a %s embedded profile with a fresh enabled profile",
    async (kind) => {
      const h = await run(kind);
      if (h.onError.mock.calls.length) {
        expect(h.save).not.toHaveBeenCalled();
        expect(h.files.get(h.saved.path)).toBe(h.beforePrimary);
      } else {
        // Recovering the valid owner-scoped backup is also an acceptable admission outcome.
        expect(
          parseJarvisLearningMarkdown(h.files.get(h.saved.path)!, account),
        ).toMatchObject({
          enabled: false,
          items: [expect.objectContaining({ value: memory })],
        });
      }
      expect(h.files.get(`${h.saved.path}.bak`)).toBe(h.original);
    },
  );
});

function sendMessage() {
  window.dispatchEvent(
    new CustomEvent("jarvis:send", {
      detail: {
        chatId: "m03-owned-chat",
        text: "An ordinary meaningful message without a memory instruction.",
      },
    }),
  );
}

async function ownedHarness(
  kind: "malformed" | "foreign" | "placeholder" | "missing",
  holdFirstLoad?: Promise<void>,
  holdRetry?: Promise<void>,
) {
  const files = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const io: LearningFileIo = {
    resolveRoot: async () => "C:\\synthetic-m03",
    createDirectory: async () => undefined,
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, value) => {
      writes.push([path, value]);
      files.set(path, value);
    },
  };
  const store = useJarvisLearningStore.getState();
  store.setAccount(account);
  store.setEnabled(false);
  store.remember({
    value: memory,
    category: "workflow",
    source: { kind: "explicit" },
  });
  const original = store.exportMarkdown();
  const target = await saveLearningFile(account, original, io);
  await saveLearningFile(account, original, io);
  if (kind === "malformed")
    files.set(
      target.path,
      "# Jarvis Learning\n\n<!-- jarvis-learning-v1:%7Bbroken -->\n",
    );
  if (kind === "foreign")
    files.set(
      target.path,
      renderMarkdown({ ...store.currentProfile(), accountId: "foreign-m03" }),
    );
  if (kind === "placeholder")
    files.set(target.path, "# Jarvis Learning\n\nNo saved learning yet.\n");
  if (kind === "missing") files.clear();
  const originalFiles = new Map(files);
  store.clearForTests();
  writes.length = 0;
  let active = account;
  let accountChanged = () => {};
  const onError = vi.fn();
  const save = vi.fn((owner: string, markdown: string) =>
    saveLearningFile(owner, markdown, io),
  );
  let loads = 0;
  let firstReadDone = false;
  let retryReadDone = false;
  const load = vi.fn(async (owner: string) => {
    const first = loads++ === 0;
    const result = await loadLearningFile(owner, io);
    if (first) {
      firstReadDone = true;
      await holdFirstLoad;
    } else {
      retryReadDone = true;
      await holdRetry;
    }
    return result;
  });
  const statuses: string[] = [];
  const onStatus = (event: Event) =>
    statuses.push((event as CustomEvent<{ state: string }>).detail.state);
  window.addEventListener("jarvis:memory-status", onStatus);
  const dispose = startJarvisLearningListener({
    getAccountId: () => active,
    subscribeAccount: (listener) => {
      accountChanged = listener;
      return () => {
        accountChanged = () => {};
      };
    },
    load,
    save,
    onError,
    debounceMs: 0,
  });
  stop = async () => {
    await dispose();
    window.removeEventListener("jarvis:memory-status", onStatus);
  };
  return {
    files,
    originalFiles,
    writes,
    target,
    original,
    io,
    save,
    load,
    onError,
    statuses,
    firstReadDone: () => firstReadDone,
    retryReadDone: () => retryReadDone,
    switchAccount(next: string) {
      active = next;
      accountChanged();
    },
  };
}

describe("unavailable profile hydration with actual file serialization", () => {
  it.each(["malformed", "foreign", "placeholder"] as const)(
    "preserves all %s stored candidates and disables unverified live learning",
    async (kind) => {
      const h = await ownedHarness(kind);
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());
      expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(
        false,
      );
      expect(h.statuses).toContain("error");
      expect(h.statuses).not.toContain("recovered");
      useJarvisLearningStore.getState().remember({
        value: "A manual edit while unavailable",
        category: "workflow",
        source: { kind: "explicit" },
      });
      await stop?.();
      stop = undefined;
      expect(h.save).not.toHaveBeenCalled();
      expect(h.writes).toEqual([]);
      expect(h.files).toEqual(h.originalFiles);
    },
  );

  it("distinguishes actual absence from an existing placeholder and allows first persistence", async () => {
    const h = await ownedHarness("missing");
    sendMessage();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
    await stop?.();
    stop = undefined;
    expect(h.onError).not.toHaveBeenCalled();
    expect(
      parseJarvisLearningMarkdown(h.files.get(h.target.path)!, account),
    ).toMatchObject({
      accountId: account,
      meaningfulMessageCount: 1,
    });
  });

  it("retries on a later event after explicit valid restoration and keeps saved consent and items", async () => {
    const h = await ownedHarness("malformed");
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    h.files.set(h.target.path, h.original);
    sendMessage();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    await stop?.();
    stop = undefined;
    expect(h.onError).toHaveBeenCalledOnce();
    expect(
      parseJarvisLearningMarkdown(
        (await loadLearningFile(account, h.io)).markdown,
        account,
      ),
    ).toMatchObject({
      enabled: false,
      items: [expect.objectContaining({ value: memory })],
    });
    expect(h.files.get(`${h.target.path}.bak`)).toBe(h.original);
  });

  it("retains a newer manual item while unavailable until valid storage can be admitted", async () => {
    const h = await ownedHarness("malformed");
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    useJarvisLearningStore.getState().remember({
      value: "Keep this newer manual intent",
      category: "workflow",
      source: { kind: "explicit" },
    });
    expect(h.save).not.toHaveBeenCalled();
    h.files.set(h.target.path, h.original);
    sendMessage();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
    await stop?.();
    stop = undefined;
    const saved = parseJarvisLearningMarkdown(
      (await loadLearningFile(account, h.io)).markdown,
      account,
    )!;
    expect(saved.enabled).toBe(false);
    expect(saved.items.map((item) => item.value)).toEqual(
      expect.arrayContaining([memory, "Keep this newer manual intent"]),
    );
  });

  it("bounds persistent corruption retries to explicit events without writing during disposal", async () => {
    const h = await ownedHarness("foreign");
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    for (let index = 0; index < 3; index++) {
      sendMessage();
      await vi.waitFor(() =>
        expect(h.onError).toHaveBeenCalledTimes(index + 2),
      );
    }
    await stop?.();
    stop = undefined;
    expect(h.load).toHaveBeenCalledTimes(4);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.files).toEqual(h.originalFiles);
  });

  it("keeps another account available and rechecks the corrupt account on reentry", async () => {
    const h = await ownedHarness("malformed");
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    h.switchAccount("m03-other-account");
    sendMessage();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.save.mock.calls[0]?.[0]).toBe("m03-other-account");
    expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(
      true,
    );
    expect(h.files.get(h.target.path)).toBe(h.originalFiles.get(h.target.path));
    expect(h.files.get(`${h.target.path}.bak`)).toBe(h.original);
    h.switchAccount(account);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(
      false,
    );
    await stop?.();
    stop = undefined;
    expect(h.save).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "ignores late corrupt hydration after an account transition (ABA=%s)",
    async (aba) => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await ownedHarness("malformed", hold);
      await vi.waitFor(() => expect(h.firstReadDone()).toBe(true));
      h.switchAccount("m03-other-account");
      sendMessage();
      await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
      if (aba) {
        h.files.set(h.target.path, h.original);
        h.switchAccount(account);
        await vi.waitFor(() =>
          expect(
            useJarvisLearningStore.getState().currentProfile().items,
          ).toHaveLength(1),
        );
      }
      const before = useJarvisLearningStore.getState().exportMarkdown();
      release();
      await h.load.mock.results[0]!.value;
      await Promise.resolve();
      await stop?.();
      stop = undefined;
      expect(h.onError).not.toHaveBeenCalled();
      expect(useJarvisLearningStore.getState().exportMarkdown()).toBe(before);
      expect(h.save).toHaveBeenCalledOnce();
    },
  );
});

it.each(["remember", "clear"] as const)(
  "independent: preserves newer %s intent while valid hydration retry is held",
  async (action) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await ownedHarness("malformed", undefined, hold);
    try {
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
      useJarvisLearningStore
        .getState()
        .remember({
          value: "Manual item before valid retry",
          category: "workflow",
          source: { kind: "explicit" },
        });
      expect(h.save).not.toHaveBeenCalled();
      h.files.set(h.target.path, h.original);
      sendMessage();
      await vi.waitFor(() => expect(h.retryReadDone()).toBe(true));
      if (action === "remember") {
        useJarvisLearningStore
          .getState()
          .remember({
            value: "Manual item during valid retry",
            category: "workflow",
            source: { kind: "explicit" },
          });
        expect(
          useJarvisLearningStore
            .getState()
            .currentProfile()
            .items.map((item) => item.value),
        ).toContain("Manual item during valid retry");
      } else {
        useJarvisLearningStore.getState().clear();
        expect(
          useJarvisLearningStore.getState().currentProfile().items,
        ).toEqual([]);
      }
      release();
      await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
      await stop?.();
      stop = undefined;
      const saved = parseJarvisLearningMarkdown(
        (await loadLearningFile(account, h.io)).markdown,
        account,
      )!;
      expect(saved.enabled).toBe(false);
      if (action === "remember")
        expect(saved.items.map((item) => item.value)).toEqual(
          expect.arrayContaining([
            memory,
            "Manual item before valid retry",
            "Manual item during valid retry",
          ]),
        );
      else expect(saved.items).toEqual([]);
    } finally {
      release();
    }
  },
);
