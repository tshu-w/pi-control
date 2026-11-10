import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { hasPending, hasQueuedAction, clearPending } = await jiti.import("../extensions/command-actions.ts");

function register(router, overrides = {}) {
	let tool;
	router({ registerTool(value) { tool = value; }, on() {}, ...overrides });
	return (params, ctx = {}) => tool.execute("test", params, undefined, undefined, ctx);
}

const entries = [
	{ id: "entry-1", type: "message", message: { role: "user", content: "hello" } },
	{ id: "entry-2", type: "message", message: { role: "assistant", content: "world" } },
];
function treeContext() {
	return { sessionManager: {
		getEntry: (id) => entries.find((entry) => entry.id === id),
		getEntries: () => entries,
		getBranch: () => entries,
		getTree: () => entries.map((entry) => ({ entry, children: [] })),
		getLabel: (id) => id === "entry-2" ? "bookmark" : undefined,
		getLeafId: () => "entry-1",
		getSessionFile: () => undefined,
	} };
}

test("models reject invalid requests and unresolved targets before scheduling or consulting", async () => {
	const models = [{ provider: "one", id: "shared" }, { provider: "two", id: "shared" }];
	let authCalls = 0;
	let consultCalls = 0;
	const ctx = { scopedModels: [], modelRegistry: {
		getAvailable: async () => models,
		find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		getApiKeyAndHeaders: async () => { authCalls++; return { ok: false }; },
		streamSimple: () => { consultCalls++; throw new Error("unexpected consultation"); },
	} };
	const execute = register(registerModelsRouter);
	for (const [params, pattern] of [
		[{ action: "switch" }, /modelId.*required/],
		[{ action: "consult", modelId: "shared" }, /prompt.*required/],
		[{ action: "consult", prompt: "review" }, /modelId.*required/],
		[{ action: "switch", modelId: "missing" }, /Model not found/],
		[{ action: "consult", modelId: "missing", prompt: "review" }, /Model not found/],
		[{ action: "switch", modelId: "one/shared", provider: "two" }, /Provider mismatch/],
		[{ action: "consult", modelId: "one/shared", provider: "two", prompt: "review" }, /Provider mismatch/],
		[{ action: "switch", modelId: "shared" }, /Ambiguous.*one\/shared.*two\/shared/],
		[{ action: "consult", modelId: "shared", prompt: "review" }, /Ambiguous.*one\/shared.*two\/shared/],
	]) {
		await assert.rejects(execute(params, ctx), pattern);
	}
	ctx.scopedModels = models.map((model) => ({ model }));
	await assert.rejects(execute({ action: "switch", modelId: "shared" }, ctx), /Ambiguous.*scoped.*one\/shared.*two\/shared/);
	assert.equal(authCalls, 0);
	await assert.rejects(execute({ action: "switch", modelId: "one/shared" }, ctx), /No API key/);
	assert.equal(authCalls, 1);
	assert.equal(consultCalls, 0);
	assert.equal(hasPending(ctx), false);
	const empty = await execute({ action: "list", filter: "missing" }, ctx);
	assert.deepEqual(empty.details.models, []);
});

test("tree rejects invalid parameters, targets and label collisions without mutations", async () => {
	const mutations = [];
	const execute = register(registerTreeRouter, { setLabel: (...args) => mutations.push(args) });
	const ctx = treeContext();
	for (const [params, pattern] of [
		[{ action: "list", scope: "all", filter: "all" }, /only supported with scope/],
		[{ action: "list", scope: "all", types: ["message"] }, /only supported with scope/],
		[{ action: "search" }, /keyword.*required/],
		[{ action: "set_label" }, /entryId.*required/],
		[{ action: "set_label", entryId: "missing" }, /Entry not found/],
		[{ action: "set_label", entryId: "entry-1", label: "bookmark" }, /already used by \[entry-2\]/],
		[{ action: "navigate" }, /entryId.*required for navigate/],
		[{ action: "navigate", entryId: "missing" }, /Entry not found: missing/],
		[{ action: "navigate", entryId: "entry-" }, /Entry not found: entry-$/],
		[{ action: "navigate", entryId: "bookmark" }, /Entry not found: bookmark/],
		[{ action: "fork" }, /entryId.*required/],
		[{ action: "fork", entryId: "missing" }, /Entry not found/],
		[{ action: "fork", entryId: "entry-2" }, /Fork requires a user-message entry/],
	]) {
		await assert.rejects(execute(params, ctx), pattern);
	}
	assert.deepEqual(mutations, []);
	assert.equal(hasPending(ctx), false);
	const noOp = await execute({ action: "navigate", entryId: "entry-1" }, ctx);
	assert.match(noOp.content[0].text, /Already at entry/);
	assert.equal(hasPending(ctx), false);
	const empty = await execute({ action: "search", keyword: "missing" }, ctx);
	assert.equal(empty.details.matches, 0);
});

test("transition rejection preserves the previously scheduled operation", async () => {
	const sessions = register(registerSessionsRouter);
	const tree = register(registerTreeRouter);
	const models = register(registerModelsRouter);
	const ctx = treeContext();
	const scheduled = await sessions({ action: "reload" }, ctx);
	assert.equal(scheduled.details.scheduled, "reload");
	await assert.rejects(sessions({ action: "new" }, ctx), /Cannot schedule this change: a reload is already scheduled/);
	await assert.rejects(tree({ action: "fork", entryId: "entry-1" }, ctx), /Cannot schedule this change: a reload is already scheduled/);
	ctx.scopedModels = [];
	ctx.modelRegistry = {
		getAvailable: async () => [{ provider: "one", id: "model" }],
		find: () => ({ provider: "one", id: "model" }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
	};
	await assert.rejects(models({ action: "switch", modelId: "one/model" }, ctx), /Cannot schedule the model switch: a reload is already scheduled/);
	assert.equal(hasQueuedAction(ctx), true);
	clearPending(ctx);
	assert.equal(hasPending(ctx), false);
});
