export const STATE_CUSTOM_TYPE = "autocontinue-state";
export const STATE_VERSION = 2;
export const MAX_RECOVERY_ATTEMPTS = 6;

export type AutoContinuePhase = "armed" | "running" | "stopped";
export type AutoContinueStopReason =
  | "done"
  | "blocked"
  | "budget_exhausted"
  | "recovery_exhausted"
  | "aborted"
  | "user_input"
  | "command"
  | "error";

export type AutoContinueInjectionKind = "continuation" | "recovery";

export interface AutoContinueFailure {
  category: "transient" | "blocked";
  summary: string;
  stopReason?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  diagnosticCodes?: string[];
}

export interface PendingInjection {
  id: string;
  kind: AutoContinueInjectionKind;
  requestedAt: number;
  sourceSettlementId?: string;
  normalAttempt?: number;
  recoveryAttempt?: number;
  started?: boolean;
}

export interface AutoContinueState {
  version: typeof STATE_VERSION;
  cycleId: string;
  phase: AutoContinuePhase;
  maxAttempts: number;
  attemptsUsed: number;
  recoveryAttemptsUsed: number;
  startedAt: number;
  startedFromLeafId?: string;
  templateSource: string;
  lastHandledSettlementId?: string;
  pendingInjection?: PendingInjection;
  reservedNormalAttempt?: number;
  retryAt?: number;
  lastFailure?: AutoContinueFailure;
  stoppedAt?: number;
  stopReason?: AutoContinueStopReason;
  stopSummary?: string;
}

const STOP_REASONS: readonly AutoContinueStopReason[] = [
  "done",
  "blocked",
  "budget_exhausted",
  "recovery_exhausted",
  "aborted",
  "user_input",
  "command",
  "error",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isOptionalId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 200);
}

function parseFailure(value: unknown): AutoContinueFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AutoContinueFailure>;
  if (candidate.category !== "transient" && candidate.category !== "blocked") return undefined;
  if (typeof candidate.summary !== "string" || candidate.summary.length === 0 || candidate.summary.length > 2000) {
    return undefined;
  }
  if (candidate.stopReason !== undefined && typeof candidate.stopReason !== "string") return undefined;
  if (candidate.httpStatus !== undefined && !isBoundedInteger(candidate.httpStatus, 100, 599)) return undefined;
  if (candidate.retryAfterMs !== undefined && (!isFiniteNumber(candidate.retryAfterMs) || candidate.retryAfterMs < 0)) {
    return undefined;
  }
  if (
    candidate.diagnosticCodes !== undefined &&
    (!Array.isArray(candidate.diagnosticCodes) ||
      candidate.diagnosticCodes.some((code) => typeof code !== "string" || code.length === 0 || code.length > 200))
  ) {
    return undefined;
  }
  return {
    category: candidate.category,
    summary: candidate.summary,
    ...(candidate.stopReason === undefined ? {} : { stopReason: candidate.stopReason }),
    ...(candidate.httpStatus === undefined ? {} : { httpStatus: candidate.httpStatus }),
    ...(candidate.retryAfterMs === undefined ? {} : { retryAfterMs: candidate.retryAfterMs }),
    ...(candidate.diagnosticCodes === undefined ? {} : { diagnosticCodes: [...candidate.diagnosticCodes] }),
  };
}

function parsePending(
  value: unknown,
  maxAttempts: number,
  attemptsUsed: number,
  recoveryAttemptsUsed: number,
): PendingInjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PendingInjection>;
  if (!isOptionalId(candidate.id) || candidate.id === undefined) return undefined;
  if (candidate.kind !== "continuation" && candidate.kind !== "recovery") return undefined;
  if (!isFiniteNumber(candidate.requestedAt)) return undefined;
  if (!isOptionalId(candidate.sourceSettlementId)) return undefined;
  if (
    candidate.normalAttempt !== undefined &&
    (!isBoundedInteger(candidate.normalAttempt, 1, maxAttempts) || candidate.normalAttempt <= attemptsUsed)
  ) {
    return undefined;
  }
  if (candidate.kind === "continuation") {
    if (candidate.normalAttempt === undefined || candidate.recoveryAttempt !== undefined) return undefined;
  } else if (
    !isBoundedInteger(candidate.recoveryAttempt, 1, MAX_RECOVERY_ATTEMPTS) ||
    candidate.recoveryAttempt !== recoveryAttemptsUsed
  ) {
    return undefined;
  }
  if (candidate.started !== undefined && typeof candidate.started !== "boolean") return undefined;
  return {
    id: candidate.id,
    kind: candidate.kind,
    requestedAt: candidate.requestedAt,
    ...(candidate.sourceSettlementId === undefined ? {} : { sourceSettlementId: candidate.sourceSettlementId }),
    ...(candidate.normalAttempt === undefined ? {} : { normalAttempt: candidate.normalAttempt }),
    ...(candidate.recoveryAttempt === undefined ? {} : { recoveryAttempt: candidate.recoveryAttempt }),
    ...(candidate.started === undefined ? {} : { started: candidate.started }),
  };
}

