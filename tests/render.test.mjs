import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { Text } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");

const tools = new Map();
const pi = { registerTool: (tool) => tools.set(tool.name, tool), on() {} };
registerSessionsRouter(pi);
registerTreeRouter(pi);
registerModelsRouter(pi);
registerCommandsRouter(pi);

function assertWrappedHint(tool, result, context, theme, hiddenText) {
	const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
	for (const width of [24, 1000, 40]) {
		component.invalidate();
		const expected = new Text(hiddenText, 0, 0).render(width).length;
		const lines = component.render(width).map((line) => line.trimEnd()).join("\n");
		assert.ok(lines.includes(`... (${expected} more lines,`), `hidden display lines at width ${width}: ${lines}`);
	}
}

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

test("command runs collapse output after fifteen lines", () => {
	const commands = tools.get("commands");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const notifications = Array.from({ length: 16 }, (_, index) => `notification ${index + 1}${index === 15 ? " 中🙂".repeat(20) : ""}`);
	const content = notifications.join("\n");
	const context = { args: { action: "run" }, isError: false };

	const collapsed = commands.renderResult(
		{ content: [{ type: "text", text: content }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^notification 1/);
	assert.match(collapsed, /notification 15/);
	assert.doesNotMatch(collapsed, /notification 16/);
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)$/);
	assertWrappedHint(commands, { content: [{ type: "text", text: content }], details: {} }, context, theme, notifications[15]);

	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/command.txt]";
	const truncated = commands.renderResult(
		{ content: [{ type: "text", text: `${content}\n\n${notice}` }], details: { truncation: { truncated: true } } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(truncated, /to expand\)\n\n\[(?:Output truncated:|Showing lines)/);
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
	assertWrappedHint(commands, result, context, theme, entries.slice(20).join("\n"));
	assert.match(collapsed, /command-20/);
	assert.doesNotMatch(collapsed, /command-21/);
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)\n\n\[(?:Output truncated:|Showing lines)/);

	const expanded = commands.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("model consultations collapse after fifteen response lines", () => {
	const models = tools.get("models");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const response = Array.from({ length: 16 }, (_, index) => `response line ${index + 1}${index === 15 ? " wrapped".repeat(10) : ""}`).join("\n");
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
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)$/);
	assert.doesNotMatch(collapsed, /Output truncated/);
	assertWrappedHint(models, { content: [{ type: "text", text: content }], details: {} }, context, theme, response.split("\n").slice(15).join("\n"));

	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/consult.txt]";
	const truncatedContent = `${content}\n\n${notice}`;
	const truncated = models.renderResult(
		{ content: [{ type: "text", text: truncatedContent }], details: { truncation: { truncated: true } } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(truncated, /to expand\)\n\n\[(?:Output truncated:|Showing lines)/);

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
	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/models.txt]";
	const content = `all available models:\n${entries.join("\n")}\n\n${notice}`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "list", scope: "all" }, isError: false };

	const collapsed = models.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assertWrappedHint(models, result, context, theme, entries.slice(20).join("\n"));
	assert.match(collapsed, /model-20/);
	assert.doesNotMatch(collapsed, /model-21/);
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)\n\n\[(?:Output truncated:|Showing lines)/);

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
	assertWrappedHint(tree, result, context, theme, groups.slice(5).join("\n"));
	assert.match(collapsed, /fork-5/);
	assert.match(collapsed, /branch-5/);
	assert.doesNotMatch(collapsed, /fork-6/);
	assert.match(collapsed, /\.\.\. \(2 more lines, .*to expand\)\n\n\[12 more fork points/);

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
	assertWrappedHint(tree, result, context, theme, entries.slice(15).join("\n"));
	assert.match(collapsed, /entry-15/);
	assert.doesNotMatch(collapsed, /entry-16/);
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)/);
	assert.match(collapsed, /\[24 older entries\. Use offset=16 to continue\.\]$/);

	const expanded = tree.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("hard truncation notices use warning while continuation hints stay subdued", () => {
	const styles = [];
	const theme = {
		bold: (text) => text,
		fg: (color, text) => { styles.push([color, text]); return text; },
	};
	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/output.txt]";
	const continuation = "[12 more results. Use offset=5 to continue.]";
	const suffix = `\nScope: all\n\n${continuation}`;
	for (const [name, args] of [
		["commands", { action: "run" }],
		["models", { action: "consult" }],
		["sessions", { action: "search" }],
		["tree", { action: "search" }],
	]) {
		const body = name === "commands" ? "[Output truncated: user content]\nbody" : "body";
		for (const prefix of [`${body}\n\n`, ""]) {
			const content = `${prefix}${notice}${suffix}`;
			const rendered = tools.get(name).renderResult(
				{ content: [{ type: "text", text: content }], details: { truncation: { truncated: true } } },
				{ expanded: true, isPartial: false },
				theme,
				{ args, isError: false },
			).render(1000).map((line) => line.trimEnd()).join("\n");
			assert.equal(rendered, content);
		}
	}
	assert.equal(styles.filter(([color, text]) => color === "warning" && text === notice).length, 8);
	assert.equal(styles.filter(([color, text]) => color === "toolOutput" && text.includes(suffix)).length, 8);
	assert.equal(styles.some(([color, text]) => color === "warning" && /Scope:|Use offset=/.test(text)), false);

	styles.length = 0;
	const retainedEntries = Array.from({ length: 16 }, (_, index) => `[entry-${index + 1}] user: preview`);
	tools.get("tree").renderResult(
		{ content: [{ type: "text", text: `entries\n${retainedEntries.join("\n")}\n\n${notice}${suffix}` }], details: { shown: 100, truncation: { truncated: true } } },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "list", scope: "branch" }, isError: false },
	).render(1000);
	assert.ok(styles.some(([color, text]) => color === "warning" && text === notice), "collapsed tree retains the hard truncation warning");
	assert.ok(styles.some(([color, text]) => color === "muted" && /\.\.\. \(1 more lines, .*to expand\)/.test(text)));
	assert.ok(styles.some(([color, text]) => color === "toolOutput" && text === "Scope: all"));
	assert.ok(styles.some(([color, text]) => color === "toolOutput" && text === continuation));

	styles.length = 0;
	tools.get("tree").renderResult(
		{ content: [{ type: "text", text: continuation }], details: {} },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { action: "list" }, isError: false },
	).render(1000);
	assert.equal(styles.some(([color]) => color === "warning"), false);
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
	const content = `sessions (6 returned)\n\n${records.join("\n\n")}\n\n[2 more results. Use offset=6 to continue.]\n\n${notice}`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "search" }, isError: false };

	const collapsed = sessions.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assertWrappedHint(sessions, result, context, theme, records.slice(5).join("\n\n"));
	assert.match(collapsed, /name="session 5"/);
	assert.doesNotMatch(collapsed, /name="session 6"/);
	assert.match(collapsed, /\.\.\. \(3 more lines, .*to expand\)/);
	assert.match(collapsed, /\[2 more results. Use offset=6 to continue.\]/);
	assert.match(collapsed, /\[(?:Output truncated:|Showing lines)/);

	const expanded = sessions.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);

	const fiveSessions = `sessions (5 returned)\n\n${records.slice(0, 5).join("\n\n")}`;
	const notCollapsed = sessions.renderResult(
		{ content: [{ type: "text", text: fiveSessions }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(notCollapsed, fiveSessions);

	const sevenSessions = `sessions (7 returned)\n\n${[...records, records[5]].join("\n\n")}`;
	const twoHiddenRecords = sessions.renderResult(
		{ content: [{ type: "text", text: sevenSessions }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(twoHiddenRecords, /\.\.\. \(7 more lines, .*to expand\)/);
	assert.doesNotMatch(twoHiddenRecords, /name="session 6"/);
});
