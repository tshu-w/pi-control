import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");

function register() {
	let tool;
	const handlers = new Map();
	registerModelsRouter({
		registerTool(value) { tool = value; },
		on(event, handler) { handlers.set(event, handler); },
	});
	return { tool, handlers };
}

function modelContext(model) {
	return {
		scopedModels: [],
		modelRegistry: {
			getAvailable: async () => [model],
			find: (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
	};
}

test("consult rejects aborted and failed model responses", async () => {
	const faux = registerFauxProvider();
	try {
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Upstream failed" }),
		]);
		const { tool, handlers } = register();
		const params = { action: "consult", modelId: `${model.provider}/${model.id}`, prompt: "review" };
		const toolResult = handlers.get("tool_result");

		await assert.rejects(tool.execute("aborted", params, undefined, undefined, modelContext(model)), /Consultation aborted/);
		const abortedPatch = toolResult({ toolName: "models", toolCallId: "aborted" });
		assert.ok(abortedPatch.usage.totalTokens > 0, "aborted consultations retain nested model usage");

		await assert.rejects(tool.execute("failed", params, undefined, undefined, modelContext(model)), /Upstream failed/);
		const failedPatch = toolResult({ toolName: "models", toolCallId: "failed" });
		assert.ok(failedPatch.usage.totalTokens > 0, "failed consultations retain nested model usage");
		assert.equal(toolResult({ toolName: "models", toolCallId: "failed" }), undefined, "usage is consumed once");
	} finally {
		faux.unregister();
	}
});
