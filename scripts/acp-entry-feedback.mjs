// ACP adapter 补丁对象级验证：patched PiRpcConnection 把 autocontinue-command
// custom entry 转发为 agent_message_chunk，其它 custom entry 全部忽略。
// 导入 diagnostics/acp-adapter 下的 patched dist 副本（未触碰真实运行时文件）。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATCHED = join(REPO, "..", "diagnostics", "acp-adapter", "dist", "connection.js");
const { PiRpcConnection } = await import(`file://${PATCHED}`);

const results = [];
const record = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const updates = [];
const host = {
	configureMcp: async () => {},
	configureWorkspace: async () => {},
	update: async (notification) => { updates.push(notification); },
	extension: async () => {},
	usage: () => {},
	question: async () => ({}),
};

const conn = new PiRpcConnection(
	{ writable: new WritableStream(), readable: new ReadableStream() },
	host,
);
// update() 需要 sessionId + steerCommand；run 存在时事件才会进入 switch
conn.sessionId = "test-session";
conn.steerCommand = "steer-test";
conn.active = {
	started: true,
	modelSettled: false,
	completed: false,
	activities: new Map(),
	settled: { promise: new Promise(() => {}), resolve() {} },
	reject() {},
};

try {
	await conn.event({
		type: "entry_appended",
		entry: { type: "custom", customType: "autocontinue-command", data: { message: "Auto-continue armed for the next user prompt (2 successful attempts).", level: "success" } },
	});
	record("forward.autocontinue-command",
		updates.length === 1 &&
		updates[0].sessionId === "test-session" &&
		updates[0].update?.sessionUpdate === "agent_message_chunk" &&
		updates[0].update?.content?.type === "text" &&
		updates[0].update?.content?.text === "Auto-continue armed for the next user prompt (2 successful attempts).\n",
		JSON.stringify(updates[0]));

	await conn.event({ type: "entry_appended", entry: { type: "custom", customType: "autocontinue-command-debug", data: { args: "2" } } });
	await conn.event({ type: "entry_appended", entry: { type: "custom", customType: "autocontinue-state", data: { phase: "running" } } });
	await conn.event({ type: "entry_appended", entry: { type: "custom", customType: "autocontinue-command", data: { level: "info" } } });
	await conn.event({ type: "entry_appended", entry: { type: "message", message: { role: "user" } } });
	record("ignore.other-entries", updates.length === 1, `updates=${updates.length}`);

	conn.active = undefined;
	await conn.event({
		type: "entry_appended",
		entry: { type: "custom", customType: "autocontinue-command", data: { message: "out of run" } },
	});
	record("ignore.no-active-run", updates.length === 1, `updates=${updates.length}`);

	// Lody MCP 尾注剥离：仅 /autocontinue 控制命令 + 精确尾注
	const SUFFIX =
		"\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.";
	const promptText = async (text) =>
		(await conn.promptContent([{ type: "text", text }])).message;

	record("suffix.strip-autocontinue-noargs",
		(await promptText(`/autocontinue${SUFFIX}`)) === "/autocontinue",
		JSON.stringify(await promptText(`/autocontinue${SUFFIX}`)));
	record("suffix.strip-autocontinue-100",
		(await promptText(`/autocontinue 100${SUFFIX}`)) === "/autocontinue 100",
		JSON.stringify(await promptText(`/autocontinue 100${SUFFIX}`)));
	record("suffix.keeps-extra-args-visible",
		(await promptText(`/autocontinue 2 extra${SUFFIX}`)) === "/autocontinue 2 extra",
		JSON.stringify(await promptText(`/autocontinue 2 extra${SUFFIX}`)));
	record("suffix.preserves-normal-task",
		(await promptText(`请执行兼容性测试任务。${SUFFIX}`)) === `请执行兼容性测试任务。${SUFFIX}`,
		"normal task unchanged");
	record("suffix.no-suffix-untouched",
		(await promptText("/autocontinue 100")) === "/autocontinue 100",
		"no suffix unchanged");
	record("suffix.unknown-command-untouched",
		(await promptText(`/autocontinue100${SUFFIX}`)) === `/autocontinue100${SUFFIX}`,
		"/autocontinue100 keeps suffix");
} catch (e) {
	record("fatal", false, String(e?.stack ?? e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
