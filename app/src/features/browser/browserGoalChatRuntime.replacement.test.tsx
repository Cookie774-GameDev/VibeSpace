import { describe, expect, it, vi } from "vitest";

import type { JarvisIssuedActionExecution } from "@/lib/jarvis/approvalEngine";
import type { JarvisRegisteredActionDefinition } from "@/lib/jarvis/actions/catalog";
import type { JarvisRun } from "@/lib/jarvis/contracts";
import {
  createGoalCheckpointRepository,
  type GoalCheckpointStoragePort,
  type GoalCheckpointStoredRecordV1,
} from "@/lib/jarvis/goalCheckpointRepository";
import {
  createBrowserGoalChatRuntime,
  type BrowserGoalChatBinding,
} from "./browserGoalChatRuntime";
import {
  createBrowserGoalLaunchRuntime,
  type CanonicalBrowserActionInput,
} from "./browserGoalLaunchRuntime";
import { createBrowserGoalStore } from "./browserGoalStore";
import {
  createBrowserNativeHandoffRuntime,
  type BrowserNativeHandoffRequest,
} from "./browserNativeHandoff";

type CancellationPort = JarvisIssuedActionExecution["requestCancellation"];
function completedCancellation(): Awaited<ReturnType<CancellationPort>> {
  // The synthetic canonical run below is explicitly already completed.
  return { kind: "already_terminal", terminalStatus: "completed" };
}

function repositoryHarness() {
  const records: GoalCheckpointStoredRecordV1[] = [];
  const storage: GoalCheckpointStoragePort = {
    loadScope: async (accountId, projectId) =>
      records.filter(
        (record) =>
          record.accountId === accountId && record.projectId === projectId,
      ),
    async appendExpected(input) {
      const duplicate = records.find(
        (record) =>
          record.manifestId === input.manifestId &&
          record.idempotencyKey === input.idempotencyKey,
      );
      if (duplicate) return { kind: "duplicate", record: duplicate };
      const revision = records
        .filter((record) => record.manifestId === input.manifestId)
        .reduce((highest, record) => Math.max(highest, record.revision), 0);
      if (revision !== input.expectedRevision) {
        return { kind: "conflict", currentRevision: revision };
      }
      records.push(input.record);
      return { kind: "appended", record: input.record };
    },
  };
  return { repository: createGoalCheckpointRepository(storage), records };
}

function fixture(
  options: {
    repository?: ReturnType<typeof repositoryHarness>["repository"];
    now?: () => number;
    modelId?: string;
    approvalId?: string;
  } = {},
) {
  const repository = options.repository ?? repositoryHarness().repository;
  const store = createBrowserGoalStore();
  const handoffValues = new Map<string, string>();
  const handoffRuntime = createBrowserNativeHandoffRuntime({
    storage: {
      getItem: (key) => handoffValues.get(key) ?? null,
      setItem: (key, value) => void handoffValues.set(key, value),
    },
    now: () => 1_100,
    hash: async (text) =>
      [...text]
        .reduce(
          (hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0,
          5381,
        )
        .toString(16)
        .padStart(64, "0"),
  });
  const chatRuntime = createBrowserGoalChatRuntime({
    store,
    handoffRuntime,
    readMode: () => ({ mode: "token-saver", effortOverride: null }),
  });
  const bindings: BrowserGoalChatBinding[] = [];
  const requestCancellation = vi.fn<CancellationPort>(async () => completedCancellation());
  const execution = {
    approval: {
      runId: "jrun_browser_1",
      requestId: "jreq_browser_1",
      attemptNumber: 1,
    },
    requestCancellation,
  } as unknown as JarvisIssuedActionExecution;
  const run = {
    id: "jrun_browser_1",
    accountId: "account-1",
    projectId: "project-1",
    chatId: "chat-1",
    source: "typed_chat",
    status: "completed",
    agentId: "agent-jarvis",
    identityVersion: 1,
    profileRevisionId: "profile-1",
    model: {
      providerId: "openai",
      modelId: options.modelId ?? "gpt-5",
      connectionId: "connection-1",
      connectionMode: "native-api",
      capabilities: {},
      capturedAt: 900,
    },
    createdAt: 900,
    updatedAt: 1_000,
  } satisfies JarvisRun;
  const registration = {
    id: "browser.click",
    version: 1,
    title: "Browser click",
    description: "Perform one reviewed click.",
    inputSchema: {},
    outputSchema: {},
    requiredCapabilities: ["browser.operator"],
    requiredEntitlements: [],
    risk: "external-side-effect",
    approval: "always",
    expectedEffect: "Click Continue.",
    exposeToAI: false,
    executor: { kind: "builtin", registryActionId: "browser.click" },
    credentialBindings: [],
    validateParameters: (value: unknown) => value as Record<string, unknown>,
    deriveTarget: () => ({
      kind: "external_resource",
      service: "browser",
      resourceId: "tab-1",
    }),
  } as unknown as JarvisRegisteredActionDefinition;
  const action: CanonicalBrowserActionInput = {
    registration,
    params: {
      origin: "https://example.test",
      tabId: "tab-1",
      reviewId: "review-1",
      expectedEffect: "Click the reviewed Continue button.",
    },
    context: {
      source: "ai",
      chatId: "chat-1",
      accountId: "account-1",
      runId: "jrun_browser_1",
      approvalId: options.approvalId ?? "approval-1",
      requestId: "jreq_browser_1",
      attemptNumber: 1,
    },
    execution,
    run,
  };
  const runtime = createBrowserGoalLaunchRuntime({
    repository,
    chatRuntime: {
      ...chatRuntime,
      activate(binding) {
        bindings.push(binding);
        return chatRuntime.activate(binding);
      },
    },
    store,
    now: options.now ?? (() => 1_000),
    hash: async (text) =>
      text.includes("other-model") ? "b".repeat(64) : "a".repeat(64),
    handoffRuntime,
  });
  return {
    runtime,
    chatRuntime,
    store,
    action,
    repository,
    requestCancellation,
    bindings,
  };
}

function successOutcome() {
  return {
    kind: "executor_returned" as const,
    result: {
      ok: true as const,
      summary: "Approved browser operation completed and was observed.",
      data: {
        outcome: {
          capabilityId: "browser.operator",
          capabilityVersion: 1,
          kind: "browser",
          operation: "browser.click",
          state: "completed",
          resultRef: "jresult_browser_1",
          evidenceRef: "jlive_browser_1",
        },
        observation: {
          url: "https://example.test/after",
          title: "After",
          text: "Done",
        },
        sessionId: "session-1",
        tabId: "tab-1",
      },
    },
  };
}

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BrowserGoalStatus } from "./BrowserGoalStatus";
import { useBrowserStore } from "./browserStore";

