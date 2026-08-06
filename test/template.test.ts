import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATE, loadTemplate, MAX_TEMPLATE_BYTES } from "../src/template.js";

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-autocontinue-template-"));
}

describe("loadTemplate", () => {
  it("uses the trusted project template before the global template", () => {
    const cwd = projectDir();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "AUTOCONTINUE.md"), "Project continuation rules");

    const result = loadTemplate({ cwd, isProjectTrusted: () => true });

    expect(result.content).toBe("Project continuation rules");
    expect(result.source).toBe(join(cwd, ".pi", "AUTOCONTINUE.md"));
  });

  it("ignores an untrusted project template", () => {
    const cwd = projectDir();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "AUTOCONTINUE.md"), "Untrusted rules");

    const result = loadTemplate({ cwd, isProjectTrusted: () => false });

    expect(result.content).toBe(BUILTIN_TEMPLATE);
    expect(result.source).toBe("built-in");
  });

  it("falls back when a project template is empty or too large", () => {
    const emptyCwd = projectDir();
    mkdirSync(join(emptyCwd, ".pi"));
    writeFileSync(join(emptyCwd, ".pi", "AUTOCONTINUE.md"), "   \n");
    expect(loadTemplate({ cwd: emptyCwd, isProjectTrusted: () => true })).toMatchObject({
      content: BUILTIN_TEMPLATE,
      source: "built-in",
    });

    const largeCwd = projectDir();
    mkdirSync(join(largeCwd, ".pi"));
    writeFileSync(join(largeCwd, ".pi", "AUTOCONTINUE.md"), "x".repeat(MAX_TEMPLATE_BYTES + 1));
    expect(loadTemplate({ cwd: largeCwd, isProjectTrusted: () => true })).toMatchObject({
      content: BUILTIN_TEMPLATE,
      source: "built-in",
    });
  });
});
