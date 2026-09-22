import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { hasPending, runPendingDeferredInline } = await jiti.import("../extensions/command-actions.ts");

function register(overrides = {}) {
	let tool;
	const handlers = new Map();
	registerModelsRouter({
		registerTool(value) { tool = value; },
		on(event, handler) { handlers.set(event, handler); },
		...overrides,
	});
	return { tool, handlers };
}

async function modelContext(faux) {
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const modelRegistry = new ModelRegistry(runtime);
	modelRegistry.registerProvider(faux.provider);
	return { scopedModels: [], modelRegistry };
}

test("consult uses the session provider, preserving prompt, reasoning, cancellation and usage", async () => {
	const faux = fauxProvider({ models: [{ id: "reviewer", reasoning: true }] });
	const ctx = await modelContext(faux);
	const model = faux.getModel();
	const controller = new AbortController();
	faux.setResponses([(context, options) => {
		assert.deepEqual(context.messages.map(message => message.role), ["user"]);
		assert.equal(context.messages.at(-1).content[0].text, "review");
		assert.deepEqual(getCurrentTools(context.messages), []);
		assert.equal(options.reasoning, "high");
		assert.equal(options.signal, controller.signal);
		return fauxAssistantMessage("Reviewed.");
	}]);
	const { tool } = register();
	const result = await tool.execute("consult", {
		action: "consult", provider: model.provider, modelId: model.id, prompt: "review",
		thinkingLevel: "high",
	}, controller.signal, undefined, ctx);
	assert.match(result.content[0].text, /Reviewed\./);
	assert.equal(faux.state.callCount, 1);
	assert.ok(result.usage.totalTokens > 0);
});

test("consult resolves configured authentication for an extension stream", async () => {
	const faux = fauxProvider();
	const ctx = await modelContext(faux);
	ctx.modelRegistry.registerProvider("configured-consult", {
		api: faux.api,
		apiKey: "test-key",
		headers: { "X-Test-Auth": "test-header" },
		baseUrl: "https://example.invalid",
		models: [{ id: "reviewer", name: "Reviewer", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			assert.equal(options.apiKey, "test-key");
			assert.equal(options.headers["X-Test-Auth"], "test-header");
			assert.equal(model.baseUrl, "https://example.invalid");
			return faux.provider.streamSimple(model, context, options);
		},
	});
	faux.setResponses([fauxAssistantMessage("Authenticated review.")]);
	const { tool } = register();
	const result = await tool.execute("configured", { action: "consult", provider: "configured-consult", modelId: "reviewer", prompt: "review" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /Authenticated review\./);
	assert.equal(faux.state.callCount, 1);
});

test("consult rejects aborted and failed model responses", async () => {
	const faux = fauxProvider();
	const ctx = await modelContext(faux);
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "Upstream failed" }),
	]);
	const { tool, handlers } = register();
	const params = { action: "consult", provider: model.provider, modelId: model.id, prompt: "review" };
	const toolResult = handlers.get("tool_result");

	await assert.rejects(tool.execute("aborted", params, undefined, undefined, ctx), /Consultation aborted/);
	const abortedPatch = toolResult({ toolName: "models", toolCallId: "aborted" });
	assert.ok(abortedPatch.usage.totalTokens > 0, "aborted consultations retain nested model usage");

	await assert.rejects(tool.execute("failed", params, undefined, undefined, ctx), /Upstream failed/);
	const failedPatch = toolResult({ toolName: "models", toolCallId: "failed" });
	assert.ok(failedPatch.usage.totalTokens > 0, "failed consultations retain nested model usage");
	assert.equal(toolResult({ toolName: "models", toolCallId: "failed" }), undefined, "usage is consumed once");
});

test("successful consult retains usage once on temporary-directory and file-write failures", async (t) => {
	const directories = [];
	const { mkdtemp, writeFile } = fs;
	let operation;
	let failure;
	t.after(async () => {
		operation = undefined;
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
	});
	t.mock.method(fs, "mkdtemp", async (...args) => {
		if (operation === "mkdtemp") throw failure;
		const directory = await mkdtemp(...args);
		directories.push(directory);
		return directory;
	});
	t.mock.method(fs, "writeFile", async (...args) => {
		if (operation === "writeFile") throw failure;
		return writeFile(...args);
	});
	syncBuiltinESMExports();
	for (operation of ["mkdtemp", "writeFile"]) {
		failure = Object.assign(new Error(`${operation} failed`), { code: "ENOSPC" });

		const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
		const model = { provider: "test", id: "reviewer" };
		let requests = 0;
		const ctx = { scopedModels: [], modelRegistry: {
			getAvailable: async () => [model],
			find: () => model,
			streamSimple: () => ({ result: async () => {
				requests++;
				return { ...fauxAssistantMessage("x".repeat(60 * 1024)), usage };
			} }),
		} };
		const { tool, handlers } = register();
		await assert.rejects(tool.execute(operation, {
			action: "consult", provider: "test", modelId: "reviewer", prompt: "review",
		}, undefined, undefined, ctx), error => error === failure);
		assert.equal(requests, 1, "saving failures must not rerun paid consultations");
		const toolResult = handlers.get("tool_result");
		assert.equal(toolResult({ toolName: "commands", toolCallId: operation }), undefined);
		assert.equal(toolResult({ toolName: "models", toolCallId: "other" }), undefined);
		assert.deepEqual(toolResult({ toolName: "models", toolCallId: operation, isError: true }), { usage });
		assert.equal(toolResult({ toolName: "models", toolCallId: operation, isError: true }), undefined);
	}
});

