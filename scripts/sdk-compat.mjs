// 真实 SDK 集成验证：本仓库 src/index.ts（pi-autocontinue fork）
// 在本机 @earendil-works/pi-coding-agent 下的加载与续跑/停止行为。
// 零网络：fetch 拒绝 + registerProvider streamSimple mock，不发真实模型请求。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = import.meta.resolve("@earendil-works/pi-coding-agent");
const PIAI = import.meta.resolve("@earendil-works/pi-ai");
const EXT = join(REPO, "src", "index.ts");

globalThis.fetch = () => Promise.reject(new Error("network disabled in compat test"));

const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	ModelRuntime,
} = await import(SDK);
const { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } = await import(PIAI);

const results = [];
function record(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

// 脚本化响应：{text} 纯文本 stop；{tool:{reason,summary}} 一次 autocontinue_stop 调用
function makeMock(script, maxCalls) {
	const calls = [];
	const streamSimple = (model, context, options) => {
		const n = calls.length + 1;
		const ctxText = JSON.stringify(context?.messages ?? []);
		const lastMsg = [...(context?.messages ?? [])].reverse().find((m) => m?.role !== "toolResult");
		const lastText =
			typeof lastMsg?.content === "string"
				? lastMsg.content
				: (lastMsg?.content ?? [])
						.filter((p) => p?.type === "text")
						.map((p) => p.text)
						.join("\n");
		calls.push({
			n,
			hasAutocontinuePrompt: ctxText.includes("autocontinue-prompt"),
			hasAutoContinueText: ctxText.includes("auto-continue"),
			lastRole: lastMsg?.role,
			lastText: (lastText ?? "").slice(0, 120),
		});
		if (n > maxCalls) throw new Error(`unexpected model request #${n}`);
		const step = script[n - 1] ?? script[script.length - 1];
		const stream = createAssistantMessageEventStream();
		setImmediate(() => {
			const partial = (msg) => ({ ...msg, content: [], stopReason: "pending" });
			if (step.tool) {
				const block = fauxToolCall("autocontinue_stop", step.tool);
				const message = fauxAssistantMessage(block, { stopReason: "toolUse" });
				const p = partial(message);
				stream.push({ type: "start", partial: p });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: p });
				stream.push({
					type: "toolcall_delta", contentIndex: 0,
					delta: JSON.stringify(step.tool), partial: p,
				});
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: p });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const text = step.text;
				const message = fauxAssistantMessage(text, { stopReason: "stop" });
				const p = partial(message);
				stream.push({ type: "start", partial: p });
				stream.push({ type: "text_start", contentIndex: 0, partial: p });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: p });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: p });
				stream.push({ type: "done", reason: "stop", message });
			}
		});
		return stream;
	};
	return { calls, streamSimple };
}

async function makeSession(mock) {
	const base = mkdtempSync(join(tmpdir(), "ac-compat-"));
	const cwd = join(base, "ws");
	const agentDir = join(base, "agent");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("compat-mock", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "compat-local-only",
		models: [{
			id: "compat-model-1", name: "Compat Mock", input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false, contextWindow: 128000, maxTokens: 8192,
		}],
		streamSimple: mock.streamSimple,
	});
	const model = modelRuntime.getModel("compat-mock", "compat-model-1");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [EXT],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd, agentDir, modelRuntime, model,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager, resourceLoader,
	});
	const extErrors = [];
	const state = { settles: 0 };
	const unsub = session.subscribe((event) => {
		if (event.type === "extension_error") extErrors.push(JSON.stringify(event));
		if (event.type === "agent_settled") state.settles += 1;
	});
	await session.bindExtensions({ onError: (e) => extErrors.push(`onError:${e?.event}:${e?.error}`) });
	const dispositions = [];
	const prompt = (text) =>
		session.prompt(text, {
			expandPromptTemplates: true,
			preflightResult: (d) => dispositions.push(`${text.slice(0, 30)}→${d}`),
		});
	const waitFor = (cond, label) =>
		new Promise((res, rej) => {
			const deadline = Date.now() + 5000;
			const tick = () => {
				if (cond()) return res();
				if (Date.now() > deadline) return rej(new Error(`waitFor timeout: ${label}`));
				setImmediate(tick);
			};
			tick();
		});
	const drain = (ticks = 10) =>
		new Promise((res) => { const s = () => (ticks-- <= 0 ? res() : setImmediate(s)); s(); });
	const lastAutoContinueState = () => {
		const entries = session.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === "autocontinue-state");
		const last = entries[entries.length - 1];
		if (!last) return undefined;
		return typeof last.data === "string" ? JSON.parse(last.data) : last.data;
	};
	return {
		session, extensionsResult, extErrors, state, dispositions, prompt,
		waitFor, drain, lastAutoContinueState, cleanup: () => unsub(),
	};
}

