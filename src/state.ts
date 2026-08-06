import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AutoContinueState,
  type AutoContinueStopReason,
  isActiveState,
  isValidState,
  STATE_CUSTOM_TYPE,
} from "./types.js";

export class AutoContinueStateManager {
  private state: AutoContinueState | null = null;

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  loadFromSession(ctx: ExtensionContext): void {
    this.state = null;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as any;
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      if (isValidState(entry.data)) {
        this.state = { ...entry.data };
      }
      return;
    }
  }

  getState(): AutoContinueState | null {
    return this.state ? { ...this.state } : null;
  }

  isActive(): boolean {
    return isActiveState(this.state);
  }

  arm(maxAttempts: number, templateSource: string): AutoContinueState {
    this.state = {
      phase: "armed",
      maxAttempts,
      attemptsUsed: 0,
      startedAt: Date.now(),
      templateSource,
    };
    this.persist();
    return this.getState()!;
  }

  startNow(maxAttempts: number, templateSource: string): AutoContinueState {
    this.state = {
      phase: "running",
      maxAttempts,
      attemptsUsed: 0,
      startedAt: Date.now(),
      templateSource,
    };
    this.persist();
    return this.getState()!;
  }

  beginFromUserInput(): boolean {
    if (this.state?.phase !== "armed") return false;
    this.state.phase = "running";
    this.persist();
    return true;
  }

  consumeAttempt(): number | undefined {
    if (this.state?.phase !== "running") return undefined;
    if (this.state.attemptsUsed >= this.state.maxAttempts) return undefined;
    this.state.attemptsUsed += 1;
    this.persist();
    return this.state.attemptsUsed;
  }

  stop(reason: AutoContinueStopReason, summary?: string): AutoContinueState | null {
    if (!this.state || !isActiveState(this.state)) return null;
    this.state.phase = "stopped";
    this.state.stoppedAt = Date.now();
    this.state.stopReason = reason;
    if (summary) this.state.stopSummary = summary;
    this.persist();
    return this.getState();
  }

  private persist(): void {
    if (!this.state) return;
    this.pi.appendEntry(STATE_CUSTOM_TYPE, { ...this.state });
  }
}