function heldVoid() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const failedOutcome = () => ({
  kind: "executor_returned" as const,
  result: { ok: false as const, error: "Synthetic reviewed action failed" },
});
function successorAction(
  action: CanonicalBrowserActionInput,
): CanonicalBrowserActionInput {
  if (!action.run) throw new Error("Synthetic run missing");
  const runId = "jrun_browser_2";
  const requestId = "jreq_browser_2";
  return {
    ...action,
    run: { ...action.run, id: runId },
    context: { ...action.context, runId, requestId, approvalId: "approval-2" },
    execution: {
      ...action.execution,
      approval: { ...action.execution.approval, runId, requestId },
      requestCancellation: vi.fn<CancellationPort>(async () => completedCancellation()),
    },
  };
}

describe("B01 actual launch/control replacement boundary", () => {
  it.each(["resolved", "rejected"] as const)(
    "settles an old %s cancel without rejecting or replacing the newer canonical goal",
    async (settlement) => {
      let clock = 1000;
      const h = fixture({ now: () => clock++ });
      const cancel = heldVoid();
      const oldDispatch = heldVoid();
      const newDispatch = heldVoid();
      h.requestCancellation.mockImplementation(async () => {
        await cancel.promise;
        if (settlement === "rejected")
          throw new Error("Synthetic old cancellation rejected");
        return completedCancellation();
      });
      const firstDispatch = vi.fn(async () => {
        await oldDispatch.promise;
        return failedOutcome();
      });
      const first = h.runtime.executeRegisteredAction(h.action, firstDispatch);
      await waitFor(() => expect(firstDispatch).toHaveBeenCalledOnce());
      const pending = h.chatRuntime.cancel("chat-1");
      void pending.catch(() => undefined);
      await waitFor(() => expect(h.requestCancellation).toHaveBeenCalledOnce());
      oldDispatch.release();
      await first;
      expect(h.store.getSnapshot("chat-1")).toMatchObject({
        state: "failed",
        runId: "jrun_browser_1",
      });
      const nextAction = successorAction(h.action);
      const secondDispatch = vi.fn(async () => {
        await newDispatch.promise;
        return failedOutcome();
      });
      const second = h.runtime.executeRegisteredAction(
        nextAction,
        secondDispatch,
      );
      try {
        await waitFor(() => expect(secondDispatch).toHaveBeenCalledOnce());
        const replacement = h.store.getSnapshot("chat-1");
        expect(replacement).toMatchObject({
          state: "active",
          runId: "jrun_browser_2",
        });
        cancel.release();
        await expect(pending).resolves.toBeDefined();
        expect(h.store.getSnapshot("chat-1")).toEqual(replacement);
        expect(nextAction.execution.requestCancellation).not.toHaveBeenCalled();
      } finally {
        cancel.release();
        newDispatch.release();
        await pending.catch(() => undefined);
        await second;
      }
    },
  );

  it("does not keep replacement goal controls locked by an old pending UI cancel", async () => {
    let clock = 1000;
    const h = fixture({ now: () => clock++ });
    const cancel = heldVoid();
    const oldDispatch = heldVoid();
    const newDispatch = heldVoid();
    h.requestCancellation.mockImplementation(async () => {
      await cancel.promise;
      return completedCancellation();
    });
    const firstDispatch = vi.fn(async () => {
      await oldDispatch.promise;
      return failedOutcome();
    });
    const first = h.runtime.executeRegisteredAction(h.action, firstDispatch);
    await waitFor(() => expect(firstDispatch).toHaveBeenCalledOnce());
    useBrowserStore.setState({ agentActions: [] });
    const view = render(
      <BrowserGoalStatus
        chatId="chat-1"
        store={h.store}
        runtime={h.chatRuntime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    );
    await waitFor(() => expect(h.requestCancellation).toHaveBeenCalledOnce());
    await act(async () => {
      oldDispatch.release();
      await first;
    });
    const nextAction = successorAction(h.action);
    const secondDispatch = vi.fn(async () => {
      await newDispatch.promise;
      return failedOutcome();
    });
    let second!: ReturnType<typeof h.runtime.executeRegisteredAction>;
    try {
      await act(async () => {
        second = h.runtime.executeRegisteredAction(nextAction, secondDispatch);
        await Promise.resolve();
      });
      await waitFor(() => expect(secondDispatch).toHaveBeenCalledOnce());
      expect(h.store.getSnapshot("chat-1")).toMatchObject({
        state: "active",
        runId: "jrun_browser_2",
      });
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
        "disabled",
        false,
      );
      expect(nextAction.execution.requestCancellation).not.toHaveBeenCalled();
    } finally {
      // Original caller uses a void async handler; a rejected stale settlement is
      // intentionally left observable by Vitest, not hidden by a fake caller.
      await act(async () => {
        cancel.release();
        newDispatch.release();
        if (second) await second;
        await Promise.resolve();
      });
      view.unmount();
    }
  });

  it("retains ordinary current-goal cancellation and never calls another run", async () => {
    let clock = 1000;
    const h = fixture({ now: () => clock++ });
    const dispatchHeld = heldVoid();
    const dispatch = vi.fn(async () => {
      await dispatchHeld.promise;
      return failedOutcome();
    });
    const launched = h.runtime.executeRegisteredAction(h.action, dispatch);
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    try {
      await expect(h.chatRuntime.cancel("chat-1")).resolves.toMatchObject({
        state: "cancelled",
        runId: "jrun_browser_1",
      });
      expect(h.requestCancellation).toHaveBeenCalledOnce();
      expect(h.store.getSnapshot("chat-1")).toMatchObject({
        state: "cancelled",
        runId: "jrun_browser_1",
      });
    } finally {
      dispatchHeld.release();
      await launched;
    }
  });

  it.each(["mounted", "remounted"] as const)(
    "does not let old finally release a newer pending cancel when %s",
    async (mountState) => {
      let clock = 1000;
      const repo = repositoryHarness();
      const h = fixture({ repository: repo.repository, now: () => clock++ });
      const oldCancel = heldVoid();
      const newCancel = heldVoid();
      const oldDispatch = heldVoid();
      const newDispatch = heldVoid();
      h.requestCancellation.mockImplementation(async () => {
        await oldCancel.promise;
        return completedCancellation();
      });
      const firstDispatch = vi.fn(async () => {
        await oldDispatch.promise;
        return failedOutcome();
      });
      const first = h.runtime.executeRegisteredAction(h.action, firstDispatch);
      await waitFor(() => expect(firstDispatch).toHaveBeenCalledOnce());
      useBrowserStore.setState({ agentActions: [] });
      let view = render(
        <BrowserGoalStatus
          chatId="chat-1"
          store={h.store}
          runtime={h.chatRuntime}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(h.requestCancellation).toHaveBeenCalledOnce());
      if (mountState === "remounted") view.unmount();
      await act(async () => {
        oldDispatch.release();
        await first;
      });
      const successor = successorAction(h.action);
      const currentCancel = vi.fn<CancellationPort>(async () => {
        await newCancel.promise;
        return completedCancellation();
      });
      const nextAction = {
        ...successor,
        execution: {
          ...successor.execution,
          requestCancellation: currentCancel,
        },
      };
      const secondDispatch = vi.fn(async () => {
        await newDispatch.promise;
        return failedOutcome();
      });
      let second!: ReturnType<typeof h.runtime.executeRegisteredAction>;
      try {
        await act(async () => {
          second = h.runtime.executeRegisteredAction(
            nextAction,
            secondDispatch,
          );
          await Promise.resolve();
        });
        await waitFor(() => expect(secondDispatch).toHaveBeenCalledOnce());
        if (mountState === "remounted") {
          view = render(
            <BrowserGoalStatus
              chatId="chat-1"
              store={h.store}
              runtime={h.chatRuntime}
            />,
          );
          fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
        }
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
          "disabled",
          false,
        );
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(currentCancel).toHaveBeenCalledOnce());
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
          "disabled",
          true,
        );
        await act(async () => {
          oldCancel.release();
          await waitFor(() =>
            expect(
              repo.records.some(
                (record) =>
                  record.manifest.runId === "jrun_browser_1" &&
                  record.idempotencyKey.includes(":cancel:"),
              ),
            ).toBe(true),
          );
        });
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
          "disabled",
          true,
        );
        expect(h.store.getSnapshot("chat-1")).toMatchObject({
          state: "active",
          runId: "jrun_browser_2",
        });
        await act(async () => {
          newCancel.release();
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(h.store.getSnapshot("chat-1")).toMatchObject({
            state: "cancelled",
            runId: "jrun_browser_2",
          }),
        );
        expect(h.requestCancellation).toHaveBeenCalledOnce();
        expect(currentCancel).toHaveBeenCalledOnce();
      } finally {
        oldCancel.release();
        newCancel.release();
        oldDispatch.release();
        newDispatch.release();
        await act(async () => {
          await first;
          if (second) await second;
          await Promise.resolve();
        });
        view.unmount();
      }
    },
  );

  it("treats remove and restore of the same goal after another run as new ownership", async () => {
    let clock = 1000;
    const repo = repositoryHarness();
    const h = fixture({ repository: repo.repository, now: () => clock++ });
    const cancel = heldVoid();
    const oldDispatch = heldVoid();
    h.requestCancellation.mockImplementation(async () => {
      await cancel.promise;
      return completedCancellation();
    });
    const dispatch = vi.fn(async () => {
      await oldDispatch.promise;
      return failedOutcome();
    });
    const first = h.runtime.executeRegisteredAction(h.action, dispatch);
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const firstBinding = h.bindings[0];
    if (!firstBinding) throw new Error("Real launch binding was not captured");
    useBrowserStore.setState({ agentActions: [] });
    const view = render(
      <BrowserGoalStatus
        chatId="chat-1"
        store={h.store}
        runtime={h.chatRuntime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(h.requestCancellation).toHaveBeenCalledOnce());
    try {
      await act(async () => {
        oldDispatch.release();
        await first;
        await h.runtime.executeRegisteredAction(
          successorAction(h.action),
          async () => failedOutcome(),
        );
        const latest = [...repo.records]
          .filter((record) => record.manifest.runId === "jrun_browser_1")
          .sort((a, b) => b.revision - a.revision)[0];
        if (!latest) throw new Error("Real original checkpoint missing");
        h.chatRuntime.activate({ ...firstBinding, record: latest });
      });
      const restored = h.store.getSnapshot("chat-1");
      expect(restored).toMatchObject({
        state: "paused",
        runId: "jrun_browser_1",
      });
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
        "disabled",
        false,
      );
      await act(async () => {
        cancel.release();
        await waitFor(() =>
          expect(
            repo.records.some(
              (record) =>
                record.manifest.runId === "jrun_browser_1" &&
                record.idempotencyKey.includes(":cancel:"),
            ),
          ).toBe(true),
        );
      });
      expect(h.store.getSnapshot("chat-1")).toEqual(restored);
      expect(screen.getByRole("button", { name: "Resume" })).toHaveProperty(
        "disabled",
        false,
      );
    } finally {
      cancel.release();
      oldDispatch.release();
      await first;
      view.unmount();
    }
  });

  it("still publishes a genuine current-goal cancellation failure", async () => {
    let clock = 1000;
    const h = fixture({ now: () => clock++ });
    const held = heldVoid();
    h.requestCancellation.mockRejectedValue(
      new Error("Synthetic cancellation port failure"),
    );
    const dispatch = vi.fn(async () => {
      await held.promise;
      return failedOutcome();
    });
    const launched = h.runtime.executeRegisteredAction(h.action, dispatch);
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    useBrowserStore.setState({ agentActions: [] });
    const view = render(
      <BrowserGoalStatus
        chatId="chat-1"
        store={h.store}
        runtime={h.chatRuntime}
      />,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(h.store.getSnapshot("chat-1")).toMatchObject({
          state: "failed",
          runId: "jrun_browser_1",
          failureReason:
            "Browser goal control failed before verified settlement.",
        }),
      );
      expect(screen.getByRole("alert").textContent).toBe(
        "Browser goal control failed before verified settlement.",
      );
    } finally {
      held.release();
      await act(async () => {
        await launched;
      });
      view.unmount();
    }
  });
});
