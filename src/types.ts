export const STATE_CUSTOM_TYPE = "autocontinue-state";

export type AutoContinuePhase = "armed" | "running" | "stopped";
export type AutoContinueStopReason =
  | "done"
  | "blocked"
  | "budget_exhausted"
  | "user_input"
  | "command"
  | "error";

export interface AutoContinueState {
  phase: AutoContinuePhase;
  maxAttempts: number;
  attemptsUsed: number;
  startedAt: number;
  templateSource: string;
  stoppedAt?: number;
  stopReason?: AutoContinueStopReason;
  stopSummary?: string;
}

export function isActiveState(state: AutoContinueState | null): state is AutoContinueState {
  return state?.phase === "armed" || state?.phase === "running";
}

export function isValidState(value: unknown): value is AutoContinueState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AutoContinueState>;
  const maxAttempts = candidate.maxAttempts;
  const attemptsUsed = candidate.attemptsUsed;
  if (candidate.phase !== "armed" && candidate.phase !== "running" && candidate.phase !== "stopped") {
    return false;
  }
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    return false;
  }
  if (typeof attemptsUsed !== "number" || !Number.isInteger(attemptsUsed) || attemptsUsed < 0 || attemptsUsed > maxAttempts) {
    return false;
  }
  if (typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt)) return false;
  if (typeof candidate.templateSource !== "string") return false;
  if (candidate.stoppedAt !== undefined && (typeof candidate.stoppedAt !== "number" || !Number.isFinite(candidate.stoppedAt))) {
    return false;
  }
  if (
    candidate.stopReason !== undefined &&
    !["done", "blocked", "budget_exhausted", "user_input", "command", "error"].includes(candidate.stopReason)
  ) {
    return false;
  }
  if (candidate.stopSummary !== undefined && typeof candidate.stopSummary !== "string") return false;
  return true;
}
