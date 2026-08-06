import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  classifySettledAssistant,
  nextRecoveryDelayMs,
  parseRetryAfterMs,
  RECOVERY_DELAYS_MS,
} from "../src/recovery.js";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "result" }],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

describe("transport recovery classification", () => {
  it("classifies successful and aborted settlements without retry", () => {
    expect(classifySettledAssistant(assistant())).toEqual({ kind: "success" });
    expect(classifySettledAssistant(assistant({ stopReason: "aborted", errorMessage: "Cancelled" }))).toEqual({
      kind: "aborted",
      summary: "Cancelled",
    });
  });

  it("classifies retryable HTTP, provider, and diagnostic evidence as transient", () => {
    expect(
      classifySettledAssistant(
        assistant({ stopReason: "error", errorMessage: "Upstream service temporarily unavailable" }),
        { status: 502 },
      ).kind,
    ).toBe("transient");

    expect(
      classifySettledAssistant(
        assistant({
          stopReason: "error",
          errorMessage: "Provider request failed",
          diagnostics: [
            {
              type: "stream_error",
              timestamp: 1,
              error: { message: "socket connection was closed", code: "ECONNRESET" },
            },
          ],
        }),
      ),
    ).toMatchObject({
      kind: "transient",
      failure: { diagnosticCodes: ["ECONNRESET"] },
    });

    expect(
      classifySettledAssistant(
        assistant({ stopReason: "error", errorMessage: "Provider returned error" }),
        { status: 403 },
      ).kind,
    ).toBe("transient");
    expect(classifySettledAssistant(assistant({ stopReason: "error", errorMessage: "Opaque stream failure" })).kind).toBe(
      "transient",
    );
  });

  it("does not retry definite quota, credential, or context blockers", () => {
    expect(
      classifySettledAssistant(
        assistant({ stopReason: "error", errorMessage: "insufficient_user_quota: account balance exhausted" }),
        { status: 429 },
      ).kind,
    ).toBe("blocked");
    expect(
      classifySettledAssistant(
        assistant({ stopReason: "error", errorMessage: "Invalid API key supplied" }),
        { status: 401 },
      ).kind,
    ).toBe("blocked");
    expect(
      classifySettledAssistant(
        assistant({ stopReason: "error", errorMessage: "Prompt is too long for the maximum context window" }),
      ).kind,
    ).toBe("blocked");
  });

  it("parses and caps Retry-After while preserving the fixed cooldown floor", () => {
    expect(parseRetryAfterMs({ "retry-after-ms": "25000" }, 0)).toBe(25_000);
    expect(parseRetryAfterMs({ "retry-after": "120" }, 0)).toBe(120_000);
    expect(parseRetryAfterMs({ "retry-after": "99999" }, 0)).toBe(600_000);
    expect(parseRetryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:01:00 GMT" }, 0)).toBe(60_000);
    expect(nextRecoveryDelayMs(0, 25_000)).toBe(25_000);
    expect(nextRecoveryDelayMs(1)).toBe(RECOVERY_DELAYS_MS[1]);
    expect(nextRecoveryDelayMs(5, 900_000)).toBe(600_000);
  });
});