// 用例1+2+3：/autocontinue 2 → 任务 → 第2请求含续跑提示 → done 工具停止
async function caseArmDone() {
	console.log("\n=== CASE arm+done: /autocontinue 2, 文本回复, autocontinue_stop done ===");
	const mock = makeMock([{ text: "我会开始调查。" }, { tool: { reason: "done", summary: "调查完成。" } }], 2);
	const t = await makeSession(mock);
	try {
		record("arm.load-errors", t.extensionsResult.errors.length === 0, JSON.stringify(t.extensionsResult.errors));
		await t.prompt("/autocontinue 2");
		record("arm.command-handled", t.dispositions[0]?.endsWith("→handled") === true, t.dispositions[0]);
		record("arm.no-model-call", mock.calls.length === 0, `calls=${mock.calls.length}`);
		await t.prompt("请执行兼容性测试任务。");
		await t.waitFor(() => mock.calls.length >= 2, "2 model calls");
		await t.waitFor(() => t.state.settles >= 2 && t.session.isIdle, "settled+idle");
		await t.drain();
		record("done.calls==2", mock.calls.length === 2,
			JSON.stringify(mock.calls.map((c) => ({ n: c.n, act: c.hasAutoContinueText, role: c.lastRole }))));
		record("done.2nd-context-marker", mock.calls[1]?.hasAutoContinueText === true,
			`customTypeInCtx=${mock.calls[1]?.hasAutocontinuePrompt} lastRole=${mock.calls[1]?.lastRole} lastText=${JSON.stringify(mock.calls[1]?.lastText)}`);
		const st = t.lastAutoContinueState();
		record("done.state-stopped-done",
			st?.phase === "stopped" && st?.stopReason === "done",
			`phase=${st?.phase} stopReason=${st?.stopReason} attemptsUsed=${st?.attemptsUsed}`);
		record("done.no-extension-error", t.extErrors.length === 0, JSON.stringify(t.extErrors));
	} finally { t.cleanup(); await t.session.dispose(); }
}

// 用例4：max=1 → 初始+1次续跑 → budget_exhausted 持久化
async function caseBudget() {
	console.log("\n=== CASE budget: /autocontinue 1, 两轮文本回复 ===");
	const mock = makeMock([{ text: "第一步完成。" }, { text: "第二步完成。" }], 3);
	const t = await makeSession(mock);
	try {
		await t.prompt("/autocontinue 1");
		await t.prompt("请执行兼容性测试任务。");
		await t.waitFor(() => mock.calls.length >= 2, "2 model calls");
		await t.waitFor(() => t.state.settles >= 2 && t.session.isIdle, "settled+idle");
		await t.drain();
		record("budget.calls==2", mock.calls.length === 2, JSON.stringify(mock.calls.map((c) => c.n)));
		const st = t.lastAutoContinueState();
		record("budget.state-stopped-budget_exhausted",
			st?.phase === "stopped" && st?.stopReason === "budget_exhausted" && st?.attemptsUsed === 1,
			`phase=${st?.phase} stopReason=${st?.stopReason} attemptsUsed=${st?.attemptsUsed} maxAttempts=${st?.maxAttempts}`);
		record("budget.no-extension-error", t.extErrors.length === 0, JSON.stringify(t.extErrors));
	} finally { t.cleanup(); await t.session.dispose(); }
}

// 用例5：blocked 工具停止
async function caseBlocked() {
	console.log("\n=== CASE blocked: /autocontinue 1, 首轮即 blocked ===");
	const mock = makeMock([{ tool: { reason: "blocked", summary: "需要用户提供凭证。" } }], 1);
	const t = await makeSession(mock);
	try {
		await t.prompt("/autocontinue 1");
		await t.prompt("请执行兼容性测试任务。");
		await t.waitFor(() => t.state.settles >= 1 && t.session.isIdle, "settled+idle");
		await t.drain();
		record("blocked.calls==1", mock.calls.length === 1, JSON.stringify(mock.calls.map((c) => c.n)));
		const st = t.lastAutoContinueState();
		record("blocked.state-stopped-blocked",
			st?.phase === "stopped" && st?.stopReason === "blocked",
			`phase=${st?.phase} stopReason=${st?.stopReason}`);
		record("blocked.no-extension-error", t.extErrors.length === 0, JSON.stringify(t.extErrors));
	} finally { t.cleanup(); await t.session.dispose(); }
}

for (const [name, fn] of [["armDone", caseArmDone], ["budget", caseBudget], ["blocked", caseBlocked]]) {
	try { await fn(); } catch (e) { record(`${name}.fatal`, false, String(e?.stack ?? e)); }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
