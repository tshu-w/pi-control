import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES as MAX_BYTES,
	DEFAULT_MAX_LINES as MAX_LINES,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { patchBindCommandContext } = await jiti.import("../extensions/command-actions.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { withToolOutputContract } = await jiti.import("../extensions/tool-output.ts");

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
		assert.match(error.message, /Full output could not be saved to a temporary file/);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("session search uses labeled records and reusable sessionFile locators", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-search-"));
	const sessionsDir = path.join(agentDir, "sessions", "--work--");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const sessionFile = path.join(sessionsDir, "session.jsonl");
	fs.writeFileSync(sessionFile, [
		{ type: "session", id: "session-id", timestamp: "2026-07-31T18:20:00.000Z", cwd: "/work" },
		{ type: "session_info", name: "project refactor" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Refactor the authentication module" }] } },
	].map((entry) => JSON.stringify(entry)).join("\n"));

	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const sessions = register(registerSessionsRouter);
		assert.equal(sessions.parameters.properties.limit.type, "integer");
		assert.equal(sessions.parameters.properties.limit.minimum, 1);
		const result = await sessions.execute(
			"id",
			{ action: "search", keyword: "authentication", scope: "all" },
			undefined,
			undefined,
			{ cwd: "/work" },
		);
		assert.equal(result.content[0].text, [
			"sessions (1 returned)",
			"",
			'- name: "project refactor"',
			`  sessionFile: ${JSON.stringify(sessionFile)}`,
			'  timestamp: "2026-07-31T18:20:00.000Z"',
			'  cwd: "/work"',
			"  matches:",
			'    - "[user] Refactor the authentication module"',
			"",
			"Use sessions(action='resume', sessionFile=...) to switch.",
		].join("\n"));
		assert.equal(result.details.results[0].sessionFile, sessionFile);
		assert.equal("file" in result.details.results[0], false);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("transition follow-up messages reject whitespace at runtime", async () => {
	const sessions = register(registerSessionsRouter);
	for (const action of ["resume", "new", "reload"]) {
		await assert.rejects(
			sessions.execute("id", { action, message: " \n " }, undefined, undefined, {}),
			/non-whitespace character when provided/,
		);
	}
});

test("resume validates session files and reports deferred execution", async () => {
	const sessions = register(registerSessionsRouter);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-resume-"));
	const sessionFile = path.join(directory, "session.jsonl");
	fs.writeFileSync(sessionFile, "{}\n");
	try {
		await assert.rejects(
			sessions.execute("id", { action: "resume" }, undefined, undefined, {}),
			/`sessionFile` is required for resume/,
		);
		await assert.rejects(
			sessions.execute("id", { action: "resume", sessionFile: path.join(directory, "session.txt") }, undefined, undefined, {}),
			/not a \.jsonl file/,
		);
		await assert.rejects(
			sessions.execute("id", { action: "resume", sessionFile: path.join(directory, "missing.jsonl") }, undefined, undefined, {}),
			/Session file not found/,
		);

		patchBindCommandContext();
		const sessionManager = {};
		ExtensionRunner.prototype.bindCommandContext.call({ sessionManager }, {
			switchSession: async () => ({ cancelled: false }),
			newSession: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			reload: async () => {},
			waitForIdle: async () => {},
		});
		const result = await sessions.execute(
			"id",
			{ action: "resume", sessionFile, message: "continue" },
			undefined,
			undefined,
			{ sessionManager },
		);
		assert.equal(
			result.content[0].text,
			`Scheduled session switch to: ${sessionFile} (with follow-up message).`,
		);
		assert.deepEqual(result.details, {
			scheduled: "resume",
			sessionFile,
			messageScheduled: true,
		});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("new reports the effective parent-session settings", async () => {
	const sessions = register(registerSessionsRouter);
	patchBindCommandContext();
	const sessionManager = { getSessionFile: () => "/sessions/parent.jsonl" };
	ExtensionRunner.prototype.bindCommandContext.call({ sessionManager }, {
		switchSession: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		reload: async () => {},
		waitForIdle: async () => {},
	});
	const result = await sessions.execute(
		"id",
		{ action: "new", message: "continue" },
		undefined,
		undefined,
		{ sessionManager },
	);
	assert.equal(result.content[0].text, "Scheduled new session creation (with follow-up message).");
	assert.deepEqual(result.details, {
		scheduled: "new",
		linkParent: true,
		parentSession: "/sessions/parent.jsonl",
		messageScheduled: true,
	});
});

test("session names are validated and rendered as JSON strings", async () => {
	let assignedName;
	const sessions = register(registerSessionsRouter, {
		setSessionName(name) { assignedName = name; },
	});
	await assert.rejects(
		sessions.execute("id", { action: "name", name: " \n " }, undefined, undefined, {}),
		/non-whitespace/,
	);
	const name = 'review "checkpoint"';
	const result = await sessions.execute("id", { action: "name", name }, undefined, undefined, {});
	assert.equal(assignedName, name);
	assert.equal(result.content[0].text, `Session named: ${JSON.stringify(name)}`);
	assert.deepEqual(result.details, { name });
});

test("queue_message validates content and reports only the delivery mode", async () => {
	const submissions = [];
	const sessions = register(registerSessionsRouter, {
		sendUserMessage(message, options) { submissions.push({ message, options }); },
	});
	await assert.rejects(
		sessions.execute("id", { action: "queue_message", message: " \n " }, undefined, undefined, {}),
		/non-whitespace/,
	);
	const followUp = await sessions.execute(
		"id",
		{ action: "queue_message", message: "continue" },
		undefined,
		undefined,
		{},
	);
	assert.equal(followUp.content[0].text, "Message submitted as followUp.");
	assert.deepEqual(followUp.details, { deliverAs: "followUp" });
	const steer = await sessions.execute(
		"id",
		{ action: "queue_message", message: "redirect", deliverAs: "steer" },
		undefined,
		undefined,
		{},
	);
	assert.equal(steer.content[0].text, "Message submitted as steer.");
	assert.deepEqual(submissions, [
		{ message: "continue", options: { deliverAs: "followUp" } },
		{ message: "redirect", options: { deliverAs: "steer" } },
	]);
});

test("sessions info retains complete structured state", async () => {
	const sessions = register(registerSessionsRouter);
	const usage = { tokens: 1200, contextWindow: 128000, percent: 0.9375 };
	const result = await sessions.execute(
		"id",
		{ action: "info" },
		undefined,
		undefined,
		{
			cwd: "/work",
			model: { provider: "provider", id: "model" },
			getContextUsage: () => usage,
			sessionManager: {
				getSessionFile: () => "/sessions/current.jsonl",
				getSessionName: () => "current",
				getEntries: () => [{}, {}],
			},
		},
	);
	assert.deepEqual(result.details, {
		model: "provider/model",
		thinkingLevel: "off",
		sessionName: "current",
		sessionFile: "/sessions/current.jsonl",
		cwd: "/work",
		entries: 2,
		usage,
	});
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

	const scopedModel = available[7];
	const scopedResult = await models.execute(
		"id",
		{ action: "list", scope: "scoped" },
		undefined,
		undefined,
		{
			scopedModels: [{ model: scopedModel, thinkingLevel: "high" }],
			modelRegistry: { getAvailable: async () => available },
		},
	);
	assert.deepEqual(scopedResult.details.models, [{ provider: scopedModel.provider, id: scopedModel.id }]);
});

test("executed commands preserve full output without duplicating captured text in details", async () => {
	patchBindCommandContext();
	const sessionManager = {};
	const commandContext = {
		hasUI: false,
		sessionManager,
		ui: { notify() {}, setStatus() {} },
	};
	const runner = {
		sessionManager,
		getRegisteredCommands: () => [{
			invocationName: "loud",
			name: "loud",
			description: "emit a large notification",
			sourceInfo: { path: "/extension.ts", source: "test", scope: "user" },
		}],
		getCommand: () => ({ handler: async (_args, ctx) => ctx.ui.notify("n".repeat(60 * 1024), "info") }),
		createCommandContext: () => commandContext,
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
	const result = await commands.execute("id", { action: "run", name: "loud", args: "" }, undefined, undefined, { sessionManager });
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
