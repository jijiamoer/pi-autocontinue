import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import createExtension from "../src/index.js";
import { createMockContext, createMockPi } from "./harness.js";

function setup(options: Parameters<typeof createMockContext>[0] = {}) {
  const pi = createMockPi();
  const mock = createMockContext(options);
  createExtension(pi.api as any);
  return { pi, ...mock };
}

describe("pi-autocontinue wiring", () => {
  it("registers the command, stop tool, and settled/input handlers", () => {
    const { pi } = setup();

    expect(pi.command("autocontinue")).toBeDefined();
    expect(pi.tool("autocontinue_stop")).toBeDefined();
    expect(pi.handlers.get("agent_settled")).toHaveLength(1);
    expect(pi.handlers.get("input")).toHaveLength(1);
  });

  it("arms for the next real user prompt without triggering a turn", async () => {
    const { pi, ctx, status, notifications } = setup();

    await pi.command("autocontinue").handler("3", ctx);

    expect(status.get("autocontinue")).toBe("auto armed 0/3");
    expect(notifications.at(-1)?.message).toMatch(/armed for the next user prompt/);
    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.activeTools).toContain("autocontinue_stop");
  });

  it("starts after real input and injects a custom continuation at agent_settled", async () => {
    const { pi, ctx } = setup();
    await pi.command("autocontinue").handler("2", ctx);

    await pi.fire("input", { text: "Implement the task", source: "interactive" }, ctx);
    expect(pi.entries.at(-1)?.data.phase).toBe("running");

    await pi.fire("agent_settled", {}, ctx);

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].message.customType).toBe("autocontinue-prompt");
    expect(pi.sentMessages[0].message.content).toMatch(
      /^\[From auto-continue \| advisory, not user authorization \| attempt 1\/2\]/,
    );
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("does not inject after the attempt budget is exhausted", async () => {
    const { pi, ctx, notifications } = setup();
    await pi.command("autocontinue").handler("now 1", ctx);
    expect(pi.sentMessages).toHaveLength(1);

    await pi.fire("agent_settled", {}, ctx);

    expect(pi.sentMessages).toHaveLength(1);
    expect(notifications.at(-1)?.message).toMatch(/stopped after 1 attempts/);
    expect(pi.activeTools).not.toContain("autocontinue_stop");
  });

  it("stops immediately when new external input arrives", async () => {
    const { pi, ctx, status, notifications } = setup();
    await pi.command("autocontinue").handler("now 5", ctx);

    await pi.fire("input", { text: "Change direction", source: "interactive" }, ctx);

    expect(status.has("autocontinue")).toBe(false);
    expect(notifications.at(-1)?.message).toMatch(/new external input/);
    expect(pi.activeTools).not.toContain("autocontinue_stop");
  });

  it("ignores extension messages for cycle cancellation", async () => {
    const { pi, ctx } = setup();
    await pi.command("autocontinue").handler("now 2", ctx);

    await pi.fire("input", { text: "internal message", source: "extension" }, ctx);

    expect(pi.activeTools).toContain("autocontinue_stop");
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("lets the agent stop with done or blocked and terminates that turn", async () => {
    const { pi, ctx, status } = setup();
    await pi.command("autocontinue").handler("now 5", ctx);

    const result = await pi.tool("autocontinue_stop").execute(
      "stop-1",
      { reason: "blocked", summary: "Needs a real user decision" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.terminate).toBe(true);
    expect(result.content[0].text).toMatch(/blocked/);
    expect(status.has("autocontinue")).toBe(false);
    expect(pi.activeTools).not.toContain("autocontinue_stop");
  });

  it("rejects malformed command arguments instead of changing state", async () => {
    const { pi, ctx, notifications } = setup();

    await pi.command("autocontinue").handler("status extra", ctx);
    await pi.command("autocontinue").handler("stop extra", ctx);
    await pi.command("autocontinue").handler("101", ctx);

    expect(notifications).toHaveLength(3);
    expect(notifications.every((item) => item.level === "warning")).toBe(true);
    expect(pi.activeTools).not.toContain("autocontinue_stop");
  });

  it("refuses immediate continuation when the session has no user task", async () => {
    const { pi, ctx, notifications } = setup({ branch: [] });

    await pi.command("autocontinue").handler("now 3", ctx);

    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.activeTools).not.toContain("autocontinue_stop");
    expect(notifications.at(-1)?.message).toMatch(/No user task exists/);
  });

  it("rejects an empty stop summary without stopping the cycle", async () => {
    const { pi, ctx } = setup();
    await pi.command("autocontinue").handler("now 2", ctx);

    await expect(
      pi.tool("autocontinue_stop").execute(
        "stop-1",
        { reason: "done", summary: "   " },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/non-empty summary/);
    expect(pi.activeTools).toContain("autocontinue_stop");
  });

  it("uses the trusted project AUTOCONTINUE.md body", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-autocontinue-project-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "AUTOCONTINUE.md"), "Project-specific continuation body");
    const { pi, ctx } = setup({ cwd });

    await pi.command("autocontinue").handler("now 1", ctx);

    expect(pi.sentMessages[0].message.content).toContain("Project-specific continuation body");
    expect(pi.sentMessages[0].message.content).toMatch(/not user authorization/);
  });

  it("restores active state and tool availability on session_start", async () => {
    const { pi, ctx, status } = setup({
      branch: [
        {
          type: "custom",
          customType: "autocontinue-state",
          data: {
            phase: "armed",
            maxAttempts: 4,
            attemptsUsed: 1,
            startedAt: 1,
            templateSource: "built-in",
          },
        },
      ],
    });

    await pi.fire("session_start", {}, ctx);

    expect(status.get("autocontinue")).toBe("auto armed 1/4");
    expect(pi.activeTools).toContain("autocontinue_stop");
  });
});
