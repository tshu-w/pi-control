import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");

const tools = new Map();
const pi = { registerTool: (tool) => tools.set(tool.name, tool) };
registerSessionsRouter(pi);
registerTreeRouter(pi);
registerModelsRouter(pi);
registerCommandsRouter(pi);

const cases = [
	["sessions", { action: "search", keyword: "renderer", limit: 10, scope: "all" }, '<b>sessions</b>(action="search", keyword="renderer", limit=10, scope="all")'],
	["tree", { action: "list", scope: "branch", types: ["message", "compaction"] }, '<b>tree</b>(action="list", scope="branch", types=["message","compaction"])'],
	["models", { action: "consult", modelId: "gpt-5.5", thinkingLevel: "high", prompt: "review" }, '<b>models</b>(action="consult", modelId="gpt-5.5", thinkingLevel="high", prompt="review")'],
	["commands", { action: "run", name: "ssh", args: "off" }, '<b>commands</b>(action="run", name="ssh", args="off")'],
];

test("router calls render every argument in function-call form", () => {
	for (const [name, args, expected] of cases) {
		const styles = [];
		const theme = {
			bold: (text) => `<b>${text}</b>`,
			fg: (color, text) => { styles.push([color, text]); return text; },
		};
		const pending = tools.get(name).renderCall(args, theme, { expanded: false, isPartial: true });
		assert.deepEqual(pending.render(1000).map((line) => line.trimEnd()), [expected]);
		const completed = tools.get(name).renderCall(args, theme, { expanded: false, isPartial: false });
		assert.deepEqual(completed.render(1000).map((line) => line.trimEnd()), [expected, ""]);
		assert.equal(styles[0][0], "toolTitle");
		assert.ok(styles.filter(([color]) => color === "text").length > Object.keys(args).length);
		assert.equal(styles.some(([color]) => color === "muted"), false);
		assert.equal(styles.some(([color]) => color === "accent"), false);
	}
});

