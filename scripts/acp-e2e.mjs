// ACP e2e：真实 adapter（node dist/index.js）+ 真实 Pi 子进程 + mock provider。
// 隔离：PI_CODING_AGENT_DIR / cwd / mock 日志均在 /tmp 独立目录；零上游模型请求。
// 环境：PI_ACP_PACKAGE_ROOT 指定 adapter 包根（含 dist/ 与 node_modules/）；
// 未提供时经本仓库 node_modules 解析 @earendil-works/pi-coding-agent 上溯推断。
// 用法：PI_ACP_PACKAGE_ROOT=<pkg> node scripts/acp-e2e.mjs [adapter-dist-dir]
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const discoverPackageRoot = () => {
	if (process.env.PI_ACP_PACKAGE_ROOT) return process.env.PI_ACP_PACKAGE_ROOT;
	try {
		const sdkDist = realpathSync(
			dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
		);
		// <pkg>/node_modules/@earendil-works/pi-coding-agent/dist → 上溯 4 级
		return dirname(dirname(dirname(dirname(sdkDist))));
	} catch {
		throw new Error("Cannot locate ACP package root; set PI_ACP_PACKAGE_ROOT");
	}
};
const PKG = discoverPackageRoot();
const ADAPTER = process.argv[2] ?? join(PKG, "dist");
const require_ = createRequire(join(PKG, "package.json"));
const { ClientSideConnection, ndJsonStream } = require_("@agentclientprotocol/sdk");
const MOCK_EXT = join(REPO, "scripts", "acp-mock-provider.ts");
const EXT = join(REPO, "src", "index.ts");
// Lody 对每个 prompt block 追加的 MCP 指导尾注（adapter patch 只对 /autocontinue 剥离）
const LODY_MCP_SUFFIX =
	"\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.";

const results = [];
const record = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const readLog = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const sessionFiles = (agentDir) => {
	const roots = join(agentDir, "sessions");
	if (!existsSync(roots)) return [];
	const files = [];
	const walk = (d) => {
		for (const f of readdirSync(d, { withFileTypes: true }))
			if (f.isDirectory()) walk(join(d, f.name));
			else if (f.name.endsWith(".jsonl")) files.push(join(d, f.name));
	};
	walk(roots);
	return files;
};
const sessionEntries = (agentDir) => {
	const latest = sessionFiles(agentDir)
		.map((f) => [f, readFileSync(f, "utf8").length])
		.sort((a, b) => a[1] - b[1])
		.at(-1)?.[0];
	if (!latest) return [];
	return readFileSync(latest, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch { return undefined; } })
		.filter(Boolean);
};
const lastStateEntry = (entries) => entries.filter((e) => e?.type === "custom" && e?.customType === "autocontinue-state").at(-1)?.data;
const commandEntries = (entries) => entries.filter((e) => e?.type === "custom" && e?.customType === "autocontinue-command");