test("successful consult usage is not patched twice or retained after the result event", async () => {
	const faux = fauxProvider();
	const ctx = await modelContext(faux);
	faux.setResponses([fauxAssistantMessage("Reviewed.")]);
	const { tool, handlers } = register();
	const result = await tool.execute("success", {
		action: "consult", provider: faux.getModel().provider, modelId: faux.getModel().id, prompt: "review",
	}, undefined, undefined, ctx);
	assert.ok(result.usage.totalTokens > 0);
	const toolResult = handlers.get("tool_result");
	assert.equal(toolResult({ toolName: "models", toolCallId: "success", usage: result.usage, isError: false }), undefined);
	assert.equal(toolResult({ toolName: "models", toolCallId: "success", isError: true }), undefined,
		"successful results consume the pending usage even without returning a patch");
});

test("switch accepts valid authentication without an API key and remains deferred", async () => {
	const faux = fauxProvider();
	const ctx = await modelContext(faux);
	const model = faux.getModel();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	assert.equal(auth.ok, true);
	assert.equal(auth.apiKey, undefined);
	const switched = [];
	const { tool } = register({ setModel: async (value) => { switched.push(value); return true; } });
	const result = await tool.execute("switch", { action: "switch", provider: model.provider, modelId: model.id }, undefined, undefined, ctx);
	assert.equal(result.details.scheduled, true);
	assert.deepEqual(switched, []);
	assert.equal(hasPending(ctx), true);
	await runPendingDeferredInline(ctx);
	assert.deepEqual(switched.map(value => [value.provider, value.id]), [[model.provider, model.id]]);
	assert.equal(hasPending(ctx), false);
});

test("explicit provider resolves slash-containing IDs before prefixes without hiding mismatches", async () => {
	const anthropic = fauxProvider({ provider: "anthropic", models: [{ id: "claude" }, { id: "shared" }] });
	const openrouter = fauxProvider({ provider: "openrouter", models: [{ id: "anthropic/claude" }, { id: "shared" }] });
	const ctx = await modelContext(anthropic);
	ctx.modelRegistry.registerProvider(openrouter.provider);
	ctx.modelRegistry.getAvailable = () => [...anthropic.models, ...openrouter.models];
	const switched = [];
	const { tool } = register({ setModel: async (model) => { switched.push(model); return true; } });
	for (const modelId of ["anthropic/claude", "openrouter/anthropic/claude"]) {
		openrouter.setResponses([fauxAssistantMessage("OpenRouter review.")]);
		const consult = await tool.execute(`consult-${modelId}`, {
			action: "consult", provider: "OpenRouter", modelId, prompt: "review",
		}, undefined, undefined, ctx);
		assert.equal(consult.details.provider, "openrouter");
		assert.equal(consult.details.modelId, "anthropic/claude");
		assert.match(consult.content[0].text, /OpenRouter review/);
		const scheduled = await tool.execute(`switch-${modelId}`, {
			action: "switch", provider: "OpenRouter", modelId,
		}, undefined, undefined, ctx);
		assert.equal(scheduled.details.modelId, "anthropic/claude");
		await runPendingDeferredInline(ctx);
	}
	assert.equal(anthropic.state.callCount, 0);
	assert.equal(openrouter.state.callCount, 2);
	assert.deepEqual(switched.map(model => [model.provider, model.id]), [
		["openrouter", "anthropic/claude"], ["openrouter", "anthropic/claude"],
	]);
	for (const action of ["consult", "switch"]) {
		await assert.rejects(tool.execute("mismatch", {
			action, provider: "openrouter", modelId: "anthropic/shared", prompt: "review",
		}, undefined, undefined, ctx), /Provider mismatch/);
		await assert.rejects(tool.execute("ambiguous", {
			action, modelId: "shared", prompt: "review",
		}, undefined, undefined, ctx), /Ambiguous.*anthropic\/shared.*openrouter\/shared/);
	}
	assert.equal(hasPending(ctx), false);
});
