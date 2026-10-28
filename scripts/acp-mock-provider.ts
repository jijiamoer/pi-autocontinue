// ACP e2e 测试 fixture：以 pi -e 扩展注入，注册 compat-mock provider。
// 每次模型请求向 ACP_MOCK_LOG 追加一行 JSON；响应脚本由 ACP_MOCK_SCRIPT 选择：
//   done    — 第1轮文本，第2轮 autocontinue_stop{done}
//   budget  — 永远文本
//   blocked — 第1轮即 autocontinue_stop{blocked}
import { appendFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";

export default function acpMockProvider(pi: {
	registerProvider: (name: string, config: Record<string, unknown>) => void;
}) {
	const script = process.env.ACP_MOCK_SCRIPT ?? "done";
	const logPath = process.env.ACP_MOCK_LOG ?? "/tmp/acp-mock-calls.log";
	let n = 0;

	pi.registerProvider("compat-mock", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "compat-local-only",
		models: [
			{
				id: "compat-model-1",
				name: "Compat Mock",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		streamSimple(_model: unknown, context: { messages?: Array<{ role?: string; content?: unknown }> }) {
			n += 1;
			const messages = context?.messages ?? [];
			const last = [...messages].reverse().find((m) => m?.role !== "toolResult");
			const lastText =
				typeof last?.content === "string"
					? last.content
					: ((last?.content ?? []) as Array<{ type?: string; text?: string }>)
							.filter((p) => p?.type === "text")
							.map((p) => p.text)
							.join("\n");
			appendFileSync(
				logPath,
				JSON.stringify({ n, lastRole: last?.role, lastText: String(lastText ?? "").slice(0, 200) }) + "\n",
			);
			const stream = createAssistantMessageEventStream();
			setImmediate(() => emitScripted(stream, script, n));
			return stream;
		},
	});
}

function emitScripted(
	stream: { push: (event: Record<string, unknown>) => void },
	script: string,
	n: number,
) {
	const tool = scriptTool(script, n);
	if (tool) {
		const block = fauxToolCall("autocontinue_stop", tool);
		const message = fauxAssistantMessage(block, { stopReason: "toolUse" });
		// faux 契约：toolcall_start 的 partial.content 必须已是 toolCall 块
		const p = {
			...message,
			content: [{ type: "toolCall", id: block.id, name: block.name, arguments: {} }],
			stopReason: "pending",
		};
		const pDone = { ...p, content: [{ ...p.content[0], arguments: tool }] };
		stream.push({ type: "start", partial: p });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: p });
		stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(tool), partial: pDone });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: pDone });
		stream.push({ type: "done", reason: "toolUse", message });
		return;
	}
	const partial = (msg: Record<string, unknown>) => ({ ...msg, content: [], stopReason: "pending" });
	const text = script === "done" && n === 1 ? "我会开始调查。" : `第${n}步完成。`;
	const message = fauxAssistantMessage(text, { stopReason: "stop" });
	const p = partial(message);
	stream.push({ type: "start", partial: p });
	stream.push({ type: "text_start", contentIndex: 0, partial: p });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: p });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: p });
	stream.push({ type: "done", reason: "stop", message });
}

function scriptTool(script: string, n: number): { reason: string; summary: string } | undefined {
	if (script === "done" && n === 2) return { reason: "done", summary: "调查完成。" };
	if (script === "blocked" && n === 1) return { reason: "blocked", summary: "需要用户提供凭证。" };
	return undefined;
}
