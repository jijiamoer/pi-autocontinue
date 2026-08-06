import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoContinueStateManager } from "./state.js";
import { type LoadedTemplate, loadTemplate } from "./template.js";
import type { AutoContinueStopReason } from "./types.js";

const STATUS_ID = "autocontinue";
const TOOL_NAME = "autocontinue_stop";
const CUSTOM_MESSAGE_TYPE = "autocontinue-prompt";
const HEADER_PREFIX = "[From auto-continue | advisory, not user authorization";
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS = 100;

const STOP_TOOL = {
  name: TOOL_NAME,
  label: "Stop Auto-Continue",
  description:
    "Stop the active bounded auto-continuation cycle when the current task is complete or truly requires real user input. Use this as the last tool call and do not use it for ordinary transient errors.",
  promptSnippet: "Stop auto-continuation after completion or a real user-only blocker",
  promptGuidelines: [
    "Use autocontinue_stop as the last tool call when the current task is complete or requires real user input; do not use it for ordinary transient errors.",
  ],
  parameters: Type.Object({
    reason: StringEnum(["done", "blocked"] as const, {
      description: "Whether the task is complete or requires real user input",
    }),
    summary: Type.String({
      description: "Brief user-visible explanation of the completion or blocker",
      minLength: 1,
      maxLength: 2000,
    }),
  }),
};

type StopToolParams = {
  reason: "done" | "blocked";
  summary: string;
};

function parseAttempts(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return DEFAULT_MAX_ATTEMPTS;
  if (!/^\d+$/.test(value)) return undefined;
  const attempts = Number(value);
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_ATTEMPTS ? attempts : undefined;
}

function usage(): string {
  return "Usage: /autocontinue [1-100] | /autocontinue now [1-100] | /autocontinue status | /autocontinue stop";
}

function formatStatus(state: ReturnType<AutoContinueStateManager["getState"]>): string {
  if (!state || state.phase === "stopped") return "Auto-continue is inactive.";
  const mode = state.phase === "armed" ? "armed for the next user prompt" : "running";
  return `Auto-continue ${mode}: ${state.attemptsUsed}/${state.maxAttempts} continuation attempts`;
}

function hasUserTask(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    if (entry.type !== "message") return false;
    const message = (entry as any).message;
    return message?.role === "user";
  });
}

