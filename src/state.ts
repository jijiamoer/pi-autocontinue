import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AutoContinueFailure,
  type AutoContinueState,
  type AutoContinueStopReason,
  isActiveState,
  MAX_RECOVERY_ATTEMPTS,
  type PendingInjection,
  parseAutoContinueState,
  STATE_CUSTOM_TYPE,
  STATE_VERSION,
} from "./types.js";

interface StateManagerOptions {
  now?: () => number;
  createId?: () => string;
}

function cloneState(state: AutoContinueState): AutoContinueState {
  return {
    ...state,
    ...(state.pendingInjection === undefined ? {} : { pendingInjection: { ...state.pendingInjection } }),
    ...(state.lastFailure === undefined
      ? {}
      : {
          lastFailure: {
            ...state.lastFailure,
            ...(state.lastFailure.diagnosticCodes === undefined
              ? {}
              : { diagnosticCodes: [...state.lastFailure.diagnosticCodes] }),
          },
        }),
  };
}

export class AutoContinueStateManager {
  private state: AutoContinueState | null = null;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    options: StateManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  loadFromSession(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.state = null;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as any;
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      const parsed = parseAutoContinueState(entry.data);
      if (parsed) this.state = parsed;
      return;
    }
  }

  getState(): AutoContinueState | null {
    return this.state ? cloneState(this.state) : null;
  }

  isActive(): boolean {
    return isActiveState(this.state);
  }

  arm(maxAttempts: number, templateSource: string, startedFromLeafId?: string): AutoContinueState {
    return this.start("armed", maxAttempts, templateSource, startedFromLeafId);
  }

  startNow(maxAttempts: number, templateSource: string, startedFromLeafId?: string): AutoContinueState {
    return this.start("running", maxAttempts, templateSource, startedFromLeafId);
  }

  beginFromUserInput(): boolean {
    if (this.state?.phase !== "armed") return false;
    this.state.phase = "running";
    this.persist();
    return true;
  }

  reserveContinuation(sourceSettlementId?: string): PendingInjection | undefined {
    if (
      this.state?.phase !== "running" ||
      this.state.pendingInjection !== undefined ||
      this.state.retryAt !== undefined ||
      this.state.reservedNormalAttempt !== undefined ||
      this.state.attemptsUsed >= this.state.maxAttempts
    ) {
      return undefined;
    }

    const pending: PendingInjection = {
      id: this.createId(),
      kind: "continuation",
      requestedAt: this.now(),
      normalAttempt: this.state.attemptsUsed + 1,
      ...(sourceSettlementId === undefined ? {} : { sourceSettlementId }),
    };
    this.state.pendingInjection = pending;
    this.persist();
    return { ...pending };
  }

  reserveRecovery(sourceSettlementId?: string): PendingInjection | undefined {
    if (
      this.state?.phase !== "running" ||
      this.state.pendingInjection !== undefined ||
      this.state.retryAt === undefined ||
      this.state.retryAt > this.now() ||
      this.state.recoveryAttemptsUsed >= MAX_RECOVERY_ATTEMPTS
    ) {
      return undefined;
    }

    this.state.recoveryAttemptsUsed += 1;
    const pending: PendingInjection = {
      id: this.createId(),
      kind: "recovery",
      requestedAt: this.now(),
      recoveryAttempt: this.state.recoveryAttemptsUsed,
      ...(this.state.reservedNormalAttempt === undefined
        ? {}
        : { normalAttempt: this.state.reservedNormalAttempt }),
      ...(sourceSettlementId === undefined ? {} : { sourceSettlementId }),
    };
    this.state.pendingInjection = pending;
    this.state.retryAt = undefined;
    this.persist();
    return { ...pending };
  }

  markPendingStarted(): boolean {
    if (!this.state?.pendingInjection || this.state.pendingInjection.started === true) return false;
    this.state.pendingInjection.started = true;
    this.persist();
    return true;
  }

  recordSuccessfulSettlement(settlementId: string): AutoContinueState | null {
    if (this.state?.phase !== "running") return null;
    const normalAttempt = this.state.pendingInjection?.normalAttempt ?? this.state.reservedNormalAttempt;
    if (normalAttempt !== undefined) {
      this.state.attemptsUsed = Math.max(this.state.attemptsUsed, normalAttempt);
    }
    this.state.pendingInjection = undefined;
    this.state.reservedNormalAttempt = undefined;
    this.state.retryAt = undefined;
    this.state.lastFailure = undefined;
    this.state.recoveryAttemptsUsed = 0;
    this.state.lastHandledSettlementId = settlementId;
    this.persist();
    return this.getState();
  }

  recordTransientFailure(
    settlementId: string | undefined,
    failure: AutoContinueFailure,
    retryAt: number,
  ): AutoContinueState | null {
    if (this.state?.phase !== "running") return null;
    const normalAttempt = this.state.pendingInjection?.normalAttempt ?? this.state.reservedNormalAttempt;
    this.state.pendingInjection = undefined;
    this.state.reservedNormalAttempt = normalAttempt;
    this.state.retryAt = retryAt;
    this.state.lastFailure = {
      ...failure,
      ...(failure.diagnosticCodes === undefined ? {} : { diagnosticCodes: [...failure.diagnosticCodes] }),
    };
    if (settlementId !== undefined) this.state.lastHandledSettlementId = settlementId;
    this.persist();
    return this.getState();
  }

  stop(
    reason: AutoContinueStopReason,
    summary?: string,
    failure?: AutoContinueFailure,
  ): AutoContinueState | null {
    if (!this.state || !isActiveState(this.state)) return null;
    this.state.phase = "stopped";
    this.state.stoppedAt = this.now();
    this.state.stopReason = reason;
    if (summary) this.state.stopSummary = summary;
    this.state.pendingInjection = undefined;
    this.state.reservedNormalAttempt = undefined;
    this.state.retryAt = undefined;
    if (failure) {
      this.state.lastFailure = {
        ...failure,
        ...(failure.diagnosticCodes === undefined ? {} : { diagnosticCodes: [...failure.diagnosticCodes] }),
      };
    }
    this.persist();
    return this.getState();
  }

  private start(
    phase: "armed" | "running",
    maxAttempts: number,
    templateSource: string,
    startedFromLeafId?: string,
  ): AutoContinueState {
    this.state = {
      version: STATE_VERSION,
      cycleId: this.createId(),
      phase,
      maxAttempts,
      attemptsUsed: 0,
      recoveryAttemptsUsed: 0,
      startedAt: this.now(),
      templateSource,
      ...(startedFromLeafId === undefined ? {} : { startedFromLeafId }),
    };
    this.persist();
    return this.getState()!;
  }

  private persist(): void {
    if (!this.state) return;
    this.pi.appendEntry(STATE_CUSTOM_TYPE, cloneState(this.state));
  }
}