function parseCurrentState(candidate: Record<string, unknown>): AutoContinueState | undefined {
  if (candidate.version !== STATE_VERSION) return undefined;
  if (!isOptionalId(candidate.cycleId) || candidate.cycleId === undefined) return undefined;
  if (candidate.phase !== "armed" && candidate.phase !== "running" && candidate.phase !== "stopped") return undefined;
  if (!isBoundedInteger(candidate.maxAttempts, 1, 100)) return undefined;
  if (!isBoundedInteger(candidate.attemptsUsed, 0, candidate.maxAttempts)) return undefined;
  if (!isBoundedInteger(candidate.recoveryAttemptsUsed, 0, MAX_RECOVERY_ATTEMPTS)) return undefined;
  if (!isFiniteNumber(candidate.startedAt)) return undefined;
  if (!isOptionalId(candidate.startedFromLeafId)) return undefined;
  if (typeof candidate.templateSource !== "string") return undefined;
  if (!isOptionalId(candidate.lastHandledSettlementId)) return undefined;
  if (candidate.stoppedAt !== undefined && !isFiniteNumber(candidate.stoppedAt)) return undefined;
  if (candidate.stopReason !== undefined && !STOP_REASONS.includes(candidate.stopReason as AutoContinueStopReason)) {
    return undefined;
  }
  if (candidate.stopSummary !== undefined && typeof candidate.stopSummary !== "string") return undefined;
  if (candidate.retryAt !== undefined && (!isFiniteNumber(candidate.retryAt) || candidate.retryAt < 0)) return undefined;
  if (
    candidate.reservedNormalAttempt !== undefined &&
    (!isBoundedInteger(candidate.reservedNormalAttempt, 1, candidate.maxAttempts) ||
      candidate.reservedNormalAttempt <= candidate.attemptsUsed)
  ) {
    return undefined;
  }

  const pendingInjection =
    candidate.pendingInjection === undefined
      ? undefined
      : parsePending(
          candidate.pendingInjection,
          candidate.maxAttempts,
          candidate.attemptsUsed,
          candidate.recoveryAttemptsUsed,
        );
  if (candidate.pendingInjection !== undefined && pendingInjection === undefined) return undefined;
  const lastFailure = candidate.lastFailure === undefined ? undefined : parseFailure(candidate.lastFailure);
  if (candidate.lastFailure !== undefined && lastFailure === undefined) return undefined;
  if (pendingInjection !== undefined && candidate.retryAt !== undefined) return undefined;
  if (candidate.phase === "stopped" && (pendingInjection !== undefined || candidate.retryAt !== undefined)) return undefined;

  return {
    version: STATE_VERSION,
    cycleId: candidate.cycleId,
    phase: candidate.phase,
    maxAttempts: candidate.maxAttempts,
    attemptsUsed: candidate.attemptsUsed,
    recoveryAttemptsUsed: candidate.recoveryAttemptsUsed,
    startedAt: candidate.startedAt,
    templateSource: candidate.templateSource,
    ...(candidate.startedFromLeafId === undefined ? {} : { startedFromLeafId: candidate.startedFromLeafId }),
    ...(candidate.lastHandledSettlementId === undefined
      ? {}
      : { lastHandledSettlementId: candidate.lastHandledSettlementId }),
    ...(pendingInjection === undefined ? {} : { pendingInjection }),
    ...(candidate.reservedNormalAttempt === undefined
      ? {}
      : { reservedNormalAttempt: candidate.reservedNormalAttempt }),
    ...(candidate.retryAt === undefined ? {} : { retryAt: candidate.retryAt }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(candidate.stoppedAt === undefined ? {} : { stoppedAt: candidate.stoppedAt }),
    ...(candidate.stopReason === undefined ? {} : { stopReason: candidate.stopReason as AutoContinueStopReason }),
    ...(candidate.stopSummary === undefined ? {} : { stopSummary: candidate.stopSummary as string }),
  };
}

function parseLegacyState(candidate: Record<string, unknown>): AutoContinueState | undefined {
  if (candidate.version !== undefined) return undefined;
  if (candidate.phase !== "armed" && candidate.phase !== "running" && candidate.phase !== "stopped") return undefined;
  if (!isBoundedInteger(candidate.maxAttempts, 1, 100)) return undefined;
  if (!isBoundedInteger(candidate.attemptsUsed, 0, candidate.maxAttempts)) return undefined;
  if (!isFiniteNumber(candidate.startedAt)) return undefined;
  if (typeof candidate.templateSource !== "string") return undefined;
  if (candidate.stoppedAt !== undefined && !isFiniteNumber(candidate.stoppedAt)) return undefined;
  if (candidate.stopReason !== undefined && !STOP_REASONS.includes(candidate.stopReason as AutoContinueStopReason)) {
    return undefined;
  }
  if (candidate.stopSummary !== undefined && typeof candidate.stopSummary !== "string") return undefined;

  return {
    version: STATE_VERSION,
    cycleId: `legacy-${candidate.startedAt.toString(36)}`,
    phase: candidate.phase,
    maxAttempts: candidate.maxAttempts,
    attemptsUsed: candidate.attemptsUsed,
    recoveryAttemptsUsed: 0,
    startedAt: candidate.startedAt,
    templateSource: candidate.templateSource,
    ...(candidate.stoppedAt === undefined ? {} : { stoppedAt: candidate.stoppedAt }),
    ...(candidate.stopReason === undefined ? {} : { stopReason: candidate.stopReason as AutoContinueStopReason }),
    ...(candidate.stopSummary === undefined ? {} : { stopSummary: candidate.stopSummary as string }),
  };
}

export function parseAutoContinueState(value: unknown): AutoContinueState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return parseCurrentState(candidate) ?? parseLegacyState(candidate);
}

export function isActiveState(state: AutoContinueState | null): state is AutoContinueState {
  return state?.phase === "armed" || state?.phase === "running";
}

export function isValidState(value: unknown): value is AutoContinueState {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== STATE_VERSION) return false;
  return parseCurrentState(value as Record<string, unknown>) !== undefined;
}
