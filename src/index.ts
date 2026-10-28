import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  classifySettledAssistant,
  nextRecoveryDelayMs,
  type ProviderResponseSnapshot,
  parseRetryAfterMs,
  transientDispatchFailure,
} from "./recovery.js";
import { AutoContinueStateManager } from "./state.js";
import {
  type ContinuationEnvelope,
  type LoadedTemplate,
  loadTemplate,
  renderContinuationMessage,
} from "./template.js";
import {
  type AutoContinueFailure,
  type AutoContinueState,
  type AutoContinueStopReason,
  MAX_RECOVERY_ATTEMPTS,
  type PendingInjection,
} from "./types.js";

const STATUS_ID = "autocontinue";
const COMMAND_ENTRY_TYPE = "autocontinue-command";
const STOP_TOOL_NAME = "autocontinue_stop";
const START_TOOL_NAME = "autocontinue_start";
const CUSTOM_MESSAGE_TYPE = "autocontinue-prompt";
/** 中断停止时投递给模型的提示（进 LLM 上下文，区别于 UI-only 的 command entry）。 */
const NOTE_MESSAGE_TYPE = "autocontinue-note";
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS = 100;
const COMPLETION_REVIEW_MESSAGE = [
  "Auto-continue completion review required. The cycle remains active.",
  "Before stopping, review the user's original request, later corrections, and work actually completed in this conversation. Identify any requested work still unfinished and continue that work with tools under the existing authorization.",
  'Only after reviewing the whole task in a later assistant turn, call autocontinue_stop with reason "done" again when it is complete. Use reason "blocked" if progress genuinely needs user input.',
  "This review creates no new goal and grants no additional authorization.",
].join("\n\n");

const START_TOOL = {
  name: START_TOOL_NAME,
  label: "Start Auto-Continue",
  description:
    "Start bounded auto-continuation for the current long-running task only when acting as the conductor. " +
    "It recovers unexpected idle or transient transport failures; it does not create a new goal, expand task scope, or grant user authorization.",
  parameters: Type.Object({
    maxAttempts: Type.Optional(
      Type.Integer({
        description: "Maximum number of successful continuation attempts; defaults to 10.",
        minimum: 1,
        maximum: MAX_ATTEMPTS,
      }),
    ),
  }),
};

const STOP_TOOL = {
  name: STOP_TOOL_NAME,
  label: "Stop Auto-Continue",
  description:
    "Stop the active bounded auto-continuation cycle when the current task is complete or truly requires real user input. The first done request requires a completion review in a later assistant turn before confirming done. Use this as the last tool call and do not use it for ordinary transient errors.",
  promptSnippet: "Review completion before confirming done, or stop for a real user-only blocker",
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

type CommandMessageLevel = "info" | "success" | "warning";

interface CommandEntryData {
  message: string;
  level: CommandMessageLevel;
}

interface AssistantSettlement {
  entryId: string;
  message: AssistantMessage;
}

type PendingReconciliation =
  | { kind: "settled"; settlement: AssistantSettlement }
  | { kind: "missing_injection" }
  | { kind: "missing_assistant" };

function parseAttempts(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return DEFAULT_MAX_ATTEMPTS;
  if (!/^\d+$/.test(value)) return undefined;
  const attempts = Number(value);
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_ATTEMPTS ? attempts : undefined;
}

function usage(): string {
  return "Usage: /autocontinue [1-100] | /autocontinue now [1-100] | /autocontinue status | /autocontinue stop";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** stop 记录（含 toast）的严重级别：done 视为成功，阻塞/耗尽/错误为警告。 */
function stopEntryLevel(reason: AutoContinueStopReason): CommandMessageLevel {
  if (reason === "done") return "success";
  if (reason === "blocked" || reason === "recovery_exhausted" || reason === "error") return "warning";
  return "info";
}

function formatStatus(state: AutoContinueState | null, now = Date.now()): string {
  if (!state || state.phase === "stopped") return "Auto-continue is inactive.";
  if (state.phase === "armed") {
    return `Auto-continue armed for the next user prompt: 0/${state.maxAttempts} continuation attempts`;
  }
  if (state.retryAt !== undefined) {
    const nextRecoveryAttempt = Math.min(state.recoveryAttemptsUsed + 1, MAX_RECOVERY_ATTEMPTS);
    return `Auto-continue recovering: continuation ${state.attemptsUsed}/${state.maxAttempts}, transport ${nextRecoveryAttempt}/${MAX_RECOVERY_ATTEMPTS} in ${formatDuration(state.retryAt - now)}`;
  }
  if (state.pendingInjection?.kind === "recovery") {
    return `Auto-continue recovery running: continuation ${state.attemptsUsed}/${state.maxAttempts}, transport ${state.pendingInjection.recoveryAttempt}/${MAX_RECOVERY_ATTEMPTS}`;
  }
  const reservedAttempt = state.pendingInjection?.normalAttempt ?? state.reservedNormalAttempt;
  const progress = reservedAttempt === undefined ? `${state.attemptsUsed}/${state.maxAttempts}` : `${reservedAttempt}/${state.maxAttempts}`;
  return `Auto-continue running: ${progress} continuation attempts`;
}

function hasUserTask(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    if (entry.type !== "message") return false;
    return entry.message.role === "user";
  });
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { message: AssistantMessage } {
  return entry.type === "message" && entry.message.role === "assistant";
}

function injectionId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== CUSTOM_MESSAGE_TYPE) return undefined;
  const details = entry.details;
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { injectionId?: unknown }).injectionId;
  return typeof value === "string" ? value : undefined;
}