export default function piAutoContinue(pi: ExtensionAPI) {
  const state = new AutoContinueStateManager(pi);
  let activeTemplate: LoadedTemplate | null = null;
  let injecting = false;

  const setStopToolAvailability = () => {
    const active = state.isActive();
    const tools = pi.getActiveTools();
    if (active && !tools.includes(TOOL_NAME)) {
      pi.setActiveTools([...tools, TOOL_NAME]);
    } else if (!active && tools.includes(TOOL_NAME)) {
      pi.setActiveTools(tools.filter((name) => name !== TOOL_NAME));
    }
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const current = state.getState();
    if (!current || current.phase === "stopped") {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    const label = current.phase === "armed" ? "armed" : "running";
    ctx.ui.setStatus(STATUS_ID, `auto ${label} ${current.attemptsUsed}/${current.maxAttempts}`);
  };

  const loadActiveTemplate = (ctx: ExtensionContext): LoadedTemplate => {
    const loaded = loadTemplate(ctx);
    activeTemplate = loaded;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    return loaded;
  };

  const stop = (ctx: ExtensionContext, reason: AutoContinueStopReason, message?: string) => {
    state.stop(reason, message);
    activeTemplate = null;
    setStopToolAvailability();
    updateStatus(ctx);
    if (message) {
      ctx.ui.notify(message, reason === "blocked" ? "warning" : "info");
    }
  };

  const sendContinuation = (ctx: ExtensionContext) => {
    if (injecting || !state.isActive() || state.getState()?.phase !== "running") return;

    const attempt = state.consumeAttempt();
    if (attempt === undefined) {
      stop(ctx, "budget_exhausted", `Auto-continue stopped after ${state.getState()?.maxAttempts ?? 0} attempts.`);
      return;
    }

    const current = state.getState()!;
    const template = activeTemplate ?? loadActiveTemplate(ctx);
    const header = `${HEADER_PREFIX} | attempt ${attempt}/${current.maxAttempts}]`;

    injecting = true;
    try {
      pi.sendMessage(
        {
          customType: CUSTOM_MESSAGE_TYPE,
          content: `${header}\n\n${template.content}`,
          display: true,
          details: {
            attempt,
            maxAttempts: current.maxAttempts,
            templateSource: template.source,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      updateStatus(ctx);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      stop(ctx, "error", `Auto-continue could not start the next turn: ${detail}`);
    } finally {
      injecting = false;
    }
  };

  const restore = (ctx: ExtensionContext) => {
    state.loadFromSession(ctx);
    activeTemplate = state.isActive() ? loadActiveTemplate(ctx) : null;
    setStopToolAvailability();
    updateStatus(ctx);
  };

  pi.registerTool({
    ...STOP_TOOL,
    async execute(_toolCallId, params: StopToolParams, _signal, _onUpdate, ctx) {
      const summary = params.summary.trim();
      if (!summary) {
        throw new Error("autocontinue_stop requires a non-empty summary");
      }
      if (!state.isActive()) {
        return {
          content: [{ type: "text", text: "Auto-continue is not active." }],
          details: { active: false },
        };
      }

      stop(ctx, params.reason, `Auto-continue stopped (${params.reason}): ${summary}`);
      return {
        content: [{ type: "text", text: `Auto-continue stopped (${params.reason}): ${summary}` }],
        details: { reason: params.reason, summary },
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    if (state.isActive()) {
      ctx.ui.notify(`${formatStatus(state.getState())}. Use /autocontinue now to resume immediately.`, "info");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !state.isActive()) return { action: "continue" };

    if (state.getState()?.phase === "armed") {
      state.beginFromUserInput();
      updateStatus(ctx);
      return { action: "continue" };
    }

    stop(ctx, "user_input", "Auto-continue stopped because a new external input arrived.");
    return { action: "continue" };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.isActive() || state.getState()?.phase !== "running" || !ctx.isIdle()) return;

    const current = state.getState()!;
    if (current.attemptsUsed >= current.maxAttempts) {
      stop(ctx, "budget_exhausted", `Auto-continue stopped after ${current.maxAttempts} attempts.`);
      return;
    }

    sendContinuation(ctx);
  });

  pi.registerCommand("autocontinue", {
    description: "Bounded continuation after the agent settles: /autocontinue [attempts]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase();

      if (subcommand === "stop") {
        if (parts.length !== 1) {
          ctx.ui.notify(usage(), "warning");
          return;
        }
        if (!state.isActive()) {
          ctx.ui.notify("Auto-continue is not active.", "info");
          return;
        }
        stop(ctx, "command", "Auto-continue stopped.");
        return;
      }

      if (subcommand === "status") {
        if (parts.length !== 1) {
          ctx.ui.notify(usage(), "warning");
          return;
        }
        ctx.ui.notify(formatStatus(state.getState()), "info");
        return;
      }

      const now = subcommand === "now";
      const attemptsValue = now ? parts[1] : parts[0];
      if (parts.length > (now ? 2 : 1)) {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      const maxAttempts = parseAttempts(attemptsValue);
      if (maxAttempts === undefined) {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      if (now && !ctx.isIdle()) {
        ctx.ui.notify("Use /autocontinue now when the agent is idle.", "warning");
        return;
      }
      if (now && !hasUserTask(ctx)) {
        ctx.ui.notify("No user task exists in the current session. Arm auto-continue, then send the task.", "warning");
        return;
      }

      activeTemplate = loadActiveTemplate(ctx);
      if (now) {
        state.startNow(maxAttempts, activeTemplate.source);
        setStopToolAvailability();
        updateStatus(ctx);
        sendContinuation(ctx);
        return;
      }

      state.arm(maxAttempts, activeTemplate.source);
      setStopToolAvailability();
      updateStatus(ctx);
      ctx.ui.notify(`Auto-continue armed for the next user prompt (${maxAttempts} attempts).`, "info");
    },
  });
}