const startAdapter = (base, script) => {
	const mockLog = join(base, "mock-calls.log");
	const agentDir = join(base, "agent");
	const stderrFd = openSync(join(base, "adapter-stderr.log"), "w");
	const child = spawn(
		process.execPath,
		[
			join(ADAPTER, "index.js"),
			"-e", MOCK_EXT,
			"-e", EXT,
			"--provider", "compat-mock",
			"--model", "compat-model-1",
		],
		{
			cwd: base,
			stdio: ["pipe", "pipe", stderrFd],
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				ACP_MOCK_SCRIPT: script,
				ACP_MOCK_LOG: mockLog,
			},
		},
	);
	const sessionUpdates = [];
	const conn = new ClientSideConnection(
		() => ({
			sessionUpdate: (n) => { sessionUpdates.push(n); },
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
		ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
	);
	const stop = () => {
		try { child.kill("SIGTERM"); } catch {}
		return new Promise((r) => child.once("exit", r));
	};
	return { child, conn, sessionUpdates, stop, mockLog, agentDir };
};

const waitFor = (cond, label) =>
	new Promise((res, rej) => {
		const deadline = Date.now() + 20_000;
		const tick = () => {
			if (cond()) return res();
			if (Date.now() > deadline) return rej(new Error(`waitFor timeout: ${label}`));
			setImmediate(tick);
		};
		tick();
	});

async function runCase(name, script, maxAttempts) {
	console.log(`\n=== CASE ${name} (script=${script}, max=${maxAttempts}) ===`);
	const base = mkdtempSync(join(tmpdir(), `acp-e2e-${name}-`));
	const ws = join(base, "ws");
	mkdirSync(ws, { recursive: true });
	const { conn, sessionUpdates, stop, mockLog, agentDir } = startAdapter(base, script);
	const chunkTexts = () =>
		sessionUpdates
			.filter((n) => n?.update?.sessionUpdate === "agent_message_chunk")
			.map((n) => n.update?.content?.text)
			.filter(Boolean);
	try {
		const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		record(`${name}.initialize`, Boolean(init?.agentCapabilities), JSON.stringify(init?.protocolVersion));
		const { sessionId } = await conn.newSession({ cwd: ws, mcpServers: [] });
		record(`${name}.newSession`, typeof sessionId === "string" && sessionId.length > 0, sessionId);

		// 命令（带 Lody 精确 MCP 尾注）：handled、零模型请求、armed 可见、state 已落盘
		const cmdResp = await conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: `/autocontinue ${maxAttempts}${LODY_MCP_SUFFIX}` }],
		});
		record(`${name}.command-prompt-returns`, cmdResp?.stopReason !== undefined, JSON.stringify(cmdResp));
		record(`${name}.command-no-model-call`, readLog(mockLog).length === 0, `calls=${readLog(mockLog).length}`);
		const cmdChunks = chunkTexts();
		record(`${name}.armed-visible-chunk`,
			cmdChunks.some((t) => t.includes(`armed for the next user prompt (${maxAttempts} successful attempts)`)),
			JSON.stringify(cmdChunks));
		// 命令期持久化：模型调用前 session JSONL 已存在，armed state 落盘（依赖 session-manager patch）
		await waitFor(() => sessionEntries(agentDir).some((e) => e?.customType === "autocontinue-state"), "armed state persisted");
		const armedState = lastStateEntry(sessionEntries(agentDir));
		record(`${name}.command-state-persisted`,
			armedState?.phase === "armed" && armedState?.maxAttempts === maxAttempts,
			`phase=${armedState?.phase} max=${armedState?.maxAttempts}`);

		// 任务：prompt 返回时第2请求已完成（同一 run 内 queue）
		await conn.prompt({ sessionId, prompt: [{ type: "text", text: `请执行兼容性测试任务。${LODY_MCP_SUFFIX}` }] });
		const callsAtResolve = readLog(mockLog);
		record(`${name}.prompt-returned-after-2-calls`, callsAtResolve.length === 2,
			JSON.stringify(callsAtResolve.map((c) => ({ n: c.n, role: c.lastRole }))));
		record(`${name}.2nd-request-is-continuation`,
			callsAtResolve[1]?.lastRole === "user" && callsAtResolve[1]?.lastText?.includes("[From auto-continue"),
			JSON.stringify(callsAtResolve[1]?.lastText?.slice(0, 90)));

		const entries2 = sessionEntries(agentDir);
		const armed = commandEntries(entries2).find((e) => /armed for the next user prompt/.test(e?.data?.message ?? ""))?.data?.message ?? "";
		record(`${name}.command-armed-entry`, new RegExp(`armed for the next user prompt \\(${maxAttempts} successful attempts\\)`).test(armed), armed);

		const progress = commandEntries(entries2).map((e) => e?.data?.message).filter(Boolean);
		record(`${name}.progress-entry`,
			progress.some((m) => m === `Auto-continue: continuation 1/${maxAttempts}.`),
			JSON.stringify(progress));

		const st = lastStateEntry(entries2);
		if (script === "done") {
			record(`${name}.state-stopped-done`, st?.phase === "stopped" && st?.stopReason === "done",
				`phase=${st?.phase} stopReason=${st?.stopReason}`);
		} else {
			record(`${name}.state-budget_exhausted`,
				st?.phase === "stopped" && st?.stopReason === "budget_exhausted" && st?.attemptsUsed === 1,
				`phase=${st?.phase} stopReason=${st?.stopReason} attemptsUsed=${st?.attemptsUsed}`);
		}
		const stopMsg = commandEntries(entries2).map((e) => e?.data?.message).join(" | ");
		const stopPattern = script === "done" ? /stopped \(done\): 调查完成。/ : /stopped after 1 successful attempts/;
		record(`${name}.stop-visible-entry`, stopPattern.test(stopMsg), stopMsg.slice(0, 160));

		const taskChunks = chunkTexts();
		record(`${name}.progress-visible-chunk`,
			taskChunks.some((t) => t.includes(`Auto-continue: continuation 1/${maxAttempts}.`)),
			JSON.stringify(taskChunks));
		record(`${name}.stop-visible-chunk`, taskChunks.some((t) => stopPattern.test(t)), JSON.stringify(taskChunks.at(-1)));

		// status（带尾注）：inactive 可见
		const statusResp = await conn.prompt({ sessionId, prompt: [{ type: "text", text: `/autocontinue status${LODY_MCP_SUFFIX}` }] });
		record(`${name}.status-prompt-returns`, statusResp?.stopReason !== undefined, JSON.stringify(statusResp));
		await waitFor(() => commandEntries(sessionEntries(agentDir)).some((e) => /inactive/.test(e?.data?.message ?? "")), "status entry");
		const statusChunks = chunkTexts();
		record(`${name}.status-visible-chunk`, statusChunks.some((t) => t.includes("Auto-continue is inactive.")), JSON.stringify(statusChunks.at(-1)));

		return { sessionId, ws, agentDir };
	} catch (e) {
		record(`${name}.fatal`, false, String(e?.stack ?? e));
		return { sessionId: undefined, ws, agentDir };
	} finally {
		await stop();
		console.log(`(artifacts kept: ${base})`);
	}
}