test("command runs retain status and collapse captured output after fifteen lines", () => {
	const commands = tools.get("commands");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const notifications = Array.from({ length: 15 }, (_, index) => `  [info] notification ${index + 1}`);
	const content = [
		"Command: /example run",
		"Status: completed",
		"Notifications:",
		...notifications,
	].join("\n");
	const context = { args: { action: "run" }, isError: false };

	const collapsed = commands.renderResult(
		{ content: [{ type: "text", text: content }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^Command: \/example run\nStatus: completed/);
	assert.match(collapsed, /notification 14/);
	assert.doesNotMatch(collapsed, /notification 15/);
	assert.match(collapsed, /\.\.\. \(1 command output line hidden, .*to expand\)$/);

	const notice = "[Output truncated: 100 lines. Full output: /tmp/command.txt]";
	const truncated = commands.renderResult(
		{ content: [{ type: "text", text: `${content}\n\n${notice}` }], details: { truncated: true } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(truncated, /to expand\)\n\n\[Output truncated:/);
});

test("command lists collapse after twenty entries and retain truncation notices", () => {
	const commands = tools.get("commands");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const entries = Array.from({ length: 21 }, (_, index) => `/command-${index + 1} — description (source)`);
	const notice = "[Output truncated: 100 lines. Narrow the filter or use pagination to continue.]";
	const content = `${entries.join("\n")}\n\n${notice}`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "list" }, isError: false };

	const collapsed = commands.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /command-20/);
	assert.doesNotMatch(collapsed, /command-21/);
	assert.match(collapsed, /\.\.\. \(1 command hidden, .*to expand\)\n\n\[Output truncated:/);

	const expanded = commands.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("model consultations collapse after fifteen response lines", () => {
	const models = tools.get("models");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const response = Array.from({ length: 16 }, (_, index) => `response line ${index + 1}`).join("\n");
	const header = "response from provider/model ↑1200 ↓800 $0.0123";
	const content = `${header}\n\n${response}`;
	const context = { args: { action: "consult" }, isError: false };

	const collapsed = models.renderResult(
		{ content: [{ type: "text", text: content }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /response line 15/);
	assert.doesNotMatch(collapsed, /response line 16/);
	assert.match(collapsed, /\.\.\. \(1 response line hidden, .*to expand\)$/);
	assert.doesNotMatch(collapsed, /Output truncated/);

	const notice = "[Output truncated: 100 lines. Full output: /tmp/consult.txt]";
	const truncatedContent = `${content}\n\n${notice}`;
	const truncated = models.renderResult(
		{ content: [{ type: "text", text: truncatedContent }], details: { truncated: true } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(truncated, /to expand\)\n\n\[Output truncated:/);

	const partial = models.renderResult(
		{ content: [{ type: "text", text: "Consulting provider/model..." }], details: {} },
		{ expanded: false, isPartial: true },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(partial, "Consulting provider/model...");
});

test("model lists collapse after twenty entries and retain truncation notices", () => {
	const models = tools.get("models");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const entries = Array.from({ length: 21 }, (_, index) =>
		`- provider/model-${index + 1} context=128000 reasoning=false`,
	);
	const notice = "[Output truncated: 100 lines. Full output: /tmp/models.txt]";
	const content = `all available models:\n${entries.join("\n")}\n\n${notice}`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "list", scope: "all" }, isError: false };

	const collapsed = models.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /model-20/);
	assert.doesNotMatch(collapsed, /model-21/);
	assert.match(collapsed, /\.\.\. \(1 model hidden, .*to expand\)\n\n\[Output truncated:/);

	const expanded = models.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("grouped tree results collapse after five complete fork points", () => {
	const tree = tools.get("tree");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const groups = Array.from({ length: 6 }, (_, index) => [
		`├─ [fork-${index + 1}] 2026-08-01T00:00:00 user: fork ${index + 1}`,
		`│  └─ [branch-${index + 1}] 2026-08-01T00:00:00 assistant: branch ${index + 1} (2 entries)`,
	].join("\n"));
	const continuation = "[12 more fork points. Use offset=6 to continue.]";
	const content = `current branch (120 entries, tip [tip] user)\n${groups.join("\n")}\n${continuation}`;
	const result = { content: [{ type: "text", text: content }], details: { shown: 6 } };
	const context = { args: { action: "list", scope: "all" }, isError: false };

	const collapsed = tree.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /fork-5/);
	assert.match(collapsed, /branch-5/);
	assert.doesNotMatch(collapsed, /fork-6/);
	assert.match(collapsed, /\.\.\. \(1 fork point hidden, .*to expand\)\n\n\[12 more fork points/);

	const expanded = tree.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("linear tree results collapse after fifteen entries and retain continuation", () => {
	const tree = tools.get("tree");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const entries = Array.from({ length: 16 }, (_, index) =>
		`[entry-${index + 1}] 2026-08-01T00:00:00 user: preview ${index + 1}`,
	);
	const continuation = "[24 older entries. Use offset=16 to continue.]";
	const content = `branch entries newest-first (16/40, offset 0)\n${entries.join("\n")}\n\n${continuation}`;
	const result = { content: [{ type: "text", text: content }], details: { shown: 16 } };
	const context = { args: { action: "list", scope: "branch" }, isError: false };

	const collapsed = tree.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /entry-15/);
	assert.doesNotMatch(collapsed, /entry-16/);
	assert.match(collapsed, /\.\.\. \(1 entry hidden, .*to expand\)/);
	assert.match(collapsed, /\[24 older entries\. Use offset=16 to continue\.\]$/);

	const expanded = tree.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("session searches collapse after five complete records", () => {
	const sessions = tools.get("sessions");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const records = Array.from({ length: 6 }, (_, index) => [
		`- name="session ${index + 1}" timestamp=2026-08-01T00:00:0${index + 1}.000Z cwd="/work"`,
		`  sessionFile: "/sessions/${index + 1}.jsonl"`,
		`  preview: "preview ${index + 1}"`,
	].join("\n"));
	const notice = "[Output truncated: 100 lines. Narrow the filter or use pagination to continue.]";
	const content = `sessions (6 returned)\n\n${records.join("\n\n")}\n\nUse sessions(action='resume', sessionFile=...) to switch.\n\n${notice}`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "search" }, isError: false };

	const collapsed = sessions.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /name="session 5"/);
	assert.doesNotMatch(collapsed, /name="session 6"/);
	assert.match(collapsed, /\.\.\. \(1 session hidden, .*to expand\)/);
	assert.match(collapsed, /Use sessions\(action='resume'/);
	assert.match(collapsed, /\[Output truncated:/);

	const expanded = sessions.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);

	const fiveSessions = `sessions (5 returned)\n\n${records.slice(0, 5).join("\n\n")}\n\nUse sessions(action='resume', sessionFile=...) to switch.`;
	const notCollapsed = sessions.renderResult(
		{ content: [{ type: "text", text: fiveSessions }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(notCollapsed, fiveSessions);
});
