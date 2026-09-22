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
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { patchBindCommandContext } = await jiti.import("../extensions/command-actions.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { withToolOutputContract } = await jiti.import("../extensions/tool-output.ts");

// The limits bound the content; the truncation notice sits on top of it.
function assertContentBounded(text) {
	const content = text.split(/\n\n\[(?:Output truncated:|Showing |Line )/)[0];
	assert.ok(Buffer.byteLength(content) <= MAX_BYTES, `expected <= ${MAX_BYTES} bytes`);
	assert.ok(content.split("\n").length <= MAX_LINES, `expected <= ${MAX_LINES} lines`);
}

function assertBounded(result) {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assertContentBounded(text);
	return text;
}

function register(registerRouter, overrides = {}) {
	let tool;
	const pi = {
		registerTool(value) { tool = value; },
		on() {},
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
	}, { tempPrefix: "pi-control-test" });

	const result = await tool.execute("id", { action: "run" }, undefined, undefined, {});
	const text = assertBounded(result);
	assert.match(text, /Showing lines/);
	assert.equal(result.details.state, "keep");
	assert.equal(result.details.truncation.truncated, true);
	assert.equal(result.details.truncation.totalBytes, Buffer.byteLength(full));
	assert.equal(result.details.fullOutputSaved, undefined);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), full);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("oversized first lines retain no content using native head truncation", async () => {
	const full = "a" + "😀".repeat(MAX_BYTES);
	const tool = withToolOutputContract({
		name: "list", label: "List", description: "test", parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: full }], details: {} };
		},
	});
	const result = await tool.execute("id", {}, undefined, undefined, {});
	const content = assertBounded(result).split(/\n\n\[(?:Output truncated:|Showing |Line )/)[0];
	const truncation = result.details.truncation;
	assert.equal(content, "");
	assert.equal(truncation.content, "");
	assert.equal(truncation.outputLines, 0);
	assert.equal(truncation.outputBytes, 0);
	assert.equal(truncation.lastLinePartial, false);
	assert.equal(truncation.firstLineExceedsLimit, true);
	assert.equal(truncation.totalBytes, Buffer.byteLength(full));
	assert.equal(result.content[0].text, `\n\n[Line 1 is 200.0KB, exceeds 50.0KB limit. Full output: ${result.details.fullOutputPath}]`);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), full);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("rerunnable results also preserve full output when truncated", async () => {
	const full = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
	const tool = withToolOutputContract({
		name: "list",
		label: "List",
		description: "test",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: full }], details: {} };
		},
	});
	const result = await tool.execute("id", {}, undefined, undefined, {});
	const text = assertBounded(result);
	assert.match(text, /Showing lines 1-2000 of 2100\. Full output:/);
	assert.equal(result.details.truncation.truncated, true);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), full);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("save failures propagate unchanged for results and execution errors", async () => {
	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = path.join(os.tmpdir(), `pi-control-missing-${Date.now()}`, "nested");
		const full = "e".repeat(60 * 1024);
		const originalError = new Error(full);
		const tool = withToolOutputContract({
			name: "run",
			label: "Run",
			description: "test",
			parameters: Type.Object({ action: Type.String() }),
			async execute(_id, params) {
				if (params.action === "throw") throw originalError;
				return { content: [{ type: "text", text: full }], details: {} };
			},
		});
		for (const action of ["run", "consult", "list", "throw"]) {
			await assert.rejects(tool.execute("id", { action }, undefined, undefined, {}), (error) => {
				assert.equal(error.code, "ENOENT");
				assert.equal(error.syscall, "mkdtemp");
				return true;
			});
		}
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("truncated errors preserve complete messages", async () => {
	const original = new Error("Upstream failed\n" + "e".repeat(MAX_BYTES));
	const tool = withToolOutputContract({
		name: "error", label: "Error", description: "test", parameters: Type.Object({}),
		async execute() { throw original; },
	});
	await assert.rejects(tool.execute("id", {}, undefined, undefined, {}), (error) => {
		assertContentBounded(error.message);
		assert.match(error.message, /^Upstream failed\n\n\[Showing lines 1-1 of 2/);
		const fullOutputPath = error.message.match(/Full output: ([^\n]+)\]$/)[1];
		assert.equal(fs.readFileSync(fullOutputPath, "utf8"), original.message);
		fs.rmSync(path.dirname(fullOutputPath), { recursive: true });
		return true;
	});
});

for (const outcome of ["result", "error"]) {
	test(`oversized continuation-like ${outcome} text stays in the saved output`, async (t) => {
		const payload = "x".repeat(100 * 1024);
		const digits = "9".repeat(100 * 1024);
		for (const full of [
			`[1 more ${payload}. Use offset=1 to continue.]`,
			`[${digits} more results. Use offset=1 to continue.]`,
			`[1 more results. Use offset=${digits} to continue.]`,
		]) {
			const tool = withToolOutputContract({
				name: "continuation", label: "Continuation", description: "test", parameters: Type.Object({}),
				async execute() {
					if (outcome === "error") throw new Error(full);
					return { content: [{ type: "text", text: full }], details: {} };
				},
			});
			let text;
			if (outcome === "error") {
				await assert.rejects(tool.execute("id", {}, undefined, undefined, {}), (error) => {
					text = error.message;
					return true;
				});
			} else {
				text = (await tool.execute("id", {}, undefined, undefined, {})).content[0].text;
			}
			const fullOutputPath = text.match(/Full output: ([^\n]+)\]/)[1];
			t.after(() => fs.rmSync(path.dirname(fullOutputPath), { recursive: true }));
			assert.equal(fs.readFileSync(fullOutputPath, "utf8"), full);
			assert.match(text, /^\n\n\[Line 1 is /);
			assert.ok(text.endsWith(`Full output: ${fullOutputPath}]`), "do not restore unbounded text after the notice");
			assert.doesNotMatch(text, /Use offset=/);
		}
	});
}

test("hard truncation preserves the complete page and restores only omitted continuation", async () => {
	const continuation = "[3 more results. Use offset=2 to continue.]";
	const pages = [
		"header\n" + "x".repeat(MAX_BYTES) + "\n\n" + continuation,
		"x".repeat(MAX_BYTES + 1) + "\n\n" + continuation,
		// A trailing newline crosses the byte limit after the continuation already fits.
		"x".repeat(MAX_BYTES - continuation.length - 2) + "\n\n" + continuation + "\n",
		Array.from({ length: MAX_LINES + 1 }, () => "row").join("\n") + "\n\n[3 older entries. Use offset=2 to continue.]",
		"x".repeat(MAX_BYTES + 1) + "\n\n[1 older entry. Use offset=2 to continue.]",
		"x".repeat(MAX_BYTES + 1) + "\n\n[3 more labels. Use offset=2 to continue.]",
		"x".repeat(MAX_BYTES + 1) + "\n\n[3 more fork points. Use offset=2 to continue.]",
	];
	for (const full of pages) {
		const tool = withToolOutputContract({
			name: "page", label: "Page", description: "test", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: full }], details: { total: 5, offset: 0, limit: 2 } }; },
		});
		const result = await tool.execute("id", {}, undefined, undefined, {});
		try {
			const text = assertBounded(result);
			const native = truncateHead(full);
			assert.deepEqual(result.details.truncation, native);
			assert.ok(text.startsWith(native.content + "\n\n["), "never prune or rewrite retained content");
			assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), full);
			assert.equal(text.match(/Use offset=2 to continue\./g).length, 1);
			assert.equal(result.details.total, 5);
			if (!native.content.includes("Use offset=2")) {
				assert.ok(text.endsWith(`Full output: ${result.details.fullOutputPath}]\n\n${full.trimEnd().split("\n").at(-1)}`));
			}
		} finally {
			fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
		}
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
			'- name="project refactor" timestamp=2026-07-31T18:20:00.000Z cwd="/work"',
			`  sessionFile: ${JSON.stringify(sessionFile)}`,
			'  match: "[user] Refactor the authentication module"',
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
	assert.equal(fs.readFileSync(sessionResult.details.fullOutputPath, "utf8"), `Session named: ${JSON.stringify("n".repeat(60 * 1024))}`);
	fs.rmSync(path.dirname(sessionResult.details.fullOutputPath), { recursive: true });

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
	assert.equal(modelResult.details.models.length, 20, "structured model locators describe the current page");
	assert.equal(modelResult.details.total, available.length);

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
	assert.ok(scopedResult.content[0].text.includes(
		`- ${scopedModel.provider}/${scopedModel.id} context=${scopedModel.contextWindow} reasoning=false`,
	));
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
	assert.deepEqual(Object.keys(result.details).sort(), ["fullOutputPath", "status", "truncation"]);
	assert.equal(result.details.truncation.truncated, true);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8").includes("n".repeat(1000)), true);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("compact reports scheduling without echoing instructions and sends follow-up only after completion", async () => {
	const messages = [];
	const tree = register(registerTreeRouter, {
		sendUserMessage: (message, options) => messages.push({ message, options }),
	});
	for (const message of [undefined, "Continue after compaction"]) {
		let compaction;
		const result = await tree.execute("compact", {
			action: "compact", customInstructions: "Keep implementation details", message,
		}, undefined, undefined, { compact: (options) => { compaction = options; } });
		assert.equal(result.content[0].text, message
			? "Compaction triggered. Your message will be sent after completion."
			: "Compaction triggered.");
		assert.deepEqual(result.details, { scheduled: "compact", messageScheduled: message !== undefined });
		assert.equal(compaction.customInstructions, "Keep implementation details");
		assert.deepEqual(messages, []);
		compaction.onComplete();
		assert.deepEqual(messages, message ? [{ message, options: { deliverAs: "followUp" } }] : []);
	}
});

