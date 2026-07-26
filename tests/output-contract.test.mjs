import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { patchBindCommandContext } = await jiti.import("../extensions/command-actions.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { withToolOutputContract } = await jiti.import("../extensions/tool-output.ts");

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

function assertBounded(result) {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.ok(Buffer.byteLength(text) <= MAX_BYTES, `expected <= ${MAX_BYTES} bytes`);
	assert.ok(text.split("\n").length <= MAX_LINES, `expected <= ${MAX_LINES} lines`);
	return text;
}

function register(registerRouter, overrides = {}) {
	let tool;
	const pi = {
		registerTool(value) { tool = value; },
		getThinkingLevel() { return "off"; },
		setSessionName() {},
		setLabel() {},
		...overrides,
	};
	registerRouter(pi);
	return tool;
}

test("output wrapper enforces aggregate bounds and preserves expensive results", async () => {
	const full = ["x".repeat(30 * 1024), "😀".repeat(10 * 1024)].join("\n");
	const tool = withToolOutputContract({
		name: "test",
		label: "Test",
		description: "test",
		parameters: Type.Object({ action: Type.String() }),
		async execute() {
			return {
				content: [{ type: "text", text: full.slice(0, 30 * 1024) }, { type: "text", text: full.slice(30 * 1024 + 1) }],
				details: { state: "keep" },
			};
		},
	}, { preserveFullOutput: () => true, tempPrefix: "pi-control-test" });

	const result = await tool.execute("id", { action: "run" }, undefined, undefined, {});
	const text = assertBounded(result);
	assert.match(text, /Output truncated/);
	assert.equal(result.details.state, "keep");
	assert.equal(result.details.fullOutputSaved, true);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), full);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("safe rerunnable results truncate without creating files", async () => {
	const tool = withToolOutputContract({
		name: "list",
		label: "List",
		description: "test",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n") }], details: {} };
		},
	});
	const result = await tool.execute("id", {}, undefined, undefined, {});
	const text = assertBounded(result);
	assert.match(text, /Narrow the filter or use pagination/);
	assert.equal(result.details.fullOutputPath, undefined);
});

test("save failure and thrown errors remain bounded without changing semantics", async () => {
	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = path.join(os.tmpdir(), `pi-control-missing-${Date.now()}`, "nested");
		const tool = withToolOutputContract({
			name: "run",
			label: "Run",
			description: "test",
			parameters: Type.Object({ action: Type.String() }),
			async execute() { throw new Error("e".repeat(60 * 1024)); },
		}, { preserveFullOutput: () => true });
		const error = await tool.execute("id", { action: "run" }, undefined, undefined, {}).then(() => null, (value) => value);
		assert.ok(error instanceof Error);
		assert.ok(Buffer.byteLength(error.message) <= MAX_BYTES);
		assert.ok(error.message.split("\n").length <= MAX_LINES);
		assert.match(error.message, /operation already ran, so retry only if safe/);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("sessions and models inherit the wrapper at their public execute seam", async () => {
	const sessions = register(registerSessionsRouter);
	const sessionResult = await sessions.execute(
		"id",
		{ action: "name", name: "n".repeat(60 * 1024) },
		undefined,
		undefined,
		{},
	);
	assertBounded(sessionResult);

	const models = register(registerModelsRouter);
	const available = Array.from({ length: 2500 }, (_, i) => ({
		provider: "provider",
		id: `model-${i}-${"x".repeat(40)}`,
		name: `Model ${i}`,
		contextWindow: 128000,
		reasoning: false,
	}));
	const modelResult = await models.execute(
		"id",
		{ action: "list", scope: "all" },
		undefined,
		undefined,
		{ cwd: "/work", modelRegistry: { getAvailable: async () => available } },
	);
	assertBounded(modelResult);
	assert.equal(modelResult.details.models.length, available.length, "structured model locators remain available");
});

test("executed commands preserve full output without duplicating captured text in details", async () => {
	patchBindCommandContext();
	const runner = {
		getRegisteredCommands: () => [{
			invocationName: "loud",
			name: "loud",
			description: "emit a large notification",
			sourceInfo: { path: "/extension.ts", source: "test", scope: "user" },
		}],
		getCommand: () => ({ handler: async (_args, ctx) => ctx.ui.notify("n".repeat(60 * 1024), "info") }),
		createCommandContext: () => ({
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
		}),
	};
	ExtensionRunner.prototype.bindCommandContext.call(runner, {
		switchSession: async () => {},
		newSession: async () => {},
		navigateTree: async () => {},
		fork: async () => {},
		reload: async () => {},
		waitForIdle: async () => {},
	});
	const commands = register(registerCommandsRouter);
	const result = await commands.execute("id", { action: "run", name: "loud", args: "" }, undefined, undefined, {});
	assertBounded(result);
	assert.deepEqual(Object.keys(result.details).sort(), ["fullOutputPath", "fullOutputSaved", "status", "truncated"]);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8").includes("n".repeat(1000)), true);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("tree details retain label locators without copying previews", async () => {
	const tree = register(registerTreeRouter);
	const entries = [{ id: "entry-1", type: "message", message: { role: "user", content: "large preview" } }];
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLabel: () => "bookmark",
		},
	};
	const result = await tree.execute("id", { action: "labels" }, undefined, undefined, ctx);
	assert.deepEqual(result.details.labels, [{ id: "entry-1", label: "bookmark", onBranch: true }]);
});
