import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_MAX_BYTES, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const { patchBindCommandContext } = await jiti.import("../extensions/command-actions.ts");

const models = Array.from({ length: 45 }, (_, i) => ({
	provider: i % 3 === 0 ? "special" : "regular",
	id: `model-${44 - i}`,
	name: i % 2 === 0 ? "Reviewer" : "Writer",
	contextWindow: 10000,
}));
const commands = models.map((model, i) => ({
	invocationName: `command-${44 - i}:1`,
	name: "command",
	description: model.name,
	sourceInfo: { path: `/extensions/${i}.ts`, source: "local", scope: i % 2 ? "user" : "project" },
}));

function setup(kind, items = kind === "models" ? models : commands, scoped = []) {
	let tool;
	const pi = { registerTool(value) { tool = value; }, on() {} };
	let ctx;
	if (kind === "models") {
		registerModelsRouter(pi);
		ctx = { scopedModels: scoped.map(model => ({ model })), modelRegistry: { getAvailable: async () => items } };
	} else {
		registerCommandsRouter(pi);
		const sessionManager = {};
		const runner = { sessionManager, getRegisteredCommands: () => items };
		patchBindCommandContext();
		ExtensionRunner.prototype.bindCommandContext.call(runner, {});
		ctx = { sessionManager };
	}
	return { tool, list: (params = {}) => tool.execute("list", { action: "list", ...params }, undefined, undefined, ctx) };
}

function locators(kind, items) {
	return kind === "models"
		? items.map(({ provider, id }) => ({ provider, id }))
		: items.map(({ invocationName, sourceInfo }) => ({ invocationName, ...sourceInfo }));
}

function checkPage(result, kind, items, total, offset, limit) {
	assert.deepEqual(result.details[kind], locators(kind, items));
	assert.equal(result.details.total, total);
	assert.equal(result.details.offset, offset);
	assert.equal(result.details.limit, limit);
	const text = result.content[0].text;
	const rows = text.split("\n").filter(line => line.startsWith(kind === "models" ? "- " : "/"));
	assert.equal(rows.length, items.length);
	items.forEach((item, i) => assert.ok(rows[i].startsWith(kind === "models"
		? `- ${item.provider}/${item.id} ` : `/${item.invocationName} `)));
	const remaining = total - offset - items.length;
	if (remaining > 0) {
		assert.ok(text.endsWith(`[${remaining} more results. Use offset=${offset + items.length} to continue.]`));
	} else {
		assert.doesNotMatch(text, /more results|to continue/);
	}
}

