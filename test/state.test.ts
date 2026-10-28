import { describe, expect, it, vi } from "vitest";
import { AutoContinueStateManager } from "../src/state.js";

function makePi() {
  return { appendEntry: vi.fn() } as any;
}

function makeCtx(branch: any[]) {
  return { sessionManager: { getBranch: () => branch } } as any;
}

describe("AutoContinueStateManager", () => {
  it("reserves normal attempts and commits them only after success", () => {
    const pi = makePi();
    const manager = new AutoContinueStateManager(pi, { createId: () => "cycle-1" });

    manager.arm(3, "project-template", "leaf-1");
    expect(manager.getState()).toMatchObject({
      phase: "armed",
      maxAttempts: 3,
      attemptsUsed: 0,
      recoveryAttemptsUsed: 0,
      startedFromLeafId: "leaf-1",
    });

    expect(manager.beginFromUserInput()).toBe(true);
    const pending = manager.reserveContinuation("settlement-0");
    expect(pending).toMatchObject({ kind: "continuation", normalAttempt: 1 });
    expect(manager.getState()).toMatchObject({ attemptsUsed: 0, pendingInjection: pending });

    manager.recordSuccessfulSettlement("settlement-1");
    expect(manager.getState()).toMatchObject({
      phase: "running",
      attemptsUsed: 1,
      recoveryAttemptsUsed: 0,
      lastHandledSettlementId: "settlement-1",
    });
  });

  it("keeps a failed normal attempt reserved through recovery and commits after recovery succeeds", () => {
    let now = 0;
    const manager = new AutoContinueStateManager(makePi(), {
      now: () => now,
      createId: () => "cycle-2",
    });
    manager.startNow(3, "built-in", "leaf-1");
    const normal = manager.reserveContinuation("settlement-0")!;

    manager.recordTransientFailure("settlement-1", { category: "transient", summary: "502" }, 15_000);
    expect(manager.getState()).toMatchObject({
      attemptsUsed: 0,
      reservedNormalAttempt: normal.normalAttempt,
      recoveryAttemptsUsed: 0,
      retryAt: 15_000,
    });

    now = 15_000;
    const recovery = manager.reserveRecovery("settlement-1")!;
    expect(recovery).toMatchObject({ kind: "recovery", recoveryAttempt: 1, normalAttempt: 1 });
    expect(manager.getState()).toMatchObject({ recoveryAttemptsUsed: 1, retryAt: undefined });

    manager.recordSuccessfulSettlement("settlement-2");
    expect(manager.getState()).toMatchObject({
      attemptsUsed: 1,
      recoveryAttemptsUsed: 0,
      reservedNormalAttempt: undefined,
      pendingInjection: undefined,
      lastHandledSettlementId: "settlement-2",
    });
  });

  it("marks a pending injection as started durably", () => {
    const manager = new AutoContinueStateManager(makePi(), { createId: () => "cycle-3" });
    manager.startNow(2, "built-in");
    manager.reserveContinuation();

    expect(manager.markPendingStarted()).toBe(true);
    expect(manager.markPendingStarted()).toBe(false);
    expect(manager.getState()?.pendingInjection?.started).toBe(true);
  });

  it("stops an active cycle and ignores repeated stop requests", () => {
    const pi = makePi();
    const manager = new AutoContinueStateManager(pi);
    manager.startNow(2, "built-in");
    pi.appendEntry.mockClear();

    manager.stop("blocked", "Needs user credentials");
    manager.stop("done", "should be ignored");

    expect(manager.isActive()).toBe(false);
    expect(manager.getState()).toMatchObject({
      phase: "stopped",
      stopReason: "blocked",
      stopSummary: "Needs user credentials",
    });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("persists the completion-review anchor and clears it on stop and restart", () => {
    const pi = makePi();
    const manager = new AutoContinueStateManager(pi);

    expect(manager.requestCompletionReview("assistant-1")).toBeNull();
    manager.startNow(3, "built-in");
    manager.requestCompletionReview("assistant-1");
    expect(manager.getState()?.completionReviewEntryId).toBe("assistant-1");

    manager.requestCompletionReview("assistant-2");
    expect(manager.getState()?.completionReviewEntryId).toBe("assistant-2");

    manager.stop("done", "complete");
    expect(manager.getState()?.completionReviewEntryId).toBeUndefined();

    manager.startNow(3, "built-in");
    expect(manager.getState()?.completionReviewEntryId).toBeUndefined();
  });

  it("restores completionReviewEntryId and rejects malformed values", () => {
    const stateData = (extra: Record<string, unknown> = {}) => ({
      version: 2,
      cycleId: "cycle-9",
      phase: "running",
      maxAttempts: 5,
      attemptsUsed: 0,
      recoveryAttemptsUsed: 0,
      startedAt: 1,
      templateSource: "built-in",
      ...extra,
    });
    const load = (data: Record<string, unknown>) => {
      const manager = new AutoContinueStateManager(makePi());
      manager.loadFromSession(makeCtx([{ type: "custom", customType: "autocontinue-state", data }]));
      return manager;
    };

    expect(load(stateData({ completionReviewEntryId: "assistant-7" })).getState()?.completionReviewEntryId).toBe(
      "assistant-7",
    );
    const legacy = load(stateData());
    expect(legacy.getState()).toMatchObject({ cycleId: "cycle-9", phase: "running" });
    expect(legacy.getState()?.completionReviewEntryId).toBeUndefined();
    expect(load(stateData({ completionReviewEntryId: 42 })).getState()).toBeNull();
  });

  it("restores current and legacy state from the current branch", () => {
    const manager = new AutoContinueStateManager(makePi());
    manager.loadFromSession(
      makeCtx([
        { type: "custom", customType: "autocontinue-state", data: { phase: "invalid" } },
        {
          type: "custom",
          customType: "autocontinue-state",
          data: {
            phase: "running",
            maxAttempts: 5,
            attemptsUsed: 2,
            startedAt: 123,
            templateSource: "built-in",
          },
        },
      ]),
    );

    expect(manager.getState()).toMatchObject({
      version: 2,
      phase: "running",
      maxAttempts: 5,
      attemptsUsed: 2,
      recoveryAttemptsUsed: 0,
      cycleId: "legacy-3f",
    });
  });
});