test("tree list and labels use forward-only offset continuation", async () => {
	const tree = register(registerTreeRouter);
	const entries = Array.from({ length: 3 }, (_, index) => ({
		id: `entry-${index + 1}`,
		type: "message",
		timestamp: `2026-08-01T00:00:0${index + 1}.000Z`,
		message: { role: "user", content: `preview ${index + 1}` },
	}));
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLabel: (id) => `label-${id}`,
		},
	};

	const list = await tree.execute("list", { action: "list", scope: "branch", limit: 1 }, undefined, undefined, ctx);
	assert.match(list.content[0].text, /\[2 older entries\. Use offset=1 to continue\.\]$/);
	assert.doesNotMatch(list.content[0].text, /newer entries/);

	const labels = await tree.execute("labels", { action: "labels", limit: 1 }, undefined, undefined, ctx);
	assert.match(labels.content[0].text, /\[2 more labels\. Use offset=1 to continue\.\]$/);
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

test("session search paginates matching Sessions after scope filtering", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-pages-"));
	const directory = path.join(root, "sessions", "--work--");
	fs.mkdirSync(directory, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		for (const [index, cwd, content] of [[1, "/work", "needle"], [2, "/other", "needle"], [3, "/work", "unrelated"], [4, "/work", "needle"], [5, "/work", "needle"]]) {
			const file = path.join(directory, `${index}.jsonl`);
			fs.writeFileSync(file, [
				{ type: "session", id: `session-${index}`, cwd },
				{ type: "message", message: { role: "user", content } },
			].map(JSON.stringify).join("\n"));
			fs.utimesSync(file, index, index);
		}
		const tool = register(registerSessionsRouter);
		const search = (offset, signal) => tool.execute("search", { action: "search", keyword: "needle", limit: 2, offset }, signal, undefined, { cwd: "/work" });
		const first = await search(0);
		assert.deepEqual(first.details.results.map((item) => item.sessionId), ["session-5", "session-4"]);
		assert.equal(first.details.total, 3);
		assert.match(first.content[0].text, /\[1 more results\. Use offset=2 to continue\.\]/);
		const last = await search(2);
		assert.deepEqual(last.details.results.map((item) => item.sessionId), ["session-1"]);
		assert.equal(last.details.results[0].sessionFile, path.join(directory, "1.jsonl"));
		assert.doesNotMatch(last.content[0].text, /to continue/);
		const beyond = await search(20);
		assert.deepEqual(beyond.details.results, []);
		assert.equal(beyond.details.total, 3);
		assert.match(beyond.content[0].text, /offset 20.*total:? 3/);
		assert.doesNotMatch(beyond.content[0].text, /to continue/);
		const controller = new AbortController();
		const pending = search(0, controller.signal);
		controller.abort();
		await assert.rejects(pending, /cancelled/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("tree search pages all matching branches newest-first and supports cancellation", async () => {
	const entries = [1, 2, 3, 4].map((index) => ({
		id: `entry00${index}`, type: "message", timestamp: `2026-08-01T00:00:0${index}.000Z`,
		message: { role: "user", content: index === 3 ? "unrelated" : "needle" },
	}));
	const ctx = { sessionManager: {
		getTree: () => entries.map((entry) => ({ entry, children: [] })),
		getBranch: () => [entries[0]],
	} };
	const tool = register(registerTreeRouter);
	const search = (offset, signal) => tool.execute("search", { action: "search", keyword: "needle", limit: 1, offset }, signal, undefined, ctx);
	const first = await search(0);
	assert.match(first.content[0].text, /entry004.*\[off-branch\]/);
	assert.equal(first.details.total, 3);
	assert.match(first.content[0].text, /\[2 more results\. Use offset=1 to continue\.\]/);
	const middle = await search(1);
	assert.match(middle.content[0].text, /entry002/);
	assert.doesNotMatch(middle.content[0].text, /entry004/);
	const last = await search(2);
	assert.match(last.content[0].text, /entry001/);
	assert.doesNotMatch(last.content[0].text, /to continue|off-branch/);
	const beyond = await search(20);
	assert.equal(beyond.details.matches, 0);
	assert.equal(beyond.details.total, 3);
	assert.match(beyond.content[0].text, /offset 20.*total:? 3/);
	assert.doesNotMatch(beyond.content[0].text, /to continue/);
	const controller = new AbortController();
	const pending = search(0, controller.signal);
	controller.abort();
	await assert.rejects(pending, /cancelled/);
});