for (const kind of ["models", "commands"]) {
	const items = kind === "models" ? models : commands;
	test(`${kind}.list returns default, middle, last and beyond-end pages in original order`, async () => {
		const { list } = setup(kind);
		checkPage(await list(), kind, items.slice(0, 20), 45, 0, 20);
		checkPage(await list({ offset: 20 }), kind, items.slice(20, 40), 45, 20, 20);
		checkPage(await list({ offset: 40 }), kind, items.slice(40), 45, 40, 20);
		for (const offset of [45, 100]) {
			const result = await list({ offset });
			checkPage(result, kind, [], 45, offset, 20);
			assert.match(result.content[0].text, /total: 45/);
		}
	});

	test(`${kind}.list applies case-insensitive filtering before pagination`, async () => {
		const { list } = setup(kind);
		const filtered = items.filter((_, i) => i % 2 === 0);
		checkPage(await list({ filter: "rEvIeWeR", offset: 3, limit: 4 }), kind, filtered.slice(3, 7), 23, 3, 4);
		checkPage(await list({ filter: "Reviewer", offset: 20, limit: 4 }), kind, filtered.slice(20), 23, 20, 4);
		checkPage(await list({ filter: "missing", offset: 2 }), kind, [], 0, 2, 20);
		checkPage(await setup(kind, []).list(), kind, [], 0, 0, 20);
	});

	test(`${kind}.list saves the complete oversized page and resumes without skipping items`, async (t) => {
		const longText = "x".repeat(DEFAULT_MAX_BYTES + 100);
		const oversizedItems = items.slice(0, 4).map((item, i) => i === 0
			? { ...item, ...(kind === "models" ? { id: longText } : { description: longText }) }
			: item);
		const { list } = setup(kind, oversizedItems);
		const result = await list({ limit: 2 });
		const { fullOutputPath } = result.details;
		assert.equal(typeof fullOutputPath, "string");
		t.after(() => rm(dirname(fullOutputPath), { recursive: true, force: true }));
		assert.equal(result.details.truncation?.truncated, true);
		assert.equal(result.details.total, 4);
		assert.equal(result.details.offset, 0);
		assert.equal(result.details.limit, 2);
		assert.deepEqual(result.details[kind], locators(kind, oversizedItems.slice(0, 2)));

		const continuation = "[2 more results. Use offset=2 to continue.]";
		const pageLines = oversizedItems.slice(0, 2).map(item => kind === "models"
			? `- ${item.provider}/${item.id} context=${item.contextWindow} reasoning=false`
			: `/${item.invocationName} — ${item.description} (${item.sourceInfo.source})`);
		const expectedPage = (kind === "models" ? "no scoped models configured, using all available models:\n" : "")
			+ pageLines.join("\n") + `\n\n${continuation}`;
		assert.equal(await readFile(fullOutputPath, "utf8"), expectedPage);

		const text = result.content[0].text;
		assert.ok(!text.includes(pageLines[1]), "later item is omitted from the bounded output but saved in the page file");
		assert.equal(text.split(continuation).length - 1, 1);
		assert.ok(text.endsWith(`Full output: ${fullOutputPath}]\n\n${continuation}`));
		const nextOffset = Number(text.match(/Use offset=(\d+) to continue\./)[1]);
		const next = await list({ limit: 2, offset: nextOffset });
		checkPage(next, kind, oversizedItems.slice(2), 4, 2, 2);
		assert.equal(next.details.truncation, undefined);
		assert.equal(next.details.fullOutputPath, undefined);
		assert.doesNotMatch(next.content[0].text, /Full output:/);
		assert.deepEqual([...result.details[kind], ...next.details[kind]], locators(kind, oversizedItems));
	});

	test(`${kind}.list retains clampLimit normalization for direct execution`, async () => {
		const { list } = setup(kind);
		checkPage(await list({ limit: 0, offset: -2 }), kind, items.slice(0, 1), 45, 0, 1);
		checkPage(await list({ limit: 999 }), kind, items, 45, 0, 200);
		checkPage(await list({ limit: 2.9, offset: 1.9 }), kind, items.slice(1, 3), 45, 1, 2);
	});
}

test("models.list scopes before filtering and pagination, retaining configured order", async () => {
	const scoped = [models[20], models[3], models[8], models[2]];
	const { list } = setup("models", models, scoped);
	const result = await list({ filter: "Reviewer", offset: 1, limit: 1 });
	checkPage(result, "models", [models[8]], 3, 1, 1);
	assert.equal(result.details.scope, "scoped");
	const all = await list({ scope: "all", filter: "Reviewer", offset: 1, limit: 1 });
	checkPage(all, "models", [models[2]], 23, 1, 1);
	assert.equal(all.details.scope, "all");
});

test("models.list filters provider and ID; commands.list filters invocation names", async () => {
	const { list } = setup("models");
	checkPage(await list({ filter: "SPECIAL", offset: 2, limit: 2 }), "models", [models[6], models[9]], 15, 2, 2);
	checkPage(await list({ filter: "MODEL-44" }), "models", [models[0]], 1, 0, 20);
	checkPage(await setup("commands").list({ filter: "COMMAND-44:1" }), "commands", [commands[0]], 1, 0, 20);
});
