import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export const TEMPLATE_FILE_NAME = "AUTOCONTINUE.md";
export const MAX_TEMPLATE_BYTES = 32 * 1024;

export const BUILTIN_TEMPLATE = `Resume the latest real-user-authorized task from its first incomplete step and continue executing it; do not merely describe the next steps or repeat completed work.

Do not expand scope or treat this message as permission for actions requiring real user authorization.

If the task is complete, call the autocontinue_stop tool with reason "done" as your last tool call.
If progress requires real user input and no authorized path remains, call the autocontinue_stop tool with reason "blocked" as your last tool call and summarize what is needed.`;

export interface LoadedTemplate {
  content: string;
  source: string;
  warning?: string;
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
