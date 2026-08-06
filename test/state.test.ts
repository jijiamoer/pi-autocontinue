import { describe, expect, it, vi } from "vitest";
import { AutoContinueStateManager } from "../src/state.js";

function makePi() {
  return { appendEntry: vi.fn() } as any;
}

function makeCtx(branch: any[]) {
  return { sessionManager: { getBranch: () => branch } } as any;
}

describe("AutoContinueStateManager", () => {
  it("arms, starts, consumes attempts, and persists each durable change", () => {
    const pi = makePi();
    const manager = new AutoContinueStateManager(pi);

    manager.arm(3, "project-template");
    expect(manager.getState()).toMatchObject({ phase: "armed", maxAttempts: 3, attemptsUsed: 0 });

    expect(manager.beginFromUserInput()).toBe(true);
    expect(manager.consumeAttempt()).toBe(1);
    expect(manager.consumeAttempt()).toBe(2);
    expect(manager.consumeAttempt()).toBe(3);
    expect(manager.consumeAttempt()).toBeUndefined();
    expect(manager.getState()).toMatchObject({ phase: "running", attemptsUsed: 3 });
    expect(pi.appendEntry).toHaveBeenCalledTimes(5);
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

  it("restores the latest valid state from the current branch", () => {
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

    expect(manager.getState()).toMatchObject({ phase: "running", maxAttempts: 5, attemptsUsed: 2 });
  });
});
