import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AutoContinueFailure } from "./types.js";

export const RECOVERY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const;

const MAX_FAILURE_SUMMARY_LENGTH = 1000;
const MAX_RETRY_AFTER_MS = RECOVERY_DELAYS_MS.at(-1)!;
const DEFINITE_USER_BLOCKER =
  /insufficient[ _](?:user[ _])?quota|quota (?:is )?(?:exceeded|exhausted)|out of (?:budget|credits?)|billing|account balance|available balance|remaining quota|preauthori[sz]ation|invalid(?:_| )api(?:_| )key|no api key|authentication failed|model[_ ]not[_ ]found|does not exist or you do not have access/i;
const CONTEXT_OR_REQUEST_BLOCKER =
  /context (?:length|window)|maximum context|prompt is too long|too many tokens|content policy|safety policy|invalid request/i;

export interface ProviderResponseSnapshot {
  status: number;
  retryAfterMs?: number;
}

export type SettledOutcome =
  | { kind: "success" }
  | { kind: "transient"; failure: AutoContinueFailure }
  | { kind: "blocked"; failure: AutoContinueFailure }
  | { kind: "aborted"; summary: string };

function boundedSummary(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_FAILURE_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_FAILURE_SUMMARY_LENGTH - 3)}...`;
}

function diagnosticEvidence(message: AssistantMessage): { text: string; codes: string[] } {
  const parts: string[] = [];
  const codes = new Set<string>();
  for (const diagnostic of message.diagnostics ?? []) {
    parts.push(diagnostic.type);
    if (diagnostic.error?.message) parts.push(diagnostic.error.message);
    if (diagnostic.error?.code !== undefined) codes.add(String(diagnostic.error.code));
    if (diagnostic.details) {
      try {
        parts.push(JSON.stringify(diagnostic.details));
      } catch {
        parts.push("unserializable diagnostics");
      }
    }
  }
  return { text: parts.join("\n"), codes: [...codes] };
}

function failureFrom(
  category: AutoContinueFailure["category"],
  message: AssistantMessage,
  providerResponse?: ProviderResponseSnapshot,
): AutoContinueFailure {
  const diagnostics = diagnosticEvidence(message);
  const summary = boundedSummary(
    message.errorMessage || diagnostics.text || message.rawStopReason || `Assistant stopped with ${message.stopReason}`,
  );
  return {
    category,
    summary,
    stopReason: message.stopReason,
    ...(providerResponse === undefined ? {} : { httpStatus: providerResponse.status }),
    ...(providerResponse?.retryAfterMs === undefined ? {} : { retryAfterMs: providerResponse.retryAfterMs }),
    ...(diagnostics.codes.length === 0 ? {} : { diagnosticCodes: diagnostics.codes }),
  };
}

export function classifySettledAssistant(
  message: AssistantMessage,
  providerResponse?: ProviderResponseSnapshot,
  contextWindow?: number,
): SettledOutcome {
  if (message.stopReason === "aborted") {
    return { kind: "aborted", summary: boundedSummary(message.errorMessage || "Assistant run was aborted.") };
  }
  if (message.stopReason !== "error") return { kind: "success" };

  const diagnostics = diagnosticEvidence(message);
  const evidence = [message.errorMessage, message.rawStopReason, diagnostics.text].filter(Boolean).join("\n");
  if (isContextOverflow(message, contextWindow) || CONTEXT_OR_REQUEST_BLOCKER.test(evidence)) {
    return { kind: "blocked", failure: failureFrom("blocked", message, providerResponse) };
  }
  if (DEFINITE_USER_BLOCKER.test(evidence)) {
    return { kind: "blocked", failure: failureFrom("blocked", message, providerResponse) };
  }

  const syntheticMessage = evidence === message.errorMessage ? message : { ...message, errorMessage: evidence };
  const transientStatus =
    providerResponse !== undefined &&
    (providerResponse.status === 408 ||
      providerResponse.status === 425 ||
      providerResponse.status === 429 ||
      providerResponse.status >= 500);
  if (isRetryableAssistantError(syntheticMessage) || transientStatus) {
    return { kind: "transient", failure: failureFrom("transient", message, providerResponse) };
  }

  return { kind: "transient", failure: failureFrom("transient", message, providerResponse) };
}

export function transientDispatchFailure(summary: string): AutoContinueFailure {
  return { category: "transient", summary: boundedSummary(summary), stopReason: "dispatch_error" };
}

export function parseRetryAfterMs(headers: Record<string, string>, now = Date.now()): number | undefined {
  const retryAfterMsValue = headers["retry-after-ms"];
  if (retryAfterMsValue !== undefined) {
    const milliseconds = Number.parseFloat(retryAfterMsValue);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
  }

  const retryAfterValue = headers["retry-after"];
  if (retryAfterValue === undefined) return undefined;
  const seconds = Number.parseFloat(retryAfterValue);
  const milliseconds = Number.isNaN(seconds) ? Date.parse(retryAfterValue) - now : seconds * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
}

export function nextRecoveryDelayMs(recoveryAttemptsUsed: number, retryAfterMs?: number): number {
  const baseDelay = RECOVERY_DELAYS_MS[Math.min(recoveryAttemptsUsed, RECOVERY_DELAYS_MS.length - 1)];
  return Math.min(Math.max(baseDelay, retryAfterMs ?? 0), MAX_RETRY_AFTER_MS);
}