function latestAssistantAfter(branch: SessionEntry[], index: number): AssistantSettlement | undefined {
  for (let i = branch.length - 1; i > index; i--) {
    const entry = branch[i];
    if (isAssistantEntry(entry)) return { entryId: entry.id, message: entry.message };
  }
  return undefined;
}

function reconcilePending(ctx: ExtensionContext, pending: PendingInjection): PendingReconciliation {
  const branch = ctx.sessionManager.getBranch();
  const injectionIndex = branch.findIndex((entry) => injectionId(entry) === pending.id);
  if (injectionIndex < 0) return { kind: "missing_injection" };
  const settlement = latestAssistantAfter(branch, injectionIndex);
  return settlement ? { kind: "settled", settlement } : { kind: "missing_assistant" };
}

function findUnprocessedSettlement(ctx: ExtensionContext, state: AutoContinueState): AssistantSettlement | undefined {
  const branch = ctx.sessionManager.getBranch();
  const boundaryId = state.lastHandledSettlementId ?? state.startedFromLeafId;
  const boundaryIndex = boundaryId === undefined ? -1 : branch.findIndex((entry) => entry.id === boundaryId);
  const settlement = latestAssistantAfter(branch, boundaryIndex);
  if (!settlement || settlement.entryId === state.lastHandledSettlementId) return undefined;
  return settlement;
}

