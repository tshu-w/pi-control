import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

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
		for (const isPartial of [true, false]) {
			styles.length = 0;
			const component = tools.get(name).renderCall(args, theme, { expanded: false, isPartial });
			assert.deepEqual(component.render(1000).map((line) => line.trimEnd()), isPartial ? [expected] : [expected, ""]);
			assert.equal(styles.filter(([color]) => color === "toolTitle").map(([, text]) => text).join(""), expected.slice(0, expected.indexOf("(")));
			assert.equal(styles.filter(([color]) => color === "text").map(([, text]) => text).join(""), expected.slice(expected.indexOf("(")));
			assert.ok(styles.every(([color]) => color === "toolTitle" || color === "text"));
		}
	}
});

test("collapsed results hide the tail and keep footers; expanded results stay complete", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/output.txt]";
	const n = 50;
	const items = (make) => Array.from({ length: n }, (_, index) => make(index + 1));
	const forkGroups = items((i) => `├─ [fork-${i}] user: fork ${i}\n│  └─ [branch-${i}] assistant: branch ${i} (2 entries)`);
	const cases = [
		["commands", { action: "run" }, `${items((i) => `notification ${i}`).join("\n")}\n\n${notice}`, {}, "notification 50", notice],
		["commands", { action: "list" }, `${items((i) => `/command-${i} — description (local)`).join("\n")}\n\n${notice}`, {}, "command-50", notice],
		["models", { action: "list", scope: "all" }, `all available models:\n${items((i) => `- provider/model-${i} context=128000 reasoning=false`).join("\n")}\n\n${notice}`, {}, "model-50", notice],
		["models", { action: "consult" }, `response from provider/model ↑1 ↓1\n\n${items((i) => `response line ${i}`).join("\n")}\n\n${notice}`, {}, "response line 50", notice],
		["tree", { action: "list", scope: "branch" }, `branch entries newest-first (${n}/80, offset 0)\n${items((i) => `[entry-${i}] user: preview ${i}`).join("\n")}\n\n[30 older entries. Use offset=${n} to continue.]`, { shown: n }, "entry-50", "[30 older entries. Use offset=50 to continue.]"],
		["tree", { action: "list", scope: "all" }, `current branch (120 entries, tip [tip] user)\n${forkGroups.join("\n")}\n[12 more fork points. Use offset=${n} to continue.]`, { shown: n }, "branch-50", "[12 more fork points. Use offset=50 to continue.]"],
		["sessions", { action: "search" }, `sessions (${n} returned)\n\n${items((i) => `- name="session ${i}"\n  sessionFile: "/sessions/${i}.jsonl"`).join("\n\n")}\n\n[2 more results. Use offset=${n} to continue.]\n\n${notice}`, {}, 'name="session 50"', notice],
	];
	for (const [name, args, content, details, lastItem, footer] of cases) {
		const tool = tools.get(name);
		const truncated = content.includes(notice);
		const result = { content: [{ type: "text", text: content }], details: { ...details, ...(truncated ? { truncation: { truncated: true } } : {}) } };
		const context = { args, isError: false };
		const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context)
			.render(1000).map((line) => line.trimEnd()).join("\n");
		assert.match(collapsed, /\.\.\. \(\d+ more lines, .*to expand\)/, `${name} ${args.action} collapses`);
		assert.equal(collapsed.includes(lastItem), false, `${name} ${args.action} hides the tail`);
		assert.ok(collapsed.includes(footer), `${name} ${args.action} keeps its footer`);
		const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context)
			.render(1000).map((line) => line.trimEnd()).join("\n");
		assert.equal(expanded, content);
	}
});

test("collapse hints count wrapped display lines", () => {
	const commands = tools.get("commands");
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const long = " 中🙂".repeat(20);
	const lines = Array.from({ length: 50 }, (_, index) => `notification ${index + 1}${long}`);
	const component = commands.renderResult(
		{ content: [{ type: "text", text: lines.join("\n") }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "run" }, isError: false },
	);
	const hiddenAt = (width) => Number(component.render(width).join("\n").match(/\.\.\. \((\d+) more lines/)[1]);
	assert.ok(hiddenAt(24) > hiddenAt(1000), "narrow widths report more hidden display lines");
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