// armed 跨进程存活：进程 A 仅 arm 后退出（模拟宿主 idle 回收），进程 B resume 同
// session 发 status 应看到 armed——对应 GC 丢状态修复（session-manager patch）。
async function caseResumeArm(name) {
	console.log(`\n=== CASE ${name} (arm → kill → resume → status) ===`);
	const base = mkdtempSync(join(tmpdir(), `acp-e2e-${name}-`));
	const ws = join(base, "ws");
	mkdirSync(ws);
	const chunkTextsOf = (u) =>
		u.filter((n) => n?.update?.sessionUpdate === "agent_message_chunk")
			.map((n) => n.update?.content?.text)
			.filter(Boolean);
	let sessionId;
	try {
		// 进程 A：armed-only，无模型调用即退出
		const a = startAdapter(base, "done");
		await a.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const s = await a.conn.newSession({ cwd: ws, mcpServers: [] });
		sessionId = s.sessionId;
		await a.conn.prompt({ sessionId, prompt: [{ type: "text", text: `/autocontinue 5${LODY_MCP_SUFFIX}` }] });
		await waitFor(() => lastStateEntry(sessionEntries(join(base, "agent")))?.phase === "armed", "armed persisted");
		record(`${name}.armed-persisted`, true, sessionId.split("/").at(-1));
		await a.stop();

		// 进程 B：resume 同一 session，status 应回报 armed
		const b = startAdapter(base, "done");
		await b.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const loaded = await b.conn
			.loadSession({ sessionId, cwd: ws, mcpServers: [] })
			.catch(() => b.conn.resumeSession({ sessionId, cwd: ws, mcpServers: [] }));
		record(`${name}.session-resumed`, loaded !== undefined, JSON.stringify(loaded)?.slice(0, 120));
		const resp = await b.conn.prompt({ sessionId, prompt: [{ type: "text", text: `/autocontinue status${LODY_MCP_SUFFIX}` }] });
		record(`${name}.status-prompt-returns`, resp?.stopReason !== undefined, JSON.stringify(resp));
		const chunks = chunkTextsOf(b.sessionUpdates);
		record(`${name}.status-shows-armed`, chunks.some((t) => /armed for the next user prompt: 0\/5/.test(t)), JSON.stringify(chunks.at(-1)));
		await b.stop();
	} catch (e) {
		record(`${name}.fatal`, false, String(e?.stack ?? e));
	}
	console.log(`(artifacts kept: ${base})`);
}

await runCase("done", "done", 100);
await runCase("budget", "budget", 1);
await caseResumeArm("resume");
const failed = results.filter((r) => !r.ok);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
