import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerTreeRouter } from "../../extensions/tree.ts";

export default function (pi: any) {
	const scenario = process.env.COMPACT_TEST_SCENARIO;
	const record = (value: any) => appendFileSync(process.env.COMPACT_TEST_TRACE!, `${JSON.stringify(value)}\n`);
	let requests = 0;
	pi.registerProvider("compact-test", {
		api: "compact-test-api", baseUrl: "http://127.0.0.1:1", apiKey: "local-test-only",
		models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model: any, context: any, options: any) {
			const stream = createAssistantMessageEventStream();
			const summary = !context.messages.some((message: any) => message.role === "system" && message.sections?.preamble);
			const first = !summary && requests++ === 0;
			record({ type: summary ? "summary_request" : "request", messages: context.messages });
			const output: any = {
				role: "assistant", content: first
					? [{ type: "toolCall", id: "compact-call", name: "tree", arguments: { action: "compact", customInstructions: "Retain the test marker" } }]
					: [{ type: "text", text: "Task completed" }],
				api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				if (summary && scenario === "provider-error") {
					output.content = [];
					output.stopReason = "error";
					output.errorMessage = "Summary provider unavailable";
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}
				const finish = () => { stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(); };
				if (first) finish();
				else {
					const timer = setTimeout(finish, 20);
					options?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						output.content = [];
						output.stopReason = "error";
						output.errorMessage = "This operation was aborted";
						stream.push({ type: "error", reason: "error", error: output });
						stream.end();
					}, { once: true });
				}
			});
			return stream;
		},
	});
	registerTreeRouter(pi);
	pi.on("session_before_compact", async (event: any) => {
		record({ type: "summary_start", instructions: event.customInstructions, reason: event.reason });
		if (scenario === "provider-error") return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, scenario === "stop" ? 1000 : 50);
			event.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
		if (scenario === "failure" || event.signal.aborted) return { cancel: true };
		record({ type: "summary_complete" });
		return { compaction: { summary: "Compacted test marker", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
}