export default function piAutoContinue(pi: ExtensionAPI) {
  const state = new AutoContinueStateManager(pi);
  let activeTemplate: LoadedTemplate | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeGeneration = 0;
  let providerResponse: ProviderResponseSnapshot | undefined;
  /** 本轮 agent_start 以来，settle 边界是否已被 agent_before_settle 处理（防双发）。 */
  let boundaryHandled = false;

  pi.registerEntryRenderer<CommandEntryData>(COMMAND_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data ?? { message: "Auto-continue command completed.", level: "info" };
    const color = data.level === "warning" ? "warning" : data.level === "success" ? "success" : "accent";
    return new Text(`${theme.fg(color, "[auto-continue]")} ${data.message}`, 0, 0);
  });

  pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details as
      | {
          kind?: "continuation" | "recovery";
          normalAttempt?: number;
          recoveryAttempt?: number;
          maxAttempts?: number;
          maxRecoveryAttempts?: number;
        }
      | undefined;
    const label =
      details?.kind === "recovery"
        ? `transport recovery ${details.recoveryAttempt ?? "?"}/${details.maxRecoveryAttempts ?? MAX_RECOVERY_ATTEMPTS}`
        : `continuation attempt ${details?.normalAttempt ?? "?"}/${details?.maxAttempts ?? "?"}`;
    const summary = `${theme.fg("accent", "[auto-continue]")} ${label}`;
    const fullContent =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    const text = expanded ? `${summary}\n${theme.fg("dim", fullContent)}` : summary;
    return new Text(text, outputPad, 0);
  });

  pi.registerMessageRenderer(NOTE_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details as { reason?: string } | undefined;
    const summary = `${theme.fg("accent", "[auto-continue]")} note: protection stopped${details?.reason ? ` (${details.reason})` : ""}`;
    const fullContent =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    const text = expanded ? `${summary}\n${theme.fg("dim", fullContent)}` : summary;
    return new Text(text, outputPad, 0);
  });

  const appendCommandEntry = (message: string, level: CommandMessageLevel = "info") => {
    pi.appendEntry<CommandEntryData>(COMMAND_ENTRY_TYPE, { message, level });
  };

  const showCommandMessage = (message: string, level: CommandMessageLevel = "info") => {
    appendCommandEntry(message, level);
  };

  const clearRecoveryTimer = () => {
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  };

  const setStopToolAvailability = () => {
    const active = state.isActive();
    const tools = pi.getActiveTools();
    if (active && !tools.includes(STOP_TOOL_NAME)) {
      pi.setActiveTools([...tools, STOP_TOOL_NAME]);
    } else if (!active && tools.includes(STOP_TOOL_NAME)) {
      pi.setActiveTools(tools.filter((name) => name !== STOP_TOOL_NAME));
    }
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const current = state.getState();
    if (!current || current.phase === "stopped") {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    if (current.phase === "armed") {
      ctx.ui.setStatus(STATUS_ID, `auto armed 0/${current.maxAttempts}`);
      return;
    }
    if (current.retryAt !== undefined) {
      const nextRecoveryAttempt = Math.min(current.recoveryAttemptsUsed + 1, MAX_RECOVERY_ATTEMPTS);
      // 恢复态同时展示续跑预算，避免分母从 maxAttempts 突变为 6 造成困惑
      ctx.ui.setStatus(
        STATUS_ID,
        `auto retry ${nextRecoveryAttempt}/${MAX_RECOVERY_ATTEMPTS} in ${formatDuration(current.retryAt - Date.now())} · cont ${current.attemptsUsed}/${current.maxAttempts}`,
      );
      return;
    }
    if (current.pendingInjection?.kind === "recovery") {
      ctx.ui.setStatus(
        STATUS_ID,
        `auto recovery ${current.pendingInjection.recoveryAttempt}/${MAX_RECOVERY_ATTEMPTS} · cont ${current.attemptsUsed}/${current.maxAttempts}`,
      );
      return;
    }
    const attempt = current.pendingInjection?.normalAttempt ?? current.attemptsUsed;
    ctx.ui.setStatus(STATUS_ID, `auto running ${attempt}/${current.maxAttempts}`);
  };

  const loadActiveTemplate = (ctx: ExtensionContext): LoadedTemplate => {
    const loaded = loadTemplate(ctx);
    activeTemplate = loaded;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    return loaded;
  };

  /** 中断类停止的 reason 文案（模型可读）。 */
  const RESUME_NOTE_REASONS = {
    aborted: "user aborted the run",
    user_input: "new user input stopped the cycle",
  } as const;

  type ResumeNoteReason = keyof typeof RESUME_NOTE_REASONS;

  /**
   * 给模型留一条 nextTurn note：告知保护刚被中断停止，恢复工作时应重新调 autocontinue_start。
   * 长程任务中“开启保护”的原始指令会被压缩掉，而这条 note 落在打断点，处于上下文新鲜尾部。
   * 发送失败不影响停止流程。
   */
  const queueResumeNote = (reason: ResumeNoteReason, stopped: AutoContinueState) => {
    const content = [
      "[From auto-continue | procedural, not user authorization]",
      `The auto-continue cycle guarding this workflow is now stopped (reason: ${RESUME_NOTE_REASONS[reason]}; attempts used: ${stopped.attemptsUsed}/${stopped.maxAttempts}).`,
      "Take no action from this note alone.",
      "If the user resumes, redirects, or continues this workflow, call autocontinue_start to restore protection (a fresh attempt budget starts).",
      "If the user is ending the work, do not restart it.",
    ].join("\n");

    try {
      pi.sendMessage(
        {
          customType: NOTE_MESSAGE_TYPE,
          content,
          display: true,
          details: {
            cycleId: stopped.cycleId,
            reason,
            attemptsUsed: stopped.attemptsUsed,
            maxAttempts: stopped.maxAttempts,
          },
        },
        // nextTurn：不触发 run、不打断，随下一条用户输入进入模型上下文
        { deliverAs: "nextTurn" },
      );
    } catch {
      // note 仅提醒用途，失败不影响停止
    }
  };

  const stop = (
    ctx: ExtensionContext,
    reason: AutoContinueStopReason,
    message?: string,
    failure?: AutoContinueFailure,
    notify = true,
  ) => {
    clearRecoveryTimer();
    const stopped = state.stop(reason, message, failure);
    activeTemplate = null;
    setStopToolAvailability();
    updateStatus(ctx);
    if (message) {
      const level = stopEntryLevel(reason);
      // 落一条 durable transcript 记录：notify 转瞬即逝，无人值守时的停止原因必须可追溯
      appendCommandEntry(message, level);
      if (notify) ctx.ui.notify(message, level === "success" ? "info" : level);
    }
    // 仅中断类停止（Esc / 用户输入）需要提醒模型：其余停止路径模型知情或语义上明确终止
    if (stopped && (reason === "aborted" || reason === "user_input")) {
      queueResumeNote(reason, stopped);
    }
  };

  const scheduleRecoveryTimer = (ctx: ExtensionContext) => {
    clearRecoveryTimer();
    const current = state.getState();
    if (current?.phase !== "running" || current.retryAt === undefined) return;

    const generation = runtimeGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    const delay = Math.max(0, current.retryAt - Date.now());
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      try {
        if (generation !== runtimeGeneration || ctx.sessionManager.getSessionId() !== sessionId || !ctx.isIdle()) return;
        dispatchRecovery(ctx);
      } catch {
        return;
      }
    }, delay);
    if (typeof recoveryTimer === "object" && "unref" in recoveryTimer) recoveryTimer.unref();
  };

  const scheduleTransientFailure = (
    ctx: ExtensionContext,
    settlementId: string | undefined,
    failure: AutoContinueFailure,
  ) => {
    const current = state.getState();
    if (current?.phase !== "running") return;
    if (current.recoveryAttemptsUsed >= MAX_RECOVERY_ATTEMPTS) {
      stop(
        ctx,
        "recovery_exhausted",
        `Auto-continue stopped after ${MAX_RECOVERY_ATTEMPTS} transport recovery attempts: ${failure.summary}`,
        failure,
      );
      return;
    }

    const delay = nextRecoveryDelayMs(current.recoveryAttemptsUsed, failure.retryAfterMs);
    state.recordTransientFailure(settlementId, failure, Date.now() + delay);
    updateStatus(ctx);
    ctx.ui.notify(
      `Auto-continue transport recovery ${current.recoveryAttemptsUsed + 1}/${MAX_RECOVERY_ATTEMPTS} scheduled in ${formatDuration(delay)}: ${failure.summary}`,
      "warning",
    );
    scheduleRecoveryTimer(ctx);
  };

  const dispatchInjection = (ctx: ExtensionContext, kind: "continuation" | "recovery") => {
    const before = state.getState();
    if (before?.phase !== "running") return;
    const sourceSettlementId = before.lastHandledSettlementId;
    const pending =
      kind === "continuation"
        ? state.reserveContinuation(sourceSettlementId)
        : state.reserveRecovery(sourceSettlementId);
    if (!pending) return;

    const current = state.getState()!;
    // 持久化一次进度可见反馈（adapter 经 entry_appended 转发为 assistant chunk）
    appendCommandEntry(
      pending.kind === "continuation"
        ? `Auto-continue: continuation ${pending.normalAttempt}/${current.maxAttempts}.`
        : `Auto-continue: transport recovery ${pending.recoveryAttempt}/${MAX_RECOVERY_ATTEMPTS} · continuation ${current.attemptsUsed}/${current.maxAttempts}.`,
    );
    const template = activeTemplate ?? loadActiveTemplate(ctx);
    const envelope: ContinuationEnvelope =
      pending.kind === "continuation"
        ? {
            kind: "continuation",
            attempt: pending.normalAttempt!,
            maxAttempts: current.maxAttempts,
          }
        : {
            kind: "recovery",
            recoveryAttempt: pending.recoveryAttempt!,
            maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
            maxAttempts: current.maxAttempts,
            ...(pending.normalAttempt === undefined ? {} : { normalAttempt: pending.normalAttempt }),
          };

    try {
      pi.sendMessage(
        {
          customType: CUSTOM_MESSAGE_TYPE,
          content: renderContinuationMessage(envelope, template.content),
          display: true,
          details: {
            cycleId: current.cycleId,
            injectionId: pending.id,
            kind: pending.kind,
            normalAttempt: pending.normalAttempt,
            recoveryAttempt: pending.recoveryAttempt,
            maxAttempts: current.maxAttempts,
            maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
            templateSource: template.source,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      updateStatus(ctx);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      scheduleTransientFailure(
        ctx,
        undefined,
        transientDispatchFailure(`Auto-continue could not dispatch ${pending.kind}: ${detail}`),
      );
    }
  };

  const dispatchContinuation = (ctx: ExtensionContext) => dispatchInjection(ctx, "continuation");

  function dispatchRecovery(ctx: ExtensionContext) {
    const current = state.getState();
    if (
      current?.phase !== "running" ||
      current.retryAt === undefined ||
      current.retryAt > Date.now() ||
      !ctx.isIdle()
    ) {
      scheduleRecoveryTimer(ctx);
      return;
    }
    dispatchInjection(ctx, "recovery");
  }

  const handleSuccessfulSettlement = (ctx: ExtensionContext, settlementId: string) => {
    providerResponse = undefined;
    const current = state.recordSuccessfulSettlement(settlementId);
    if (!current) return;
    if (current.attemptsUsed >= current.maxAttempts) {
      stop(ctx, "budget_exhausted", `Auto-continue stopped after ${current.maxAttempts} successful attempts.`);
      return;
    }
    dispatchContinuation(ctx);
  };

  const handleSettlement = (ctx: ExtensionContext, settlement: AssistantSettlement) => {
    const outcome = classifySettledAssistant(
      settlement.message,
      providerResponse,
      ctx.model?.contextWindow,
    );
    providerResponse = undefined;
    if (outcome.kind === "success") {
      handleSuccessfulSettlement(ctx, settlement.entryId);
      return;
    }
    if (outcome.kind === "transient") {
      scheduleTransientFailure(ctx, settlement.entryId, outcome.failure);
      return;
    }
    if (outcome.kind === "aborted") {
      stop(ctx, "aborted", `Auto-continue stopped because the assistant run was aborted: ${outcome.summary}`);
      return;
    }
    stop(ctx, "blocked", `Auto-continue requires real user input: ${outcome.failure.summary}`, outcome.failure);
  };

  const settledInjection = (ctx: ExtensionContext, pending: PendingInjection): AssistantSettlement | undefined => {
    const reconciliation = reconcilePending(ctx, pending);
    return reconciliation.kind === "settled" ? reconciliation.settlement : undefined;
  };

  /**
   * agent_settled event.aborted 的无条件停机路径：中止的 run 跳过 agent_before_settle，
   * 若只看 boundaryHandled，已 queue 续跑后被取消的 run 会把保护状态滞留在 running。
   */
  const stopAborted = (ctx: ExtensionContext) => {
    const current = state.getState();
    if (current?.phase !== "running") return;
    const settlement = current.pendingInjection
      ? settledInjection(ctx, current.pendingInjection)
      : findUnprocessedSettlement(ctx, current);
    let summary = "Assistant run was aborted.";
    if (settlement) {
      const outcome = classifySettledAssistant(settlement.message, providerResponse, ctx.model?.contextWindow);
      providerResponse = undefined;
      if (outcome.kind === "aborted") summary = outcome.summary;
    }
    stop(ctx, "aborted", `Auto-continue stopped because the assistant run was aborted: ${summary}`);
  };

  const handleSettled = (ctx: ExtensionContext, allowActive = false) => {
    const current = state.getState();
    if (current?.phase !== "running" || (!allowActive && !ctx.isIdle())) return;

    if (current.pendingInjection) {
      const reconciliation = reconcilePending(ctx, current.pendingInjection);
      if (reconciliation.kind !== "settled" && current.pendingInjection.started !== true) return;
      if (reconciliation.kind === "settled") {
        if (reconciliation.settlement.entryId === current.lastHandledSettlementId) return;
        handleSettlement(ctx, reconciliation.settlement);
        return;
      }
      const detail =
        reconciliation.kind === "missing_injection"
          ? `Injection ${current.pendingInjection.id} was not persisted before the run settled.`
          : `Injection ${current.pendingInjection.id} produced no assistant result before the run settled.`;
      scheduleTransientFailure(ctx, undefined, transientDispatchFailure(detail));
      return;
    }

    const settlement = findUnprocessedSettlement(ctx, current);
    if (settlement) {
      handleSettlement(ctx, settlement);
      return;
    }

    const refreshed = state.getState();
    if (refreshed?.phase !== "running") return;
    if (refreshed.retryAt !== undefined) {
      if (refreshed.retryAt <= Date.now()) dispatchRecovery(ctx);
      else scheduleRecoveryTimer(ctx);
      return;
    }
    if (refreshed.attemptsUsed >= refreshed.maxAttempts) {
      stop(ctx, "budget_exhausted", `Auto-continue stopped after ${refreshed.maxAttempts} successful attempts.`);
      return;
    }
    if (refreshed.lastHandledSettlementId !== undefined) dispatchContinuation(ctx);
  };

  const restore = (ctx: ExtensionContext) => {
    runtimeGeneration += 1;
    clearRecoveryTimer();
    providerResponse = undefined;
    state.loadFromSession(ctx);
    if (state.getState()?.pendingInjection) state.markPendingStarted();
    activeTemplate = state.isActive() ? loadActiveTemplate(ctx) : null;
    setStopToolAvailability();
    updateStatus(ctx);
    if (state.getState()?.phase === "running" && ctx.isIdle()) handleSettled(ctx);
  };

  pi.registerTool({
    ...START_TOOL,
    async execute(_toolCallId, params: { maxAttempts?: number }, _signal, _onUpdate, ctx) {
      const text = (message: string, details?: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: message }],
        details,
      });

      if (state.isActive()) {
        return text(`Auto-continue is already active: ${formatStatus(state.getState())}.`, { active: true });
      }
      if (!hasUserTask(ctx)) {
        return text("Auto-continue requires an existing real user task in the current session.", { active: false });
      }

      const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      clearRecoveryTimer();
      activeTemplate = loadActiveTemplate(ctx);
      const started = state.startNow(maxAttempts, activeTemplate.source, ctx.sessionManager.getLeafId() ?? undefined);
      setStopToolAvailability();
      updateStatus(ctx);
      ctx.ui.notify(`Auto-continue started by conductor (${maxAttempts} successful attempts).`, "info");

      return text(`Auto-continue active for the current workflow (${maxAttempts} successful attempts).`, {
        active: true,
        cycleId: started.cycleId,
        maxAttempts,
      });
    },
  });

  pi.registerTool({
    ...STOP_TOOL,
    async execute(_toolCallId, params: StopToolParams, _signal, _onUpdate, ctx) {
      const summary = params.summary.trim();
      if (!summary) throw new Error("autocontinue_stop requires a non-empty summary");
      if (!state.isActive()) {
        return {
          content: [{ type: "text" as const, text: "Auto-continue is not active." }],
          details: { active: false },
        };
      }

      if (params.reason === "done") {
        const latestId = latestAssistantAfter(ctx.sessionManager.getBranch(), -1)?.entryId;
        const reviewedId = state.getState()?.completionReviewEntryId;
        // 复核确认必须来自锚点assistant之后的新assistant entry；无锚点则先记录，
        // 同一codemode turn内重复done、或无任何assistant entry都不能视为确认。
        if (reviewedId === undefined || latestId === undefined || reviewedId === latestId) {
          if (reviewedId === undefined && latestId !== undefined) state.requestCompletionReview(latestId);
          appendCommandEntry("自动续跑：收到完成请求，正在复核任务完成情况。", "info");
          updateStatus(ctx);
          return {
            content: [{ type: "text" as const, text: COMPLETION_REVIEW_MESSAGE }],
            details: { active: true, completionReviewRequired: true },
          };
        }
      }

      stop(ctx, params.reason, `Auto-continue stopped (${params.reason}): ${summary}`, undefined, false);
      return {
        content: [{ type: "text" as const, text: `Auto-continue stopped (${params.reason}): ${summary}` }],
        details: { reason: params.reason, summary },
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    if (state.isActive()) ctx.ui.notify(formatStatus(state.getState()), "info");
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_shutdown", async () => {
    runtimeGeneration += 1;
    clearRecoveryTimer();
    providerResponse = undefined;
  });

  pi.on("agent_start", async () => {
    boundaryHandled = false;
    if (state.getState()?.pendingInjection) state.markPendingStarted();
    providerResponse = undefined;
  });

  pi.on("after_provider_response", async (event) => {
    const retryAfterMs = parseRetryAfterMs(event.headers);
    providerResponse = {
      status: event.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
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

  pi.on("agent_before_settle", async (_event, ctx) => {
    // 续跑在 run 仍活动时 queue：sendMessage triggerTurn 的注入被同一 agent run 消费，
    // 不走会先行完结宿主请求的 agent_settled 路径。
    boundaryHandled = true;
    handleSettled(ctx, true);
  });

  pi.on("agent_settled", async (event, ctx) => {
    // 中止的 run 跳过 agent_before_settle；aborted 停机必须在 fallback 判断之前。
    if (event.aborted) {
      stopAborted(ctx);
      return;
    }
    // 无 agent_before_settle 的旧版 Pi 走此 fallback；同轮已被 before_settle 处理则不重复。
    if (boundaryHandled) return;
    handleSettled(ctx);
  });

  pi.registerCommand("autocontinue", {
    description: "Bounded continuation after the agent settles: /autocontinue [attempts]",
    handler: async (args, ctx) => {
      // 参数错误时回显接收到的原始 args（ACP 可见的错误反馈，限控制命令）
      const showUsage = () =>
        showCommandMessage(`${usage()}\nReceived arguments: ${JSON.stringify(args.slice(0, 200))}`, "warning");
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase();

      if (subcommand === "stop") {
        if (parts.length !== 1) {
          showUsage();
          return;
        }
        if (!state.isActive()) {
          showCommandMessage("Auto-continue is not active.");
          return;
        }
        stop(ctx, "command", "Auto-continue stopped.", undefined, false);
        return;
      }

      if (subcommand === "status") {
        if (parts.length !== 1) {
          showUsage();
          return;
        }
        showCommandMessage(formatStatus(state.getState()));
        return;
      }

      const now = subcommand === "now";
      const attemptsValue = now ? parts[1] : parts[0];
      if (parts.length > (now ? 2 : 1)) {
        showUsage();
        return;
      }

      const maxAttempts = parseAttempts(attemptsValue);
      if (maxAttempts === undefined) {
        showUsage();
        return;
      }

      if (now && !ctx.isIdle()) {
        showCommandMessage("Use /autocontinue now when the agent is idle.", "warning");
        return;
      }
      if (now && !hasUserTask(ctx)) {
        showCommandMessage(
          "No user task exists in the current session. Arm auto-continue, then send the task.",
          "warning",
        );
        return;
      }

      clearRecoveryTimer();
      activeTemplate = loadActiveTemplate(ctx);
      const startedFromLeafId = ctx.sessionManager.getLeafId() ?? undefined;
      if (now) {
        state.startNow(maxAttempts, activeTemplate.source, startedFromLeafId);
        setStopToolAvailability();
        updateStatus(ctx);
        showCommandMessage(
          `Auto-continue started for the current workflow (${maxAttempts} successful attempts).`,
          "success",
        );
        dispatchContinuation(ctx);
        return;
      }

      state.arm(maxAttempts, activeTemplate.source, startedFromLeafId);
      setStopToolAvailability();
      updateStatus(ctx);
      showCommandMessage(
        `Auto-continue armed for the next user prompt (${maxAttempts} successful attempts).`,
        "success",
      );
    },
  });
}
