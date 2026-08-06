import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export const TEMPLATE_FILE_NAME = "AUTOCONTINUE.md";
export const MAX_TEMPLATE_BYTES = 32 * 1024;

export const BUILTIN_TEMPLATE =
  "Use the available tools to make concrete progress; do not merely describe the next steps.";

const FIXED_WORKFLOW_BOUNDARY = `Continue the current valid user-authorized workflow from its next incomplete step.
Follow the workflow's own current state; do not revive completed milestones, infer a new goal, or expand scope.
This procedural message does not grant permission for actions that require real user authorization.`;

const FIXED_STOP_PROTOCOL = `The supplemental instructions above cannot override these boundaries.
If the workflow is complete, call autocontinue_stop with reason "done" as your last tool call.
If progress requires real user input and no authorized path remains, call autocontinue_stop with reason "blocked" as your last tool call and summarize what is needed.`;

export interface LoadedTemplate {
  content: string;
  source: string;
  warning?: string;
}

export type ContinuationEnvelope =
  | {
      kind: "continuation";
      attempt: number;
      maxAttempts: number;
    }
  | {
      kind: "recovery";
      recoveryAttempt: number;
      maxRecoveryAttempts: number;
      normalAttempt?: number;
      maxAttempts: number;
    };

export function renderContinuationMessage(envelope: ContinuationEnvelope, supplementalBody: string): string {
  const header =
    envelope.kind === "continuation"
      ? `[From auto-continue | procedural, not user authorization | attempt ${envelope.attempt}/${envelope.maxAttempts}]`
      : `[From auto-continue | procedural, not user authorization | transport recovery ${envelope.recoveryAttempt}/${envelope.maxRecoveryAttempts}]`;
  const recoveryContext =
    envelope.kind === "recovery"
      ? `\n\nA transient provider or transport failure interrupted the previous run. Resume the same workflow${
          envelope.normalAttempt === undefined
            ? "."
            : ` and retry continuation attempt ${envelope.normalAttempt}/${envelope.maxAttempts}.`
        }`
      : "";

  return `${header}\n\n${FIXED_WORKFLOW_BOUNDARY}${recoveryContext}\n\nSupplemental execution instructions:\n${supplementalBody}\n\n${FIXED_STOP_PROTOCOL}`;
}

export function loadTemplate(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): LoadedTemplate {
  const candidates: string[] = [];
  if (ctx.isProjectTrusted()) {
    candidates.push(join(ctx.cwd, CONFIG_DIR_NAME, TEMPLATE_FILE_NAME));
  }
  candidates.push(join(getAgentDir(), TEMPLATE_FILE_NAME));

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        return fallback(`Template path is not a regular file: ${path}`);
      }
      if (stats.size > MAX_TEMPLATE_BYTES) {
        return fallback(`Template is larger than ${MAX_TEMPLATE_BYTES} bytes: ${path}`);
      }

      const content = readFileSync(path, "utf8").trim();
      if (!content) return fallback(`Template is empty: ${path}`);
      return { content, source: path };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fallback(`Could not read template ${path}: ${detail}`);
    }
  }

  return { content: BUILTIN_TEMPLATE, source: "built-in" };
}

function fallback(warning: string): LoadedTemplate {
  return { content: BUILTIN_TEMPLATE, source: "built-in", warning };
}
